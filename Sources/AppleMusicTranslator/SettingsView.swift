import AppKit
import LyricsCore
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var settings: AppSettings
    @State private var apiKeyDraft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            nowPlaying

            if let error = model.player.scriptingError {
                Label {
                    Text("Can't read Music: \(error)\nAllow access in System Settings > Privacy & Security > Automation.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                .font(.caption)
            }

            Divider()

            Picker("Translate to", selection: $settings.targetLanguage) {
                ForEach(AppSettings.languages, id: \.self) { Text($0).tag($0) }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Anthropic API key").font(.subheadline.weight(.medium))
                HStack {
                    SecureField("sk-ant-...", text: $apiKeyDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(saveKey)
                    Button("Save", action: saveKey)
                        .disabled(apiKeyDraft == settings.apiKey)
                }
                HStack {
                    Text(settings.apiKey.isEmpty ? "No key saved" : "Key saved in Keychain")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Link("Get a key", destination: URL(string: "https://console.anthropic.com/settings/keys")!)
                }
                .font(.caption)
            }

            HStack {
                Text("Model")
                TextField(AppSettings.defaultModel, text: $settings.model)
                    .textFieldStyle(.roundedBorder)
            }

            Divider()

            Toggle("Show lyrics overlay", isOn: $settings.overlayEnabled)

            Picker("Position", selection: $settings.dockMode) {
                ForEach(DockMode.allCases) { Text($0.label).tag($0) }
            }

            HStack {
                Text("Text size")
                Slider(value: $settings.fontSize, in: 14...34, step: 1)
            }

            Toggle("Pre-translate the next song", isOn: $settings.prefetchNext)

            Toggle("Launch at login", isOn: Binding(
                get: { settings.launchAtLogin },
                set: { settings.setLaunchAtLogin($0) }
            ))

            Divider()

            HStack {
                Button("Retranslate") { model.retranslate() }
                    .disabled(model.lyrics == nil || model.isTranslating)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(16)
        .frame(width: 340)
        .onAppear { apiKeyDraft = settings.apiKey }
    }

    private var nowPlaying: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Lyrics Translator").font(.headline)
            if let track = model.track {
                Text("\(track.name) \u{2014} \(track.artist)")
                    .font(.caption)
                    .lineLimit(1)
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Nothing playing in Music").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var statusText: String {
        if model.isTranslating { return "Translating..." }
        if let error = model.translationError { return error }
        switch model.lyricsStatus {
        case .idle: return ""
        case .loading: return "Looking up lyrics..."
        case .ready: return model.translations.isEmpty ? "Lyrics loaded" : "Translated to \(settings.targetLanguage)"
        case .notFound: return "No lyrics found"
        case .instrumental: return "Instrumental"
        case let .failed(message): return message
        }
    }

    private func saveKey() {
        settings.apiKey = apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        apiKeyDraft = settings.apiKey
    }
}
