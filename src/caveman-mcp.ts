import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

export type CavemanMcpOptions = {
  /** Absolute path to `caveman-mcp` (overrides env and default install). */
  mcpBin?: string
}

/**
 * Resolve a local `caveman-mcp` command for `ctx.mcp.transform`.
 * Skips missing paths silently so a machine without Caveman still loads the plugin.
 */
export function resolveCavemanMcpCommand(options?: CavemanMcpOptions): string[] | undefined {
  const candidates = [
    options?.mcpBin,
    process.env.CAVEMAN_MCP_BIN,
    path.join(resolveHome(), ".caveman", "bin", "caveman-mcp"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return [resolved]
    } catch {
      // Best effort — try the next candidate.
    }
  }
  return undefined
}
