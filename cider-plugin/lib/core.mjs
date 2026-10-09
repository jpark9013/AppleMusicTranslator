const USER_AGENT = "AppleMusicTranslator/0.1 (https://github.com/jpark9013/AppleMusicTranslator)"
const LRCLIB_BASE = "https://lrclib.net/api"
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
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

export function requestBody(lines, track, language, model) {
  return {
    model,
    max_tokens: 8192,
    system: systemPrompt(language, lines.length),
    messages: [
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
  if (!apiKey) throw new TranslationError("missing-key", "Add your Anthropic API key to see translations.")
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

async function sendTranslation(lines, track, language, model, apiKey, http) {
  const { status, body } = await http(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody(lines, track, language, model)),
  })
  const json = safeJSON(body)
  if (status !== 200) {
    throw new TranslationError(status, json?.error?.message || body || "Unknown error")
  }
  const text = (json?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
  const translations = parseTranslations(text)
  if (!translations || translations.length !== lines.length) {
    throw new TranslationError("malformed", "Translation failed: the model returned an unexpected response.")
  }
  return translations
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

export async function loadTranslatedLyrics(track, settings, http, cache = createMemoryCache()) {
  let lyrics = cache.lyrics(track)
  if (!lyrics) {
    lyrics = await fetchLyrics(track, http)
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
    model: "claude-haiku-5-5",
    apiKey: "",
    enabled: true,
  }
}

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch",
  "Swedish", "Polish", "Russian", "Ukrainian", "Turkish", "Greek", "Arabic",
  "Hebrew", "Hindi", "Indonesian", "Vietnamese", "Thai", "Japanese", "Korean",
  "Chinese (Simplified)", "Chinese (Traditional)", "Tagalog",
]
