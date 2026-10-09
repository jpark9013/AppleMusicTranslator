import Foundation
import LyricsCore

func registerLyricsServiceTests() {
    let track = Track(name: "Song (feat. Someone)", artist: "Artist", album: "Album", duration: 200.4)

    TestRuntime.add("uses exact match with all fields") {
        let http = FakeHTTP([(200, json(["syncedLyrics": "[00:01.00] Hi", "duration": 200]))])
        let lyrics = try await LyricsService(http: http.client).fetch(for: track)

        try expectEqual(lyrics, Lyrics(lines: [LyricLine(time: 1, text: "Hi")], isSynced: true, isInstrumental: false))
        let query = await http.queryItems(at: 0)
        try expectEqual(query, [
            "track_name": "Song (feat. Someone)",
            "artist_name": "Artist",
            "album_name": "Album",
            "duration": "200",
        ])
        let request = await http.requests[0]
        try expect(request.url?.path.hasSuffix("/api/get") == true)
        try expect(request.value(forHTTPHeaderField: "User-Agent")?.contains("AppleMusicTranslator") == true)
    }

    TestRuntime.add("falls back to search and matches duration") {
        let results: [[String: Any]] = [
            ["duration": 120, "syncedLyrics": "[00:01.00] Wrong song"],
            ["duration": 202, "syncedLyrics": "[00:01.00] Right song"],
        ]
        let http = FakeHTTP([(404, "{}"), (200, json(results))])
        let lyrics = try await LyricsService(http: http.client).fetch(for: track)

        try expect(lyrics.lines.first?.text == "Right song")
        let request = await http.requests[1]
        try expect(request.url?.path.hasSuffix("/api/search") == true)
    }

    TestRuntime.add("retries search with simplified title") {
        let http = FakeHTTP([
            (404, "{}"),
            (200, "[]"),
            (200, json([["duration": 200, "plainLyrics": "Line one\nLine two"]])),
        ])
        let lyrics = try await LyricsService(http: http.client).fetch(for: track)

        try expectEqual(lyrics.isSynced, false)
        try expectEqual(lyrics.lines.map(\.text), ["Line one", "Line two"])
        let query = await http.queryItems(at: 2)
        try expect(query["track_name"] == "Song")
    }

    TestRuntime.add("throws not found when only mismatched durations exist") {
        let mismatched = json([["duration": 90, "syncedLyrics": "[00:01.00] Nope"]])
        let http = FakeHTTP([(404, "{}"), (200, mismatched), (200, mismatched)])
        try await expectThrows(LyricsError.notFound) {
            _ = try await LyricsService(http: http.client).fetch(for: track)
        }
    }

    TestRuntime.add("reports instrumental tracks") {
        let http = FakeHTTP([(200, json(["instrumental": true]))])
        let lyrics = try await LyricsService(http: http.client).fetch(for: track)
        try expect(lyrics.isInstrumental)
        try expect(lyrics.lines.isEmpty)
    }

    for (input, expected) in [
        ("Song (feat. Someone)", "Song"),
        ("Song [Remastered 2011]", "Song"),
        ("Song - Live at Wembley", "Song"),
        ("Plain Title", "Plain Title"),
        ("(Intro)", "(Intro)"),
    ] {
        TestRuntime.add("simplifies title \(input)") {
            try expectEqual(LyricsService.simplifiedTitle(input), expected)
        }
    }
}
