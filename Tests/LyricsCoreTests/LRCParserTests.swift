import LyricsCore

func registerLRCParserTests() {
    TestRuntime.add("parses timestamps and text") {
        let lines = LRCParser.parse("""
        [00:01.50] First line
        [00:04.25]Second line
        [01:02.123] Third line
        """)
        try expectEqual(lines, [
            LyricLine(time: 1.5, text: "First line"),
            LyricLine(time: 4.25, text: "Second line"),
            LyricLine(time: 62.123, text: "Third line"),
        ])
    }

    TestRuntime.add("ignores metadata tags and blank lines") {
        let lines = LRCParser.parse("""
        [ar: Artist]
        [ti: Title]

        [00:10.00] Only line
        """)
        try expectEqual(lines, [LyricLine(time: 10, text: "Only line")])
    }

    TestRuntime.add("expands lines with multiple timestamps") {
        let lines = LRCParser.parse("""
        [00:05.00][00:20.00] Chorus
        [00:10.00] Verse
        """)
        try expectEqual(lines.map(\.time), [5, 10, 20])
        try expectEqual(lines.map(\.text), ["Chorus", "Verse", "Chorus"])
    }

    TestRuntime.add("keeps empty timed lines as instrumental breaks") {
        let lines = LRCParser.parse("[00:01.00] Hello\n[00:05.00]\n[00:09.00] Again")
        try expectEqual(lines.map(\.text), ["Hello", "", "Again"])
    }

    TestRuntime.add("accepts colon-separated hundredths and whole seconds") {
        let lines = LRCParser.parse("[00:07:50] Colon\n[02:03] Whole")
        try expectEqual(lines.map(\.time), [7.5, 123])
    }

    TestRuntime.add("sorts by time keeping file order for ties") {
        let lines = LRCParser.parse("[00:09.00] C\n[00:01.00] A\n[00:01.00] B")
        try expectEqual(lines.map(\.text), ["A", "B", "C"])
    }

    TestRuntime.add("handles non-Latin text") {
        let lines = LRCParser.parse("[00:12.00] 너의 집 앞에서")
        try expectEqual(lines, [LyricLine(time: 12, text: "너의 집 앞에서")])
    }
}

func registerActiveLineTests() {
    let lyrics = Lyrics(
        lines: [LyricLine(time: 5, text: "a"), LyricLine(time: 10, text: "b"), LyricLine(time: 15, text: "c")],
        isSynced: true,
        isInstrumental: false
    )

    TestRuntime.add("active line is nil before first line") {
        try expect(lyrics.activeLineIndex(at: 2) == nil)
    }

    TestRuntime.add("picks latest started line") {
        try expect(lyrics.activeLineIndex(at: 5) == 0)
        try expect(lyrics.activeLineIndex(at: 12) == 1)
        try expect(lyrics.activeLineIndex(at: 100) == 2)
    }

    TestRuntime.add("lead highlights slightly early") {
        try expect(lyrics.activeLineIndex(at: 9.8, lead: 0.25) == 1)
    }

    TestRuntime.add("active line is nil for unsynced lyrics") {
        let plain = Lyrics(lines: [LyricLine(time: nil, text: "a")], isSynced: false, isInstrumental: false)
        try expect(plain.activeLineIndex(at: 30) == nil)
    }
}
