import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum LyricsError: LocalizedError, Equatable {
    case notFound

    public var errorDescription: String? { "No lyrics found for this song." }
}

/// Fetches lyrics from LRCLIB (https://lrclib.net), a free, keyless lyrics database.
public struct LyricsService: Sendable {
    public struct Record: Decodable {
        let trackName: String?
        let duration: Double?
        let instrumental: Bool?
        let plainLyrics: String?
        let syncedLyrics: String?
    }

    public static let defaultBaseURL = URL(string: "https://lrclib.net/api")!
    static let maxDurationDifference = 5.0
    private static let userAgent = "AppleMusicTranslator/0.1 (https://github.com/jpark9013/AppleMusicTranslator)"

    private let baseURL: URL
    private let http: HTTPClient

    public init(baseURL: URL = LyricsService.defaultBaseURL, http: @escaping HTTPClient = HTTP.urlSession(timeout: 15)) {
        self.baseURL = baseURL
        self.http = http
    }

    public func fetch(for track: Track) async throws -> Lyrics {
        if let record = try await exactMatch(track), let lyrics = Self.lyrics(from: record) {
            return lyrics
        }
        var titles = [track.name]
        let simplified = Self.simplifiedTitle(track.name)
        if simplified != track.name { titles.append(simplified) }
        for title in titles {
            if let record = try await searchMatch(title: title, track: track),
               let lyrics = Self.lyrics(from: record) {
                return lyrics
            }
        }
        throw LyricsError.notFound
    }

    private func exactMatch(_ track: Track) async throws -> Record? {
        var items = [
            URLQueryItem(name: "track_name", value: track.name),
            URLQueryItem(name: "artist_name", value: track.artist),
            URLQueryItem(name: "album_name", value: track.album),
        ]
        if track.duration > 0 {
            items.append(URLQueryItem(name: "duration", value: String(Int(track.duration.rounded()))))
        }
        let (data, status) = try await get("get", items)
        guard status == 200 else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private func searchMatch(title: String, track: Track) async throws -> Record? {
        let items = [
            URLQueryItem(name: "track_name", value: title),
            URLQueryItem(name: "artist_name", value: track.artist),
        ]
        let (data, status) = try await get("search", items)
        guard status == 200, let records = try? JSONDecoder().decode([Record].self, from: data) else { return nil }
        return Self.bestMatch(records, duration: track.duration)
    }

    /// Prefers synced over plain lyrics, and rejects results whose length is far
    /// from the track's so a different song with the same title isn't picked.
    public static func bestMatch(_ records: [Record], duration: Double) -> Record? {
        let candidates = records.filter { record in
            guard duration > 0, let recordDuration = record.duration else { return true }
            return abs(recordDuration - duration) <= maxDurationDifference
        }
        return candidates.first { $0.syncedLyrics?.isEmpty == false }
            ?? candidates.first { $0.plainLyrics?.isEmpty == false }
            ?? candidates.first { $0.instrumental == true }
    }

    private func get(_ endpoint: String, _ items: [URLQueryItem]) async throws -> (Data, Int) {
        var components = URLComponents(url: baseURL.appendingPathComponent(endpoint), resolvingAgainstBaseURL: false)!
        components.queryItems = items
        var request = URLRequest(url: components.url!)
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        return try await http(request)
    }

    public static func lyrics(from record: Record) -> Lyrics? {
        if record.instrumental == true {
            return Lyrics(lines: [], isSynced: false, isInstrumental: true)
        }
        if let synced = record.syncedLyrics, !synced.isEmpty {
            let lines = LRCParser.parse(synced)
            if !lines.isEmpty { return Lyrics(lines: lines, isSynced: true, isInstrumental: false) }
        }
        if let plain = record.plainLyrics, !plain.isEmpty {
            let lines = plain
                .components(separatedBy: .newlines)
                .map { LyricLine(time: nil, text: $0.trimmingCharacters(in: .whitespaces)) }
            return Lyrics(lines: lines, isSynced: false, isInstrumental: false)
        }
        return nil
    }

    /// Strips suffixes like "(feat. X)", "[Remastered]" or "- Live" that LRCLIB often omits.
    public static func simplifiedTitle(_ title: String) -> String {
        var result = title.replacingOccurrences(of: #"\s*[\(\[][^\)\]]*[\)\]]"#, with: "", options: .regularExpression)
        if let dash = result.range(of: " - ") {
            result = String(result[..<dash.lowerBound])
        }
        let trimmed = result.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? title : trimmed
    }
}
