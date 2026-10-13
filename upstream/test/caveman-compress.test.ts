import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CAVEMAN_MIN_BYTES,
  cavemanCompressText,
  isCavemanRecoveryTool,
  resolveCavemanEngineBin,
  shouldSkipCavemanCompress,
} from "../src/caveman/compress.js"

// The real engine, when present, gives us a true round-trip. Without it these
// integration tests skip and the unit tests below still guard the fail-open path.
const engineBin = resolveCavemanEngineBin()
const haveEngine = engineBin !== null

function makeLog(): string {
  const lines: string[] = []
  for (let i = 0; i < 60; i++) {
    lines.push(`2026-10-13T10:00:${String(i % 60).padStart(2, "0")}Z INFO  service starting up ok`)
  }
  lines.splice(20, 0, "2026-10-13T10:00:20Z ERROR database connection refused: dial tcp 10.0.0.5:5432")
  lines.push("2026-10-13T10:01:00Z INFO service stopped")
  return lines.join("\n")
}

function engineRetrieve(handle: string): string | null {
  if (!engineBin) return null
  const p = spawnSync(engineBin, ["retrieve", handle], { encoding: "utf8" })
  if (p.status !== 0) return null
  return p.stdout
}

describe("caveman compress (unit)", () => {
  test("skips short text", () => {
    const short = "x".repeat(CAVEMAN_MIN_BYTES - 1)
    expect(shouldSkipCavemanCompress(short)).toBe(true)
    expect(cavemanCompressText(short, { engineBin: null })).toBe(short)
  })

  test("skips caveman_retrieve output", () => {
    const big = "x".repeat(CAVEMAN_MIN_BYTES + 10)
    expect(isCavemanRecoveryTool("caveman_retrieve")).toBe(true)
    expect(shouldSkipCavemanCompress(big, { toolName: "caveman_retrieve" })).toBe(true)
  })

  test("fail-open when engine missing", () => {
    const big = "INFO line\n".repeat(80)
    expect(cavemanCompressText(big, { engineBin: null })).toBe(big)
  })

  test("skips text already carrying a caveman elision marker (idempotent guard)", () => {
    const marked = "head\n… 5 lines elided (caveman) …\ntail\n" + "pad".repeat(300)
    expect(shouldSkipCavemanCompress(marked)).toBe(true)
  })
})

const integration = haveEngine ? describe : describe.skip

integration("caveman compress (integration, real engine)", () => {
  test("log shrinks, keeps the ERROR line, and a handle recovers the original", () => {
    const log = makeLog()
    expect(Buffer.byteLength(log, "utf8")).toBeGreaterThan(CAVEMAN_MIN_BYTES)

    const out = cavemanCompressText(log)
    // Strictly smaller, and the error line survives.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(Buffer.byteLength(log, "utf8"))
    expect(out).toContain("ERROR database connection refused")
    expect(out).toContain("lines elided (caveman)")

    // A recovery handle must be exposed and resolve to byte-identical original.
    const m = out.match(/recovery_handle="([^"]+)"/)
    expect(m).not.toBeNull()
    const original = engineRetrieve(m![1])
    expect(original).not.toBeNull()
    expect(original).toBe(log)
  })

  test("a second compress of compressed output does not drop the error or marker", () => {
    const once = cavemanCompressText(makeLog())
    const twice = cavemanCompressText(once)
    expect(twice).toContain("ERROR database connection refused")
    expect(twice).toContain("lines elided (caveman)")
  })

  test("short user message passes through unchanged", () => {
    const msg = "What is the capital of France?"
    expect(cavemanCompressText(msg)).toBe(msg)
  })
})
