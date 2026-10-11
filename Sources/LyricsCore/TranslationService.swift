import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum TranslationError: LocalizedError, Equatable {
    case missingAPIKey
    case api(status: Int, message: String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            "Add your DeepSeek API key in the menu bar settings to see translations."
        case let .api(status, message):
            "Translation failed (\(status)): \(message)"
        case .malformedResponse:
            "Translation failed: the model returned an unexpected response."
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .malformedResponse: true
        case let .api(status, _): status == 429 || status >= 500
        case .missingAPIKey: false
        }
    }
}

/// Translates song lyrics with DeepSeek V4.1 Flash through the Chat Completions API.
public struct TranslationService: Sendable {
    public static let defaultEndpoint = URL(string: "https://api.deepseek.com/chat/completions")!
    public static let defaultModel = "deepseek-flash"

    private let endpoint: URL
    private let http: HTTPClient

    public init(endpoint: URL = TranslationService.defaultEndpoint, http: @escaping HTTPClient = HTTP.urlSession(timeout: 90)) {
        self.endpoint = endpoint
        self.http = http
    }

    /// Returns a map from each original line to its translation. Lines that are
    /// already in the target language map to an empty string.
    public func translate(
        lines: [String],
        track: Track,
        to language: String,
        model: String,
        apiKey: String
    ) async throws -> [String: String] {
        guard !apiKey.isEmpty else { throw TranslationError.missingAPIKey }

        let unique = Self.uniqueLines(lines)
        guard !unique.isEmpty else { return [:] }

        var lastError = TranslationError.malformedResponse
        for _ in 0..<2 {
            do {
                let translated = try await send(unique, track: track, language: language, model: model, apiKey: apiKey)
                return Dictionary(zip(unique, translated), uniquingKeysWith: { first, _ in first })
            } catch let error as TranslationError where error.isRetryable {
                lastError = error
            }
        }
        throw lastError
    }

    /// Non-empty lines in first-seen order. Choruses repeat, so each distinct
    /// line is only sent once.
    public static func uniqueLines(_ lines: [String]) -> [String] {
        var seen = Set<String>()
        return lines.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public static func systemPrompt(language: String, count: Int) -> String {
        """
        You translate song lyrics into \(language) for display under the original lines while the song plays.
        Translate meaning, tone and imagery naturally, the way a skilled human lyric translator would, rather than word for word.
        Keep each translation on a single line and roughly as concise as the original.
        If a line is already in \(language), or is only vocalizations like "oh" or "la la", return an empty string for it.
        Respond with only a JSON object of the form {"translations": ["...", "..."]} containing exactly \(count) strings, one per input line, in the same order. No commentary, no code fences.
        """
    }

    public static func requestBody(lines: [String], track: Track, language: String, model: String) throws -> Data {
        let linesJSON = String(data: try JSONSerialization.data(withJSONObject: lines), encoding: .utf8) ?? "[]"
        let user = """
        Song: "\(track.name)" by \(track.artist)
        Lines (\(lines.count)):
        \(linesJSON)
        """
        let body: [String: Any] = [
            "model": model,
            "max_tokens": 8192,
            "response_format": ["type": "json_object"],
            // Reasoning made up ~85-90% of output tokens with no gain for this task.
            "thinking": ["type": "disabled"],
            "messages": [
                ["role": "system", "content": systemPrompt(language: language, count: lines.count)],
                ["role": "user", "content": user],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: body)
    }

    private func send(_ lines: [String], track: Track, language: String, model: String, apiKey: String) async throws -> [String] {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try Self.requestBody(lines: lines, track: track, language: language, model: model)

        let (data, status) = try await http(request)
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]

        guard status == 200 else {
            let message = (json?["error"] as? [String: Any])?["message"] as? String
                ?? String(data: data, encoding: .utf8) ?? "Unknown error"
            throw TranslationError.api(status: status, message: message)
        }

        let text = Self.assistantText(json)
        guard let translations = Self.parseTranslations(text), translations.count == lines.count else {
            throw TranslationError.malformedResponse
        }
        return translations
    }

    public static func assistantText(_ json: [String: Any]?) -> String {
        let choices = json?["choices"] as? [[String: Any]]
        let message = choices?.first?["message"] as? [String: Any]
        return message?["content"] as? String ?? ""
    }

    /// Extracts `{"translations": [...]}` from model output, tolerating code
    /// fences or stray text around the JSON object.
    public static func parseTranslations(_ text: String) -> [String]? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let data = String(text[start...end]).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let translations = object["translations"] as? [Any]
        else { return nil }
        return translations.map { ($0 as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}
