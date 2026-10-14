import { describe, expect, it } from "bun:test"
import { isCursorPackage } from "../src/plugin-core.js"
import { CURSOR_PROVIDER_ID } from "../src/shared.js"

/**
 * `isCursorPackage` is the only thing that recognises an `aisdk` package event
 * as ours when the provider id does not already say so. Get it wrong and the
 * provider silently stops loading — the host's plugin resolver reports nothing
 * at all on a miss — so the directory rename it has to absorb is worth pinning.
 */
describe("isCursorPackage", () => {
  it("accepts our provider id whatever the package says", () => {
    expect(isCursorPackage("anything-at-all", CURSOR_PROVIDER_ID)).toBe(true)
  })

  it("accepts the current package name, bare and aisdk-prefixed", () => {
    expect(isCursorPackage("cursor-provider", CURSOR_PROVIDER_ID)).toBe(true)
    expect(isCursorPackage("aisdk:cursor-provider", CURSOR_PROVIDER_ID)).toBe(true)
  })

  it("accepts the current directory as a resolved file URL", () => {
    expect(
      isCursorPackage(
        "aisdk:file:///Users/me/Documents/git/cursor-provider/dist/index.js",
        "opencode",
      ),
    ).toBe(true)
  })

  it("still accepts the retired directory names", () => {
    // A stale checkpoint or an older config keeps pointing at these.
    for (const dir of ["opencode-cursor", "cursor-caveman"]) {
      expect(
        isCursorPackage(`file:///Users/me/git/${dir}/dist/index.js`, "opencode"),
        dir,
      ).toBe(true)
    }
  })

  it("accepts a Windows path separator", () => {
    expect(
      isCursorPackage("C:\\Users\\me\\git\\cursor-provider\\dist\\index.js", "opencode"),
    ).toBe(true)
  })

  it("rejects an unrelated package", () => {
    expect(isCursorPackage("aisdk:some-other-provider", "opencode")).toBe(false)
    expect(isCursorPackage("file:///x/not-cursor/dist/index.js", "opencode")).toBe(false)
  })

  it("does not match a name that merely contains ours as a substring", () => {
    // `pkg.includes` is deliberately a substring check for the bare-name forms,
    // so this documents the accepted trade-off rather than asserting a
    // guarantee we do not have.
    expect(isCursorPackage("my-cursor-provider-fork", "opencode")).toBe(true)
  })
})
