import Combine
import Foundation
import LyricsCore

enum LyricsStatus: Equatable {
    case idle
    case loading
    case ready
    case notFound
    case instrumental
    case failed(String)
}

/// Coordinates the pipeline: track change -> lyrics -> translation -> overlay.
@MainActor
final class AppModel: ObservableObject {
    let settings = AppSettings()
    let player = PlayerMonitor()
    let windowTracker = WindowTracker()

    @Published private(set) var track: Track?
    @Published private(set) var lyrics: Lyrics?
    @Published private(set) var translations: [String: String] = [:]
    @Published private(set) var lyricsStatus: LyricsStatus = .idle
    @Published private(set) var isTranslating = false
    @Published private(set) var translationError: String?
    @Published private(set) var activeLineIndex: Int?

    private let lyricsService = LyricsService()
    private let translationService = TranslationService()
    private let cache = TranslationCache()
    private var overlay: OverlayController?
    private var loadTask: Task<Void, Never>?
    private var prefetching = Set<String>()
    private var cancellables = Set<AnyCancellable>()

    /// Highlight a line slightly before its timestamp, as Apple Music does.
    private static let highlightLead = 0.25

    func start() {
        player.start()
        overlay = OverlayController(model: self)

        player.$track
            .removeDuplicates()
            .sink { [weak self] track in self?.load(track) }
            .store(in: &cancellables)

        player.$position
            .sink { [weak self] position in self?.updateActiveLine(position) }
            .store(in: &cancellables)

        settings.$targetLanguage
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] language in self?.retranslate(language: language) }
            .store(in: &cancellables)

        settings.$apiKey
            .dropFirst()
            .debounce(for: .seconds(1), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self, self.translationError != nil else { return }
                self.retranslate()
            }
            .store(in: &cancellables)
    }

    func seek(to line: LyricLine) {
        guard let time = line.time else { return }
        player.seek(to: time)
    }

    func retranslate(language: String? = nil) {
        guard let track, let lyrics, !lyrics.isInstrumental else { return }
        let language = language ?? settings.targetLanguage
        translations = [:]
        translationError = nil
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            await self?.translate(lyrics, for: track, language: language)
        }
    }

    // MARK: - Pipeline

    private func load(_ track: Track?) {
        loadTask?.cancel()
        self.track = track
        lyrics = nil
        translations = [:]
        translationError = nil
        isTranslating = false
        activeLineIndex = nil

        guard let track else {
            lyricsStatus = .idle
            return
        }
        lyricsStatus = .loading
        let language = settings.targetLanguage

        loadTask = Task { [weak self] in
            guard let self else { return }
            let lyrics: Lyrics
            do {
                lyrics = try await self.lyrics(for: track)
            } catch {
                guard !Task.isCancelled else { return }
                self.lyricsStatus = error is LyricsError ? .notFound : .failed(error.localizedDescription)
                return
            }
            guard !Task.isCancelled else { return }

            self.lyrics = lyrics
            self.lyricsStatus = lyrics.isInstrumental ? .instrumental : .ready
            self.updateActiveLine(self.player.position)

            if !lyrics.isInstrumental {
                await self.translate(lyrics, for: track, language: language)
            }
            guard !Task.isCancelled else { return }
            self.prefetchNextTrack(language: language)
        }
    }

    private func lyrics(for track: Track) async throws -> Lyrics {
        if let cached = cache.lyrics(for: track) { return cached }
        let lyrics = try await lyricsService.fetch(for: track)
        cache.store(lyrics, for: track)
        return lyrics
    }

    private func translate(_ lyrics: Lyrics, for track: Track, language: String) async {
        if let cached = cache.translations(for: track, language: language) {
            translations = cached
            return
        }
        isTranslating = true
        defer { if !Task.isCancelled { isTranslating = false } }
        do {
            let result = try await translationService.translate(
                lines: lyrics.lines.map(\.text),
                track: track,
                to: language,
                model: settings.model,
                apiKey: settings.apiKey
            )
            cache.store(result, for: track, language: language)
            guard !Task.isCancelled else { return }
            translations = result
        } catch {
            guard !Task.isCancelled else { return }
            translationError = error.localizedDescription
        }
    }

    private func prefetchNextTrack(language: String) {
        guard settings.prefetchNext, !settings.apiKey.isEmpty,
              let next = player.nextTrack(), next != track,
              cache.translations(for: next, language: language) == nil,
              prefetching.insert(next.cacheKey).inserted
        else { return }

        let model = settings.model
        let apiKey = settings.apiKey
        Task { [weak self] in
            guard let self else { return }
            defer { self.prefetching.remove(next.cacheKey) }
            guard let lyrics = try? await self.lyrics(for: next), !lyrics.isInstrumental,
                  let result = try? await self.translationService.translate(
                      lines: lyrics.lines.map(\.text), track: next, to: language, model: model, apiKey: apiKey)
            else { return }
            self.cache.store(result, for: next, language: language)
        }
    }

    private func updateActiveLine(_ position: Double) {
        let index = lyrics?.activeLineIndex(at: position, lead: Self.highlightLead)
        if index != activeLineIndex { activeLineIndex = index }
    }
}
