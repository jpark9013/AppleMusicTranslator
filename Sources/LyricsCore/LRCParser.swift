import Foundation

public enum LRCParser {
    private static let timestamp = try! NSRegularExpression(pattern: #"\[(\d+):(\d{1,2}(?:[\.:]\d{1,3})?)\]"#)

    /// Parses LRC text such as "[01:02.34] line". Lines may carry several
    /// timestamps; metadata tags like "[ar: Artist]" are ignored.
    public static func parse(_ lrc: String) -> [LyricLine] {
        var lines: [LyricLine] = []
        for rawLine in lrc.components(separatedBy: .newlines) {
            let ns = rawLine as NSString
            let matches = timestamp.matches(in: rawLine, range: NSRange(location: 0, length: ns.length))
            guard let last = matches.last else { continue }
            let text = ns.substring(from: last.range.location + last.range.length)
                .trimmingCharacters(in: .whitespaces)
            for match in matches {
                let minutes = Double(ns.substring(with: match.range(at: 1))) ?? 0
                let seconds = Double(ns.substring(with: match.range(at: 2)).replacingOccurrences(of: ":", with: ".")) ?? 0
                lines.append(LyricLine(time: minutes * 60 + seconds, text: text))
            }
        }
        // Stable sort so lines sharing a timestamp keep their file order.
        return lines.enumerated()
            .sorted { ($0.element.time ?? 0, $0.offset) < ($1.element.time ?? 0, $1.offset) }
            .map(\.element)
    }
}
