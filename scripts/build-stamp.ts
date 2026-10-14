#!/usr/bin/env bun
/**
 * Guard against the stale-`dist/` hazard.
 *
 *   bun run build      → `tsc` then `stamp`
 *   bun scripts/build-stamp.ts stamp   Record src content hash + git sha into dist/
 *   bun scripts/build-stamp.ts check   Fail when dist/ no longer matches src/
 *
 * `dist/` is gitignored and `server.js` re-exports `./dist/plugin.js`, so a
 * plugin built from an older tree is served silently and looks identical to the
 * current one. On 2026-10-14 the OpenCode service started at 13:22, the fix was
 * built at 13:25 and only reached the host at 13:52 — nothing in any log said
 * which commit was actually loaded. The stamp makes that one line.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")
const srcDir = path.join(repoRoot, "src")
const distDir = path.join(repoRoot, "dist")
const stampPath = path.join(distDir, ".build-stamp.json")

type Stamp = { srcHash: string; gitSha: string; builtAt: string }

/** Content hash over every source file, so the stamp survives branch switches. */
function hashSrc(): string {
  const hash = crypto.createHash("sha256")
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts")) {
        hash.update(path.relative(repoRoot, full))
        hash.update(fs.readFileSync(full))
      }
    }
  }
  walk(srcDir)
  return hash.digest("hex")
}

function gitSha(): string {
  try {
    const read = (args: string[]): string =>
      Buffer.from(
        Bun.spawnSync({ cmd: ["git", ...args], cwd: repoRoot, stdout: "pipe" }).stdout,
      ).toString().trim()
    const sha = read(["rev-parse", "--short", "HEAD"])
    if (!sha) return "unknown"
    return read(["status", "--porcelain"]).length > 0 ? `${sha}+dirty` : sha
  } catch {
    return "unknown"
  }
}

const mode = process.argv[2]
if (mode === "stamp") {
  if (!fs.existsSync(distDir)) {
    process.stderr.write("build-stamp: dist/ does not exist — run `tsc` first.\n")
    process.exit(1)
  }
  const stamp: Stamp = { srcHash: hashSrc(), gitSha: gitSha(), builtAt: new Date().toISOString() }
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`)
  process.stdout.write(`build-stamp: ${stamp.gitSha} @ ${stamp.builtAt}\n`)
} else if (mode === "check") {
  let stamp: Stamp | undefined
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, "utf8")) as Stamp
  } catch {
    process.stderr.write("build-stamp: no stamp in dist/ — run `bun run build`.\n")
    process.exit(1)
  }
  const current = hashSrc()
  if (current !== stamp!.srcHash) {
    process.stderr.write(
      `build-stamp: dist/ is STALE — built from ${stamp!.gitSha} at ${stamp!.builtAt}, `
      + "but src/ has changed since.\nA stale dist/ serves the host an old plugin silently. "
      + "Run `bun run build`, then `opencode service restart`.\n",
    )
    process.exit(1)
  }
  process.stdout.write(`build-stamp: dist/ matches src/ (${stamp!.gitSha}).\n`)
} else {
  process.stderr.write("usage: bun scripts/build-stamp.ts <stamp|check>\n")
  process.exit(2)
}
