# Apple Music Lyrics Translator

Companion lyrics translator for Apple Music on the Mac, and a [Cider](https://cider.sh/) plugin for Windows and Linux.

Music.app has no plugin API, so the Mac app is a menu-bar companion. It reads the current track from Music, fetches time-synced lyrics from [LRCLIB](https://lrclib.net), translates them with [DeepSeek V4.1 Flash](https://api-docs.deepseek.com/news/news260910), and shows each translation under the original line in a floating panel attached to the Music window.

On Windows and Linux the same pipeline runs inside Cider as a plugin and writes translations under Cider's own lyric lines. Docker is not part of this project: a container cannot sit on Cider's lyrics view.

## Requirements

- macOS 14 or later for the Music.app companion
- [Cider](https://cider.sh/) 2 or later for the Windows/Linux plugin
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)
- Swift 5.10+ to build the Mac app, or Node 22+ to test/bundle the Cider plugin

Xcode is optional. Command Line Tools are enough to run `scripts/build-app.sh`.

## Build the Mac app

```bash
chmod +x scripts/build-app.sh
./scripts/build-app.sh
open "build/Lyrics Translator.app"
```

On first launch, macOS will ask for Automation access to Music. Allow it under **System Settings → Privacy & Security → Automation**.

Open the menu-bar extra, paste your API key, pick a language, and play a song. The overlay docks to the right of the Music window (or over the lyrics sidebar). Click a line to seek.

## Install the Cider plugin

See [cider-plugin/README.md](cider-plugin/README.md). Short version:

```bash
node cider-plugin/scripts/bundle.mjs
```

Copy `cider-plugin/dist/` into Cider's plugins folder as `com.jpark9013.apple-music-translator`, restart Cider, and add your API key in the plugin settings.

## Tests

```bash
./scripts/test.sh
npm test --prefix cider-plugin
```

GitHub Actions runs both suites on every push to every branch (Swift on macOS and Linux, the plugin on macOS, Linux, and Windows). If `swift run` cannot load the package (a Command Line Tools mismatch), `scripts/test.sh` compiles the same tests with `swiftc`.

## How it works

```
Music.app or Cider
        │
        ├─ track + position
        ▼
   LyricsCore / cider-plugin/lib
        │
        ├─ LRCLIB synced lyrics
        ├─ DeepSeek translation (cached)
        ▼
   Overlay panel  or  Cider lyric lines
```

Repeat plays of the same song and language are served from cache and do not call DeepSeek again.
