import { trace } from "../debug.js"

/**
 * Schema-driven argument adaptation for the Cursor ⇄ OpenCode translation layer.
 *
 * OpenCode advertises every tool's authoritative JSON Schema to us on each turn
 * (`OpencodeToolDef.inputSchema`, forwarded verbatim to Cursor by
 * `toolsToDescriptors`). This module reads that schema instead of maintaining a
 * second hand-written copy of it.
 *
 * The `filePath` outage (177 identical `- path: Missing key` host rejections)
 * was one half of that defect: a *renamed* key produced an error that named
 * itself. The other half never produces an error at all — when we silently drop
 * an optional key the host declares (`literal`, `hidden`, `background`, `limit`,
 * `caseSensitive`), the call succeeds with different semantics, or returns a
 * wrong answer, and no log anywhere records that the model asked for something
 * else. OpenCode only ever sees args we have already mapped.
 *
 * Three guarantees, in increasing order of severity:
 *
 *  1. {@link forwardDeclaredKeys} re-adds any schema-declared key the semantic
 *     builder did not explicitly handle, so optional keys can no longer be
 *     dropped by omission.
 *  2. {@link auditEmittedArgs} reports schema-declared keys that were supplied
 *     but not emitted — the silent half of the class.
 *  3. The same audit reports missing *required* keys before the call is sent,
 *     turning an opaque host rejection into a local diagnostic.
 *
 * Everything fails open. No schema ⇒ no rewriting and no reporting; the audit
 * warns but never blocks a send, because the host is the authority and a stale
 * or mis-read contract must never be able to break a turn.
 */

/**
 * Structural shape of an advertised tool. Kept loose — deliberately not
 * `OpencodeToolDef` — so this module stays cycle-free and callers can pass the
 * host's raw `Record<string, unknown>` descriptors straight through.
 */
export type ToolContractSource = {
  name?: unknown
  inputSchema?: unknown
}

export type ToolContract = {
  name: string
  /** Every property name the host schema declares. */
  keys: ReadonlySet<string>
  /** JSON-Schema `required[]`, reduced conservatively across combinators. */
  required: readonly string[]
  /** False when the host advertised no usable object schema for this tool. */
  schemaKnown: boolean
}

type ObjectShape = {
  keys: string[]
  required: string[]
}

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const

/**
 * Read an object shape out of an advertised JSON Schema.
 *
 * `anyOf`/`oneOf` branches are alternatives, so a key is only required when
 * *every* branch requires it (intersection). `allOf` is a conjunction, so the
 * branches combine (union). `$ref` and unrecognised wrappers yield `undefined`
 * rather than a guess — an unknown schema is handled by the fail-open path.
 */
function readObjectShape(schema: unknown, depth = 0): ObjectShape | undefined {
  if (!schema || typeof schema !== "object" || depth > 6) return undefined
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const shape = readObjectShape(entry, depth + 1)
      if (shape) return shape
    }
    return undefined
  }

  const record = schema as Record<string, unknown>
  const properties = record.properties
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    return {
      keys: Object.keys(properties as Record<string, unknown>),
      required: Array.isArray(record.required)
        ? record.required.filter((key): key is string => typeof key === "string" && key.length > 0)
        : [],
    }
  }

  for (const combinator of COMBINATORS) {
    const branches = record[combinator]
    if (!Array.isArray(branches)) continue
    const union: ObjectShape = { keys: [], required: [] }
    let intersection: string[] | undefined
    let sawShape = false
    for (const branch of branches) {
      const shape = readObjectShape(branch, depth + 1)
      if (!shape) continue
      sawShape = true
      for (const key of shape.keys) if (!union.keys.includes(key)) union.keys.push(key)
      const branchRequired = new Set(shape.required)
      intersection = intersection === undefined
        ? [...branchRequired]
        : intersection.filter((key) => branchRequired.has(key))
    }
    if (!sawShape) continue
    if (combinator === "allOf") {
      for (const key of union.required) if (!intersection!.includes(key)) intersection!.push(key)
      return { keys: union.keys, required: intersection! }
    }
    return { keys: union.keys, required: intersection ?? [] }
  }
  return undefined
}

/**
 * Build the per-turn contract map from OpenCode's advertised tool catalog.
 *
 * Keyed by the host's own tool id. Retired 1.x ids resolve through
 * {@link RETIRED_TOOL_ID_ALIASES} so a caller holding a legacy name still finds
 * the contract for the tool it actually becomes.
 */
export function buildToolContracts(
  tools: readonly ToolContractSource[] | undefined,
): Map<string, ToolContract> {
  const contracts = new Map<string, ToolContract>()
  for (const tool of tools ?? []) {
    const name = typeof tool?.name === "string" ? tool.name : ""
    if (name.length === 0) continue
    if (contracts.has(name)) continue
    const shape = readObjectShape(tool.inputSchema)
    contracts.set(
      name,
      shape
        ? { name, keys: new Set(shape.keys), required: shape.required, schemaKnown: true }
        : { name, keys: new Set(), required: [], schemaKnown: false },
    )
  }
  return contracts
}

/** The host's own rename table, applied when resolving a contract by name. */
const RETIRED_TOOL_ID_ALIASES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  apply_patch: "patch",
}

export function contractFor(
  contracts: ReadonlyMap<string, ToolContract> | undefined,
  toolName: string,
): ToolContract | undefined {
  if (!contracts) return undefined
  return contracts.get(toolName)
    ?? contracts.get(RETIRED_TOOL_ID_ALIASES[toolName] ?? "")
    ?? undefined
}

type Alias = readonly [source: string, target: string]

/**
 * Cursor/1.x spellings that must be rewritten to OpenCode's key names.
 *
 * Only *proven* renames live here: every entry is either documented by the
 * host's own post-compaction migration notice (which names `filePath`→`path`,
 * `file_text`→`content`, `old_string`/`new_string`, `subagent_type`→`agent`,
 * `task_id`→`sessionID`, `skill.name`→`id`) or asserted by an existing test or
 * a recorded production failure. Guessing at further aliases would recreate the
 * hand-mirrored schema this module exists to replace — anything the model
 * learns from the advertised schema needs no alias at all, and arrives under
 * its correct name.
 */
const GLOBAL_INBOUND_ALIASES: readonly Alias[] = [
  ["filePath", "path"],
  ["file_path", "path"],
  ["file_text", "content"],
  ["fileText", "content"],
  ["old_string", "oldString"],
  ["new_string", "newString"],
]

/**
 * Per-tool renames. Scoped because the same source key means different things
 * to different tools — `glob` is an *include filter* for `grep` but is not a
 * `glob`-tool key at all.
 */
const TOOL_INBOUND_ALIASES: Readonly<Record<string, readonly Alias[]>> = {
  shell: [["working_directory", "workdir"]],
  grep: [["glob", "include"]],
  glob: [
    ["glob_pattern", "pattern"],
    ["globPattern", "pattern"],
    ["target_directory", "path"],
    ["targetDirectory", "path"],
  ],
  skill: [["name", "id"]],
}

/**
 * Rewrite Cursor/1.x arg spellings onto OpenCode's key names, in place.
 *
 * A rename never overwrites a key the sender already supplied under the host's
 * own name: when both are present the host name wins and the alias source is
 * dropped, so the stale spelling cannot linger as an undeclared key.
 */
export function applyInboundAliases(toolName: string, args: Record<string, unknown>): void {
  for (const [source, target] of GLOBAL_INBOUND_ALIASES) aliasOnce(source, target, args)
  for (const [source, target] of TOOL_INBOUND_ALIASES[toolName] ?? []) aliasOnce(source, target, args)
}

function aliasOnce(source: string, target: string, args: Record<string, unknown>): void {
  if (!(source in args)) return
  if (target in args) {
    delete args[source]
    return
  }
  args[target] = args[source]
  delete args[source]
}

/**
 * Aliases whose correctness is decided by the *host's* declaration rather than
 * by a name table.
 *
 * The bound is deliberately two-sided: rename `<from>` to `<to>` only when the
 * tool's own schema declares `<to>`, does not declare `<from>`, and the caller
 * supplied `<from>`. Nothing is guessed — if a future tool declares both keys,
 * or neither, nothing happens. That makes this the only kind of alias that is
 * safe to grow without a recorded failure to point at.
 *
 * `script` → `code`: browser-mcp documents `browser_execute_script` as
 * accepting `script`, but OpenCode validates against the MCP schema first and
 * answers `- code: Missing key` (observed live, twice).
 */
const SCHEMA_DRIVEN_ALIASES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["script", "code"],
]

/** Rename caller keys only where the host's own schema proves the rename. */
export function applySchemaDrivenAliases(
  contract: ToolContract | undefined,
  args: Record<string, unknown>,
): void {
  if (!contract?.schemaKnown) return
  for (const [from, to] of SCHEMA_DRIVEN_ALIASES) {
    if (from === to || !(from in args)) continue
    if (contract.keys.has(from)) continue // the host accepts this spelling
    if (!contract.keys.has(to)) continue // the host does not want it either
    args[to] = args[from]
    delete args[from]
  }
}

/**
 * Copy every schema-declared key that `source` supplies and `target` has not
 * already set. This is what keeps optional keys from being dropped by omission:
 * `grep.literal`, `glob.hidden`, `shell.background`, `grep.limit` and friends
 * reach the host because they are in the schema, not because a hand-written
 * case remembered them.
 *
 * `suppress` lists keys the semantic builder deliberately omitted (OpenCode
 * treats `offset: 0` as "read zero lines", so protobuf zero-defaults must not
 * be forwarded).
 */
export function forwardDeclaredKeys(
  contract: ToolContract | undefined,
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
  suppress?: ReadonlySet<string>,
): void {
  if (!contract?.schemaKnown) return
  for (const key of contract.keys) {
    if (key in target) continue
    if (suppress?.has(key)) continue
    if (!(key in source)) continue
    target[key] = source[key]
  }
}

export type ArgAudit = {
  toolName: string
  /** Supplied, declared by the host, but not emitted. The silent failure mode. */
  droppedDeclared: string[]
  /** Required by the host schema but not emitted. Will be rejected. */
  missingRequired: string[]
  /** Supplied but not in the host schema: handled semantically, or unknown. */
  undeclared: string[]
  /** Key names we are about to send. Names only — never values. */
  emittedKeys: string[]
}

/**
 * Compare what we are about to send against what the host declares.
 * Returns `undefined` when there is nothing to report.
 */
export function auditEmittedArgs(input: {
  contract: ToolContract | undefined
  toolName: string
  sourceKeys: readonly string[] | undefined
  emitted: Readonly<Record<string, unknown>>
  suppress?: ReadonlySet<string>
}): ArgAudit | undefined {
  const { contract, toolName, sourceKeys, emitted, suppress } = input
  if (!contract?.schemaKnown || !sourceKeys || sourceKeys.length === 0) return undefined

  const droppedDeclared: string[] = []
  const undeclared: string[] = []
  for (const key of sourceKeys) {
    if (key in emitted) continue
    if (suppress?.has(key)) continue
    if (contract.keys.has(key)) droppedDeclared.push(key)
    else undeclared.push(key)
  }
  const missingRequired = contract.required.filter((key) => !(key in emitted))
  if (droppedDeclared.length === 0 && missingRequired.length === 0 && undeclared.length === 0) {
    return undefined
  }
  return {
    toolName,
    droppedDeclared,
    missingRequired,
    undeclared,
    // Key names only. The audit survives the call, so it must never retain arg
    // values — those can be whole file contents.
    emittedKeys: Object.keys(emitted),
  }
}

/**
 * Process-level dedupe for the always-on warnings.
 *
 * The `filePath` outage produced 177 identical failures across three days with
 * no signal at all. The fix is one loud line per distinct signature rather than
 * one per call: repetition carries no information, but silence carried none
 * either.
 */
const reportedSignatures = new Set<string>()

function reportOnce(signature: string, message: string): void {
  if (reportedSignatures.has(signature)) {
    trace(`arg-audit repeat: ${signature}`)
    return
  }
  reportedSignatures.add(signature)
  console.error(message)
}

/** Test seam: forget which signatures have already been reported. */
export function resetArgAuditReports(): void {
  reportedSignatures.clear()
}

/** Emit the always-on warnings and a debug trace for one audit result. */
export function reportArgAudit(audit: ArgAudit | undefined): void {
  if (!audit) return
  const { toolName, droppedDeclared, missingRequired, undeclared } = audit
  if (undeclared.length > 0) {
    trace(`arg-audit ${toolName}: undeclared=[${undeclared.join(", ")}]`)
  }
  if (droppedDeclared.length > 0) {
    const sorted = [...droppedDeclared].sort()
    reportOnce(
      `drop|${toolName}|${sorted.join(",")}`,
      `[cursor-provider] ${toolName}: dropping schema-declared arg key(s) `
      + `${sorted.map((key) => `\`${key}\``).join(", ")} — the host declares them but this `
      + `translator did not emit them, so the call runs with different semantics than the `
      + `model asked for. This is the silent half of the \`filePath\` failure class.`,
    )
  }
  if (missingRequired.length > 0) {
    const sorted = [...missingRequired].sort()
    reportOnce(
      `missing|${toolName}|${sorted.join(",")}`,
      `[cursor-provider] ${toolName}: sending a call the host schema will reject — required `
      + `arg key(s) ${sorted.map((key) => `\`${key}\``).join(", ")} are absent from the emitted `
      + `args. Expect \`Invalid arguments for tool "${toolName}"\`. `
      + `Emitted keys: ${audit.emittedKeys.join(", ") || "(none)"}.`,
    )
  }
}

/**
 * Contract lookup + audit + report in one call, for the hand-built arg sites
 * that bypass {@link mapCursorArgsToOpencode}: the native background-shell,
 * subagent and Pi-edit channels assemble OpenCode args by hand, so they get no
 * schema forwarding but still deserve the same missing-required pre-flight.
 */
export function auditArgsAgainstContract(
  contracts: ReadonlyMap<string, ToolContract> | undefined,
  toolName: string,
  sourceKeys: readonly string[],
  emitted: Readonly<Record<string, unknown>>,
  suppress?: ReadonlySet<string>,
): void {
  reportArgAudit(auditEmittedArgs({
    contract: contractFor(contracts, toolName),
    toolName,
    sourceKeys,
    emitted,
    suppress,
  }))
}
