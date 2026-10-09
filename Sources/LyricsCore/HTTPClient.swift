import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends a request and returns the body and status code. Injected so tests can
/// replace the network.
public typealias HTTPClient = @Sendable (URLRequest) async throws -> (Data, Int)

public enum HTTP {
    public static func urlSession(timeout: TimeInterval = 30) -> HTTPClient {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        let session = URLSession(configuration: config)
        return { request in
            let (data, response) = try await session.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }
}
