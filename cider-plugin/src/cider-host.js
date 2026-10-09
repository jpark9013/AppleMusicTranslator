const SETTINGS_KEY = "apple-music-translator.settings"
const STYLE_ID = "amt-translator-style"

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }
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

function nowPlayingTrack() {
  const item =
    window.AppleMusic?.nowPlayingItem ||
    window.CiderApp?.store?.state?.currentTrack ||
    window.MusicKit?.getInstance?.()?.nowPlayingItem ||
    null
  if (!item) return null
  const name = item.name || item.title || item.attributes?.name
  const artist = item.artistName || item.artist || item.attributes?.artistName
  if (!name || !artist) return null
  const duration =
    item.durationInMillis != null
      ? item.durationInMillis / 1000
      : Number(item.duration || item.attributes?.durationInMillis / 1000 || 0)
  return {
    name,
    artist,
    album: item.albumName || item.album || item.attributes?.albumName || "",
    duration: Number.isFinite(duration) ? duration : 0,
  }
}

function currentPosition() {
  return (
    window.MusicKit?.getInstance?.()?.currentPlaybackTime ??
    window.CiderApp?.store?.state?.currentPlaybackTime ??
    0
  )
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
    .amt-settings input, .amt-settings select { width: 100%; }
    .amt-status { opacity: 0.7; }
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

function originalText(node) {
  const clone = node.cloneNode(true)
  clone.querySelectorAll(".amt-translation").forEach((child) => child.remove())
  return clone.textContent.replace(/\s+/g, " ").trim()
}

function injectTranslations(translations) {
  ensureStyles()
  for (const node of lyricNodes()) {
    const text = originalText(node)
    const translation = translations[text]
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

function createSettingsElement() {
  if (customElements.get("amt-translator-settings")) return
  customElements.define(
    "amt-translator-settings",
    class extends HTMLElement {
      connectedCallback() {
        const settings = loadSettings()
        this.innerHTML = `
          <form class="amt-settings">
            <strong>Lyrics Translator</strong>
            <label>Translate to
              <select name="language">${LANGUAGES.map(
                (language) => `<option ${language === settings.language ? "selected" : ""}>${language}</option>`
              ).join("")}</select>
            </label>
            <label>Anthropic API key
              <input name="apiKey" type="password" value="${settings.apiKey}" placeholder="sk-ant-..." />
            </label>
            <label>Model
              <input name="model" value="${settings.model}" />
            </label>
            <label><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""} /> Show translations under lyrics</label>
            <div class="amt-status">Translations appear under Cider's own lyric lines.</div>
          </form>
        `
        this.querySelector("form").addEventListener("change", () => {
          const form = new FormData(this.querySelector("form"))
          saveSettings({
            language: String(form.get("language") || "English"),
            apiKey: String(form.get("apiKey") || "").trim(),
            model: String(form.get("model") || "claude-haiku-5-5"),
            enabled: this.querySelector('[name="enabled"]').checked,
          })
          this.dispatchEvent(new CustomEvent("amt-settings-changed", { bubbles: true }))
        })
      }
    }
  )
}

function startPlugin() {
  ensureStyles()
  createSettingsElement()
  const cache = createMemoryCache()
  let currentKey = ""
  let currentTranslations = {}
  let loading = false

  const tick = async () => {
    const settings = loadSettings()
    if (!settings.enabled) {
      document.querySelectorAll(".amt-translation").forEach((node) => node.remove())
      return
    }
    const track = nowPlayingTrack()
    if (!track) return
    const key = `${cacheKey(track)}|${settings.language}|${settings.model}`
    if (key !== currentKey && !loading) {
      loading = true
      currentKey = key
      try {
        const result = await loadTranslatedLyrics(track, settings, browserHTTP, cache)
        currentTranslations = result.translations
      } catch {
        currentTranslations = {}
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

const plugin = {
  name: "Lyrics Translator",
  identifier: "com.jpark9013.apple-music-translator",
  description: "Shows Claude translations under each lyric line in Cider.",
  version: "0.1.0",
  author: "jpark9013",
  repo: "https://github.com/jpark9013/AppleMusicTranslator",
  SettingsElement: "amt-translator-settings",
  setup() {
    startPlugin()
  },
}

if (typeof window !== "undefined") {
  window.AppleMusicTranslatorPlugin = plugin
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPlugin, { once: true })
  } else {
    startPlugin()
  }
}

if (typeof module !== "undefined") {
  module.exports = plugin
}
