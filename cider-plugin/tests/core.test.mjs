import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  LyricsError,
  TranslationError,
  activeLineIndex,
  alignTranslations,
  applyTranslationsToLines,
  bestMatch,
  cacheKey,
  clearOwnedTranslations,
  createMemoryCache,
  createPersistentCache,
  createSSEParser,
  createTranslationStreamParser,
  decodeEntities,
  detectLanguage,
  fetchLyrics,
  hasForeignTranslations,
  lineKey,
  linesToTranslate,
  loadTranslatedLyrics,
  parseLRC,
  pairsFromTranslatedTtml,
  parseTranslations,
  requestBody,
  simplifiedTitle,
  streamTranslateLines,
  thirdPartyLyricsRequest,
  ttmlLineTexts,
  translationsByLineKey,
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

  function reply(translations) {
    return {
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify({ translations }) } }],
      },
    }
  }

  it("throws without an API key and does not call the network", async () => {
    const http = fakeHTTP([])
    await assert.rejects(
      () => translateLines(["안녕"], song, "English", "deepseek-flash", "", http),
      TranslationError
    )
    assert.equal(http.requests.length, 0)
  })

  it("sends each distinct line once and maps the results", async () => {
    const http = fakeHTTP([reply(["Hello", "Goodbye"])])
    const result = await translateLines(["안녕", "", "잘가", "안녕"], song, "English", "deepseek-flash", "test-key", http)
    assert.deepEqual(result, { 안녕: "Hello", 잘가: "Goodbye" })
    const body = JSON.parse(http.requests[0].options.body)
    assert.equal(body.model, "deepseek-flash")
    assert.equal(body.messages[0].role, "system")
    assert.match(body.messages[0].content, /exactly 2 strings/)
    assert.match(body.messages[1].content, /\["안녕","잘가"\]/)
    assert.equal(http.requests[0].options.headers.Authorization, "Bearer test-key")
  })

  it("ignores thinking blocks and retries a mismatched line count", async () => {
    const http = fakeHTTP([
      reply(["only one"]),
      reply(["A", "B"]),
    ])
    const result = await translateLines(["a", "b"], song, "English", "deepseek-flash", "key", http)
    assert.deepEqual(result, { a: "A", b: "B" })
    assert.equal(http.requests.length, 2)
  })

  it("does not retry client errors", async () => {
    const http = fakeHTTP([
      { status: 401, body: { error: { message: "invalid x-api-key" } } },
      reply(["never"]),
    ])
    await assert.rejects(
      () => translateLines(["a"], song, "English", "deepseek-flash", "key", http),
      (error) => error instanceof TranslationError && error.code === 401
    )
    assert.equal(http.requests.length, 1)
  })

  it("parses JSON wrapped in code fences", () => {
    assert.deepEqual(parseTranslations('```json\n{"translations": [" Hello ", ""]}\n```'), ["Hello", ""])
    assert.equal(parseTranslations("Sorry, I can't help with that."), null)
  })

  it("turns off reasoning, which cost most of the output tokens", () => {
    assert.deepEqual(requestBody(["a"], song, "English", "deepseek-flash").thinking, { type: "disabled" })
  })

  it("builds a request body with the song title", () => {
    const body = requestBody(["안녕"], song, "English", "deepseek-flash")
    assert.equal(body.max_tokens, 8192)
    assert.equal(body.messages[0].role, "system")
    assert.match(body.messages[1].content, /Song: "Song" by Artist/)
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
    const loaded = await loadTranslatedLyrics(song, { language: "English", model: "deepseek-flash", apiKey: "" }, first, cache)
    assert.equal(loaded.lyrics.lines[0].text, "Hi")
    assert.match(loaded.error, /API key/)

    const second = fakeHTTP([])
    const again = await loadTranslatedLyrics(song, { language: "English", model: "deepseek-flash", apiKey: "" }, second, cache)
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

describe("line matching", () => {
  it("matches Cider's unspaced word spans to LRCLIB lines", () => {
    assert.equal(lineKey("오늘 날씨가 정말 좋다"), lineKey("오늘날씨가정말좋다"))
    assert.equal(lineKey("I Love  You"), lineKey("iloveyou"))
  })

  it("indexes translations by line key and drops empty ones", () => {
    const byKey = translationsByLineKey({ "오늘 날씨": "Today's weather", "oh oh": "" })
    assert.deepEqual(byKey, { [lineKey("오늘날씨")]: "Today's weather" })
  })
})

describe("decodeEntities", () => {
  it("decodes named and numeric entities from provider lyrics", () => {
    assert.equal(decodeEntities("제목 &#8211; 가수 &amp; 친구"), "제목 – 가수 & 친구")
    assert.equal(decodeEntities("&#x2013; &quot;hi&quot; &lt;3"), '– "hi" <3')
  })

  it("leaves unknown entities and plain ampersands alone", () => {
    assert.equal(decodeEntities("R&B &bogus; &"), "R&B &bogus; &")
  })

  it("lets escaped DOM text match LRCLIB text", () => {
    assert.equal(lineKey("가수&amp;친구"), lineKey("가수 & 친구"))
  })
})

describe("displayed-lyrics fallback", () => {
  const reply = (lines) => ({
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify({ translations: lines.map((l) => `T:${l}`) }) } }] },
  })
  const settings = { language: "English", model: "m", apiKey: "k" }

  it("translates the lines on screen when LRCLIB has nothing", async () => {
    const http = fakeHTTP([{ status: 404, body: {} }, { status: 200, body: [] }, { status: 200, body: [] }, reply(["가", "나"])])
    const result = await loadTranslatedLyrics(track, settings, http, createMemoryCache(), () => ["가", "나", "가", ""])
    assert.deepEqual(result.translations, { 가: "T:가", 나: "T:나" })
    assert.equal(result.error, null)
  })

  it("still throws LyricsError when nothing is on screen", async () => {
    const http = fakeHTTP([{ status: 404, body: {} }])
    await assert.rejects(loadTranslatedLyrics(track, settings, http, createMemoryCache(), () => []), LyricsError)
  })
})

function sseResponse(text, chunkSize = 7) {
  const events = []
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push({ choices: [{ delta: { content: text.slice(i, i + chunkSize) } }] })
  }
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(body)
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11))
      controller.close()
    },
  }), { status: 200 })
}

describe("streaming translation", () => {
  it("emits each finished string from a partial reply", () => {
    const parser = createTranslationStreamParser()
    assert.deepEqual(parser.push('{"transl'), [])
    assert.deepEqual(parser.push('ations": ["One \\"q\\"", "Tw'), [{ index: 0, text: 'One "q"' }])
    assert.deepEqual(parser.push('o", ""]}'), [{ index: 1, text: "Two" }, { index: 2, text: "" }])
    assert.equal(parser.count, 3)
  })

  it("ignores strings after the array closes", () => {
    const parser = createTranslationStreamParser()
    assert.deepEqual(parser.push('{"translations": ["a"], "note": "x"}').map((item) => item.text), ["a"])
  })

  it("reads text deltas from split server-sent events and surfaces stream errors", () => {
    const push = createSSEParser()
    assert.deepEqual(push('data: {"choices":[{"delta":{"content":"ab"}}]}\n'), [])
    assert.deepEqual(push("\n"), ["ab"])
    assert.throws(() => push('data: {"error":{"message":"busy","type":"overloaded_error"}}\n\n'), /busy/)
  })

  it("reports lines as they stream in", async () => {
    const seen = []
    const fetchImpl = async (url, options) => {
      assert.equal(JSON.parse(options.body).stream, true)
      return sseResponse('{"translations": ["Hello", "", "World"]}')
    }
    const result = await streamTranslateLines(["안녕", "오", "세상", "안녕"], track, "English", "m", "k", fetchImpl, (line, text) => seen.push([line, text]))
    assert.deepEqual(seen, [["안녕", "Hello"], ["세상", "World"]])
    assert.deepEqual(result, { 안녕: "Hello", 오: "", 세상: "World" })
  })

  it("retries without streaming when the line count is wrong", async () => {
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push(JSON.parse(options.body).stream === true)
      if (calls.length === 1) return sseResponse('{"translations": ["only one"]}')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"translations": ["A", "B"]}' } }] }), { status: 200 })
    }
    const result = await streamTranslateLines(["a", "b"], track, "English", "m", "k", fetchImpl)
    assert.deepEqual(calls, [true, false])
    assert.deepEqual(result, { a: "A", b: "B" })
  })

  it("does not retry client errors", async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{"error":{"message":"bad key"}}', { status: 401 })
    }
    await assert.rejects(streamTranslateLines(["a"], track, "English", "m", "k", fetchImpl), /bad key/)
    assert.equal(calls, 1)
  })
})

describe("Cider lyric lines", () => {
  it("fills empty lines, keeps Cider's translations, and updates its own", () => {
    const owned = new WeakMap()
    const lines = [{ text: "오늘 날씨" }, { text: "官方" , translation: "Official" }, { text: "&amp; 또" , translation: "" }]
    assert.equal(applyTranslationsToLines(lines, { [lineKey("오늘날씨")]: "Mine", [lineKey("官方")]: "Claude", [lineKey("& 또")]: "And" }, owned), 2)
    assert.deepEqual(lines.map((line) => line.translation), ["Mine", "Official", "And"])
    assert.equal(hasForeignTranslations(lines, owned), true)
    applyTranslationsToLines(lines, { [lineKey("오늘날씨")]: "Changed" }, owned)
    assert.equal(lines[0].translation, "Changed")
    clearOwnedTranslations(lines, owned)
    assert.deepEqual(lines.map((line) => line.translation), ["", "Official", ""])
  })

  it("persists translations and evicts the oldest songs", () => {
    const map = new Map()
    const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }
    const cache = createPersistentCache(storage, 2)
    cache.set("1", "English", { a: "A" })
    cache.set("2", "English", { b: "B" })
    cache.set("3", "English", { c: "C" })
    assert.equal(cache.get("1", "English"), null)
    assert.deepEqual(cache.get("3", "English"), { c: "C" })
  })
})

describe("official translations", () => {
  it("ignores punctuation and maps a joined official line onto the first displayed line", () => {
    const lines = ["같이 갈래", "어디든 좋아", "천천히 걷자", "Hello again", "마지막 줄"]
    const pairs = [
      { line: "같이 갈래?", translation: "Shall we go together?" },
      { line: "어디든 좋아, 천천히 걷자", translation: "Anywhere is fine, let's walk slowly" },
      { line: "Hello again", translation: "" },
    ]
    assert.deepEqual(alignTranslations(lines, pairs), {
      [lineKey("같이 갈래")]: "Shall we go together?",
      [lineKey("어디든 좋아")]: "Anywhere is fine, let's walk slowly",
    })
  })
})

describe("declined translations", () => {
  it("does not retry when the stream answers in prose", async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return sseResponse("I can't translate that, but here is a summary instead.")
    }
    await assert.rejects(
      streamTranslateLines(["a", "b"], track, "English", "m", "k", fetchImpl),
      (error) => error.code === "declined" && !error.isRetryable
    )
    assert.equal(calls, 1)
  })

  it("does not retry a prose reply without streaming either", async () => {
    const http = fakeHTTP([{ status: 200, body: { choices: [{ message: { content: "No thanks." } }] } }])
    await assert.rejects(translateLines(["a"], track, "English", "m", "k", http), (error) => error.code === "declined")
    assert.equal(http.requests.length, 1)
  })
})

describe("Cider provider lookups", () => {
  const rise = "https://exp-rise.cider.sh/api/v1/lyrics"

  it("recognizes user-submitted, Musixmatch and NetEase requests", () => {
    assert.deepEqual(thirdPartyLyricsRequest(`${rise}/user/123/all`), { provider: "user", id: "123", name: null })
    assert.deepEqual(thirdPartyLyricsRequest(`${rise}/mxm`, JSON.stringify({ id: 9, name: "Song" })), { provider: "musixmatch", id: "9", name: "Song" })
    assert.equal(thirdPartyLyricsRequest("https://music.163.com/api/search/get?s=Song%20Artist").query, "Song Artist")
  })

  it("leaves translation and Apple Music requests alone", () => {
    assert.equal(thirdPartyLyricsRequest(`${rise}/translations`), null)
    assert.equal(thirdPartyLyricsRequest(`${rise}/ttml/translate`), null)
    assert.equal(thirdPartyLyricsRequest("https://amp-api.music.apple.com/v1/catalog/us/songs/1/lyrics"), null)
  })
})

describe("TTML helpers", () => {
  const original = '<tt><body><div><p begin="1">하나 &amp; 둘</p><p>셋<br/>넷</p><p>Same</p></div></body></tt>'
  const translated = '<tt><body><div><p begin="1">One &amp; two</p><p>Three four</p><p>Same</p></div></body></tt>'

  it("reads line text without markup", () => {
    assert.deepEqual(ttmlLineTexts(original), ["하나 & 둘", "셋 넷", "Same"])
  })

  it("pairs translated lines and drops unchanged ones", () => {
    assert.deepEqual(pairsFromTranslatedTtml(original, translated), [
      { line: "하나 & 둘", translation: "One & two" },
      { line: "셋 넷", translation: "Three four" },
    ])
  })
})

describe("detectLanguage", () => {
  it("uses the script instead of a wrong provider label", () => {
    assert.equal(detectLanguage(["오늘 날씨가 정말 좋다", "See you soon"], "en"), "ko")
    assert.equal(detectLanguage(["今日はいい天気", "また明日"], "en"), "ja")
    assert.equal(detectLanguage(["今天天气很好"], "en"), "zh")
  })

  it("falls back to the label for Latin-script lyrics", () => {
    assert.equal(detectLanguage(["Te quiero mucho"], "es_US"), "es")
    assert.equal(detectLanguage(["Hello there"], ""), "en")
  })
})

describe("linesToTranslate", () => {
  const lines = ["오늘 날씨가 좋다", "Hold on tight", "oh oh oh", "La la la", "오늘 날씨가 좋다", "", "Yeah, yeah!", "Café ☕"]

  it("skips vocalizations and English lines when translating into English", () => {
    assert.deepEqual(linesToTranslate(lines, "English"), ["오늘 날씨가 좋다"])
  })

  it("keeps English lines for other target languages", () => {
    assert.deepEqual(linesToTranslate(lines, "Spanish"), ["오늘 날씨가 좋다", "Hold on tight", "Café ☕"])
  })
})

