import Foundation
import LyricsCore

func registerTranslationCacheTests() {
    let track = Track(name: "Song", artist: "Artist", album: "Album", duration: 180)

    @Sendable func makeCache() -> TranslationCache {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LyricsCoreTests-\(UUID().uuidString)", isDirectory: true)
        return TranslationCache(directory: dir)
    }

    TestRuntime.add("round trips lyrics") {
        let cache = makeCache()
        let lyrics = Lyrics(lines: [LyricLine(time: 1, text: "Hi")], isSynced: true, isInstrumental: false)
        try expect(cache.lyrics(for: track) == nil)
        cache.store(lyrics, for: track)
        try expect(cache.lyrics(for: track) == lyrics)
    }

    TestRuntime.add("keeps translations per language") {
        let cache = makeCache()
        cache.store(["Hola": "Hello"], for: track, language: "English")
        try expect(cache.translations(for: track, language: "English") == ["Hola": "Hello"])
        try expect(cache.translations(for: track, language: "French") == nil)
    }

    TestRuntime.add("key ignores case and album") {
        let cache = makeCache()
        cache.store(["a": "b"], for: track, language: "English")
        let sameSong = Track(name: "SONG", artist: "artist", album: "Deluxe Edition", duration: 181)
        try expect(cache.translations(for: sameSong, language: "English") == ["a": "b"])
    }

    TestRuntime.add("fnv1a matches reference values") {
        try expectEqual(TranslationCache.fnv1a(""), "cbf29ce484222325")
        try expectEqual(TranslationCache.fnv1a("a"), "af63dc4c8601ec8c")
    }
}
