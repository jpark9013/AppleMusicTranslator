const SETTINGS_KEY = "apple-music-translator.settings"
const STYLE_ID = "amt-translator-style"

function loadSettings() {
  try {
    const settings = { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }
    if (/claude|haiku/i.test(settings.model || "")) settings.model = DEFAULT_MODEL
    return settings
  } catch {
    return defaultSettings()
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

function browserHTTP(url, options = {}) {
  return fetch(url, options).then(async (response) => ({
    status: response.status,
    body: await response.text(),
  }))
}

function appleMusicStore() {
  return window.__PLUGINSYS__?.Stores?.appleMusicStore ?? null
}

function ciderStore(id) {
  return window.CiderApp?.store?._s?.get?.(id) ?? null
}

// Same id Cider uses as songId in its lyric store (catalog id for library songs).
function songId(item) {
  return (
    item?.songId ??
    item?.attributes?.playParams?.catalogId ??
    item?.relationships?.catalog?.data?.[0]?.id ??
    item?.id ??
    null
  )
}

function trackInfo(item) {
  return { name: item?.attributes?.name ?? "", artist: item?.attributes?.artistName ?? "" }
}

// The playing song first, then the next queued song so its translation is
// ready before it starts (Cider preloads the next song's lyrics).
function wantedSongs() {
  const songs = []
  const current = appleMusicStore()?.nowPlayingItem
  if (songId(current)) songs.push({ id: String(songId(current)), track: trackInfo(current) })
  const provider = ciderStore("provider-store")?.getCurrentProviderStore?.()
  const next = provider?.queue?.[(provider?.queuePosition ?? -1) + 1]?.track
  if (songId(next) && String(songId(next)) !== songs[0]?.id) {
    songs.push({ id: String(songId(next)), track: trackInfo(next) })
  }
  return songs
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))])
}

function nowPlayingTrack() {
  const item =
    appleMusicStore()?.nowPlayingItem ||
    window.CiderApp?.RPC?.nowPlayingAttributes ||
    window.MusicKit?.getInstance?.()?.nowPlayingItem ||
    null
  if (!item) return null
  const name = item.name || item.title || item.attributes?.name
  const artist = item.artistName || item.artist || item.attributes?.artistName
  if (!name || !artist) return null
  const millis = item.durationInMillis ?? item.attributes?.durationInMillis
  const duration = millis != null ? millis / 1000 : Number(item.duration || 0)
  return {
    name,
    artist,
    album: item.albumName || item.album || item.attributes?.albumName || "",
    duration: Number.isFinite(duration) ? duration : 0,
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
    .amt-translation {
      display: block;
      margin-top: 0.2em;
      font-size: 0.72em;
      font-weight: 600;
      opacity: 0.72;
      line-height: 1.25;
    }
    .amt-settings {
      display: grid;
      gap: 10px;
      min-width: 280px;
      padding: 12px;
      font: 13px/1.4 system-ui, sans-serif;
    }
    .amt-settings label { display: grid; gap: 4px; }
    .amt-settings input, .amt-settings select { width: 100%; box-sizing: border-box; }
    .amt-settings .amt-inline { display: flex; align-items: center; gap: 6px; }
    .amt-settings .amt-inline input { width: auto; }
    .amt-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
    .amt-status { opacity: 0.7; overflow-wrap: anywhere; }
  `
  document.head.appendChild(style)
}

function lyricNodes() {
  const selectors = [
    ".lyric-line",
    ".lyrics-line",
    "[data-lyric-line]",
    ".lyrics__line",
    ".lyricLine",
  ]
  for (const selector of selectors) {
    const nodes = [...document.querySelectorAll(selector)].filter(
      (node) => !node.classList.contains("amt-translation")
    )
    if (nodes.length > 0) return nodes
  }
  return []
}

// Reads only the original lyric, not Cider's own translation or ours. Cider
// puts each word in its own span, so words are joined with spaces.
function originalText(node) {
  const source = node.querySelector(".lyric-text")
  if (source) {
    const words = source.children.length > 0 ? [...source.children].map((child) => child.textContent) : [source.textContent]
    return decodeEntities(words.join(" ")).replace(/\s+/g, " ").trim()
  }
  const clone = node.cloneNode(true)
  clone.querySelectorAll(".amt-translation, .lyric-text-translated").forEach((child) => child.remove())
  return decodeEntities(clone.textContent).replace(/\s+/g, " ").trim()
}

function displayedLines() {
  return lyricNodes().map(originalText)
}

function displayedSignature() {
  return lineKey(displayedLines().join("\n"))
}

function decodeLyricEntities() {
  for (const node of lyricNodes()) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.data.includes("&") || text.parentElement?.closest(".amt-translation")) continue
      const decoded = decodeEntities(text.data)
      if (decoded !== text.data) text.data = decoded
    }
  }
}

function injectTranslations(translationsByKey) {
  ensureStyles()
  for (const node of lyricNodes()) {
    const translation = translationsByKey[lineKey(originalText(node))]
    let label = node.querySelector(":scope > .amt-translation")
    if (!translation) {
      label?.remove()
      continue
    }
    if (!label) {
      label = document.createElement("span")
      label.className = "amt-translation"
      node.appendChild(label)
    }
    if (label.textContent !== translation) label.textContent = translation
  }
}

function keyHint(apiKey) {
  return apiKey ? `Key saved, ending in …${apiKey.slice(-4)}` : "No API key yet. DeepSeek translations need one."
}

// Lists models, which costs no tokens, to confirm the key is accepted.
async function checkAPIKey(apiKey) {
  try {
    const response = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (response.ok) return "Key works."
    const body = await response.json().catch(() => null)
    return `Key rejected: ${body?.error?.message || `HTTP ${response.status}`}`
  } catch (error) {
    return `Could not reach DeepSeek: ${error.message}`
  }
}

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties)
  node.append(...children)
  return node
}

// The saved key is never written into the page; the form only shows its last
// four characters and takes a new key in an empty password field.
function createSettingsElement() {
  if (customElements.get("amt-translator-settings")) return
  customElements.define(
    "amt-translator-settings",
    class extends HTMLElement {
      connectedCallback() {
        const settings = loadSettings()
        const changed = () => this.dispatchEvent(new CustomEvent("amt-settings-changed", { bubbles: true }))
        const update = (patch) => {
          saveSettings({ ...loadSettings(), ...patch })
          changed()
        }

        const status = element("div", { className: "amt-status", textContent: keyHint(settings.apiKey) })
        const keyInput = element("input", { type: "password", placeholder: "sk-...", autocomplete: "off", spellcheck: false })
        const saveKey = element("button", { type: "button", textContent: "Save key" })
        const testKey = element("button", { type: "button", textContent: "Check key" })
        const removeKey = element("button", { type: "button", textContent: "Remove key" })

        saveKey.addEventListener("click", async () => {
          const apiKey = keyInput.value.trim()
          if (!apiKey) return
          keyInput.value = ""
          update({ apiKey })
          status.textContent = `${keyHint(apiKey)}. Checking…`
          status.textContent = `${keyHint(apiKey)}. ${await checkAPIKey(apiKey)}`
        })
        keyInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") saveKey.click()
        })
        testKey.addEventListener("click", async () => {
          const { apiKey } = loadSettings()
          if (!apiKey) return
          status.textContent = `${keyHint(apiKey)}. Checking…`
          status.textContent = `${keyHint(apiKey)}. ${await checkAPIKey(apiKey)}`
        })
        removeKey.addEventListener("click", () => {
          update({ apiKey: "" })
          status.textContent = keyHint("")
        })

        const language = element(
          "select",
          {},
          LANGUAGES.map((name) => element("option", { value: name, textContent: name, selected: name === settings.language }))
        )
        language.addEventListener("change", () => update({ language: language.value }))
        const model = element("input", { value: settings.model, spellcheck: false })
        model.addEventListener("change", () => update({ model: model.value.trim() || defaultSettings().model }))
        const enabled = element("input", { type: "checkbox", checked: settings.enabled })
        enabled.addEventListener("change", () => update({ enabled: enabled.checked }))

        this.replaceChildren(
          element("div", { className: "amt-settings" }, [
            element("strong", { textContent: "Lyrics Translator" }),
            element("label", {}, [document.createTextNode("DeepSeek API key"), keyInput]),
            element("div", { className: "amt-buttons" }, [saveKey, testKey, removeKey]),
            status,
            element("label", {}, [document.createTextNode("Translate to"), language]),
            element("label", {}, [document.createTextNode("Model"), model]),
            element("label", { className: "amt-inline" }, [enabled, document.createTextNode(" Show translations under lyrics")]),
          ])
        )
      }
    }
  )
}

function openSettings() {
  const appState = window.CiderApp?.appState
  if (appState) {
    appState.settingsDeepLinkPluginId = plugin.identifier
    appState.settingsDeepLinkTab = "plugins"
  }
  window.CiderApp?.dialogs?.settings?.("plugins")
}

// A top-bar button opens the settings in place, and the Plugins menu has an
// entry for the full settings page, so the key can be changed at any time.
function addSettingsEntryPoints() {
  const components = window.__PLUGINSYS__?.Components
  components?.CustomButtons?.addCustomButton?.({
    location: "chrome-top/right",
    title: "Lyrics Translator",
    element: "文A",
    menuElement: "amt-translator-settings",
  })
  components?.MainMenu?.addMenuItem?.({ label: "Lyrics Translator settings…", onClick: openSettings })
}

let started = false

function startPlugin(notifications) {
  if (started) return
  started = true
  ensureStyles()
  createSettingsElement()
  addSettingsEntryPoints()
  if (ciderStore("lyric-store")) {
    installLyricsGate()
    startStoreMode(notifications)
  }
  else startDOMMode(notifications)
}

const PROVIDER_TIMEOUT_MS = 5000

function notFoundResponse() {
  return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404, headers: { "Content-Type": "application/json" } })
}

async function fetchWithTimeout(realFetch, input, init, ms) {
  const controller = new AbortController()
  init?.signal?.addEventListener?.("abort", () => controller.abort(init.signal.reason), { once: true })
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await realFetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !init?.signal?.aborted) return new Response("", { status: 504 })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function appleHasLyrics(id) {
  try {
    const response = await withTimeout(
      window.CiderApp.v3(`/v1/catalog/$STOREFRONT/songs/${id}/lyrics`, {}, { skipLanguage: true, suppressServiceIssue: true }),
      PROVIDER_TIMEOUT_MS
    )
    return ttmlLineTexts(response?.data?.data?.[0]?.attributes?.ttml).some(Boolean)
  } catch {
    return false
  }
}

// Cider asks user-submitted lyrics, Apple Music, Musixmatch and NetEase in
// turn, waiting up to 35 s on each, and keeps going after Apple Music when its
// lyrics are unsynced. This answers the other providers with "not found" when
// Apple Music has lyrics for the song, and gives them 5 s otherwise.
function installLyricsGate() {
  const realFetch = window.fetch.bind(window)
  const appleChecks = new Map()
  const namesToIds = new Map()
  const checkApple = (id) => {
    if (!appleChecks.has(id)) appleChecks.set(id, appleHasLyrics(id))
    return appleChecks.get(id)
  }
  const idForQuery = (query) => {
    const key = lineKey(query)
    for (const [name, id] of namesToIds) if (name && key.includes(name)) return id
    return null
  }

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input)
    const request = thirdPartyLyricsRequest(url, init?.body)
    if (!request) return realFetch(input, init)
    // NetEase also supplies Chinese translations; leave it alone for those.
    if (request.provider === "netease" && String(window.CiderApp?.config?.getValue?.("lyrics.translationLanguage") ?? "").startsWith("zh")) {
      return realFetch(input, init)
    }
    if (request.id && request.name) namesToIds.set(lineKey(request.name), request.id)
    const id = request.id ?? idForQuery(request.query ?? "")
    if (id && (await checkApple(id))) return notFoundResponse()
    return fetchWithTimeout(realFetch, input, init, PROVIDER_TIMEOUT_MS)
  }
}

// Cider's Rise server translates Apple Music and user-submitted TTML with
// machine translation. A finished translation is cached there for everyone.
async function riseCachedTranslation(id, code, ttml) {
  try {
    const response = await withTimeout(fetch(`${RISE_LYRICS_API}/ttml/translations/${encodeURIComponent(id)}/${code}`), 1500)
    if (!response?.ok) return null
    const json = await response.json()
    const pairs = (json.translations ?? []).map((t) => ({ line: t.originalText, translation: t.translatedText }))
    return pairs.length ? pairs : null
  } catch {
    return null
  }
}

async function riseMachineTranslation(id, ttml, sourceLanguage, targetLanguage) {
  try {
    const response = await fetch(`${RISE_LYRICS_API}/ttml/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ttml, sourceLanguage, targetLanguage }),
    })
    if (!response.ok) return null
    const json = await response.json()
    if (json.status === "completed" && json.translatedTtml) {
      const pairs = pairsFromTranslatedTtml(ttml, json.translatedTtml)
      return pairs.length ? pairs : null
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const pairs = await riseCachedTranslation(id, targetLanguage, ttml)
      if (pairs) return pairs
    }
  } catch {}
  return null
}

// Cider 4: translations are written onto the lines in Cider's lyric store, so
// Cider renders them in its own translation slot for static, line-synced and
// word-synced lyrics alike. Cider's own translations always win.
function startStoreMode(notifications) {
  const store = ciderStore("lyric-store")
  const persistent = createPersistentCache(localStorage)
  const owned = new WeakMap()
  const translations = new Map()
  const jobs = new Map()
  let scheduled = false

  const entriesFor = (id) => store.lyricStore.filter((entry) => String(entry.songId) === id)

  const decodeLines = (entries) => {
    for (const entry of entries) {
      for (const line of entry.lyrics ?? []) {
        if (typeof line.text === "string" && line.text.includes("&")) line.text = decodeEntities(line.text)
        for (const word of line.words ?? []) {
          if (typeof word.text === "string" && word.text.includes("&")) word.text = decodeEntities(word.text)
        }
      }
    }
  }

  const sync = () => {
    scheduled = false
    const settings = loadSettings()
    if (!settings.enabled) {
      for (const entry of store.lyricStore) clearOwnedTranslations(entry.lyrics, owned)
      return
    }
    for (const song of wantedSongs()) {
      const entries = entriesFor(song.id)
      if (entries.length === 0) continue
      decodeLines(entries)
      const key = `${song.id}|${settings.language}`
      if (!jobs.has(key)) jobs.set(key, translateSong(song, entries, settings, key))
      const byKey = translations.get(key)
      if (byKey) for (const entry of entries) applyTranslationsToLines(entry.lyrics, byKey, owned)
    }
  }

  const scheduleSync = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(sync)
  }

  const useTranslations = (key, byKey) => {
    translations.set(key, byKey)
    scheduleSync()
  }

  async function officialTranslations(id, language) {
    const code = LANGUAGE_CODES[language]
    if (!code) return null
    const stored = store.getTranslations?.(id, code)
    if (stored?.translations?.length) {
      return stored.translations.map((t) => ({ line: t.matched_line, translation: t.translation }))
    }
    const lookup = window.CiderApp?.RPC?.getLyricsTranslations?.(id, code)
    const result = lookup ? await withTimeout(Promise.resolve(lookup).catch(() => null), 1500) : null
    return result?.ok && result.translations?.length ? result.translations : null
  }

  // Every song gets a translation request, whichever provider its lyrics came
  // from: official or already-made translations first, then DeepSeek, with
  // Cider's own machine translation started alongside as the fallback.
  async function translateSong(song, entries, settings, key) {
    const code = LANGUAGE_CODES[settings.language]
    const entry = entries[0]
    const lines = entry.lyrics.map((line) => decodeEntities(line.text ?? "").trim())
    const show = (source, pairsOrByKey, isPairs = true) => {
      const byKey = isPairs ? alignTranslations(lines, pairsOrByKey) : pairsOrByKey
      for (const current of entriesFor(song.id)) clearOwnedTranslations(current.lyrics, owned)
      persistent.set(song.id, settings.language, { source, translations: byKey })
      useTranslations(key, byKey)
    }

    // A replay shows the saved translation at once. Official translations
    // still replace a saved DeepSeek or machine translation.
    const saved = persistent.get(song.id, settings.language)
    const savedTranslations = saved?.translations ?? saved
    if (savedTranslations) useTranslations(key, savedTranslations)
    if (saved?.source === "official") return

    const sourceLanguage = detectLanguage(lines.filter(Boolean), entry.info?.language)
    if (code && sourceLanguage === code) return

    try {
      const official = await officialTranslations(song.id, settings.language)
      if (official) return show("official", official)
      if (savedTranslations || entries.some((current) => hasForeignTranslations(current.lyrics, owned))) return

      const machineReady = entry.ttml && code ? await riseCachedTranslation(song.id, code, entry.ttml) : null
      if (machineReady) return show("cider", machineReady)
      const machine = entry.ttml && code ? riseMachineTranslation(song.id, entry.ttml, sourceLanguage, code) : null

      try {
        const byKey = {}
        translations.set(key, byKey)
        const result = await streamTranslateLines(linesToTranslate(lines, settings.language), song.track, settings.language, settings.model, settings.apiKey, fetch, (line, translation) => {
          byKey[lineKey(line)] = translation
          scheduleSync()
        })
        Object.assign(byKey, translationsByLineKey(result))
        persistent.set(song.id, settings.language, { source: "deepseek", translations: byKey })
        scheduleSync()
      } catch (error) {
        const fallback = machine ? await machine : null
        if (fallback) return show("cider", fallback)
        throw error
      }
    } catch (error) {
      reportError(notifications, error.message)
      // Temporary failures are retried later; a declined song or a bad key is
      // not, so a failing song does not keep costing requests.
      if (error instanceof TranslationError && error.isRetryable) setTimeout(() => jobs.delete(key), 60_000)
    }
  }

  store.$subscribe?.(scheduleSync, { detached: true })
  setInterval(sync, 500)
  document.addEventListener("amt-settings-changed", () => {
    for (const entry of store.lyricStore) clearOwnedTranslations(entry.lyrics, owned)
    jobs.clear()
    translations.clear()
    sync()
  })
  sync()
}

// Older Cider builds without a lyric store: match LRCLIB lyrics to the lines
// on screen and add our own label under each one.
function startDOMMode(notifications) {
  const cache = createMemoryCache()
  let currentKey = ""
  let currentTranslations = {}
  let loading = false
  let waitingForLyricsView = ""
  // Lyrics on screen when the track changed belong to the previous track until
  // Cider swaps them, so the fallback must not translate them.
  let staleSignature = ""
  let currentTrackKey = ""
  const freshDisplayedLines = () => (displayedSignature() === staleSignature ? [] : displayedLines())

  const tick = async () => {
    decodeLyricEntities()
    const settings = loadSettings()
    if (!settings.enabled) {
      document.querySelectorAll(".amt-translation").forEach((node) => node.remove())
      return
    }
    const track = nowPlayingTrack()
    if (!track) return
    const key = `${cacheKey(track)}|${settings.language}|${settings.model}`
    if (key === waitingForLyricsView && lyricNodes().length > 0 && displayedSignature() !== staleSignature) {
      waitingForLyricsView = ""
      currentKey = ""
    }
    if (key !== currentKey && !loading) {
      loading = true
      if (currentTrackKey && currentTrackKey !== cacheKey(track)) staleSignature = displayedSignature()
      currentTrackKey = cacheKey(track)
      currentKey = key
      try {
        const result = await loadTranslatedLyrics(track, settings, browserHTTP, cache, freshDisplayedLines)
        currentTranslations = translationsByLineKey(result.translations)
        if (result.error) reportError(notifications, result.error)
      } catch (error) {
        currentTranslations = {}
        if (error instanceof LyricsError) waitingForLyricsView = key
        else reportError(notifications, error.message)
      } finally {
        loading = false
      }
    }
    injectTranslations(currentTranslations)
  }

  setInterval(tick, 400)
  document.addEventListener("amt-settings-changed", () => {
    currentKey = ""
    tick()
  })
  tick()
}

function reportError(notifications, message) {
  console.warn("[Lyrics Translator]", message)
  try {
    notifications?.notify?.({ title: "Lyrics Translator", message })
  } catch {}
}

// Cider 4 imports plugin.js as an ES module and calls setup() on its default
// export, skipping any plugin without pluginKitVersion.
const plugin = {
  name: "Lyrics Translator",
  identifier: "com.jpark9013.apple-music-translator",
  description: "Shows DeepSeek translations under each lyric line in Cider.",
  version: PLUGIN_VERSION,
  author: "jpark9013",
  repo: "https://github.com/jpark9013/AppleMusicTranslator",
  pluginKitVersion: 1,
  SettingsElement: "amt-translator-settings",
  setup({ Notifications } = {}) {
    startPlugin(Notifications)
  },
}

export default plugin
