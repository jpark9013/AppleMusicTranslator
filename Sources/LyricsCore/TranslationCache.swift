import Foundation

/// Stores fetched lyrics and translations as JSON files so replaying a song
/// costs no network calls or API tokens.
public struct TranslationCache: Sendable {
    public let directory: URL

    public init(directory: URL = TranslationCache.defaultDirectory) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("AppleMusicTranslator/Cache", isDirectory: true)
    }

    public func lyrics(for track: Track) -> Lyrics? {
        read(key: "lyrics|\(track.cacheKey)")
    }

    public func store(_ lyrics: Lyrics, for track: Track) {
        write(lyrics, key: "lyrics|\(track.cacheKey)")
    }

    public func translations(for track: Track, language: String) -> [String: String]? {
        read(key: "translation|\(track.cacheKey)|\(language)")
    }

    public func store(_ translations: [String: String], for track: Track, language: String) {
        write(translations, key: "translation|\(track.cacheKey)|\(language)")
    }

    func fileURL(for key: String) -> URL {
        directory.appendingPathComponent("\(Self.fnv1a(key)).json")
    }

    /// 64-bit FNV-1a, used for file names because CryptoKit isn't available on Linux.
    public static func fnv1a(_ string: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x100_0000_01b3
        }
        return String(format: "%016llx", hash)
    }

    private func read<T: Decodable>(key: String) -> T? {
        guard let data = try? Data(contentsOf: fileURL(for: key)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: fileURL(for: key), options: .atomic)
    }
}
