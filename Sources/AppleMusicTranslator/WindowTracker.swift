import AppKit
import CoreGraphics

struct MusicWindow: Equatable {
    /// Frame in Cocoa screen coordinates (origin at bottom-left of the primary display).
    let frame: NSRect
    let windowNumber: Int
    let isFrontmost: Bool
}

/// Follows the Music window's position via CGWindowList, which needs no
/// Accessibility or Screen Recording permission for window bounds.
@MainActor
final class WindowTracker: ObservableObject {
    @Published private(set) var musicWindow: MusicWindow?

    private var timer: Timer?

    func setActive(_ active: Bool) {
        if active, timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20.0, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
            RunLoop.main.add(timer!, forMode: .common)
            refresh()
        } else if !active, let timer {
            timer.invalidate()
            self.timer = nil
            musicWindow = nil
        }
    }

    private func refresh() {
        let window = Self.findMusicWindow()
        if window != musicWindow { musicWindow = window }
    }

    private static func findMusicWindow() -> MusicWindow? {
        guard let music = NSRunningApplication.runningApplications(withBundleIdentifier: PlayerMonitor.musicBundleID).first,
              !music.isHidden,
              let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return nil }

        let pid = music.processIdentifier
        let candidates = info.compactMap { entry -> (CGRect, Int)? in
            guard entry[kCGWindowOwnerPID as String] as? pid_t == pid,
                  entry[kCGWindowLayer as String] as? Int == 0,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict),
                  bounds.width > 300, bounds.height > 200,
                  let number = entry[kCGWindowNumber as String] as? Int
            else { return nil }
            return (bounds, number)
        }
        // Window list is front-to-back, so the first match is Music's frontmost main window.
        guard let (bounds, number) = candidates.first,
              let primaryHeight = NSScreen.screens.first?.frame.height
        else { return nil }

        let frame = NSRect(
            x: bounds.minX,
            y: primaryHeight - bounds.maxY,
            width: bounds.width,
            height: bounds.height
        )
        return MusicWindow(
            frame: frame,
            windowNumber: number,
            isFrontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        )
    }
}
