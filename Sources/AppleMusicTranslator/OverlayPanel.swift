import AppKit
import Combine
import SwiftUI

/// Borderless panel that never takes focus away from Music.
final class OverlayPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 600),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        appearance = NSAppearance(named: .darkAqua)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Lets clicks on lyric lines register without first focusing the panel.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class OverlayController {
    private static let gap: CGFloat = 8
    private static let insideInset: CGFloat = 10
    private static let toolbarHeight: CGFloat = 52

    private let model: AppModel
    private let panel = OverlayPanel()
    private var cancellables = Set<AnyCancellable>()

    init(model: AppModel) {
        self.model = model

        let root = LyricsOverlayView(model: model, settings: model.settings)
        panel.contentView = FirstMouseHostingView(rootView: root)

        let wantsOverlay = Publishers.CombineLatest(model.settings.$overlayEnabled, model.$track)
            .map { enabled, track in enabled && track != nil }
            .removeDuplicates()

        wantsOverlay
            .sink { [weak model] active in model?.windowTracker.setActive(active) }
            .store(in: &cancellables)

        Publishers.CombineLatest4(
            wantsOverlay,
            model.windowTracker.$musicWindow,
            model.settings.$dockMode,
            model.settings.$fontSize
        )
        .sink { [weak self] active, window, dockMode, fontSize in
            self?.update(active: active, window: window, dockMode: dockMode, fontSize: fontSize)
        }
        .store(in: &cancellables)
    }

    private func update(active: Bool, window: MusicWindow?, dockMode: DockMode, fontSize: Double) {
        guard active, let window else {
            panel.orderOut(nil)
            return
        }

        let width = max(320, min(560, CGFloat(fontSize) * 17))
        panel.setFrame(Self.frame(for: window.frame, width: width, dockMode: dockMode), display: true)

        if window.isFrontmost {
            panel.level = .floating
            panel.orderFrontRegardless()
        } else if NSApp.isActive {
            // Our own settings popover is open; leave the panel where it is.
            if !panel.isVisible { panel.orderFrontRegardless() }
        } else {
            // Sit directly above Music so other apps' windows still cover the panel.
            panel.level = .normal
            panel.order(.above, relativeTo: window.windowNumber)
        }
    }

    private static func frame(for music: NSRect, width: CGFloat, dockMode: DockMode) -> NSRect {
        let screen = NSScreen.screens.first { $0.frame.intersects(music) }?.visibleFrame ?? music

        if dockMode == .beside {
            let right = NSRect(x: music.maxX + gap, y: music.minY, width: width, height: music.height)
            if right.maxX <= screen.maxX { return right }
            let left = NSRect(x: music.minX - gap - width, y: music.minY, width: width, height: music.height)
            if left.minX >= screen.minX { return left }
        }

        return NSRect(
            x: music.maxX - width - insideInset,
            y: music.minY + insideInset,
            width: width,
            height: max(200, music.height - toolbarHeight - insideInset * 2)
        )
    }
}
