import AppKit
import LyricsCore
import SwiftUI

struct LyricsOverlayView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var settings: AppSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.3)
            content
        }
        .foregroundStyle(.white)
        .background(VisualEffectBackground())
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.track?.name ?? "")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(model.track?.artist ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1)
            }
            Spacer()
            if model.isTranslating {
                ProgressView().controlSize(.small)
                Text("Translating")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.6))
            } else if model.lyricsStatus == .ready, model.translationError == nil {
                Text(settings.targetLanguage)
                    .font(.system(size: 11, weight: .medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.white.opacity(0.12), in: Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        switch model.lyricsStatus {
        case .idle:
            message("Play a song in Music")
        case .loading:
            VStack { ProgressView() }.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            message("No lyrics found for this song")
        case .instrumental:
            message("Instrumental")
        case let .failed(error):
            message(error)
        case .ready:
            if let lyrics = model.lyrics {
                VStack(spacing: 0) {
                    if let error = model.translationError {
                        Text(error)
                            .font(.system(size: 11))
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                    }
                    LyricsList(
                        lyrics: lyrics,
                        translations: model.translations,
                        activeIndex: model.activeLineIndex,
                        fontSize: settings.fontSize,
                        onSelect: model.seek(to:)
                    )
                }
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.white.opacity(0.6))
            .multilineTextAlignment(.center)
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct LyricsList: View {
    let lyrics: Lyrics
    let translations: [String: String]
    let activeIndex: Int?
    let fontSize: Double
    let onSelect: (LyricLine) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: fontSize * 0.9) {
                    ForEach(Array(lyrics.lines.enumerated()), id: \.offset) { index, line in
                        LyricRow(
                            line: line,
                            translation: translations[line.text],
                            emphasis: emphasis(for: index),
                            fontSize: fontSize
                        )
                        .id(index)
                        .contentShape(Rectangle())
                        .onTapGesture { onSelect(line) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 40)
                // Lets the last lines scroll up to the reading position.
                .padding(.bottom, 200)
            }
            .onAppear { scroll(proxy, animated: false) }
            .onChange(of: activeIndex) { scroll(proxy, animated: true) }
        }
    }

    /// 0 for the active line, growing with distance; nil when lyrics aren't synced.
    private func emphasis(for index: Int) -> Int? {
        guard lyrics.isSynced else { return nil }
        guard let activeIndex else { return index == 0 ? 1 : 2 }
        return min(abs(index - activeIndex), 4)
    }

    private func scroll(_ proxy: ScrollViewProxy, animated: Bool) {
        guard let activeIndex else { return }
        let anchor = UnitPoint(x: 0, y: 0.3)
        if animated {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.9)) { proxy.scrollTo(activeIndex, anchor: anchor) }
        } else {
            proxy.scrollTo(activeIndex, anchor: anchor)
        }
    }
}

struct LyricRow: View {
    let line: LyricLine
    let translation: String?
    let emphasis: Int?
    let fontSize: Double

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.2) {
            if line.text.isEmpty {
                Text("\u{2022} \u{2022} \u{2022}")
                    .font(.system(size: fontSize * 0.8, weight: .bold))
            } else {
                Text(line.text)
                    .font(.system(size: fontSize, weight: .bold))
                if let translation, !translation.isEmpty {
                    Text(translation)
                        .font(.system(size: fontSize * 0.68, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.75))
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(opacity)
        .blur(radius: blur)
        .scaleEffect(emphasis == 0 ? 1.0 : 0.97, anchor: .leading)
        .animation(.easeOut(duration: 0.35), value: emphasis)
    }

    private var opacity: Double {
        guard let emphasis else { return 1 }
        return emphasis == 0 ? 1 : 0.4
    }

    private var blur: CGFloat {
        guard let emphasis, emphasis > 1 else { return 0 }
        return CGFloat(emphasis - 1) * 0.6
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
