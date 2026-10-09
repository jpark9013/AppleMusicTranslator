import Foundation

struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

func expect(_ condition: Bool, _ message: String = "", file: String = #fileID, line: Int = #line) throws {
    if !condition {
        throw TestFailure(description: "\(file):\(line) \(message)")
    }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, file: String = #fileID, line: Int = #line) throws {
    try expect(actual == expected, "expected \(expected), got \(actual)", file: file, line: line)
}

@discardableResult
func expectThrows<E: Error & Equatable>(_ expected: E, file: String = #fileID, line: Int = #line, _ body: () async throws -> Void) async throws -> E {
    do {
        try await body()
        throw TestFailure(description: "\(file):\(line) expected to throw \(expected)")
    } catch let error as E {
        try expectEqual(error, expected, file: file, line: line)
        return error
    } catch {
        throw TestFailure(description: "\(file):\(line) threw \(error) instead of \(expected)")
    }
}

struct TestCase: Sendable {
    let name: String
    let body: @Sendable () async throws -> Void
}

enum TestRuntime {
    private static var cases: [TestCase] = []

    static func add(_ name: String, _ body: @escaping @Sendable () async throws -> Void) {
        cases.append(TestCase(name: name, body: body))
    }

    static func run() async -> Int {
        var failed = 0
        for test in cases {
            do {
                try await test.body()
                print("ok   \(test.name)")
            } catch {
                failed += 1
                print("FAIL \(test.name)")
                print("     \(error)")
            }
        }
        print("\(cases.count - failed) passed, \(failed) failed, \(cases.count) total")
        return failed
    }
}

@main
enum LyricsCoreTestRunner {
    static func main() async {
        registerAllTests()
        let failed = await TestRuntime.run()
        if failed > 0 { exit(1) }
    }
}
