import { describe, expect, it } from "bun:test"
import protobuf from "protobufjs"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"
import {
  advertisedToolNamesFromDescriptors,
  extractExecDisplayCallId,
  extractProtobufSubmessage,
  listProtobufFieldNumbers,
  parseDisplayToolCall,
} from "../src/protocol/tool-call-bridge.js"

function encodeCanonicalToolCall(
  variantField: number,
  writeArgs: (writer: protobuf.Writer) => void,
): Uint8Array {
  const writer = protobuf.Writer.create()
  writer.uint32((variantField << 3) | 2).fork()
  writer.uint32((1 << 3) | 2).fork()
  writeArgs(writer)
  writer.ldelim()
  writer.ldelim()
  writer.uint32((57 << 3) | 2).string("canonical-call")
  return writer.finish()
}

describe("tool-call-bridge", () => {
  it("decodes UpdateTodosToolCall oneof and maps to todowrite", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "tc_todos",
      update_todos_tool_call: {
        args: {
          todos: [{ id: "1", content: "Wire bridge", status: 2 }],
          merge: true,
        },
        result: {
          success: {
            todos: [
              { id: "1", content: "Wire bridge", status: 2 },
              { id: "2", content: "Add tests", status: 1 },
            ],
            was_merge: true,
          },
        },
      },
    })
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
    const display = parseDisplayToolCall("tc_todos", decoded)
    expect(display).toBeDefined()
    expect(display!.variant).toBe("update_todos_tool_call")
    expect(display!.preferredToolName).toBe("todowrite")
    expect(display!.args.todos).toEqual([
      { id: "1", content: "Wire bridge", status: "in_progress", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ])

    // OpenCode 2.0 has no `todowrite`, so this payload is decoded for display
    // only and never becomes a host call — the display bridge that used to
    // execute it was removed with the V2 dead-bridge cleanup.
  })

  it("maps CreatePlanToolCall into a display-only plan summary todo", () => {
    const display = parseDisplayToolCall("tc_plan", {
      create_plan_tool_call: {
        args: {
          name: "Bridge work",
          overview: "Surface Cursor display tools in OpenCode",
          plan: "1. Parse ToolCall\n2. Emit todowrite",
          todos: [{ id: "a", content: "Implement", status: 1 }],
        },
      },
    })
    expect(display?.preferredToolName).toBe("todowrite")
    const todos = display!.args.todos as Array<Record<string, unknown>>
    expect(todos[0]?.id).toBe("plan")
    expect(String(todos[0]?.content)).toContain("Plan: Bridge work")
    expect(todos[1]?.content).toBe("Implement")

  })

  it("decodes AskQuestionToolCall but does not replay a completed interaction", () => {
    const display = parseDisplayToolCall("tc_q", {
      ask_question_tool_call: {
        args: {
          title: "Mode",
          questions: [
            {
              id: "q1",
              prompt: "Continue bridging?",
              allow_multiple: false,
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          ],
        },
      },
    })
    expect(display?.preferredToolName).toBe("question")
  })

  it("decodes switch_mode without replaying a completed lifecycle operation", () => {
    const display = parseDisplayToolCall("tc_mode", {
      switch_mode_tool_call: {
        args: {
          target_mode_id: "plan",
          explanation: "Need a structured plan",
        },
      },
    })
    expect(display?.preferredToolName).toBe("plan_enter")
  })

  it("decodes state-destructive todo and mode fallbacks for display only", () => {
    // These all used to be declined by the (now removed) display bridge because
    // executing them would destroy state. They still decode — Cursor's own
    // transcript renders them — but there is no host target for any of them.
    const mergeWithoutFinalState = parseDisplayToolCall("merge", {
      update_todos_tool_call: {
        args: { merge: true, todos: [{ id: "changed", content: "delta", status: 3 }] },
      },
    })
    expect(mergeWithoutFinalState?.variant).toBe("update_todos_tool_call")

    const readTodos = parseDisplayToolCall("read", { read_todos_tool_call: { args: {} } })
    expect(readTodos?.variant).toBe("read_todos_tool_call")

    const leavePlan = parseDisplayToolCall("leave", {
      switch_mode_tool_call: { args: { target_mode_id: "agent" } },
    })
    expect(leavePlan?.variant).toBe("switch_mode_tool_call")

    // The completed final list is still decoded for display purposes.
    const merged = parseDisplayToolCall("merged", {
      update_todos_tool_call: {
        args: { merge: true, todos: [{ id: "changed", content: "delta", status: 3 }] },
        result: {
          success: {
            was_merge: true,
            todos: [
              { id: "kept", content: "Kept", status: 1 },
              { id: "changed", content: "Changed", status: 3 },
            ],
          },
        },
      },
    })
    expect((merged?.args.todos as Array<{ id: string }>).map((t) => t.id)).toEqual([
      "kept",
      "changed",
    ])
  })

  it("decodes edit and task calls without replaying completed operations", () => {
    const fullEdit = parseDisplayToolCall("edit", {
      edit_tool_call: { args: { path: "/tmp/a.ts", stream_content: "const x = 1\n" } },
    })

    const piEdit = parseDisplayToolCall("pi-edit", {
      pi_edit_tool_call: {
        args: { path: "/tmp/a.ts", edits: [{ old_text: "old", new_text: "" }] },
      },
    })

    const multiEdit = parseDisplayToolCall("pi-multi", {
      pi_edit_tool_call: {
        args: {
          path: "/tmp/a.ts",
          edits: [
            { old_text: "a", new_text: "b" },
            { old_text: "c", new_text: "d" },
          ],
        },
      },
    })

    const task = parseDisplayToolCall("task", {
      task_tool_call: {
        args: { description: "Inspect", prompt: "Find the bug", subagent_type: { explore: {} } },
      },
    })
    const missingSubtype = parseDisplayToolCall("task-invalid", {
      task_tool_call: { args: { description: "Inspect", prompt: "Find the bug" } },
    })

    for (const [label, display] of [
      ["edit", fullEdit],
      ["pi-edit", piEdit],
      ["pi-multi", multiEdit],
      ["task", task],
      ["task-invalid", missingSubtype],
    ] as const) {
      expect(display, label).toBeDefined()
      expect(display!.callId, label).not.toBe("")
    }
    // A completed edit is never replayed, so a mutating call with an unusable
    // payload must be marked unbridgeable rather than silently dropped.
    expect(missingSubtype?.bridgeable).toBe(false)
  })

  it("does not substitute a search term for a fetch URL", () => {
    const search = parseDisplayToolCall("search", {
      web_search_tool_call: { args: { search_term: "OpenCode" } },
    })
    expect(search?.variant).toBe("web_search_tool_call")
    expect(search?.args.url).toBeUndefined()
    expect(search?.args.search_term).toBe("OpenCode")
  })

  it("decodes canonical Pi wire fields and preserves their semantics", () => {
    const piBash = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(62, (writer) => {
        writer.uint32((1 << 3) | 2).string("echo hi")
        writer.uint32((2 << 3) | 1).double(1.5)
      }),
    )
    const bash = parseDisplayToolCall("pi-bash", piBash)

    const piGrep = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(65, (writer) => {
        writer.uint32((1 << 3) | 2).string("needle")
        writer.uint32((2 << 3) | 2).string("/tmp")
        writer.uint32((4 << 3) | 0).bool(true)
      }),
    )
    const grep = parseDisplayToolCall("pi-grep", piGrep)

    const piFind = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(66, (writer) => {
        writer.uint32((1 << 3) | 2).string("*.ts")
        writer.uint32((2 << 3) | 2).string("/tmp")
      }),
    )
    const find = parseDisplayToolCall("pi-find", piFind)
  })

  it("decodes canonical Task subagent_type without replaying the completed task", () => {
    const taskCall = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(19, (writer) => {
        writer.uint32((1 << 3) | 2).string("Inspect")
        writer.uint32((2 << 3) | 2).string("Find the bug")
        writer.uint32((3 << 3) | 2).fork()
        writer.uint32((4 << 3) | 2).fork().ldelim()
        writer.ldelim()
      }),
    )
    const task = parseDisplayToolCall("task", taskCall)
  })

  it("extracts display call ids from exec args variants", () => {
    expect(
      extractExecDisplayCallId({
        id: 3,
        shell_stream_args: { command: "ls", tool_call_id: "shell_1" },
      }),
    ).toBe("shell_1")
    expect(
      extractExecDisplayCallId({
        id: 4,
        read_args: { path: "/x", tool_call_id: "read_1" },
      }),
    ).toBe("read_1")
    expect(
      extractExecDisplayCallId({
        id: 34,
        subagent_args: { prompt: "Investigate", tool_call_id: "task_1" },
      }),
    ).toBe("task_1")
    expect(extractExecDisplayCallId({ id: 5, request_context_args: {} })).toBeUndefined()
  })

  it("lists advertised OpenCode tool names from descriptors", () => {
    expect(
      advertisedToolNamesFromDescriptors([
        { provider_identifier: "opencode", tool_name: "todowrite" },
        { provider_identifier: "github", tool_name: "create_pull_request" },
        { provider_identifier: "opencode", tool_name: "bash" },
      ]),
    ).toEqual(["todowrite", "github_create_pull_request", "bash"])
  })

  it("decodes AwaitToolCall (display-only native tool)", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "tc_await",
      await_tool_call: {
        args: {
          task_id: "shell_1",
          block_until_ms: 30000,
          regex: "exit_code",
        },
      },
    })
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
    const display = parseDisplayToolCall("tc_await", decoded)
    expect(display?.variant).toBe("await_tool_call")
    expect(display?.preferredToolName).toBe("await")
    expect(display?.args).toMatchObject({ task_id: "shell_1", block_until_ms: 30000 })
    // OpenCode turns usually do not advertise an await tool — no bridge.
  })

  it("decodes canonical read-todos status and id filters", () => {
    const encoded = encodeCanonicalToolCall(10, (writer) => {
      writer.uint32((1 << 3) | 2).fork().int32(1).int32(3).ldelim()
      writer.uint32((2 << 3) | 2).string("todo-7")
    })
    const decoded = decodeMessage<any>("ToolCall", encoded)
    expect(decoded.read_todos_tool_call.args.status_filter).toEqual([1, 3])
    expect(decoded.read_todos_tool_call.args.id_filter).toEqual(["todo-7"])
  })

  it("lists protobuf field numbers for unknown-variant diagnosis", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "x",
      await_tool_call: { args: { task_id: "t1" } },
    })
    const fields = listProtobufFieldNumbers(encoded)
    expect(fields).toContain(42)
    expect(fields).toContain(57)
    const nested = extractProtobufSubmessage(encoded, [42, 1])
    expect(nested).toBeDefined()
    expect(listProtobufFieldNumbers(nested!)).toContain(1)
  })

  it("maps every known ToolCall variant preferred tool one after another", () => {
    const cases: Array<{
      variant: string
      payload: Record<string, unknown>
      preferred: string
    }> = [
      {
        variant: "shell_tool_call",
        payload: { args: { command: "echo hi", working_directory: "/tmp" } },
        preferred: "shell",
      },
      {
        variant: "delete_tool_call",
        payload: { args: { path: "/tmp/x" } },
        preferred: "shell",
      },
      {
        variant: "glob_tool_call",
        payload: { args: { glob_pattern: "*.ts", target_directory: "/tmp" } },
        preferred: "glob",
      },
      {
        variant: "grep_tool_call",
        payload: { args: { pattern: "foo", path: "/tmp", glob: "*.ts" } },
        preferred: "grep",
      },
      {
        variant: "read_tool_call",
        payload: { args: { path: "/tmp/a.ts" } },
        preferred: "read",
      },
      {
        variant: "update_todos_tool_call",
        payload: { args: { todos: [{ id: "1", content: "x", status: 1 }], merge: false } },
        preferred: "todowrite",
      },
      {
        variant: "read_todos_tool_call",
        payload: { args: {} },
        // No dedicated branch: with the `todoread` entry removed from the
        // mapping table this falls through to the variant-derived default.
        preferred: "read_todos",
      },
      {
        variant: "edit_tool_call",
        payload: { args: { path: "/tmp/a.ts", stream_content: "new file" } },
        preferred: "write",
      },
      {
        variant: "ls_tool_call",
        payload: { args: { path: "/tmp" } },
        preferred: "read",
      },
      {
        variant: "mcp_tool_call",
        payload: {
          args: {
            provider_identifier: "github",
            tool_name: "create_pull_request",
            args: { title: "t" },
          },
        },
        preferred: "github_create_pull_request",
      },
      {
        variant: "create_plan_tool_call",
        payload: { args: { name: "n", overview: "o", plan: "p", todos: [] } },
        preferred: "todowrite",
      },
      {
        variant: "web_search_tool_call",
        payload: { args: { search_term: "opencode" } },
        preferred: "websearch",
      },
      {
        variant: "task_tool_call",
        payload: {
          args: { description: "d", prompt: "p", subagent_type: { explore: {} } },
        },
        preferred: "subagent",
      },
      {
        variant: "ask_question_tool_call",
        payload: {
          args: {
            title: "t",
            questions: [{ id: "q", prompt: "Q?", options: [{ id: "a", label: "A" }] }],
          },
        },
        preferred: "question",
      },
      {
        variant: "fetch_tool_call",
        payload: { args: { url: "https://example.com" } },
        preferred: "webfetch",
      },
      {
        variant: "web_fetch_tool_call",
        payload: { args: { url: "https://example.com" } },
        preferred: "webfetch",
      },
      {
        variant: "switch_mode_tool_call",
        payload: { args: { target_mode_id: "plan", explanation: "x" } },
        preferred: "plan_enter",
      },
      {
        variant: "generate_image_tool_call",
        payload: { args: { description: "a cat" } },
        preferred: "generateimage",
      },
      {
        variant: "get_mcp_tools_tool_call",
        payload: { args: { server: "opencode", tool_name: "edit", pattern: "edit" } },
        preferred: "get_mcp_tools",
      },
      {
        variant: "await_tool_call",
        payload: { args: { task_id: "shell_1", block_until_ms: 1000 } },
        preferred: "await",
      },
      {
        variant: "pi_read_tool_call",
        payload: { args: { path: "/tmp/a.ts" } },
        preferred: "read",
      },
      {
        variant: "pi_bash_tool_call",
        payload: { args: { command: "echo hi" } },
        preferred: "shell",
      },
      {
        variant: "pi_edit_tool_call",
        payload: { args: { path: "/tmp/a.ts", edits: [{ old_text: "a", new_text: "b" }] } },
        preferred: "edit",
      },
      {
        variant: "pi_write_tool_call",
        payload: { args: { path: "/tmp/a.ts", content: "hi" } },
        preferred: "write",
      },
      {
        variant: "pi_grep_tool_call",
        payload: { args: { pattern: "foo", path: "/tmp" } },
        preferred: "grep",
      },
      {
        variant: "pi_find_tool_call",
        payload: { args: { pattern: "*.ts", path: "/tmp" } },
        preferred: "glob",
      },
      {
        variant: "pi_ls_tool_call",
        payload: { args: { path: "/tmp" } },
        preferred: "read",
      },
    ]

    for (const c of cases) {
      const display = parseDisplayToolCall(`tc_${c.variant}`, { [c.variant]: c.payload })
      expect(display, c.variant).toBeDefined()
      expect(display!.variant, c.variant).toBe(c.variant)
      expect(display!.preferredToolName, c.variant).toBe(c.preferred)
      // Nothing in the table bridges: OpenCode 2.0 has no `todowrite`, and a
      // ToolCallCompleted notification is a transcript record rather than an
      // execution request.
    }
  })

  it("round-trips every schema ToolCall variant through encode/decode", () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ["shell_tool_call", { args: { command: "echo" } }],
      ["delete_tool_call", { args: { path: "/tmp/x" } }],
      ["glob_tool_call", { args: { glob_pattern: "*.ts" } }],
      ["grep_tool_call", { args: { pattern: "x" } }],
      ["read_tool_call", { args: { path: "/tmp/a" } }],
      ["update_todos_tool_call", { args: { todos: [], merge: false } }],
      ["read_todos_tool_call", { args: {} }],
      ["edit_tool_call", { args: { path: "/tmp/a", stream_content: "new file" } }],
      ["ls_tool_call", { args: { path: "/tmp" } }],
      ["mcp_tool_call", { args: { tool_name: "read", provider_identifier: "opencode" } }],
      ["create_plan_tool_call", { args: { name: "n", overview: "o", plan: "p" } }],
      ["web_search_tool_call", { args: { search_term: "q" } }],
      ["task_tool_call", {
        args: { description: "d", prompt: "p", subagent_type: { explore: {} } },
      }],
      ["ask_question_tool_call", { args: { title: "t", questions: [] } }],
      ["fetch_tool_call", { args: { url: "https://example.com" } }],
      ["switch_mode_tool_call", { args: { target_mode_id: "agent" } }],
      ["generate_image_tool_call", { args: { description: "img" } }],
      ["web_fetch_tool_call", { args: { url: "https://example.com" } }],
      ["await_tool_call", { args: { task_id: "t1" } }],
      ["get_mcp_tools_tool_call", { args: { tool_name: "edit" } }],
      ["pi_read_tool_call", { args: { path: "/tmp/a" } }],
      ["pi_bash_tool_call", { args: { command: "echo", timeout: 1.5 } }],
      ["pi_edit_tool_call", {
        args: { path: "/tmp/a", edits: [{ old_text: "a", new_text: "b" }] },
      }],
      ["pi_write_tool_call", { args: { path: "/tmp/a", content: "x" } }],
      ["pi_grep_tool_call", { args: { pattern: "x", ignore_case: true } }],
      ["pi_find_tool_call", { args: { pattern: "*.ts", path: "/tmp" } }],
      ["pi_ls_tool_call", { args: { path: "/tmp" } }],
    ]
    for (const [variant, payload] of variants) {
      const encoded = encodeMessage("ToolCall", { tool_call_id: `id_${variant}`, [variant]: payload })
      const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
      const display = parseDisplayToolCall(`id_${variant}`, decoded)
      expect(display?.variant, variant).toBe(variant)
    }
  })


})
