// swift-tools-version:5.10
import PackageDescription

var targets: [Target] = [
    .target(name: "LyricsCore"),
    .executableTarget(name: "LyricsCoreTestRunner", dependencies: ["LyricsCore"], path: "Tests/LyricsCoreTests"),
]

#if os(macOS)
// The menu bar app depends on AppKit and only builds on macOS; LyricsCore also builds on Linux.
targets.append(
    .executableTarget(name: "AppleMusicTranslator", dependencies: ["LyricsCore"])
)
#endif

let package = Package(
    name: "AppleMusicTranslator",
    platforms: [.macOS(.v14)],
    targets: targets
)
