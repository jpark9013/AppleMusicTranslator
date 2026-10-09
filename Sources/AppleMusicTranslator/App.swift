import AppKit
import SwiftUI

@main
struct LyricsTranslatorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Lyrics Translator", systemImage: "character.bubble") {
            SettingsView(model: appDelegate.model, settings: appDelegate.model.settings)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keeps the app out of the Dock when run unbundled via `swift run`.
        NSApp.setActivationPolicy(.accessory)
        model.start()
    }
}
