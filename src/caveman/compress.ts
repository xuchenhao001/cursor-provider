import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Match caveman proxy: blocks under this size are not worth compressing. */
export const CAVEMAN_MIN_BYTES = Number(process.env.CAVEMAN_COMPRESS_MIN_BYTES ?? 512)

const RECOVERY_TOOL_RE = /^caveman[_-]?retrieve$/i

let warnedMissingEngine = false

export type CavemanCompressOptions = {
  toolName?: string
  /** Override engine binary (tests). */
  engineBin?: string | null
}

export function cavemanCompressEnabled(): boolean {
  const v = process.env.CAVEMAN_COMPRESS
  return v !== "0" && v !== "false"
}

export function isCavemanRecoveryTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  return RECOVERY_TOOL_RE.test(toolName)
}

// The engine's own elision marker. Once a string carries it, it was compressed
// by a previous turn; never re-compress (OpenCode resends history verbatim, and
// re-eliding already-elided text wastes a spawn and risks double-marking).
const CAVEMAN_ELISION_RE = /…\s*\d+\s+lines? elided \(caveman\)\s*…/

export function shouldSkipCavemanCompress(text: string, options?: CavemanCompressOptions): boolean {
  if (!cavemanCompressEnabled()) return true
  if (!text || text.length < CAVEMAN_MIN_BYTES) return true
  if (isCavemanRecoveryTool(options?.toolName)) return true
  if (CAVEMAN_ELISION_RE.test(text)) return true
  return false
}

export function resolveCavemanEngineBin(override?: string | null): string | null {
  if (override !== undefined) return override
  const fromEnv = process.env.CAVEMAN_ENGINE_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const homeBin = join(homedir(), ".caveman", "bin", "caveman-engine")
  if (existsSync(homeBin)) return homeBin
  const which = spawnSync("which", ["caveman-engine"], { encoding: "utf8" })
  if (which.status === 0) {
    const p = which.stdout.trim()
    if (p && existsSync(p)) return p
  }
  return null
}

// caveman-engine emits ONE flat JSON object on stderr, e.g.:
//   {"content_type":"log","tokens_before":1248,"tokens_after":132,
//    "token_count_basis":"o200k_base","ratio":0.894,"basis":"inferred",
//    "recovery_handle":"ccr_<hex>","method":"log","lossless_to_model":false}
// recovery_handle is omitted entirely on pass-through. Accept both the flat
// top-level field and a nested result/Result wrapper so a future engine that
// groups fields does not silently drop recovery.
type CompressReport = {
  recovery_handle?: string
  RecoveryHandle?: string
  result?: { recovery_handle?: string; RecoveryHandle?: string }
  Result?: { recovery_handle?: string; RecoveryHandle?: string }
}

function pickHandle(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function parseRecoveryHandle(stderr: string): string | undefined {
  const trimmed = stderr.trim()
  if (!trimmed) return undefined
  try {
    const report = JSON.parse(trimmed) as CompressReport
    return (
      pickHandle(report.recovery_handle) ??
      pickHandle(report.RecoveryHandle) ??
      pickHandle(report.result?.recovery_handle) ??
      pickHandle(report.Result?.RecoveryHandle)
    )
  } catch {
    const m = trimmed.match(/"recovery_handle"\s*:\s*"([^"]+)"/)
    return m?.[1]
  }
}

function appendRecoveryHint(text: string, handle: string): string {
  const line =
    `recover: call caveman_retrieve with recovery_handle="${handle}" to get these bytes back in full.`
  if (text.includes(line) || text.includes(handle)) return text
  return `${text}\n\n${line}`
}

/** One engine spawn. Returns the shrunken text and its handle, or null. */
function runCavemanEngine(
  bin: string,
  text: string,
): { compressed: string; handle?: string } | null {
  const proc = spawnSync(bin, ["compress"], {
    input: text,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (proc.error || proc.status !== 0) return null

  const out = proc.stdout
  if (!out || out.length === 0) return null
  // Never accept a non-shrinking result: that is the engine passing through,
  // and it would spend a recovery handle on bytes the model already has.
  if (out.length >= Buffer.byteLength(text, "utf8")) return null

  return {
    compressed: out.toString("utf8"),
    handle: parseRecoveryHandle(proc.stderr?.toString("utf8") ?? ""),
  }
}

// The engine *infers* its content type, and a few words of prose in front of a
// large structured payload flip it from `json`/`log` (which elide) to `text`
// (which passes through). Measured on a 46 KB JSON array: 20,293 → 315 tokens
// bare, 0% with one English sentence prepended — so the single most common real
// prompt, "here's my log, why is it broken", saved nothing. Whole-message
// compression therefore had to be the *first* attempt, not the only one. When
// it passes through, retry on the largest blank-line-separated blocks so the
// instruction stays verbatim and only the payload moves.
const MAX_BLOCK_ATTEMPTS = 3

function splitOnBlankLines(text: string): { parts: string[]; delims: string[] } {
  const parts: string[] = []
  const delims: string[] = []
  const re = /\n[ \t]*\n/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(last, m.index))
    delims.push(m[0])
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return { parts, delims }
}

/**
 * Gap 2: a payload written directly under its instruction, with no blank line
 * between them, is one block — so the instruction and the payload can never be
 * compressed separately, and the instruction's prose keeps the whole block
 * classified as `text`. When the message did not split at all, split it at the
 * first newline instead: line one is essentially always the instruction, and
 * everything after it is the payload. The `CAVEMAN_MIN_BYTES` filter still
 * drops the instruction, so only the payload is ever sent to the engine.
 */
function splitSingleBlock(text: string): { parts: string[]; delims: string[] } {
  const nl = text.indexOf("\n")
  if (nl < 0) return { parts: [text], delims: [] }
  return { parts: [text.slice(0, nl), text.slice(nl + 1)], delims: ["\n"] }
}

/**
 * Gap 1: the engine reads the *whole* block to infer its type, and a
 * ```` ``` ```` fence is enough to make a perfectly good JSON payload come back
 * as `text` — 0% saved, exactly like the prose prefix it was introduced to fix.
 * Strip the fences, compress the interior, put them back byte for byte.
 */
const FENCE_RE = /^( {0,3}`{3,}[^\n]*\n)([\s\S]*?)(\n {0,3}`{3,}[ \t]*)$/

function compressFencedInterior(
  bin: string,
  part: string,
): { compressed: string; handle?: string } | null {
  const m = part.match(FENCE_RE)
  if (!m) return null
  const [, open, body, close] = m
  if (!body || body.length < CAVEMAN_MIN_BYTES) return null
  const result = runCavemanEngine(bin, body)
  if (!result) return null
  return { compressed: `${open}${result.compressed}${close}`, handle: result.handle }
}

/**
 * Compress the largest blocks independently, preserving every byte of the
 * blocks that do not move. Returns null when nothing shrank so the caller can
 * fall back to the original text untouched.
 */
function compressLargestBlocks(bin: string, text: string): string | null {
  let { parts, delims } = splitOnBlankLines(text)
  // Nothing to split on: fall back to the first newline so the instruction and
  // the payload are not forced to share one block.
  if (parts.length === 1) ({ parts, delims } = splitSingleBlock(parts[0]!))
  const candidates = parts
    .map((part, index) => ({ part, index }))
    .filter(
      ({ part }) => part.length >= CAVEMAN_MIN_BYTES && !CAVEMAN_ELISION_RE.test(part),
    )
    .sort((a, b) => b.part.length - a.part.length)
    .slice(0, MAX_BLOCK_ATTEMPTS)

  const replaced = [...parts]
  const handles: string[] = []
  let changed = false
  for (const { part, index } of candidates) {
    // Try the block as-is first; only strip fences if that passed through.
    const result = runCavemanEngine(bin, part) ?? compressFencedInterior(bin, part)
    if (!result) continue
    replaced[index] = result.compressed
    changed = true
    if (result.handle) handles.push(result.handle)
  }
  if (!changed) return null

  let out = ""
  for (let i = 0; i < replaced.length; i++) {
    if (i > 0) out += delims[i - 1]!
    out += replaced[i]!
  }
  for (const handle of handles) out = appendRecoveryHint(out, handle)
  return out
}

/**
 * Structural lossy compression via caveman-engine. Fail-open: returns input on
 * any error, missing binary, or non-shrinking result.
 */
export function cavemanCompressText(text: string, options?: CavemanCompressOptions): string {
  if (shouldSkipCavemanCompress(text, options)) return text

  const bin = resolveCavemanEngineBin(options?.engineBin)
  if (!bin) {
    if (!warnedMissingEngine) {
      warnedMissingEngine = true
      console.warn(
        "[cursor-caveman-provider] caveman-engine not found; log compression disabled. " +
          "Install @caveman-ai/cli or set CAVEMAN_ENGINE_BIN.",
      )
    }
    return text
  }

  const whole = runCavemanEngine(bin, text)
  if (whole) {
    return whole.handle ? appendRecoveryHint(whole.compressed, whole.handle) : whole.compressed
  }
  // Nothing moved on the message as a whole. That is almost always the type
  // inference tripping over a prose prefix, so give the payload one more chance
  // on its own; every other outcome stays exactly as it was.
  return compressLargestBlocks(bin, text) ?? text
}
