import Foundation
import LyricsCore

func registerTranslationServiceTests() {
    let track = Track(name: "Song", artist: "Artist", album: "Album", duration: 180)

    @Sendable func reply(_ translations: [String], extraBlocks: [[String: Any]] = []) -> String {
        let text = json(["translations": translations])
        return json(["content": extraBlocks + [["type": "text", "text": text]]])
    }

    @Sendable func translate(_ lines: [String], http: FakeHTTP, apiKey: String = "test-key") async throws -> [String: String] {
        try await TranslationService(http: http.client)
            .translate(lines: lines, track: track, to: "English", model: "claude-haiku-5-5", apiKey: apiKey)
    }

    TestRuntime.add("throws without API key") {
        let http = FakeHTTP([])
        try await expectThrows(TranslationError.missingAPIKey) {
            _ = try await translate(["안녕"], http: http, apiKey: "")
        }
        try expect(await http.requests.isEmpty)
    }

    TestRuntime.add("sends each distinct line once and maps results") {
        let http = FakeHTTP([(200, reply(["Hello", "Goodbye"]))])
        let result = try await translate(["안녕", "", "잘가", "안녕"], http: http)

        try expectEqual(result, ["안녕": "Hello", "잘가": "Goodbye"])

        let body = await http.jsonBody(at: 0)
        try expect(body["model"] as? String == "claude-haiku-5-5")
        let messages = body["messages"] as? [[String: Any]]
        let content = messages?.first?["content"] as? String ?? ""
        try expect(content.contains(#"["안녕","잘가"]"#))
        try expect((body["system"] as? String)?.contains("exactly 2 strings") == true)

        let request = await http.requests[0]
        try expectEqual(request.value(forHTTPHeaderField: "x-api-key"), "test-key")
        try expectEqual(request.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        try expectEqual(request.httpMethod, "POST")
    }

    TestRuntime.add("skips request when all lines are empty") {
        let http = FakeHTTP([])
        let result = try await translate(["", ""], http: http)
        try expect(result.isEmpty)
        try expect(await http.requests.isEmpty)
    }

    TestRuntime.add("ignores thinking blocks") {
        let thinking: [String: Any] = ["type": "thinking", "thinking": "{\"translations\": [\"wrong\"]}"]
        let http = FakeHTTP([(200, reply(["Hello"], extraBlocks: [thinking]))])
        let result = try await translate(["안녕"], http: http)
        try expectEqual(result, ["안녕": "Hello"])
    }

    TestRuntime.add("retries once when line count mismatches") {
        let http = FakeHTTP([(200, reply(["only one"])), (200, reply(["A", "B"]))])
        let result = try await translate(["a", "b"], http: http)
        try expectEqual(result, ["a": "A", "b": "B"])
        try expectEqual(await http.requests.count, 2)
    }

    TestRuntime.add("gives up after two malformed responses") {
        let http = FakeHTTP([(200, reply(["x"])), (200, json(["content": []]))])
        try await expectThrows(TranslationError.malformedResponse) {
            _ = try await translate(["a", "b"], http: http)
        }
    }

    TestRuntime.add("does not retry client errors") {
        let error = json(["error": ["type": "authentication_error", "message": "invalid x-api-key"]])
        let http = FakeHTTP([(401, error), (200, reply(["never"]))])
        try await expectThrows(TranslationError.api(status: 401, message: "invalid x-api-key")) {
            _ = try await translate(["a"], http: http)
        }
        try expectEqual(await http.requests.count, 1)
    }

    TestRuntime.add("retries server errors") {
        let http = FakeHTTP([(529, json(["error": ["message": "overloaded"]])), (200, reply(["A"]))])
        let result = try await translate(["a"], http: http)
        try expectEqual(result, ["a": "A"])
    }

    TestRuntime.add("parses JSON wrapped in code fences") {
        let text = "```json\n{\"translations\": [\" Hello \", \"\"]}\n```"
        try expectEqual(TranslationService.parseTranslations(text), ["Hello", ""])
    }

    TestRuntime.add("rejects text without translations object") {
        try expect(TranslationService.parseTranslations("Sorry, I can't help with that.") == nil)
        try expect(TranslationService.parseTranslations(#"{"other": []}"#) == nil)
    }
}
