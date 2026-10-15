import { afterEach, describe, expect, it } from "bun:test"
import {
  fetchOpenCodeWebSearchText,
  parseExaWebSearchResultsFromText,
  parseOpenCodeWebSearchResponse,
} from "../src/web-tools.js"

const originalExaApiKey = process.env.EXA_API_KEY

afterEach(() => {
  if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY
  else process.env.EXA_API_KEY = originalExaApiKey
})

describe("OpenCode-backed web search", () => {
  it("maps Exa JSON result arrays into websearch rows", () => {
    const payload = JSON.stringify({
      results: [
        { url: "https://example.com/a", title: "A", text: "alpha" },
        { url: "https://example.com/b", title: "B", content: "beta" },
      ],
    })
    expect(parseExaWebSearchResultsFromText(payload)).toEqual([
      { url: "https://example.com/a", title: "A", content: "alpha", time: {} },
      { url: "https://example.com/b", title: "B", content: "beta", time: {} },
    ])
  })

  it("parses JSON and SSE MCP responses", () => {
    const payload = { result: { content: [{ type: "text", text: "result" }] } }
    expect(parseOpenCodeWebSearchResponse(JSON.stringify(payload))).toBe("result")
    expect(parseOpenCodeWebSearchResponse(`event: message\ndata: ${JSON.stringify(payload)}\n`)).toBe(
      "result",
    )
  })

  it("calls Exa's MCP tool and returns the text blob", async () => {
    let requestUrl = ""
    let requestInit: RequestInit | undefined
    process.env.EXA_API_KEY = "test-key"
    const output = await fetchOpenCodeWebSearchText(
      { query: "current release", numResults: 3, livecrawl: "preferred" },
      undefined,
      (async (url: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(url)
        requestInit = init
        return new Response(
          JSON.stringify({
            result: { content: [{ type: "text", text: "search output" }] },
          }),
        )
      }) as typeof fetch,
    )

    expect(requestUrl).toContain("https://mcp.exa.ai/mcp?exaApiKey=test-key")
    const body = JSON.parse(String(requestInit?.body))
    expect(body.params).toEqual({
      name: "web_search_exa",
      arguments: {
        query: "current release",
        type: "auto",
        numResults: 3,
        livecrawl: "preferred",
      },
    })
    expect(output).toBe("search output")
  })

  it("surfaces a non-2xx status with a slice of the body", async () => {
    process.env.EXA_API_KEY = "test-key"
    await expect(
      fetchOpenCodeWebSearchText(
        { query: "boom" },
        undefined,
        (async () => new Response("server exploded", { status: 500 })) as typeof fetch,
      ),
    ).rejects.toThrow(/Web search failed \(500\)/)
  })

  it("forwards the caller's abort signal to the request", async () => {
    process.env.EXA_API_KEY = "test-key"
    const controller = new AbortController()
    controller.abort()
    let forwarded: AbortSignal | undefined
    await fetchOpenCodeWebSearchText(
      { query: "aborted" },
      controller.signal,
      (async (_url: string | URL | Request, init?: RequestInit) => {
        forwarded = (init?.signal as AbortSignal) ?? undefined
        return new Response("{}")
      }) as typeof fetch,
    )
    expect(forwarded?.aborted).toBe(true)
  })
})
