import Foundation

public struct Track: Equatable, Hashable, Sendable {
    public let name: String
    public let artist: String
    public let album: String
    /// Length in seconds, or 0 when unknown.
    public let duration: Double

    public init(name: String, artist: String, album: String, duration: Double) {
        self.name = name
        self.artist = artist
        self.album = album
        self.duration = duration
    }

    public var cacheKey: String { "\(artist)|\(name)".lowercased() }
}

public struct LyricLine: Codable, Hashable, Sendable {
    /// Start time in seconds, or nil for unsynced lyrics.
    public let time: Double?
    public let text: String

    public init(time: Double?, text: String) {
        self.time = time
        self.text = text
    }
}

public struct Lyrics: Codable, Equatable, Sendable {
    public let lines: [LyricLine]
    public let isSynced: Bool
    public let isInstrumental: Bool

    public init(lines: [LyricLine], isSynced: Bool, isInstrumental: Bool) {
        self.lines = lines
        self.isSynced = isSynced
        self.isInstrumental = isInstrumental
    }

    /// Index of the line being sung at `position`, or nil before the first line
    /// or for unsynced lyrics. `lead` highlights a line slightly early.
    public func activeLineIndex(at position: Double, lead: Double = 0) -> Int? {
        guard isSynced else { return nil }
        let target = position + lead
        return lines.lastIndex { ($0.time ?? 0) <= target }
    }
}
