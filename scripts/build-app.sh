#!/bin/bash
# Builds "build/Lyrics Translator.app" from the Swift package.
# Falls back to calling swiftc directly if SwiftPM can't load the manifest
# (seen with mismatched Command Line Tools installs).
set -euo pipefail

cd "$(dirname "$0")/.."

APP_DIR="build/Lyrics Translator.app"
EXECUTABLE="AppleMusicTranslator"
ARCH="$(uname -m)"

if swift build -c release --product "$EXECUTABLE" 2>/dev/null; then
    BINARY="$(swift build -c release --show-bin-path)/$EXECUTABLE"
else
    echo "swift build failed; compiling with swiftc directly" >&2
    OUT=".build/manual"
    mkdir -p "$OUT"
    swiftc -O -parse-as-library -emit-library -static \
        -module-name LyricsCore \
        -emit-module -emit-module-path "$OUT/LyricsCore.swiftmodule" \
        -target "$ARCH-apple-macosx14.0" \
        Sources/LyricsCore/*.swift -o "$OUT/libLyricsCore.a"
    swiftc -O -parse-as-library \
        -module-name "$EXECUTABLE" \
        -target "$ARCH-apple-macosx14.0" \
        -I "$OUT" -L "$OUT" -lLyricsCore \
        Sources/AppleMusicTranslator/*.swift -o "$OUT/$EXECUTABLE"
    BINARY="$OUT/$EXECUTABLE"
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BINARY" "$APP_DIR/Contents/MacOS/$EXECUTABLE"
cp Resources/Info.plist "$APP_DIR/Contents/Info.plist"

codesign --force --sign - --identifier com.julian.AppleMusicTranslator "$APP_DIR"

echo "Built $APP_DIR"
