import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import LyricsCore

/// Records requests and replies with canned responses, in order.
actor FakeHTTP {
    private var responses: [(Int, Data)]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [(Int, String)]) {
        self.responses = responses.map { ($0.0, Data($0.1.utf8)) }
    }

    nonisolated var client: HTTPClient {
        { request in try await self.handle(request) }
    }

    private func handle(_ request: URLRequest) throws -> (Data, Int) {
        requests.append(request)
        guard !responses.isEmpty else { return (Data(), 404) }
        let (status, data) = responses.removeFirst()
        return (data, status)
    }

    func queryItems(at index: Int) -> [String: String] {
        let components = URLComponents(url: requests[index].url!, resolvingAgainstBaseURL: false)
        var result: [String: String] = [:]
        for item in components?.queryItems ?? [] { result[item.name] = item.value ?? "" }
        return result
    }

    func jsonBody(at index: Int) -> [String: Any] {
        guard let body = requests[index].httpBody,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return json
    }
}

func json(_ object: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
}
