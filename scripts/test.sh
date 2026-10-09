#!/bin/bash
# Runs LyricsCore tests. Prefers SwiftPM; falls back to compiling with swiftc
# when Command Line Tools cannot load Package.swift.
set -euo pipefail
cd "$(dirname "$0")/.."

if swift run LyricsCoreTestRunner; then
    exit 0
fi

echo "swift run failed; compiling tests with swiftc" >&2
OUT=".build/manual-test"
ARCH="$(uname -m)"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || xcrun --show-sdk-path)"
mkdir -p "$OUT"

swiftc -parse-as-library \
    -module-name LyricsCore \
    -emit-module -emit-module-path "$OUT/LyricsCore.swiftmodule" \
    -emit-library -static \
    -target "$ARCH-apple-macosx14.0" \
    -sdk "$SDK" \
    Sources/LyricsCore/*.swift \
    -o "$OUT/libLyricsCore.a"

swiftc -parse-as-library \
    -module-name LyricsCoreTestRunner \
    -target "$ARCH-apple-macosx14.0" \
    -sdk "$SDK" \
    -I "$OUT" -L "$OUT" -lLyricsCore \
    Tests/LyricsCoreTests/*.swift \
    -o "$OUT/LyricsCoreTestRunner"

"$OUT/LyricsCoreTestRunner"
