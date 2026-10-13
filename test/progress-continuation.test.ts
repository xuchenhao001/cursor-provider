import { describe, expect, it } from "bun:test"
import {
  isProgressOnlyAssistantText,
  progressOnlyContinuationPrompt,
  shouldContinueProgressOnlyTurn,
} from "../src/protocol/progress-continuation.js"
import { appendWorkspaceRootGrounding } from "../src/protocol/workspace-grounding.js"

const CONTINUE = true
const STOP = false

describe("isProgressOnlyAssistantText", () => {
  it("accepts short inspection fragments and rejects complete answers", () => {
    const rows: Array<[string, boolean]> = [
      ["Checking the workspace", CONTINUE],
      ["Checking the workspace...", CONTINUE],
      ["Looking into it now", CONTINUE],
      ["Looking at this file", CONTINUE],
      ["Let me check the logs", CONTINUE],
      ["Reviewing this PR", CONTINUE],
      ["Checking is disabled for this repo.", STOP],
      ["Checking is disabled", STOP],
      ["Reviewing this PR: LGTM", STOP],
      ["Verifying the fix works as expected.", STOP],
      ["Investigating is not needed; use grep.", STOP],
      ["Investigating is not needed", STOP],
      ["Looking at the code, the bug is in session.ts", STOP],
      ["Looking at the code, the bug is in session.ts.", STOP],
      ["Looking at the code the bug is in session.ts", STOP],
      ["The tests pass", STOP],
      ["", STOP],
      ["Checking the workspace\n\nAnd here is the answer", STOP],
    ]
    for (const [text, expected] of rows) {
      expect(isProgressOnlyAssistantText(text), JSON.stringify(text)).toBe(expected)
    }
  })
})

describe("shouldContinueProgressOnlyTurn", () => {
  const ready = {
    allowTools: true,
    advertisedToolCount: 3,
    assistantText: "Checking the workspace",
    emittedHostTools: 0,
    continuationAttempts: 0,
    pendingExecs: 0,
  }

  it("continues a tool-enabled progress fragment once", () => {
    expect(shouldContinueProgressOnlyTurn(ready)).toBe(true)
  })

  it("never continues title/compaction turns", () => {
    expect(shouldContinueProgressOnlyTurn({ ...ready, allowTools: false })).toBe(false)
  })

  it("does not continue without advertised tools, pending execs, host tools, or a second attempt", () => {
    expect(shouldContinueProgressOnlyTurn({ ...ready, advertisedToolCount: 0 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, pendingExecs: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, emittedHostTools: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, continuationAttempts: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, assistantText: "Reviewing this PR: LGTM" })).toBe(false)
  })
})

describe("progressOnlyContinuationPrompt", () => {
  it("grounds the nudge with the workspace root when one is known", () => {
    const prompt = progressOnlyContinuationPrompt("/tmp/project")
    expect(prompt).toContain("call an available listed tool immediately")
    expect(prompt).toContain("Workspace root:")
    expect(prompt).toContain("/tmp/project")
  })

  it("omits grounding when no workspace root is supplied", () => {
    expect(progressOnlyContinuationPrompt()).not.toContain("Workspace root:")
  })
})

describe("appendWorkspaceRootGrounding", () => {
  it("appends the root once and leaves the original reason when none is known", () => {
    expect(appendWorkspaceRootGrounding("denied", undefined)).toBe("denied")
    expect(appendWorkspaceRootGrounding("denied", "  ")).toBe("denied")
    const grounded = appendWorkspaceRootGrounding("denied", "/tmp/project")
    expect(grounded).toContain("Workspace root: \"/tmp/project\"")
    expect(appendWorkspaceRootGrounding(grounded, "/other")).toBe(grounded)
  })
})
