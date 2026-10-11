# Cider plugin

Drop-in plugin for [Cider](https://cider.sh/) on Windows, Linux, and macOS. It watches the song playing in Cider, fetches synced lyrics from [LRCLIB](https://lrclib.net), translates them with DeepSeek V4.1 Flash, and injects each translation under Cider's own lyric line.

Docker is not used. Cider is already a desktop app on every platform; a plugin runs inside it and can edit the lyrics view. A container cannot.

## Install

1. From the repo root, run `node cider-plugin/scripts/bundle.mjs` (or copy the committed `dist/` folder).
2. Copy `cider-plugin/dist/` into Cider's plugins folder as `com.jpark9013.apple-music-translator/`:

| App | Typical plugins folder |
| --- | --- |
| Cider 2 | `~/Library/Application Support/Cider/plugins` (macOS), `%APPDATA%\Cider\plugins` (Windows), `~/.config/Cider/plugins` (Linux) |
| Cider Genten | `~/.config/sh.cider.genten/plugins` |

3. Restart Cider, open **Settings → Plugins**, enable Lyrics Translator, open its settings (or click the **文A** button in Cider's top bar), and save a [DeepSeek API key](https://platform.deepseek.com/api_keys).
4. Play a song and open Cider's lyrics view. Translations appear in Cider's own translation line under each lyric, for static and time-synced lyrics.

## How lyrics are loaded

Cider normally asks user-submitted lyrics, Apple Music, Musixmatch and NetEase in turn, waits up to 35 seconds on each, and keeps going after Apple Music when its lyrics are unsynced. The plugin changes that:

- If Apple Music has lyrics for the song, the other providers are skipped and Cider shows Apple's lyrics right away, even when they are unsynced.
- Otherwise user-submitted lyrics, Musixmatch and NetEase each get 5 seconds.

Cider keeps lyrics only in memory (the last 30 songs), so they are fetched again after a restart.

## How translations are chosen

Every song gets a translation request, whichever provider its lyrics came from:

1. **Official translations.** Apple Music or NetEase translations, the same ones Cider's built-in translation uses.
2. **Cider's machine translation.** If Cider's Rise server already translated the song, that translation is used.
3. **DeepSeek.** Otherwise the whole song goes to DeepSeek in one request. It reads the lyrics as one text, translates sentences that run across lines as a whole, and returns one translation per line, which is applied by position so repeated lines keep the translation for their context. Cider's machine translation is requested at the same time and is shown if DeepSeek declines or fails.

Translations are saved locally, so replays and the next song in the queue are usually ready as soon as Cider shows the lyrics. Songs already in your target language are skipped.

Older Cider builds without the lyric store fall back to LRCLIB lyrics matched against the lines on screen.

Cider's lyrics DOM varies by version. If a release uses different class names, the plugin will not find lines to annotate; open an issue with the Cider version.
