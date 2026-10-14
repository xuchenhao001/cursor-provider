import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { diagnosticsLogPath } from "../src/diagnostics.js"
import {
  applyInboundAliases,
  applySchemaDrivenAliases,
  auditArgsAgainstContract,
  auditEmittedArgs,
  buildToolContracts,
  contractFor,
  forwardDeclaredKeys,
  reportArgAudit,
  resetArgAuditReports,
  type ToolContract,
} from "../src/protocol/tool-contract.js"
import { mapCursorArgsToOpencode, parseExecServerMessage } from "../src/protocol/tools.js"

/**
 * Contract regression gate.
 *
 * The fixture is not a hand-written table of what we think OpenCode accepts —
 * it is a recording of the `inputSchema` OpenCode advertised on a real turn.
 * Every assertion here is therefore about the *host's* declaration, so the day
 * OpenCode renames or adds a key these tests name it instead of letting a
 * translator ship a silently-dropping mapper against it.
 *
 * This is the class gate for the `filePath` outage: 177 identical host
 * rejections over three days, produced by a hand-mirrored arg table that no
 * test compared against anything real.
 */

type Fixture = {
  note?: string
  opencodeVersion?: string
  capturedAt?: string
  tools: Array<{ name: string; inputSchema?: unknown }>
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "host-tools.json"), "utf8"),
) as Fixture

const contracts: ReadonlyMap<string, ToolContract> = buildToolContracts(fixture.tools)

/** Builtins this translator owns. MCP tools are passed through untouched. */
const HOST_BUILTINS = new Set([
  "edit", "glob", "grep", "read", "shell", "skill", "subagent", "websearch", "webfetch", "write",
])

describe("recorded host contract", () => {
  it("parses an object shape for every advertised builtin", () => {
    for (const name of HOST_BUILTINS) {
      const contract = contractFor(contracts, name)
      expect(contract?.schemaKnown, `no schema for \`${name}\``).toBe(true)
      expect(contract!.keys.size, `\`${name}\` declares no keys`).toBeGreaterThan(0)
    }
  })

  // These are the exact keys the hand-mirrored mapper used to drop. If this
  // fails the host changed, and the mapper must be re-read before anything
  // else in this file is trusted.
  it("declares the optional keys that were being dropped", () => {
    expect([...contractFor(contracts, "grep")!.keys].sort())
      .toEqual(["caseSensitive", "include", "limit", "literal", "path", "pattern"])
    expect([...contractFor(contracts, "glob")!.keys].sort())
      .toEqual(["hidden", "limit", "path", "pattern"])
    expect([...contractFor(contracts, "shell")!.keys].sort())
      .toEqual(["background", "command", "timeout", "workdir"])
  })

  it("declares `edit` without an `input` key", () => {
    // The mapper used to emit `{input}` for Cursor's ed-style line edit.
    expect(contractFor(contracts, "edit")!.keys.has("input")).toBe(false)
    expect(contractFor(contracts, "edit")!.required).toEqual(["path", "oldString", "newString"])
  })

  it("renames the file-target key `filePath` to `path`", () => {
    for (const name of ["read", "write", "edit"]) {
      const contract = contractFor(contracts, name)!
      expect(contract.keys.has("path"), `${name}.path`).toBe(true)
      expect(contract.keys.has("filePath"), `${name}.filePath`).toBe(false)
    }
  })

  it("selects the subagent with `agent`, not `subagent_type`", () => {
    const contract = contractFor(contracts, "subagent")!
    expect(contract.keys.has("agent")).toBe(true)
    expect(contract.keys.has("subagent_type")).toBe(false)
    expect(contract.required).toEqual(["agent", "description", "prompt"])
  })

  it("selects a skill with `id`, not `name`", () => {
    const contract = contractFor(contracts, "skill")!
    expect(contract.keys.has("id")).toBe(true)
    expect(contract.keys.has("name")).toBe(false)
  })
})

/**
 * Feed a Cursor-shaped call through the translator and assert the result
 * satisfies the recorded host contract: every required key present, no
 * undeclared key emitted.
 */
function mapAndAssert(
  toolName: string,
  input: Record<string, unknown>,
  execVariant?: string,
): { toolName: string; args: Record<string, unknown> } {
  resetArgAuditReports()
  const mapped = mapCursorArgsToOpencode(toolName, input, execVariant, contracts)
  const contract = contractFor(contracts, mapped.toolName)!
  const missing = contract.required.filter((key) => !(key in mapped.args))
  const undeclared = Object.keys(mapped.args).filter((key) => !contract.keys.has(key))
  expect(missing, `\`${mapped.toolName}\` is missing required keys`).toEqual([])
  expect(undeclared, `\`${mapped.toolName}\` emitted undeclared keys`).toEqual([])

  // The translator's own pre-flight must agree with ours.
  const audit = auditEmittedArgs({
    contract,
    toolName: mapped.toolName,
    sourceKeys: Object.keys(input),
    emitted: mapped.args,
  })
  expect(audit?.missingRequired ?? [], "required keys are absent").toEqual([])
  return mapped
}

describe("translator satisfies the recorded host contract", () => {
  it("read: `filePath` becomes `path`, protobuf zero-defaults stay omitted", () => {
    const mapped = mapAndAssert("read", { filePath: "/a.ts", offset: 0, limit: 0 })
    expect(mapped).toEqual({ toolName: "read", args: { path: "/a.ts" } })
  })

  it("read: forwards offset and limit when they are real", () => {
    const mapped = mapAndAssert("read", { filePath: "/a.ts", offset: 40, limit: 12 })
    expect(mapped).toEqual({ toolName: "read", args: { path: "/a.ts", offset: 40, limit: 12 } })
  })

  it("write: `file_text` becomes `content`", () => {
    const mapped = mapAndAssert("write", { filePath: "/a.ts", file_text: "body" })
    expect(mapped).toEqual({ toolName: "write", args: { path: "/a.ts", content: "body" } })
  })

  it("edit: `old_string`/`new_string` become `oldString`/`newString`", () => {
    const mapped = mapAndAssert("edit", {
      filePath: "/a.ts",
      old_string: "a",
      new_string: "b",
    })
    expect(mapped).toEqual({
      toolName: "edit",
      args: { path: "/a.ts", oldString: "a", newString: "b" },
    })
  })

  it("edit: forwards `replaceAll` declared by the host", () => {
    const mapped = mapAndAssert("edit", {
      path: "/a.ts",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    })
    expect(mapped.args.replaceAll).toBe(true)
  })

  it("grep: native `glob` becomes `include`", () => {
    const mapped = mapAndAssert("grep", { pattern: "foo", path: "/src", glob: "*.ts" }, "grep_args")
    expect(mapped).toEqual({ toolName: "grep", args: { pattern: "foo", path: "/src", include: "*.ts" } })
  })

  // The silent half of the class: `literal` was advertised to Cursor and then
  // discarded, so literal text ran as a regex and produced `Invalid regex`.
  it("grep: forwards `literal`, `caseSensitive` and `limit`", () => {
    const mapped = mapAndAssert("grep", {
      pattern: "a.b",
      path: "/src",
      include: "*.ts",
      literal: true,
      caseSensitive: false,
      limit: 25,
    }, "mcp_args")
    expect(mapped.args).toEqual({
      pattern: "a.b",
      path: "/src",
      include: "*.ts",
      literal: true,
      caseSensitive: false,
      limit: 25,
    })
  })

  it("grep: an empty pattern with a glob becomes a `glob` call", () => {
    const mapped = mapAndAssert("grep", { path: "/src", glob: "**/*.ts" }, "grep_args")
    expect(mapped).toEqual({ toolName: "glob", args: { pattern: "**/*.ts", path: "/src" } })
  })

  it("glob: forwards `hidden` and `limit`", () => {
    const mapped = mapAndAssert("glob", { pattern: "**/*", hidden: true, limit: 5 }, "mcp_args")
    expect(mapped.args).toEqual({ pattern: "**/*", hidden: true, limit: 5 })
  })

  it("shell: `working_directory` becomes `workdir`", () => {
    const mapped = mapAndAssert("shell", {
      command: "ls",
      working_directory: "/tmp",
      timeout: 5000,
    }, "shell_args")
    expect(mapped).toEqual({
      toolName: "shell",
      args: { command: "ls", workdir: "/tmp", timeout: 5000 },
    })
  })

  it("shell: forwards `background`", () => {
    const mapped = mapAndAssert("shell", { command: "sleep 600", background: true }, "mcp_args")
    expect(mapped.args).toEqual({ command: "sleep 600", background: true })
  })

  it("skill: `name` becomes `id`", () => {
    const mapped = mapAndAssert("skill", { name: "redesign" }, "mcp_args")
    expect(mapped).toEqual({ toolName: "skill", args: { id: "redesign" } })
  })

  it("subagent: `subagent_type` becomes a mapped `agent`", () => {
    const mapped = mapAndAssert("subagent", {
      subagent_type: "cursor-guide",
      prompt: "explore the repo",
    }, "mcp_args")
    expect(mapped.toolName).toBe("subagent")
    expect(mapped.args.agent).toBe("explore")
    expect(mapped.args.prompt).toBe("explore the repo")
    expect(String(mapped.args.description).length).toBeGreaterThan(0)
    // The retired keys must not survive into the payload the host validates.
    expect("subagent_type" in mapped.args).toBe(false)
  })

  it("subagent: `task_id`/`resume_agent_id` become `sessionID`", () => {
    const mapped = mapAndAssert("subagent", {
      agent: "explore",
      prompt: "carry on",
      task_id: "ses_abc",
    }, "mcp_args")
    expect(mapped.args.sessionID).toBe("ses_abc")
    expect("task_id" in mapped.args).toBe(false)
  })

  it("native subagent_args: retires `subagent_type`/`resume_agent_id`", () => {
    const parsed = parseExecServerMessage({
      id: 1,
      exec_id: "exec-1",
      subagent_args: { prompt: "look around", subagent_type: "cursor-guide", resume_agent_id: "ses_abc" },
    }, contracts)!
    expect(parsed.toolName).toBe("subagent")
    expect(parsed.args.agent).toBe("explore")
    expect(parsed.args.sessionID).toBe("ses_abc")
    expect(parsed.args.background).toBeUndefined()
    expect("subagent_type" in parsed.args).toBe(false)
    expect("resume_agent_id" in parsed.args).toBe(false)
  })

  it("passes an MCP tool through untouched when the mapper owns no case", () => {
    const mapped = mapAndAssert("websearch", { query: "opencode v2" }, "mcp_args")
    expect(mapped).toEqual({ toolName: "websearch", args: { query: "opencode v2" } })
  })
})

describe("argument audit", () => {
  const contract = contractFor(contracts, "grep")!

  it("reports a schema-declared key the translator did not emit", () => {
    // Exactly the bug class: the host declares it, the model supplied it, and
    // a hand-written case list silently discarded it.
    const audit = auditEmittedArgs({
      contract,
      toolName: "grep",
      sourceKeys: ["pattern", "literal"],
      emitted: { pattern: "a" },
    })
    expect(audit?.droppedDeclared).toEqual(["literal"])
  })

  it("reports nothing once the key is forwarded", () => {
    const audit = auditEmittedArgs({
      contract,
      toolName: "grep",
      sourceKeys: ["pattern", "literal"],
      emitted: { pattern: "a", literal: true },
    })
    expect(audit).toBeUndefined()
  })

  it("reports required keys that are absent", () => {
    const audit = auditEmittedArgs({
      contract,
      toolName: "grep",
      sourceKeys: ["path"],
      emitted: { path: "/src" },
    })
    expect(audit?.missingRequired).toEqual(["pattern"])
    expect(audit?.emittedKeys).toEqual(["path"])
  })

  it("does not report a key the builder omitted on purpose", () => {
    const read = contractFor(contracts, "read")!
    const audit = auditEmittedArgs({
      contract: read,
      toolName: "read",
      sourceKeys: ["path", "limit"],
      emitted: { path: "/a.ts" },
      suppress: new Set(["limit"]),
    })
    expect(audit).toBeUndefined()
  })

  it("fails open without a contract", () => {
    expect(auditEmittedArgs({
      contract: undefined,
      toolName: "grep",
      sourceKeys: ["pattern", "literal"],
      emitted: { pattern: "a" },
    })).toBeUndefined()
  })

  it("fails open when the host advertised no usable schema", () => {
    const bare = buildToolContracts([{ name: "weird", inputSchema: { $ref: "#/x" } }]).get("weird")!
    expect(bare.schemaKnown).toBe(false)
    expect(auditEmittedArgs({
      contract: bare,
      toolName: "weird",
      sourceKeys: ["a"],
      emitted: {},
    })).toBeUndefined()
  })
})

describe("schema-driven forwarding", () => {
  it("adds declared keys the semantic builder never handled", () => {
    const target: Record<string, unknown> = { pattern: "a" }
    forwardDeclaredKeys(contractFor(contracts, "glob"), target, { pattern: "a", hidden: true, limit: 3 })
    expect(target).toEqual({ pattern: "a", hidden: true, limit: 3 })
  })

  it("never overwrites a key the builder already set", () => {
    const target: Record<string, unknown> = { pattern: "kept" }
    forwardDeclaredKeys(contractFor(contracts, "glob"), target, { pattern: "other", hidden: true })
    expect(target).toEqual({ pattern: "kept", hidden: true })
  })

  it("respects the deliberate-omission suppress set", () => {
    const target: Record<string, unknown> = {}
    forwardDeclaredKeys(
      contractFor(contracts, "read"),
      target,
      { limit: 0 },
      new Set(["limit"]),
    )
    expect(target).toEqual({})
  })

  it("does nothing without a contract", () => {
    const target: Record<string, unknown> = {}
    forwardDeclaredKeys(undefined, target, { hidden: true })
    expect(target).toEqual({})
  })
})

describe("schema-driven aliases", () => {
  // browser-mcp's execute-script. The vendor's description advertises `script`,
  // OpenCode validates the MCP schema, and the call failed with
  // `- code: Missing key` (observed live, twice).
  it("renames `script` to `code` when — and only when — the host declares `code`", () => {
    const declaresCode = buildToolContracts([{
      name: "browser-mcp_browser_execute_script",
      inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    }])
    const mapped = mapCursorArgsToOpencode(
      "browser-mcp_browser_execute_script",
      { script: "document.title" },
      "mcp_args",
      declaresCode,
    )
    expect(mapped.args).toEqual({ code: "document.title" })
  })

  it("leaves the key alone when the host declares both spellings", () => {
    const both = buildToolContracts([{
      name: "both",
      inputSchema: { type: "object", properties: { code: {}, script: {} } },
    }])
    const args = { script: "x" }
    applySchemaDrivenAliases(contractFor(both, "both"), args)
    expect(args).toEqual({ script: "x" })
  })

  it("leaves the key alone when the host declares neither", () => {
    const neither = buildToolContracts([{
      name: "neither",
      inputSchema: { type: "object", properties: { other: {} } },
    }])
    const args = { script: "x" }
    applySchemaDrivenAliases(contractFor(neither, "neither"), args)
    expect(args).toEqual({ script: "x" })
  })

  it("does nothing without a contract, so an unknown tool still passes through", () => {
    const args = { script: "x" }
    applySchemaDrivenAliases(undefined, args)
    expect(args).toEqual({ script: "x" })
  })
})

describe("inbound aliases", () => {
  it("renames Cursor spellings onto the host's key names", () => {
    const args: Record<string, unknown> = { filePath: "/a", file_text: "x", old_string: "a" }
    applyInboundAliases("edit", args)
    expect(args).toEqual({ path: "/a", content: "x", oldString: "a" })
  })

  it("lets the host's own spelling win when both are present", () => {
    const args: Record<string, unknown> = { path: "/host", filePath: "/stale" }
    applyInboundAliases("read", args)
    expect(args).toEqual({ path: "/host" })
  })

  it("scopes `glob` to grep so it cannot leak into other tools", () => {
    const grep: Record<string, unknown> = { pattern: "a", glob: "*.ts" }
    applyInboundAliases("grep", grep)
    expect(grep).toEqual({ pattern: "a", include: "*.ts" })

    const other: Record<string, unknown> = { pattern: "a", glob: "*.ts" }
    applyInboundAliases("write", other)
    expect(other).toEqual({ pattern: "a", glob: "*.ts" })
  })
})

describe("contract lookup", () => {
  it("resolves through the host's own retired-id rename table", () => {
    expect(contractFor(contracts, "bash")?.name).toBe("shell")
    expect(contractFor(contracts, "task")?.name).toBe("subagent")
  })

  it("maps `apply_patch` onto `patch`, which may not be advertised", () => {
    // `patch` is a plugin tool, so it is absent from a bare turn's catalog.
    // The lookup must still target its id, and fail open when it is missing.
    expect(contractFor(contracts, "apply_patch")).toBeUndefined()
    const withPatch = buildToolContracts([
      { name: "patch", inputSchema: { type: "object", properties: { patchText: {} } } },
    ])
    expect(contractFor(withPatch, "apply_patch")?.name).toBe("patch")
  })

  it("reports unknown tools as absent rather than inventing a contract", () => {
    expect(contractFor(contracts, "nope")).toBeUndefined()
    expect(contractFor(undefined, "read")).toBeUndefined()
  })

  it("ignores catalog entries without a usable name", () => {
    const built = buildToolContracts([{ name: "" }, { name: undefined } as never, { name: "read" }])
    expect([...built.keys()]).toEqual(["read"])
  })
})

// Keep the helper referenced so a future edit that drops the pre-flight cannot
// silently remove the strongest assertion in this file.
describe("pre-flight helper", () => {
  it("is exercised by every mapped case above", () => {
    expect(typeof auditArgsAgainstContract).toBe("function")
    const emitted: Record<string, unknown> = { pattern: "a" }
    expect(() => auditArgsAgainstContract(contracts, "grep", ["pattern"], emitted)).not.toThrow()
  })
})

describe("always-on audit log", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-arg-audit-"))
    setHostCacheDirOverride(root)
    resetArgAuditReports()
  })

  afterEach(() => {
    setHostCacheDirOverride(undefined)
    resetArgAuditReports()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function auditOneDroppedKey(): void {
    const contracts = buildToolContracts([{
      name: "write",
      inputSchema: {
        type: "object",
        properties: { path: {}, content: {}, notes: {} },
        required: ["path", "content"],
      },
    }])
    // The host declares `notes` and the caller supplied it, but this translator
    // did not emit it: the exact silent half of the `filePath` failure class.
    reportArgAudit(auditEmittedArgs({
      contract: contractFor(contracts, "write"),
      toolName: "write",
      sourceKeys: ["path", "content", "notes"],
      emitted: { path: "/tmp/a", content: "x" },
    }))
  }

  it("persists a drop warning the daemonised host would otherwise swallow", () => {
    // Verified 2026-10-14: plugin console.error never reaches opencode.log, and
    // the dedupe emits the informative line exactly once *ever*. Without this
    // file, a drop is as silent as the original `filePath` failure.
    auditOneDroppedKey()
    const log = fs.readFileSync(diagnosticsLogPath(), "utf8")
    expect(log).toContain("`notes`")
    expect(log).toContain("write")
  })

  it("records one line per distinct signature, not one per call", () => {
    auditOneDroppedKey()
    auditOneDroppedKey()
    auditOneDroppedKey()
    const lines = fs.readFileSync(diagnosticsLogPath(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  it("stays silent for a clean call", () => {
    const contracts = buildToolContracts([{
      name: "write",
      inputSchema: {
        type: "object",
        properties: { path: {}, content: {} },
        required: ["path", "content"],
      },
    }])
    reportArgAudit(auditEmittedArgs({
      contract: contractFor(contracts, "write"),
      toolName: "write",
      sourceKeys: ["path", "content"],
      emitted: { path: "/tmp/a", content: "x" },
    }))
    expect(fs.existsSync(diagnosticsLogPath())).toBe(false)
  })
})
