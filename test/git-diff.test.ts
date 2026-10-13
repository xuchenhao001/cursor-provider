import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  GIT_DIFF_FORMAT_FILE_DIFFS,
  GIT_DIFF_FORMAT_NAME_STATUS,
  buildGitDiffExecMessages,
  executeGitDiff,
  parseUnifiedDiff,
} from "../src/protocol/git-diff.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { readAllFields } from "../src/protocol/struct.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cursor-git-diff-"))
  dirs.push(dir)
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(path.join(dir, "hello.txt"), "hello\nworld\n")
  git(dir, ["add", "hello.txt"])
  git(dir, ["commit", "-m", "init"])
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD"
  git(dir, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"])
  git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`])
  return dir
}

describe("parseUnifiedDiff", () => {
  it("parses a single-file hunk into FileDiff fields", () => {
    const diffs = parseUnifiedDiff(`diff --git a/hello.txt b/hello.txt
index 1111111..2222222 100644
--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,2 @@
 hello
-world
+there
`)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      from: "hello.txt",
      to: "hello.txt",
      added: 1,
      removed: 1,
    })
    expect(diffs[0]!.chunks[0]).toMatchObject({
      old_start: 1,
      old_lines: 2,
      new_start: 1,
      new_lines: 2,
    })
    expect(diffs[0]!.chunks[0]!.lines).toEqual([" hello", "-world", "+there"])
  })
})

describe("executeGitDiff", () => {
  it("returns FILE_DIFFS against the default origin/HEAD base", async () => {
    const repo = makeRepo()
    writeFileSync(path.join(repo, "hello.txt"), "hello\nthere\n")
    const response = await executeGitDiff({ cwd: repo }, repo)
    const files = (response.diff as { diffs: Array<Record<string, unknown>> }).diffs
    expect(files.some((file) => file.to === "hello.txt" || file.from === "hello.txt")).toBe(true)
    const hello = files.find((file) => file.to === "hello.txt" || file.from === "hello.txt")!
    expect(hello.added).toBeGreaterThan(0)
    expect((hello.chunks as unknown[]).length).toBeGreaterThan(0)
  })

  it("strips chunks for NAME_STATUS", async () => {
    const repo = makeRepo()
    writeFileSync(path.join(repo, "hello.txt"), "hello\nthere\n")
    const response = await executeGitDiff({
      cwd: repo,
      output_format: GIT_DIFF_FORMAT_NAME_STATUS,
    }, repo)
    const hello = (response.diff as { diffs: Array<{ chunks: unknown[]; to: string }> }).diffs
      .find((file) => file.to === "hello.txt")
    expect(hello?.chunks).toEqual([])
  })

  it("honors an explicit base_ref of HEAD for worktree changes", async () => {
    const repo = makeRepo()
    writeFileSync(path.join(repo, "hello.txt"), "hello\nthere\n")
    const response = await executeGitDiff({
      cwd: repo,
      base_ref: "HEAD",
      output_format: GIT_DIFF_FORMAT_FILE_DIFFS,
    }, repo)
    const hello = (response.diff as { diffs: Array<{ added: number; to: string }> }).diffs
      .find((file) => file.to === "hello.txt")
    expect(hello?.added).toBe(1)
  })

  it("includes head_sha when requested", async () => {
    const repo = makeRepo()
    const sha = git(repo, ["rev-parse", "HEAD"])
    writeFileSync(path.join(repo, "hello.txt"), "hello\nthere\n")
    const response = await executeGitDiff({ cwd: repo, base_ref: "HEAD", return_head_sha: true }, repo)
    expect(response.head_sha).toBe(sha)
    expect(response.has_uncommitted_changes).toBe(true)
  })
})

describe("buildGitDiffExecMessages", () => {
  it("encodes git_diff_response field #44 then stream_close", async () => {
    const repo = makeRepo()
    writeFileSync(path.join(repo, "hello.txt"), "hello\nthere\n")
    const frames = await buildGitDiffExecMessages({
      execId: 44,
      request: { cwd: repo, base_ref: "HEAD" },
      workspaceRoot: repo,
    })
    expect(frames).toHaveLength(2)
    const exec = readAllFields(frames[0]!).find((field) => field.fn === 2)
    expect(exec?.wt).toBe(2)
    const result = readAllFields(exec!.bytes!).find((field) => field.fn === 44)
    expect(result?.wt).toBe(2)
    const decoded = decodeMessage<any>("AgentClientMessage", frames[0]!).exec_client_message
    expect(decoded.id).toBe(44)
    expect(decoded.git_diff_response.diff.diffs.length).toBeGreaterThan(0)
    const close = decodeMessage<any>("AgentClientMessage", frames[1]!)
    expect(close.exec_client_control_message.stream_close.id).toBe(44)
  })

  it("throws + closes when cwd is not a git repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cursor-git-diff-empty-"))
    dirs.push(dir)
    const frames = await buildGitDiffExecMessages({
      execId: 7,
      request: { cwd: dir },
      workspaceRoot: dir,
    })
    expect(frames).toHaveLength(2)
    const control = readAllFields(frames[0]!).find((field) => field.fn === 5)
    expect(control?.wt).toBe(2)
    const thrown = readAllFields(control!.bytes!).find((field) => field.fn === 2)
    expect(thrown?.wt).toBe(2)
    const error = readAllFields(thrown!.bytes!).find((field) => field.fn === 2)
    expect(new TextDecoder().decode(error!.bytes)).toMatch(/not a git repository|fatal:/i)
    const close = decodeMessage<any>("AgentClientMessage", frames[1]!)
    expect(close.exec_client_control_message.stream_close.id).toBe(7)
  })
})
