import AppKit
import Foundation
import LyricsCore

enum PlayerState: String {
    case playing, paused, stopped
}

/// Tracks the song playing in Music.app and its playback position.
///
/// Music is polled over AppleScript twice a second; between polls the position
/// is interpolated locally so the lyric highlight moves smoothly.
@MainActor
final class PlayerMonitor: ObservableObject {
    static let musicBundleID = "com.apple.Music"

    @Published private(set) var track: Track?
    @Published private(set) var state: PlayerState = .stopped
    @Published private(set) var position: Double = 0
    @Published private(set) var scriptingError: String?

    private var polledPosition: Double = 0
    private var polledAt = Date()
    private var pollTimer: Timer?
    private var tickTimer: Timer?

    private lazy var statusScript = NSAppleScript(source: """
        tell application "Music"
            if player state is stopped then return {"stopped"}
            try
                set t to current track
                return {player state as text, player position, name of t, artist of t, album of t, duration of t}
            on error
                return {player state as text, player position}
            end try
        end tell
        """)

    private lazy var nextTrackScript = NSAppleScript(source: """
        tell application "Music"
            if shuffle enabled then return {}
            try
                set p to current playlist
                set i to index of current track
                if i < (count of tracks of p) then
                    set n to track (i + 1) of p
                    return {name of n, artist of n, album of n, duration of n}
                end if
            end try
            return {}
        end tell
        """)

    func start() {
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(playerInfoChanged),
            name: NSNotification.Name("com.apple.Music.playerInfo"),
            object: nil
        )
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(pollTimer!, forMode: .common)
        RunLoop.main.add(tickTimer!, forMode: .common)
        poll()
    }

    func seek(to seconds: Double) {
        guard isMusicRunning else { return }
        let script = NSAppleScript(source: "tell application \"Music\" to set player position to \(seconds)")
        var error: NSDictionary?
        script?.executeAndReturnError(&error)
        polledPosition = seconds
        polledAt = Date()
        position = seconds
    }

    /// Best-effort guess of the next song: the following track in the current
    /// playlist. Returns nil when shuffle is on, since the order is unknown.
    func nextTrack() -> Track? {
        guard isMusicRunning, let result = run(nextTrackScript), result.numberOfItems == 4 else { return nil }
        return Track(
            name: result.atIndex(1)?.stringValue ?? "",
            artist: result.atIndex(2)?.stringValue ?? "",
            album: result.atIndex(3)?.stringValue ?? "",
            duration: result.atIndex(4)?.doubleValue ?? 0
        )
    }

    private var isMusicRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: Self.musicBundleID).isEmpty
    }

    @objc private func playerInfoChanged(_ note: Notification) {
        poll()
    }

    private func poll() {
        guard isMusicRunning else {
            update(state: .stopped, position: 0, track: nil)
            return
        }
        guard let result = run(statusScript), result.numberOfItems >= 1 else { return }

        // "fast forwarding" and "rewinding" count as playing.
        let state = PlayerState(rawValue: result.atIndex(1)?.stringValue ?? "") ?? .playing
        guard state != .stopped, result.numberOfItems >= 2 else {
            update(state: .stopped, position: 0, track: nil)
            return
        }
        let position = result.atIndex(2)?.doubleValue ?? 0
        var track: Track?
        if result.numberOfItems >= 6 {
            track = Track(
                name: result.atIndex(3)?.stringValue ?? "",
                artist: result.atIndex(4)?.stringValue ?? "",
                album: result.atIndex(5)?.stringValue ?? "",
                duration: result.atIndex(6)?.doubleValue ?? 0
            )
        }
        update(state: state, position: position, track: track)
    }

    private func update(state: PlayerState, position: Double, track: Track?) {
        if self.state != state { self.state = state }
        if self.track != track { self.track = track }
        polledPosition = position
        polledAt = Date()
        self.position = position
    }

    private func tick() {
        guard state == .playing else { return }
        position = polledPosition + Date().timeIntervalSince(polledAt)
    }

    private func run(_ script: NSAppleScript?) -> NSAppleEventDescriptor? {
        var error: NSDictionary?
        let result = script?.executeAndReturnError(&error)
        if let error {
            let message = error[NSAppleScript.errorMessage] as? String ?? "AppleScript error"
            if scriptingError != message { scriptingError = message }
            return nil
        }
        if scriptingError != nil { scriptingError = nil }
        return result
    }
}
