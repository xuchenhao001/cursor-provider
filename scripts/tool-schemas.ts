#!/usr/bin/env bun
/**
 * Record and verify the host tool contract.
 *
 *   bun run tools:capture   Refresh `test/fixtures/host-tools.json` from the
 *                           schemas OpenCode advertises on a real turn.
 *   bun run tools:check     Diff the newest live snapshot against the fixture
 *                           and name the keys that moved.
 *
 * `capture` runs one tiny prompt through the Cursor provider — the provider is
 * the only component that sees `requestContext.tools`, so nothing else can
 * record the contract. `check` is best-effort by design: with no snapshot on
 * this machine it warns and exits 0, because a missing diagnostic must never
 * be able to block a build.
 */
import fs from "node:fs"
import path from "node:path"
import { opencodeGlobalCacheDir } from "../src/context/paths.js"

const repoRoot = path.resolve(import.meta.dir, "..")
const fixturePath = path.join(repoRoot, "test", "fixtures", "host-tools.json")
const snapshotPath = path.join(opencodeGlobalCacheDir(), "cursor-tool-schemas.json")
const note = "Recorded host tool contract. Captured from OpenCode's own advertised " +
  "`inputSchema` for a real turn (see src/protocol/tool-schema-snapshot.ts), not " +
  "hand-written and not derived from the binary. Regenerate with " +
  "`bun run tools:capture`; `bun run tools:check` names the keys that moved."

type Tool = { name: string; inputSchema?: unknown }
type Snapshot = { capturedAt?: string; opencodeVersion?: string; note?: string; tools: Tool[] }

function readSnapshot(file: string): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot
  } catch {
    return undefined
  }
}

function schemaOf(tool: Tool): { keys: string[]; required: string[] } {
  const schema = tool.inputSchema as Record<string, unknown> | undefined
  if (!schema || typeof schema !== "object") return { keys: [], required: [] }
  const properties = schema.properties
  const keys = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>)
    : []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : []
  return { keys: keys.sort(), required: required.sort() }
}

async function capture(): Promise<void> {
  const tmp = path.join(repoRoot, ".cursor-tool-schemas.capture.json")
  fs.rmSync(tmp, { force: true })
  const model = process.env.CURSOR_TOOL_SCHEMA_MODEL ?? "cursor/claude-haiku-4-5"
  process.stdout.write(`capturing host tool schemas via ${model} …\n`)
  const run = Bun.spawn({
    cmd: ["opencode", "run", "--standalone", "--auto", "--model", model, "say ok"],
    cwd: repoRoot,
    env: { ...process.env, CURSOR_TOOL_SCHEMA_CAPTURE: tmp },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await run.exited
  const captured = readSnapshot(tmp)
  if (code !== 0 || !captured?.tools?.length) {
    process.stderr.write(
      `\nfailed to capture (exit ${code}, snapshot=${captured?.tools?.length ?? 0} tools)\n`
      + `a capture needs the Cursor provider to handle the turn, so it needs Cursor credentials.\n`,
    )
    process.exit(1)
  }
  const version = await Bun.spawn({ cmd: ["opencode", "--version"], stdout: "pipe" })
    .stdout.text()
  fs.rmSync(tmp, { force: true })
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(
    fixturePath,
    `${JSON.stringify({
      note,
      opencodeVersion: version.trim(),
      capturedAt: captured.capturedAt,
      tools: captured.tools,
    }, null, 2)}\n`,
  )
  process.stdout.write(
    `wrote ${path.relative(repoRoot, fixturePath)}: ${captured.tools.length} tools `
    + `(${version.trim()})\n`,
  )
}

function check(): void {
  const live = readSnapshot(snapshotPath)
  if (!live?.tools?.length) {
    process.stdout.write(
      `tool-schemas check: skipped — no live snapshot at ${snapshotPath}.\n`
      + `Run any Cursor-provider turn with CURSOR_TOOL_SCHEMA_CAPTURE=1 to record one.\n`,
    )
    return
  }
  const fixture = readSnapshot(fixturePath)
  if (!fixture?.tools?.length) {
    process.stderr.write(`tool-schemas check: no fixture at ${fixturePath}. Run \`bun run tools:capture\`.\n`)
    process.exit(1)
  }

  const expected = new Map(fixture.tools.map((tool) => [tool.name, schemaOf(tool)]))
  const actual = new Map(live.tools.map((tool) => [tool.name, schemaOf(tool)]))
  const differences: string[] = []

  for (const [name, schema] of actual) {
    const prior = expected.get(name)
    if (!prior) {
      differences.push(`  + \`${name}\`: newly advertised [${schema.keys.join(", ")}]`)
      continue
    }
    if (prior.keys.join(",") === schema.keys.join(",")) continue
    const added = schema.keys.filter((key) => !prior.keys.includes(key))
    const removed = prior.keys.filter((key) => !schema.keys.includes(key))
    differences.push(
      `  ~ \`${name}\`: keys +[${added.join(", ")}] -[${removed.join(", ")}] `
      + `(was recorded as [${prior.keys.join(", ")}])`,
    )
  }
  for (const name of expected.keys()) {
    if (!actual.has(name)) differences.push(`  - \`${name}\`: no longer advertised`)
  }

  if (differences.length === 0) {
    process.stdout.write(
      `tool-schemas check: fixture matches the live host `
      + `(${live.opencodeVersion ?? "unknown version"}).\n`,
    )
    return
  }
  process.stderr.write(
    "host tool contract changed — the translator and its tests are now out of date:\n"
    + `${differences.join("\n")}\n`
    + `\nre-record with \`bun run tools:capture\`, then re-read `
    + "`mapCursorArgsToOpencode` for any renamed or added key.\n",
  )
  process.exit(1)
}

const command = process.argv[2]
if (command === "capture") await capture()
else if (command === "check") check()
else {
  process.stderr.write("usage: bun scripts/tool-schemas.ts <capture|check>\n")
  process.exit(2)
}
