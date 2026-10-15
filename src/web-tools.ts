// Host-neutral on purpose: no plugin-API imports. The companion plugin registers
// Exa through `ctx.websearch.transform`; only the Exa request/response plumbing
// lives here.

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const WEB_SEARCH_TIMEOUT_MS = 25_000

export type OpenCodeWebSearchArgs = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

function exaMcpUrl(): string {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return EXA_MCP_URL
  const url = new URL(EXA_MCP_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.href
}

function mcpText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const result = (value as { result?: unknown }).result
  if (!result || typeof result !== "object") return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text
    }
  }
  return undefined
}

export type OpenCodeWebSearchResult = {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function publishedMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

function asWebSearchResult(row: unknown): OpenCodeWebSearchResult | undefined {
  if (!row || typeof row !== "object") return undefined
  const record = row as Record<string, unknown>
  const url =
    typeof record.url === "string"
      ? record.url
      : typeof record.id === "string" && record.id.startsWith("http")
        ? record.id
        : undefined
  if (!url) return undefined
  const title = typeof record.title === "string" ? record.title : undefined
  const content =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.snippet === "string"
          ? record.snippet
          : undefined
  const published = publishedMs(record.publishedDate ?? record.published_at ?? record.published)
  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    time: published === undefined ? {} : { published },
  }
}

/** Turn Exa MCP text (JSON blob or plain text) into OpenCode websearch results. */
export function parseExaWebSearchResultsFromText(text: string): OpenCodeWebSearchResult[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const json = tryParseJson(trimmed)
  if (json !== undefined) {
    if (Array.isArray(json)) {
      return json
        .map(asWebSearchResult)
        .filter((row): row is OpenCodeWebSearchResult => row !== undefined)
    }
    if (json && typeof json === "object") {
      const record = json as Record<string, unknown>
      for (const key of ["results", "data", "items"]) {
        const bucket = record[key]
        if (!Array.isArray(bucket)) continue
        const parsed = bucket
          .map(asWebSearchResult)
          .filter((row): row is OpenCodeWebSearchResult => row !== undefined)
        if (parsed.length > 0) return parsed
      }
      const single = asWebSearchResult(record)
      if (single) return [single]
    }
  }

  return [{ url: "https://exa.ai/", title: "Web search results", content: trimmed, time: {} }]
}

export function parseOpenCodeWebSearchResponse(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const text = mcpText(JSON.parse(trimmed))
    if (text) return text
  } catch {
    // MCP may respond as an SSE stream instead of one JSON object.
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const text = mcpText(JSON.parse(line.slice(6)))
      if (text) return text
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return undefined
}

/** Raw Exa web-search call (MCP `web_search_exa`). */
export async function fetchOpenCodeWebSearchText(
  args: OpenCodeWebSearchArgs,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("Web search timed out")), WEB_SEARCH_TIMEOUT_MS)

  try {
    const response = await fetchImpl(exaMcpUrl(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: args.query,
            type: args.type ?? "auto",
            numResults: args.numResults ?? 8,
            livecrawl: args.livecrawl ?? "fallback",
            contextMaxCharacters: args.contextMaxCharacters,
          },
        },
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`)
    return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

export async function fetchOpenCodeWebSearchResults(
  args: OpenCodeWebSearchArgs,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenCodeWebSearchResult[]> {
  const text = await fetchOpenCodeWebSearchText(args, signal, fetchImpl)
  const parsed = parseExaWebSearchResultsFromText(text)
  return parsed.length > 0
    ? parsed
    : [{ url: "https://exa.ai/", title: args.query, content: text, time: {} }]
}

