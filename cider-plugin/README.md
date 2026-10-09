# Cider plugin

Drop-in plugin for [Cider](https://cider.sh/) on Windows, Linux, and macOS. It watches the song playing in Cider, fetches synced lyrics from [LRCLIB](https://lrclib.net), translates them with Claude, and injects each translation under Cider's own lyric line.

Docker is not used. Cider is already a desktop app on every platform; a plugin runs inside it and can edit the lyrics view. A container cannot.

## Install

1. From the repo root, run `node cider-plugin/scripts/bundle.mjs` (or copy the committed `dist/` folder).
2. Copy `cider-plugin/dist/` into Cider's plugins folder as `com.jpark9013.apple-music-translator/`:

| App | Typical plugins folder |
| --- | --- |
| Cider 2 | `~/Library/Application Support/Cider/plugins` (macOS), `%APPDATA%\Cider\plugins` (Windows), `~/.config/Cider/plugins` (Linux) |
| Cider Genten | `~/.config/sh.cider.genten/plugins` |

3. Restart Cider, open the plugin settings, and save an [Anthropic API key](https://console.anthropic.com/settings/keys).
4. Play a song and open Cider's lyrics view. Translations appear under each original line.

Cider's lyrics DOM varies by version. If a release uses different class names, the plugin will not find lines to annotate; open an issue with the Cider version.
