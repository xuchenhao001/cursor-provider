import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  UPSTREAM_MODELS_DEV_URL,
  buildUpstreamAttachmentIndex,
  clearUpstreamAttachmentMemo,
  hostModelsDevCacheFilePath,
  loadUpstreamAttachmentIndex,
  refreshUpstreamModelsDevCache,
  upstreamAttachmentLookup,
  upstreamModelsDevFilePath,
} from "../src/upstream-models.js"

afterEach(() => clearUpstreamAttachmentMemo())

describe("buildUpstreamAttachmentIndex", () => {
  it("unions attachment across providers and keeps unanimous false", () => {
    const index = buildUpstreamAttachmentIndex({
      xai: { models: { "grok-4.7": { attachment: true } } },
      // Aggregator rows mirroring the same id without images cannot veto xai.
      somegateway: { models: { "grok-4.7": { attachment: false } } },
      zai: { models: { "glm-5.2": { attachment: false } } },
      mirror: { models: { "glm-5.2": { attachment: false } } },
      // Any true wins even when it arrives after a false.
      late: { models: { "kimi-k3": { attachment: false } } },
      early: { models: { "kimi-k3": { attachment: true } } },
    })
    expect(index.get("grok-4.7")).toBe(true)
    expect(index.get("glm-5.2")).toBe(false)
    expect(index.get("kimi-k3")).toBe(true)
  })

  it("ignores malformed providers, entries and non-boolean flags", () => {
    const index = buildUpstreamAttachmentIndex({
      good: { models: { "m-1": { attachment: true }, "m-2": { attachment: false } } },
      noModels: { name: "x" },
      badModels: { models: "nope" },
      junk: null,
      42: { models: { "m-3": { attachment: true } } },
    })
    expect(index.get("m-1")).toBe(true)
    expect(index.get("m-2")).toBe(false)
    expect(index.has("m-3")).toBe(true)
    expect(buildUpstreamAttachmentIndex(undefined).size).toBe(0)
    expect(buildUpstreamAttachmentIndex("nope").size).toBe(0)
  })

  it("leaves entries without a boolean attachment out of the index", () => {
    const index = buildUpstreamAttachmentIndex({
      a: { models: { "m-1": { name: "no flag" } } },
    })
    expect(index.has("m-1")).toBe(false)
  })
})

describe("loadUpstreamAttachmentIndex", () => {
  it("memoizes by mtime and re-reads after the registry changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      const file = upstreamModelsDevFilePath(dir)
      writeFileSync(file, JSON.stringify({ xai: { models: { a: { attachment: true } } } }))
      const first = loadUpstreamAttachmentIndex(file)
      expect(first.get("a")).toBe(true)
      expect(loadUpstreamAttachmentIndex(file)).toBe(first)

      const future = new Date(Date.now() + 5_000)
      writeFileSync(file, JSON.stringify({ xai: { models: { a: { attachment: false } } } }))
      utimesSync(file, future, future)
      expect(loadUpstreamAttachmentIndex(file).get("a")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("degrades to an empty index for missing or corrupt registries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      expect(loadUpstreamAttachmentIndex(path.join(dir, "absent.json")).size).toBe(0)
      const corrupt = path.join(dir, "models.json")
      writeFileSync(corrupt, "{ not json")
      expect(loadUpstreamAttachmentIndex(corrupt).size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("upstreamAttachmentLookup", () => {
  it("answers per model id and is undefined for unknown models", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      writeFileSync(
        upstreamModelsDevFilePath(dir),
        JSON.stringify({ xai: { models: { "grok-4.7": { attachment: true } } } }),
      )
      const lookup = upstreamAttachmentLookup(dir)
      expect(lookup("grok-4.7")).toBe(true)
      expect(lookup("composer-2.5")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to OpenCode's models.json when our snapshot is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      writeFileSync(
        hostModelsDevCacheFilePath(dir),
        JSON.stringify({ xai: { models: { "grok-4.6": { attachment: true } } } }),
      )
      expect(upstreamAttachmentLookup(dir)("grok-4.6")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("refreshUpstreamModelsDevCache", () => {
  const registry = { xai: { models: { "grok-4.7": { attachment: true } } } }

  it("fetches when absent, persists atomically, and honors the TTL", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      let calls = 0
      const fetcher = (async (...args: Parameters<typeof fetch>) => {
        calls++
        expect(String(args[0])).toBe(UPSTREAM_MODELS_DEV_URL)
        return new Response(JSON.stringify(registry), { status: 200 })
      }) as typeof fetch

      expect(await refreshUpstreamModelsDevCache(dir, { fetcher })).toBe(true)
      expect(calls).toBe(1)
      expect(upstreamAttachmentLookup(dir)("grok-4.7")).toBe(true)

      // Fresh snapshot → no second fetch.
      expect(await refreshUpstreamModelsDevCache(dir, { fetcher })).toBe(false)
      expect(calls).toBe(1)

      // Past the TTL → re-fetch.
      const past = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(upstreamModelsDevFilePath(dir), past, past)
      expect(await refreshUpstreamModelsDevCache(dir, { fetcher })).toBe(true)
      expect(calls).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps the previous snapshot on HTTP or payload failure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-models-"))
    try {
      writeFileSync(
        upstreamModelsDevFilePath(dir),
        JSON.stringify(registry),
      )
      const past = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(upstreamModelsDevFilePath(dir), past, past)

      const badHttp = (async () => new Response("nope", { status: 503 })) as typeof fetch
      await expect(refreshUpstreamModelsDevCache(dir, { fetcher: badHttp })).rejects.toThrow("503")
      expect(upstreamAttachmentLookup(dir)("grok-4.7")).toBe(true)

      const poisoned = (async () => new Response("{ not json", { status: 200 })) as typeof fetch
      await expect(refreshUpstreamModelsDevCache(dir, { fetcher: poisoned })).rejects.toThrow()
      expect(upstreamAttachmentLookup(dir)("grok-4.7")).toBe(true)

      const empty = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch
      await expect(refreshUpstreamModelsDevCache(dir, { fetcher: empty })).rejects.toThrow(
        "no model entries",
      )
      expect(upstreamAttachmentLookup(dir)("grok-4.7")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
