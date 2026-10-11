import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const pkg = JSON.parse(read("../package.json"))

describe("bundled plugin", () => {
  it("loads the way Cider 4 does, as an ES module with a default export", async () => {
    const plugin = (await import("../dist/plugin.js")).default
    assert.equal(plugin.identifier, "com.jpark9013.apple-music-translator")
    assert.equal(plugin.version, pkg.version)
    assert.ok(plugin.pluginKitVersion)
    assert.equal(typeof plugin.setup, "function")
    assert.equal(plugin.SettingsElement, "amt-translator-settings")
  })

  it("ships manifests that agree with package.json", () => {
    const yml = read("../dist/plugin.yml")
    const json = JSON.parse(read("../dist/plugin.json"))
    assert.match(yml, new RegExp(`^version: ${pkg.version.replaceAll(".", "\\.")}$`, "m"))
    assert.match(yml, /^identifier: com\.jpark9013\.apple-music-translator$/m)
    assert.match(yml, /^entry: plugin\.js$/m)
    assert.equal(json.version, pkg.version)
  })
})
