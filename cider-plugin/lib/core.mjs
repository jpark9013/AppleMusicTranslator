const USER_AGENT = "AppleMusicTranslator/0.1 (https://github.com/jpark9013/AppleMusicTranslator)"
const LRCLIB_BASE = "https://lrclib.net/api"
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"
export const DEFAULT_MODEL = "deepseek-flash"
const MAX_DURATION_DIFFERENCE = 5
const TIMESTAMP = /\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g

export class LyricsError extends Error {
  constructor(message = "No lyrics found for this song.") {
    super(message)
    this.name = "LyricsError"
  }
}

export class TranslationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TranslationError"
    this.code = code
  }

  get isRetryable() {
    if (this.code === "malformed") return true
    if (this.code === "missing-key") return false
    const status = Number(this.code)
    return status === 429 || status >= 500
  }
}

export function cacheKey(track) {
  return `${track.artist}|${track.name}`.toLowerCase()
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

// Some lyric providers send HTML-escaped text ("&amp;", "&#8211;") that Cider
// shows verbatim.
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? match
    const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
  })
}

// Lyric sources disagree on spacing and punctuation ("줄래" vs "줄래?"), and
// Cider renders words in separate spans, so lines are compared without them.
export function lineKey(text) {
  return decodeEntities(text).normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, "").toLowerCase()
}

// Maps official {line, translation} pairs onto the displayed lines. Sources
// sometimes join two displayed lines into one, so a line that has no match on
// its own is tried together with the next line.
export function alignTranslations(lineTexts, pairs) {
  const official = new Map()
  for (const { line, translation } of pairs) {
    if (translation) official.set(lineKey(line), translation)
  }
  const byKey = {}
  for (let i = 0; i < lineTexts.length; i += 1) {
    const key = lineKey(lineTexts[i])
    if (!key || byKey[key]) continue
    if (official.has(key)) {
      byKey[key] = official.get(key)
    } else if (i + 1 < lineTexts.length && official.has(key + lineKey(lineTexts[i + 1]))) {
      byKey[key] = official.get(key + lineKey(lineTexts[i + 1]))
    }
  }
  return byKey
}

export function translationsByLineKey(translations) {
  const byKey = {}
  for (const [line, translation] of Object.entries(translations)) {
    if (translation) byKey[lineKey(line)] = translation
  }
  return byKey
}

export function parseLRC(lrc) {
  const lines = []
  for (const rawLine of lrc.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(TIMESTAMP)]
    if (matches.length === 0) continue
    const last = matches[matches.length - 1]
    const text = rawLine.slice(last.index + last[0].length).trim()
    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2].replace(":", "."))
      lines.push({ time: minutes * 60 + seconds, text, order: lines.length })
    }
  }
  lines.sort((a, b) => a.time - b.time || a.order - b.order)
  return lines.map(({ time, text }) => ({ time, text }))
}

export function activeLineIndex(lyrics, position, lead = 0) {
  if (!lyrics?.isSynced) return null
  const target = position + lead
  let index = null
  lyrics.lines.forEach((line, i) => {
    if ((line.time ?? 0) <= target) index = i
  })
  return index
}

export function simplifiedTitle(title) {
  let result = title.replace(/\s*[([{][^)\]}]*[)\]}]/g, "")
  const dash = result.indexOf(" - ")
  if (dash !== -1) result = result.slice(0, dash)
  const trimmed = result.trim()
  return trimmed === "" ? title : trimmed
}

export function lyricsFromRecord(record) {
  if (record.instrumental === true) {
    return { lines: [], isSynced: false, isInstrumental: true }
  }
  if (record.syncedLyrics) {
    const lines = parseLRC(record.syncedLyrics)
    if (lines.length > 0) return { lines, isSynced: true, isInstrumental: false }
  }
  if (record.plainLyrics) {
    const lines = record.plainLyrics.split(/\r?\n/).map((text) => ({
      time: null,
      text: text.trim(),
    }))
    return { lines, isSynced: false, isInstrumental: false }
  }
  return null
}

export function bestMatch(records, duration) {
  const candidates = records.filter((record) => {
    if (!(duration > 0) || record.duration == null) return true
    return Math.abs(record.duration - duration) <= MAX_DURATION_DIFFERENCE
  })
  return (
    candidates.find((record) => record.syncedLyrics) ||
    candidates.find((record) => record.plainLyrics) ||
    candidates.find((record) => record.instrumental === true) ||
    null
  )
}

export function uniqueLines(lines) {
  const seen = new Set()
  return lines.filter((line) => line && !seen.has(line) && seen.add(line))
}

export function parseTranslations(text) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const object = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(object.translations)) return null
    return object.translations.map((value) => String(value ?? "").trim())
  } catch {
    return null
  }
}

export function systemPrompt(language, count) {
  return [
    `You translate song lyrics into ${language} for display under the original lines while the song plays.`,
    "Translate meaning, tone and imagery naturally, the way a skilled human lyric translator would, rather than word for word.",
    "Keep each translation on a single line and roughly as concise as the original.",
    `If a line is already in ${language}, or is only vocalizations like "oh" or "la la", return an empty string for it.`,
    `Respond with only a JSON object of the form {"translations": ["...", "..."]} containing exactly ${count} strings, one per input line, in the same order. No commentary, no code fences.`,
  ].join("\n")
}

export function requestBody(lines, track, language, model, stream = false) {
  return {
    model,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    // Reasoning made up ~85-90% of output tokens with no gain for this task.
    thinking: { type: "disabled" },
    ...(stream ? { stream: true } : {}),
    messages: [
      { role: "system", content: systemPrompt(language, lines.length) },
      {
        role: "user",
        content: `Song: "${track.name}" by ${track.artist}\nLines (${lines.length}):\n${JSON.stringify(lines)}`,
      },
    ],
  }
}

function query(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value != null && value !== "")
  ).toString()
}

async function getJSON(url, http) {
  const { status, body } = await http(url, {
    headers: { "User-Agent": USER_AGENT },
  })
  if (status !== 200) return { status, data: null }
  return { status, data: JSON.parse(body) }
}

export async function fetchLyrics(track, http) {
  const exactURL = `${LRCLIB_BASE}/get?${query({
    track_name: track.name,
    artist_name: track.artist,
    album_name: track.album,
    duration: track.duration > 0 ? String(Math.round(track.duration)) : undefined,
  })}`
  const exact = await getJSON(exactURL, http)
  const exactLyrics = exact.data ? lyricsFromRecord(exact.data) : null
  if (exactLyrics) return exactLyrics

  const titles = [track.name]
  const simplified = simplifiedTitle(track.name)
  if (simplified !== track.name) titles.push(simplified)

  for (const title of titles) {
    const searchURL = `${LRCLIB_BASE}/search?${query({
      track_name: title,
      artist_name: track.artist,
    })}`
    const search = await getJSON(searchURL, http)
    if (!Array.isArray(search.data)) continue
    const match = bestMatch(search.data, track.duration)
    const lyrics = match ? lyricsFromRecord(match) : null
    if (lyrics) return lyrics
  }
  throw new LyricsError()
}

export async function translateLines(lines, track, language, model, apiKey, http) {
  if (!apiKey) throw new TranslationError("missing-key", "Add your DeepSeek API key to see translations.")
  const unique = uniqueLines(lines)
  if (unique.length === 0) return {}

  let lastError = new TranslationError("malformed", "Translation failed: the model returned an unexpected response.")
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const translated = await sendTranslation(unique, track, language, model, apiKey, http)
      return Object.fromEntries(unique.map((line, index) => [line, translated[index]]))
    } catch (error) {
      if (!(error instanceof TranslationError) || !error.isRetryable) throw error
      lastError = error
    }
  }
  throw lastError
}

function deepseekHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  }
}

export function assistantText(json) {
  return json?.choices?.[0]?.message?.content ?? ""
}

async function sendTranslation(lines, track, language, model, apiKey, http) {
  const { status, body } = await http(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: deepseekHeaders(apiKey),
    body: JSON.stringify(requestBody(lines, track, language, model)),
  })
  const json = safeJSON(body)
  if (status !== 200) {
    throw new TranslationError(status, json?.error?.message || body || "Unknown error")
  }
  const text = assistantText(json)
  const translations = parseTranslations(text)
  if (!translations && !text.includes('"translations"')) throw declinedError()
  if (!translations || translations.length !== lines.length) {
    throw new TranslationError("malformed", "Translation failed: the model returned an unexpected response.")
  }
  return translations
}

async function chatJSON(system, user, model, apiKey, http) {
  const { status, body } = await http(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: deepseekHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })
  const json = safeJSON(body)
  if (status !== 200) throw new TranslationError(status, json?.error?.message || body || "Unknown error")
  const text = assistantText(json)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const object = start === -1 || end <= start ? null : safeJSON(text.slice(start, end + 1))
  if (!object) throw declinedError()
  return object
}

export function wholeSongPrompt(track, language, count) {
  return [
    `Translate the complete lyrics of "${track.name}" by ${track.artist} into ${language} the way a skilled lyric translator would, reading them as one continuous text.`,
    "Sentences often continue across line breaks: translate each sentence as a whole, then distribute its translation over the lines it spans so each line carries the part of the meaning sung on that line, in an order that still reads naturally line after line.",
    `Lines already in ${language} or only vocalizations get an empty string.`,
    `Respond with only a JSON object {"translations": [...]} with exactly ${count} strings, one per numbered line, in order.`,
  ].join("\n")
}

// Sends the whole song in one request and lets the model match its
// translation to the lines, which handles sentences that run across lines.
// Returns one translation per input line, by position.
export async function translateWholeSong(lines, track, language, model, apiKey, http) {
  if (!apiKey) throw new TranslationError("missing-key", "Add your DeepSeek API key to see translations.")
  if (lines.length === 0) return []

  const numbered = lines.map((line, index) => `${index + 1}|${line}`).join("\n")
  let lastError = new TranslationError("malformed", "Translation failed: the model returned an unexpected response.")
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { translations } = await chatJSON(wholeSongPrompt(track, language, lines.length), numbered, model, apiKey, http)
      if (Array.isArray(translations) && translations.length === lines.length) {
        return translations.map((translation) => String(translation ?? "").trim())
      }
    } catch (error) {
      if (!(error instanceof TranslationError) || !error.isRetryable) throw error
      lastError = error
    }
  }
  throw lastError
}

// Applies translations by position when the lines on screen are the ones that
// were translated, so a repeated line keeps the translation for its context.
// Otherwise falls back to matching by line text. A "translation" identical to
// its line (an English line, "la la la") is not shown.
export function applyPositionalTranslations(lines, result, owned) {
  const nonEmpty = (lines ?? []).filter((line) => line && typeof line.text === "string" && line.text.trim())
  const keys = nonEmpty.map((line) => lineKey(line.text))
  const positional =
    result.layout && result.layout.length === keys.length && result.layout.every((key, index) => key === keys[index])
  if (!positional) return applyTranslationsToLines(lines, result.byKey ?? {}, owned)
  let applied = 0
  nonEmpty.forEach((line, index) => {
    const translation = result.positional[index]
    if (!translation || lineKey(translation) === keys[index]) return
    const current = line.translation
    if (current && current !== owned.get(line)) return
    if (current !== translation) line.translation = translation
    owned.set(line, translation)
    applied += 1
  })
  return applied
}

// The model answered in prose instead of the requested JSON, e.g. it chose not
// to translate the song. Retrying the same request would not change that.
function declinedError() {
  return new TranslationError("declined", "The model didn't translate this song.")
}

// Writes translations onto Cider's lyric line objects. Lines that already
// carry a translation we did not write (Cider's own) are left alone.
export function applyTranslationsToLines(lines, translationsByKey, owned) {
  let applied = 0
  for (const line of lines ?? []) {
    if (!line || typeof line.text !== "string") continue
    const translation = translationsByKey[lineKey(line.text)]
    if (!translation) continue
    const current = line.translation
    const ours = owned.get(line)
    if (current && current !== ours) continue
    if (current !== translation) line.translation = translation
    owned.set(line, translation)
    applied += 1
  }
  return applied
}

export function clearOwnedTranslations(lines, owned) {
  for (const line of lines ?? []) {
    if (!line || !owned.has(line)) continue
    if (line.translation === owned.get(line)) line.translation = ""
    owned.delete(line)
  }
}

export function hasForeignTranslations(lines, owned) {
  return (lines ?? []).some((line) => line?.translation && line.translation !== owned.get(line))
}

export function createPersistentCache(storage, limit = 300) {
  const prefix = "amt:v1:"
  const indexKey = `${prefix}index`
  const readIndex = () => {
    try {
      return JSON.parse(storage.getItem(indexKey) || "[]")
    } catch {
      return []
    }
  }
  return {
    get(songId, language) {
      try {
        return JSON.parse(storage.getItem(`${prefix}${songId}|${language}`) || "null")
      } catch {
        return null
      }
    },
    set(songId, language, translationsByKey) {
      const key = `${songId}|${language}`
      const index = readIndex().filter((entry) => entry !== key)
      index.push(key)
      while (index.length > limit) storage.removeItem(`${prefix}${index.shift()}`)
      try {
        storage.setItem(`${prefix}${key}`, JSON.stringify(translationsByKey))
        storage.setItem(indexKey, JSON.stringify(index))
      } catch {}
    },
  }
}

function safeJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function createMemoryCache() {
  const store = new Map()
  return {
    lyrics(track) {
      return store.get(`lyrics|${cacheKey(track)}`) ?? null
    },
    storeLyrics(lyrics, track) {
      store.set(`lyrics|${cacheKey(track)}`, lyrics)
    },
    translations(track, language) {
      return store.get(`translation|${cacheKey(track)}|${language}`) ?? null
    },
    storeTranslations(translations, track, language) {
      store.set(`translation|${cacheKey(track)}|${language}`, translations)
    },
  }
}

// displayedLines returns the lines the player already shows; they are
// translated when LRCLIB has no lyrics for the track.
export async function loadTranslatedLyrics(
  track,
  settings,
  http,
  cache = createMemoryCache(),
  displayedLines = () => []
) {
  let lyrics = cache.lyrics(track)
  if (!lyrics) {
    try {
      lyrics = await fetchLyrics(track, http)
    } catch (error) {
      const shown = error instanceof LyricsError ? uniqueLines(displayedLines()) : []
      if (shown.length === 0) throw error
      lyrics = { lines: shown.map((text) => ({ time: null, text })), isSynced: false, isInstrumental: false }
    }
    cache.storeLyrics(lyrics, track)
  }
  if (lyrics.isInstrumental) return { lyrics, translations: {}, error: null }

  let translations = cache.translations(track, settings.language)
  let error = null
  if (!translations) {
    try {
      translations = await translateLines(
        lyrics.lines.map((line) => line.text),
        track,
        settings.language,
        settings.model,
        settings.apiKey,
        http
      )
      cache.storeTranslations(translations, track, settings.language)
    } catch (caught) {
      translations = {}
      error = caught.message
    }
  }
  return { lyrics, translations, error }
}

export function defaultSettings() {
  return {
    language: "English",
    model: DEFAULT_MODEL,
    apiKey: "",
    enabled: true,
  }
}

export const RISE_LYRICS_API = "https://exp-rise.cider.sh/api/v1/lyrics"
const NETEASE_API = "https://music.163.com/api/"

// Identifies Cider's lookups to lyric providers other than Apple Music:
// user-submitted lyrics and Musixmatch (both through Cider's Rise server) and
// NetEase. Translation requests are not matched.
export function thirdPartyLyricsRequest(url, body) {
  const href = String(url)
  if (href.startsWith(`${RISE_LYRICS_API}/user/`)) {
    const id = href.slice(`${RISE_LYRICS_API}/user/`.length).split(/[/?#]/)[0]
    return { provider: "user", id: decodeURIComponent(id), name: null }
  }
  if (href.startsWith(`${RISE_LYRICS_API}/mxm`)) {
    const json = typeof body === "string" ? safeJSON(body) : null
    return { provider: "musixmatch", id: json?.id != null ? String(json.id) : null, name: json?.name ?? null }
  }
  if (href.startsWith(NETEASE_API)) {
    let query = ""
    try {
      query = [...new URL(href).searchParams.values()].join(" ")
    } catch {}
    return { provider: "netease", id: null, name: null, query }
  }
  return null
}

// Text of each <p> line in a TTML lyrics document, in order.
export function ttmlLineTexts(ttml) {
  return [...String(ttml ?? "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) =>
    decodeEntities(match[1].replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
  )
}

// Pairs an original TTML with Cider's machine-translated copy of it.
export function pairsFromTranslatedTtml(original, translated) {
  const source = ttmlLineTexts(original)
  const target = ttmlLineTexts(translated)
  const pairs = []
  for (let i = 0; i < Math.min(source.length, target.length); i += 1) {
    if (source[i] && target[i] && source[i] !== target[i]) pairs.push({ line: source[i], translation: target[i] })
  }
  return pairs
}

const SCRIPTS = [
  ["ko", /\p{Script=Hangul}/u],
  ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["zh", /\p{Script=Han}/u],
  ["ru", /\p{Script=Cyrillic}/u],
  ["ar", /\p{Script=Arabic}/u],
  ["he", /\p{Script=Hebrew}/u],
  ["th", /\p{Script=Thai}/u],
  ["el", /\p{Script=Greek}/u],
  ["hi", /\p{Script=Devanagari}/u],
]

// Guesses the lyrics language from its script, since providers often label
// Korean or Japanese lyrics as English. Latin-script lyrics fall back to the
// provider's label. Japanese uses Han characters too, so any kana wins.
export function detectLanguage(lines, fallback = "en") {
  const counts = new Map()
  let letters = 0
  for (const char of lines.join("")) {
    if (!/\p{L}/u.test(char)) continue
    letters += 1
    for (const [code, pattern] of SCRIPTS) {
      if (pattern.test(char)) {
        counts.set(code, (counts.get(code) ?? 0) + 1)
        break
      }
    }
  }
  if ((counts.get("ja") ?? 0) > 0 && (counts.get("ja") + (counts.get("zh") ?? 0)) / letters >= 0.15) return "ja"
  let best = null
  for (const [code, count] of counts) if (!best || count > counts.get(best)) best = code
  return best && counts.get(best) / letters >= 0.15 ? best : (fallback || "en").split(/[-_]/)[0].toLowerCase()
}

// ISO 639-1 codes Cider uses to look up official translations.
export const LANGUAGE_CODES = {
  English: "en", Spanish: "es", French: "fr", German: "de", Italian: "it", Portuguese: "pt",
  Dutch: "nl", Swedish: "sv", Polish: "pl", Russian: "ru", Ukrainian: "uk", Turkish: "tr",
  Greek: "el", Arabic: "ar", Hebrew: "he", Hindi: "hi", Indonesian: "id", Vietnamese: "vi",
  Thai: "th", Japanese: "ja", Korean: "ko", "Chinese (Simplified)": "zh", Tagalog: "tl",
}

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch",
  "Swedish", "Polish", "Russian", "Ukrainian", "Turkish", "Greek", "Arabic",
  "Hebrew", "Hindi", "Indonesian", "Vietnamese", "Thai", "Japanese", "Korean",
  "Chinese (Simplified)", "Chinese (Traditional)", "Tagalog",
]
