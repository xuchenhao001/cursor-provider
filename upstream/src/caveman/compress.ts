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

  const proc = spawnSync(bin, ["compress"], {
    input: text,
    maxBuffer: 64 * 1024 * 1024,
  })

  if (proc.error || proc.status !== 0) {
    return text
  }

  const out = proc.stdout
  if (!out || out.length === 0) return text
  if (out.length >= Buffer.byteLength(text, "utf8")) return text

  let compressed = out.toString("utf8")
  const handle = parseRecoveryHandle(proc.stderr?.toString("utf8") ?? "")
  if (handle) compressed = appendRecoveryHint(compressed, handle)
  return compressed
}
