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

/**
 * A large JSON array the engine classifies as `json` when bare and as `text`
 * the moment a sentence is put in front of it. That flip is the whole reason
 * the block fallback exists, so the fixture has to be big enough to trip it —
 * measured stable from 10 KB up.
 */
function makeJsonPayload(rows = 100): string {
  const list: Array<Record<string, unknown>> = []
  for (let i = 0; i < rows; i++) {
    list.push({
      ts: `2026-10-14T09:00:0${i % 10}Z`,
      level: "INFO",
      svc: "opencode",
      msg: "session tick",
      n: i * 137,
      ok: true,
    })
  }
  return JSON.stringify(list)
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

  // Regression: the engine infers its type, and one sentence of prose in front
  // of a pasted payload flipped it from `json` to `text`, which passes through.
  // "Here's my log, why is it broken" is the most common real prompt there is,
  // and it was saving nothing at all.
  test("a prose prefix no longer defeats compression of a pasted payload", () => {
    const payload = makeJsonPayload()
    const instruction = "Why is my build failing? Can you take a look at this?"
    const message = `${instruction}\n\n${payload}`

    // The payload alone is compressible; with a sentence in front the engine
    // refuses the whole message, so only the block fallback can save it.
    const bare = cavemanCompressText(payload)
    expect(bare.length).toBeLessThan(payload.length)

    const out = cavemanCompressText(message)
    expect(out.length).toBeLessThan(message.length)
    // The instruction the user actually wrote stays verbatim — only the
    // payload moved.
    expect(out.startsWith(instruction)).toBe(true)

    // The handle recovers the payload block byte-for-byte.
    const m = out.match(/recovery_handle="([^"]+)"/)
    expect(m).not.toBeNull()
    expect(engineRetrieve(m![1])).toBe(payload)
  })

  test("trailing prose after the payload does not block compression", () => {
    const payload = makeJsonPayload()
    const message = `Why is it failing?\n\n${payload}\n\nLet me know what to check next.`
    const out = cavemanCompressText(message)
    expect(out.length).toBeLessThan(message.length)
    expect(out).toContain("Let me know what to check next.")
  })

  // The shape OpenCode actually hands the provider when a file is attached.
  // Verified live: 16,972 → 384 tokens with the instruction above it intact.
  test("an attached <file> block compresses as json despite the wrapper", () => {
    const payload = makeJsonPayload()
    const message =
      "Search indexing is noisy. I attached a sample log.\n\n"
      + `<file name="sample.json">\n${payload}\n</file>`
    const out = cavemanCompressText(message)
    expect(out.length).toBeLessThan(message.length)
    expect(out).toContain("Search indexing is noisy.")
    const m = out.match(/recovery_handle="([^"]+)"/)
    expect(m).not.toBeNull()
    // The handle recovers the whole wrapped block, wrapper included.
    expect(engineRetrieve(m![1])).toBe(`<file name="sample.json">\n${payload}\n</file>`)
  })

  // Gap 1: the engine reads the whole block to infer its type, and a ``` fence
  // is enough on its own to make a good JSON payload come back as `text`. The
  // fences are stripped, the interior compressed, and the fences restored.
  test("a fenced payload compresses despite the ``` wrapper", () => {
    const payload = makeJsonPayload()
    const message = `Why is my build failing?\n\n\`\`\`json\n${payload}\n\`\`\``
    const out = cavemanCompressText(message)
    expect(out.length).toBeLessThan(message.length)
    expect(out.startsWith("Why is my build failing?")).toBe(true)
    // The fence itself survives, so the message still renders as code.
    expect(out).toContain("```json")

    const m = out.match(/recovery_handle="([^"]+)"/)
    expect(m).not.toBeNull()
    const recovered = engineRetrieve(m![1])
    // Depends on which path won: the block attempt (fences included) or the
    // interior attempt (fences excluded). Both must give back real bytes.
    expect(recovered === payload || recovered === `\`\`\`json\n${payload}\n\`\`\``).toBe(true)
  })

  // Gap 2: instruction and payload on consecutive lines with no blank line
  // between them form a single block, so they could never be split apart and
  // the instruction's prose kept the whole thing classified as `text`.
  test("a payload with no blank line after the instruction still compresses", () => {
    const payload = makeJsonPayload()
    const instruction = "Why is my build failing? Can you take a look at this?"
    const message = `${instruction}\n${payload}`

    const out = cavemanCompressText(message)
    expect(out.length).toBeLessThan(message.length)
    // The instruction survives verbatim, newline included.
    expect(out.startsWith(`${instruction}\n`)).toBe(true)

    const m = out.match(/recovery_handle="([^"]+)"/)
    expect(m).not.toBeNull()
    expect(engineRetrieve(m![1])).toBe(payload)
  })

  test("short blocks stay untouched when nothing clears the floor", () => {
    // The block fallback must not spawn the engine for pieces that are too
    // small to be worth it, and must leave the message byte-identical when no
    // block moves. The sentences vary in shape so the engine reads them as
    // prose rather than a table it could legitimately elide.
    const templates = [
      (n: number) => `Item ${n} never reproduced after the second cold start.`,
      (n: number) => `We shelved the ${n}th attempt at reconciling the two counters.`,
      (n: number) => `Nothing in the trace explains why request ${n} outlived its lease.`,
      (n: number) => `The ${n} retry budget turned out to be measuring the wrong window.`,
      (n: number) => `Half of the ${n} fixtures in this batch assert behaviour nobody wants.`,
    ]
    const blocks = Array.from({ length: 12 }, (_, i) =>
      templates[(i * 3 + 1) % templates.length]!(i * 7 + i % 5),
    )
    for (const block of blocks) expect(Buffer.byteLength(block, "utf8")).toBeLessThan(CAVEMAN_MIN_BYTES)
    const prose = blocks.join("\n\n")
    expect(Buffer.byteLength(prose, "utf8")).toBeGreaterThan(CAVEMAN_MIN_BYTES)
    expect(cavemanCompressText(prose)).toBe(prose)
  })
})
