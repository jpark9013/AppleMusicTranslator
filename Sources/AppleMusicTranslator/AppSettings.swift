import Foundation
import LyricsCore
import ServiceManagement

enum DockMode: String, CaseIterable, Identifiable {
    case beside
    case inside

    var id: String { rawValue }

    var label: String {
        switch self {
        case .beside: "Beside the Music window"
        case .inside: "Over the lyrics sidebar"
        }
    }
}

@MainActor
final class AppSettings: ObservableObject {
    static let languages = [
        "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch",
        "Swedish", "Polish", "Russian", "Ukrainian", "Turkish", "Greek", "Arabic",
        "Hebrew", "Hindi", "Indonesian", "Vietnamese", "Thai", "Japanese", "Korean",
        "Chinese (Simplified)", "Chinese (Traditional)", "Tagalog",
    ]

    static let defaultModel = TranslationService.defaultModel

    private let defaults = UserDefaults.standard

    @Published var targetLanguage: String {
        didSet { defaults.set(targetLanguage, forKey: "targetLanguage") }
    }
    @Published var model: String {
        didSet { defaults.set(model, forKey: "model") }
    }
    @Published var overlayEnabled: Bool {
        didSet { defaults.set(overlayEnabled, forKey: "overlayEnabled") }
    }
    @Published var fontSize: Double {
        didSet { defaults.set(fontSize, forKey: "fontSize") }
    }
    @Published var dockMode: DockMode {
        didSet { defaults.set(dockMode.rawValue, forKey: "dockMode") }
    }
    @Published var prefetchNext: Bool {
        didSet { defaults.set(prefetchNext, forKey: "prefetchNext") }
    }
    @Published var apiKey: String {
        didSet { Keychain.write(apiKey, for: "deepseek-api-key") }
    }
    @Published private(set) var launchAtLogin: Bool

    init() {
        targetLanguage = defaults.string(forKey: "targetLanguage") ?? Self.systemLanguage()
        let storedModel = defaults.string(forKey: "model") ?? Self.defaultModel
        model = storedModel.contains("claude") || storedModel.contains("haiku") ? Self.defaultModel : storedModel
        overlayEnabled = defaults.object(forKey: "overlayEnabled") as? Bool ?? true
        fontSize = defaults.object(forKey: "fontSize") as? Double ?? 22
        dockMode = DockMode(rawValue: defaults.string(forKey: "dockMode") ?? "") ?? .beside
        prefetchNext = defaults.object(forKey: "prefetchNext") as? Bool ?? true
        apiKey = Keychain.read("deepseek-api-key") ?? ""
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("Launch at login change failed: \(error)")
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    private static func systemLanguage() -> String {
        let code = Locale.current.language.languageCode?.identifier ?? "en"
        let name = Locale(identifier: "en").localizedString(forLanguageCode: code) ?? "English"
        return languages.first { $0.hasPrefix(name) } ?? "English"
    }
}
