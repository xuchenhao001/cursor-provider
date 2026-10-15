import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveCavemanMcpCommand } from "../src/caveman-mcp.js"

const originalEnv = process.env.CAVEMAN_MCP_BIN

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.CAVEMAN_MCP_BIN
  else process.env.CAVEMAN_MCP_BIN = originalEnv
})

describe("resolveCavemanMcpCommand", () => {
  it("returns undefined when no candidate exists", async () => {
    const home = path.join(os.tmpdir(), `no-caveman-home-${process.pid}-${Date.now()}`)
    await mkdir(home, { recursive: true })
    const prevHome = process.env.HOME
    process.env.HOME = home
    delete process.env.CAVEMAN_MCP_BIN
    try {
      expect(resolveCavemanMcpCommand()).toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      await rm(home, { recursive: true, force: true })
    }
  })

  it("prefers options.mcpBin over env", async () => {
    const dir = path.join(os.tmpdir(), `caveman-mcp-test-${process.pid}-${Date.now()}`)
    const bin = path.join(dir, "caveman-mcp")
    await mkdir(dir, { recursive: true })
    await writeFile(bin, "#!/bin/sh\n", "utf8")
    process.env.CAVEMAN_MCP_BIN = path.join(dir, "other")
    try {
      expect(resolveCavemanMcpCommand({ mcpBin: bin })).toEqual([bin])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
