import fs from "node:fs"
import path from "node:path"
import { opencodeGlobalCacheDir } from "./context/paths.js"

/**
 * Always-on diagnostics for signals that must survive a daemonised host.
 *
 * Verified 2026-10-14: plugin `console.error` never reaches
 * `~/.local/share/opencode/log/opencode.log`. The test was grepping a 46 MB
 * log *after* a `msg="loading plugin"` entry for this repo had been written —
 * the only `[cursor-provider]` hit in the whole file was our own shell command
 * echoed back by the host. A foreground `opencode run --standalone` surfaced
 * nothing either.
 *
 * That makes every `console.error` diagnostic in this repo unreachable in
 * production, which is fatal for the argument audit: its entire purpose is to
 * end the silent-drop failure mode the `filePath` outage produced, and its
 * dedupe guarantees the informative line is emitted exactly once, ever. If
 * nobody was watching at that instant, the signal is gone.
 *
 * `trace()` does reach a real file, but only under `CURSOR_PROVIDER_DEBUG=1`,
 * so it can carry detail but never an always-on signal. This module is the
 * always-on path.
 *
 * Fail-open by construction: a diagnostics write that throws must never be
 * able to fail the turn it was describing.
 */

/** Cap well above any plausible distinct-signature count; rotate past it. */
const MAX_BYTES = 256 * 1024

/** `<cache>/cursor-arg-audit.log` — beside `cursor-models.json` and friends. */
export function diagnosticsLogPath(): string {
  return path.join(opencodeGlobalCacheDir(), "cursor-arg-audit.log")
}

/**
 * Append one line to the always-on diagnostics log. Never throws, never
 * returns a value, and never sees argument *values* — callers pass key names
 * only, because a drop audit outlives the call it describes.
 */
export function appendDiagnostic(line: string): void {
  try {
    const file = diagnosticsLogPath()
    rotateIfFull(file)
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    /* ignore */
  }
}

function rotateIfFull(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* ignore */
  }
}
