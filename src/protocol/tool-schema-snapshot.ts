import fs from "node:fs"
import path from "node:path"
import { opencodeGlobalCacheDir } from "../context/paths.js"
import { trace } from "../debug.js"

/**
 * Durable record of the tool contract OpenCode actually advertised to us.
 *
 * The `filePath` outage lasted three days and produced 177 identical host
 * rejections because nothing anywhere held a copy of the contract that had
 * changed: OpenCode stores the *emitted* args, Cursor stores the model's, and
 * neither keeps the schema. This writes one, so the drift that matters is
 * diffable instead of discovered in production.
 *
 * Off unless `CURSOR_TOOL_SCHEMA_CAPTURE` is set — it writes to a path, or to
 * the OpenCode cache dir when the value is `1`. Writing happens once per
 * process, only for a real (non-lifecycle) turn, and never throws: a snapshot
 * is diagnostic, so it must not be able to break one.
 *
 * `bun run tools:capture` runs a one-shot prompt with this enabled and
 * refreshes `test/fixtures/host-tools.json`; `bun run tools:check` diffs the
 * newest snapshot against that fixture and names the keys that moved.
 */
export const TOOL_SCHEMA_SNAPSHOT_ENV = "CURSOR_TOOL_SCHEMA_CAPTURE"

export const TOOL_SCHEMA_SNAPSHOT_BASENAME = "cursor-tool-schemas.json"

let attempted = false

export function maybeWriteToolSchemaSnapshot(
  tools: readonly { name?: unknown; inputSchema?: unknown }[] | undefined,
): void {
  if (attempted || !tools || tools.length === 0) return
  const raw = process.env[TOOL_SCHEMA_SNAPSHOT_ENV]
  if (!raw || raw === "0") return
  attempted = true
  try {
    const target = resolveSnapshotPath(raw)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      target,
      `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        tools: tools
          .filter((tool) => typeof tool?.name === "string" && tool.name.length > 0)
          .map((tool) => ({ name: tool.name as string, inputSchema: tool.inputSchema ?? null })),
      }, null, 2)}\n`,
      { mode: 0o600 },
    )
    trace(`tool-schema snapshot written: ${target} (${tools.length} tools)`)
  } catch (error) {
    trace(`tool-schema snapshot failed: ${(error as Error).message}`)
  }
}

function resolveSnapshotPath(raw: string): string {
  if (raw === "1") return path.join(opencodeGlobalCacheDir(), TOOL_SCHEMA_SNAPSHOT_BASENAME)
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}
