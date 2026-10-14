import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Third capability layer: OpenCode's own models.dev cache.
 *
 * OpenCode maintains https://models.dev — a curated registry of 200+ providers
 * and their models with attachment/reasoning/tool_call capabilities, context
 * limits, and pricing — and caches the registry at `<cacheDir>/models.json`,
 * a sibling of our `cursor-models.json`. The upstream registry has no `cursor`
 * provider (Cursor is not a public API vendor), but it does carry the models
 * Cursor resells under their upstream vendor ids (`xai/grok-4.7`,
 * `anthropic/claude-*`, `openai/gpt-*`, `google/gemini-*`), and those ids
 * collide 1:1 with Cursor's wire ids.
 *
 * Role in {@link resolveCursorModelSupportsImages}: a *weak positive*. Cursor's
 * own two sources can both under-report a model's real capability — they
 * describe what Cursor's product/gateway advertises, not what the underlying
 * model accepts. When xai says grok-4.7 takes images, the model behind
 * Cursor's grok-4.7 is multimodal even if Cursor's docs and AvailableModels
 * flag both say otherwise. Upstream `false` never vetoes a Cursor-side
 * positive (Cursor co-trains models whose upstream twins are text-only), and
 * upstream `true` is the weakest evidence of the three — it speaks to the
 * model, not to Cursor's gateway. Only unanimous non-support stays text-only.
 *
 * Soft layer by design: reading it is memoized, any error degrades to "no
 * upstream opinion", and nothing here can fail a request.
 */

/** models.dev registry shape we consume: provider → models → attachment flag. */
type UpstreamRegistry = Record<string, unknown>

/**
 * Model id → attachment capability. `true` when any provider reports images,
 * `false` only when every provider that lists the model reports no images,
 * absent when no provider lists it.
 */
export type UpstreamAttachmentIndex = Map<string, boolean>

const EMPTY_INDEX: UpstreamAttachmentIndex = new Map()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Build the id → attachment index from a models.dev `api.json` document.
 *
 * Union across providers on purpose: mirrors the resolver's positive-trust
 * asymmetry, and is robust to aggregator rows that mirror a model without its
 * full capability set (e.g. a gateway listing `gpt-5.3-codex` with
 * `attachment: false` beside openai's authoritative `true`).
 */
export function buildUpstreamAttachmentIndex(raw: unknown): UpstreamAttachmentIndex {
  const index: UpstreamAttachmentIndex = new Map()
  if (!isRecord(raw)) return index

  for (const provider of Object.values(raw)) {
    if (!isRecord(provider)) continue
    const models = provider.models
    if (!isRecord(models)) continue

    for (const [modelId, entry] of Object.entries(models)) {
      if (!isRecord(entry)) continue
      if (entry.attachment === true) {
        index.set(modelId, true)
      } else if (entry.attachment === false && !index.has(modelId)) {
        index.set(modelId, false)
      }
      // No boolean attachment → leave any earlier verdict standing.
    }
  }
  return index
}

/** OpenCode's own models.dev cache inside a host cache directory. */
export function hostModelsDevCacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, "models.json")
}

/**
 * Our snapshot of the same registry, refreshed on our schedule.
 *
 * OpenCode's `models.json` moves on the host's cadence — observed a month
 * stale, which is exactly how Grok 4.7 shipped through Cursor while the
 * upstream layer still had no opinion on it. The lookup prefers this copy
 * and falls back to the host's when it is absent.
 */
export const UPSTREAM_MODELS_DEV_URL = "https://models.dev/api.json"
export const UPSTREAM_CACHE_FILE = "cursor-upstream-models.json"
export const UPSTREAM_CACHE_TTL_MS = 86_400_000

export function upstreamModelsDevFilePath(cacheDir: string): string {
  return path.join(cacheDir, UPSTREAM_CACHE_FILE)
}

type MemoEntry = { mtimeMs: number; size: number; index: UpstreamAttachmentIndex }

const memoByPath = new Map<string, MemoEntry>()

/**
 * Load (and memoize) the upstream attachment index for a registry file.
 * The memo key is the file's mtime+size, so the host's periodic models.dev
 * refresh is picked up without restarting the process.
 */
export function loadUpstreamAttachmentIndex(filePath: string): UpstreamAttachmentIndex {
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(filePath)
  } catch {
    // No registry (non-OpenCode host, offline install): no upstream opinion.
    return EMPTY_INDEX
  }

  const memo = memoByPath.get(filePath)
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.index

  let index: UpstreamAttachmentIndex
  try {
    index = buildUpstreamAttachmentIndex(JSON.parse(readFileSync(filePath, "utf-8")))
  } catch {
    // Corrupt/partial registry is the host's problem, not ours: memoize the
    // empty answer under the observed stat so we do not re-parse per lookup.
    index = EMPTY_INDEX
  }
  memoByPath.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, index })
  return index
}

export type UpstreamAttachmentLookup = (modelId: string) => boolean | undefined

/**
 * Lazily consult the upstream registry for one model id.
 *
 * Our snapshot wins when present (refreshed on our TTL, see
 * {@link refreshUpstreamModelsDevCache}); OpenCode's own models.json is the
 * fallback for fresh installs mid-refresh. Returned lookup is sync and cheap:
 * each file is parsed at most once per mtime generation, and only when the
 * first lookup actually happens.
 */
export function upstreamAttachmentLookup(cacheDir: string): UpstreamAttachmentLookup {
  const primary = upstreamModelsDevFilePath(cacheDir)
  const fallback = hostModelsDevCacheFilePath(cacheDir)
  return (modelId: string) =>
    loadUpstreamAttachmentIndex(primary).get(modelId) ??
    loadUpstreamAttachmentIndex(fallback).get(modelId)
}

/**
 * Refresh our models.dev snapshot when it is older than the TTL (or absent).
 *
 * Fire-and-forget from the plugin; the soft-layer contract holds — a failed
 * fetch leaves whatever copy exists in place and never surfaces an error.
 * Returns whether a fetch was attempted and persisted.
 */
export async function refreshUpstreamModelsDevCache(
  cacheDir: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number; ttlMs?: number } = {},
): Promise<boolean> {
  const filePath = upstreamModelsDevFilePath(cacheDir)
  const ttlMs = options.ttlMs ?? UPSTREAM_CACHE_TTL_MS
  try {
    if (Date.now() - statSync(filePath).mtimeMs < ttlMs) return false
  } catch {
    // Absent snapshot → fetch one.
  }

  const response = await (options.fetcher ?? fetch)(UPSTREAM_MODELS_DEV_URL, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`)
  }
  const raw = await response.text()
  // Validate before persisting: it must parse into a non-empty registry, or a
  // poisoned cache would silently disable the layer until its TTL.
  if (buildUpstreamAttachmentIndex(JSON.parse(raw)).size === 0) {
    throw new Error("models.dev registry yielded no model entries")
  }

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    writeFileSync(tempPath, raw, "utf-8")
    renameSync(tempPath, filePath)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      // Already renamed into place (or never landed); nothing to clean.
    }
  }
  return true
}

/** Test hook: drop all memoized registries. */
export function clearUpstreamAttachmentMemo(): void {
  memoByPath.clear()
}
