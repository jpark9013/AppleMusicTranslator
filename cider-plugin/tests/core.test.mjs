import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  LyricsError,
  TranslationError,
  activeLineIndex,
  bestMatch,
  cacheKey,
  createMemoryCache,
  fetchLyrics,
  loadTranslatedLyrics,
  parseLRC,
  parseTranslations,
  requestBody,
  simplifiedTitle,
  translateLines,
  uniqueLines,
} from "../lib/core.mjs"

function fakeHTTP(replies) {
  const requests = []
  const queue = [...replies]
  const http = async (url, options = {}) => {
    requests.push({ url, options })
    const next = queue.shift()
    if (!next) return { status: 404, body: "{}" }
    return { status: next.status, body: typeof next.body === "string" ? next.body : JSON.stringify(next.body) }
  }
  http.requests = requests
  return http
}

const track = { name: "Song (feat. Someone)", artist: "Artist", album: "Album", duration: 200.4 }

describe("parseLRC", () => {
  it("parses timestamps and text", () => {
    assert.deepEqual(
      parseLRC("[00:01.50] First line\n[00:04.25]Second line\n[01:02.123] Third line"),
      [
        { time: 1.5, text: "First line" },
        { time: 4.25, text: "Second line" },
        { time: 62.123, text: "Third line" },
      ]
    )
  })

  it("ignores metadata tags", () => {
    assert.deepEqual(parseLRC("[ar: Artist]\n[ti: Title]\n\n[00:10.00] Only line"), [
      { time: 10, text: "Only line" },
    ])
  })

  it("expands multiple timestamps and keeps file order for ties", () => {
    const lines = parseLRC("[00:05.00][00:20.00] Chorus\n[00:10.00] Verse\n[00:01.00] A\n[00:01.00] B")
    assert.deepEqual(lines.map((line) => line.text), ["A", "B", "Chorus", "Verse", "Chorus"])
    assert.deepEqual(lines.map((line) => line.time), [1, 1, 5, 10, 20])
  })

  it("accepts colon-separated hundredths and Korean text", () => {
    assert.deepEqual(parseLRC("[00:07:50] Colon\n[00:12.00] 너의 집 앞에서"), [
      { time: 7.5, text: "Colon" },
      { time: 12, text: "너의 집 앞에서" },
    ])
  })
})

describe("activeLineIndex", () => {
  const lyrics = {
    isSynced: true,
    lines: [
      { time: 5, text: "a" },
      { time: 10, text: "b" },
      { time: 15, text: "c" },
    ],
  }

  it("is null before the first line and for unsynced lyrics", () => {
    assert.equal(activeLineIndex(lyrics, 2), null)
    assert.equal(activeLineIndex({ isSynced: false, lines: lyrics.lines }, 30), null)
  })

  it("picks the latest started line and can lead slightly", () => {
    assert.equal(activeLineIndex(lyrics, 5), 0)
    assert.equal(activeLineIndex(lyrics, 12), 1)
    assert.equal(activeLineIndex(lyrics, 9.8, 0.25), 1)
  })
})

describe("title helpers", () => {
  it("simplifies featured, remastered, and live titles", () => {
    assert.equal(simplifiedTitle("Song (feat. Someone)"), "Song")
    assert.equal(simplifiedTitle("Song [Remastered 2011]"), "Song")
    assert.equal(simplifiedTitle("Song - Live at Wembley"), "Song")
    assert.equal(simplifiedTitle("Plain Title"), "Plain Title")
    assert.equal(simplifiedTitle("(Intro)"), "(Intro)")
  })

  it("uses a case-insensitive artist|title cache key", () => {
    assert.equal(cacheKey(track), "artist|song (feat. someone)")
  })
})

describe("fetchLyrics", () => {
  it("uses an exact match when LRCLIB has synced lyrics", async () => {
    const http = fakeHTTP([{ status: 200, body: { syncedLyrics: "[00:01.00] Hi", duration: 200 } }])
    const lyrics = await fetchLyrics(track, http)
    assert.deepEqual(lyrics, { lines: [{ time: 1, text: "Hi" }], isSynced: true, isInstrumental: false })
    assert.match(http.requests[0].url, /\/api\/get\?/)
    assert.match(http.requests[0].url, /duration=200/)
  })

  it("falls back to search and prefers the matching duration", async () => {
    const http = fakeHTTP([
      { status: 404, body: {} },
      {
        status: 200,
        body: [
          { duration: 120, syncedLyrics: "[00:01.00] Wrong song" },
          { duration: 202, syncedLyrics: "[00:01.00] Right song" },
        ],
      },
    ])
    const lyrics = await fetchLyrics(track, http)
    assert.equal(lyrics.lines[0].text, "Right song")
    assert.match(http.requests[1].url, /\/api\/search\?/)
  })

  it("retries search with a simplified title", async () => {
    const http = fakeHTTP([
      { status: 404, body: {} },
      { status: 200, body: [] },
      { status: 200, body: [{ duration: 200, plainLyrics: "Line one\nLine two" }] },
    ])
    const lyrics = await fetchLyrics(track, http)
    assert.equal(lyrics.isSynced, false)
    assert.deepEqual(lyrics.lines.map((line) => line.text), ["Line one", "Line two"])
    assert.match(decodeURIComponent(http.requests[2].url), /track_name=Song(?:&|$)/)
  })

  it("throws when only mismatched durations exist", async () => {
    const mismatched = [{ status: 200, body: [{ duration: 90, syncedLyrics: "[00:01.00] Nope" }] }]
    const http = fakeHTTP([{ status: 404, body: {} }, ...mismatched, ...mismatched])
    await assert.rejects(() => fetchLyrics(track, http), LyricsError)
  })

  it("reports instrumental tracks", async () => {
    const http = fakeHTTP([{ status: 200, body: { instrumental: true } }])
    const lyrics = await fetchLyrics(track, http)
    assert.equal(lyrics.isInstrumental, true)
    assert.deepEqual(lyrics.lines, [])
  })
})

describe("translation", () => {
  const song = { name: "Song", artist: "Artist", album: "Album", duration: 180 }

  function reply(translations, extraBlocks = []) {
    return {
      status: 200,
      body: {
        content: [...extraBlocks, { type: "text", text: JSON.stringify({ translations }) }],
      },
    }
  }

  it("throws without an API key and does not call the network", async () => {
    const http = fakeHTTP([])
    await assert.rejects(
      () => translateLines(["안녕"], song, "English", "claude-haiku-5-5", "", http),
      TranslationError
    )
    assert.equal(http.requests.length, 0)
  })

  it("sends each distinct line once and maps the results", async () => {
    const http = fakeHTTP([reply(["Hello", "Goodbye"])])
    const result = await translateLines(["안녕", "", "잘가", "안녕"], song, "English", "claude-haiku-5-5", "test-key", http)
    assert.deepEqual(result, { 안녕: "Hello", 잘가: "Goodbye" })
    const body = JSON.parse(http.requests[0].options.body)
    assert.equal(body.model, "claude-haiku-5-5")
    assert.match(body.messages[0].content, /\["안녕","잘가"\]/)
    assert.match(body.system, /exactly 2 strings/)
    assert.equal(http.requests[0].options.headers["x-api-key"], "test-key")
  })

  it("ignores thinking blocks and retries a mismatched line count", async () => {
    const http = fakeHTTP([
      reply(["only one"]),
      reply(["A", "B"], [{ type: "thinking", thinking: '{"translations":["wrong"]}' }]),
    ])
    const result = await translateLines(["a", "b"], song, "English", "claude-haiku-5-5", "key", http)
    assert.deepEqual(result, { a: "A", b: "B" })
    assert.equal(http.requests.length, 2)
  })

  it("does not retry client errors", async () => {
    const http = fakeHTTP([
      { status: 401, body: { error: { message: "invalid x-api-key" } } },
      reply(["never"]),
    ])
    await assert.rejects(
      () => translateLines(["a"], song, "English", "claude-haiku-5-5", "key", http),
      (error) => error instanceof TranslationError && error.code === 401
    )
    assert.equal(http.requests.length, 1)
  })

  it("parses JSON wrapped in code fences", () => {
    assert.deepEqual(parseTranslations('```json\n{"translations": [" Hello ", ""]}\n```'), ["Hello", ""])
    assert.equal(parseTranslations("Sorry, I can't help with that."), null)
  })

  it("builds a request body with the song title", () => {
    const body = requestBody(["안녕"], song, "English", "claude-haiku-5-5")
    assert.equal(body.max_tokens, 8192)
    assert.match(body.messages[0].content, /Song: "Song" by Artist/)
  })
})

describe("cache and pipeline", () => {
  it("keeps translations per language and ignores album/case", () => {
    const cache = createMemoryCache()
    const song = { name: "Song", artist: "Artist", album: "Album", duration: 180 }
    cache.storeTranslations({ Hola: "Hello" }, song, "English")
    assert.deepEqual(cache.translations(song, "English"), { Hola: "Hello" })
    assert.equal(cache.translations(song, "French"), null)
    assert.deepEqual(
      cache.translations({ name: "SONG", artist: "artist", album: "Deluxe", duration: 181 }, "English"),
      { Hola: "Hello" }
    )
  })

  it("reuses cached lyrics so a later play skips LRCLIB", async () => {
    const song = { name: "Song", artist: "Artist", album: "Album", duration: 180 }
    const cache = createMemoryCache()
    const first = fakeHTTP([{ status: 200, body: { syncedLyrics: "[00:01.00] Hi" } }])
    const loaded = await loadTranslatedLyrics(song, { language: "English", model: "claude-haiku-5-5", apiKey: "" }, first, cache)
    assert.equal(loaded.lyrics.lines[0].text, "Hi")
    assert.match(loaded.error, /API key/)

    const second = fakeHTTP([])
    const again = await loadTranslatedLyrics(song, { language: "English", model: "claude-haiku-5-5", apiKey: "" }, second, cache)
    assert.equal(again.lyrics.lines[0].text, "Hi")
    assert.equal(second.requests.length, 0)
  })

  it("filters empty unique lines", () => {
    assert.deepEqual(uniqueLines(["a", "", "a", "b"]), ["a", "b"])
  })

  it("prefers synced lyrics when choosing a search match", () => {
    const match = bestMatch(
      [
        { duration: 180, plainLyrics: "plain" },
        { duration: 181, syncedLyrics: "[00:01.00] synced" },
      ],
      180
    )
    assert.equal(match.syncedLyrics, "[00:01.00] synced")
  })
})
