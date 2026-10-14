import fs from "node:fs"
import { fileURLToPath } from "node:url"

export type BuildStamp = {
  /** sha256 over every `src/**` file at build time. */
  srcHash: string
  /** Commit `dist/` was built from, `+dirty` when the tree was not clean. */
  gitSha: string
  builtAt: string
}

let cached: { stamp?: BuildStamp } | undefined

/**
 * Which tree `dist/` was actually built from.
 *
 * Read next to this module, so `dist/plugin.js` reports the stamp of its own
 * build. `dist/` is gitignored and `server.js` re-exports it, which means an
 * unbuilt change is served to the host as if it were live — silently, and with
 * no way to tell from the outside. This makes "which commit is loaded?" one log
 * line. Fails open: a missing stamp is reported as absent, never as a guess.
 */
export function readBuildStamp(): BuildStamp | undefined {
  if (cached) return cached.stamp
  try {
    const file = fileURLToPath(new URL("./.build-stamp.json", import.meta.url))
    cached = { stamp: JSON.parse(fs.readFileSync(file, "utf8")) as BuildStamp }
  } catch {
    cached = {}
  }
  return cached.stamp
}
