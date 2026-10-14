import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { appendDiagnostic, diagnosticsLogPath } from "../src/diagnostics.js"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-diagnostics-"))
  setHostCacheDirOverride(root)
})

afterEach(() => {
  setHostCacheDirOverride(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("diagnostics log", () => {
  it("lives beside the provider's other cache files", () => {
    expect(diagnosticsLogPath()).toBe(path.join(root, "cursor-arg-audit.log"))
  })

  it("appends one timestamped line per call and keeps the earlier ones", () => {
    appendDiagnostic("first drop")
    appendDiagnostic("second drop")
    const lines = fs.readFileSync(diagnosticsLogPath(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("first drop")
    expect(lines[1]).toContain("second drop")
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("creates the file 0600 — a drop audit outlives the call it describes", () => {
    appendDiagnostic("x")
    expect(fs.statSync(diagnosticsLogPath()).mode & 0o777).toBe(0o600)
  })

  it("rotates rather than growing without bound", () => {
    const file = diagnosticsLogPath()
    fs.writeFileSync(file, `${"x".repeat(256 * 1024)}\n`)
    appendDiagnostic("after rotation")
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toContain("after rotation")
  })

  it("never throws when the destination is unwritable", () => {
    // A diagnostics write that threw would fail the very turn it was
    // describing, which is worse than losing the warning.
    const blocked = path.join(root, "not-a-directory")
    fs.writeFileSync(blocked, "")
    setHostCacheDirOverride(blocked)
    expect(() => appendDiagnostic("x")).not.toThrow()
  })

  it("never throws when the cache dir cannot be resolved at all", () => {
    setHostCacheDirOverride("")
    expect(() => appendDiagnostic("x")).not.toThrow()
  })
})
