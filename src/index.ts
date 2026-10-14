import { createSdk } from "./plugin-core.js"
import type { CursorContinuationOptions } from "./session.js"

export type CursorRetryOptions = {
  /** Total attempts including the initial request. Default: 3. */
  maxAttempts?: number
  /** Initial full-jitter backoff ceiling. Default: 500ms. */
  baseDelayMs?: number
  /** Exponential backoff ceiling. Default: 8000ms. */
  maxDelayMs?: number
}

export type CreateCursorOptions = {
  name: string
  /**
   * Frozen access token. Prefer `accessTokenSource`: the host caches the SDK
   * it builds from these options for the life of the process, so a token baked
   * in here is never refreshed and a credential written after construction is
   * never seen. Kept because it is what the config-driven
   * `providers.cursor.package` path hands us when no plugin is loaded.
   */
  accessToken?: string
  /**
   * Resolved lazily on every request. This is the supported way to supply a
   * credential: the host owns the credential store, so asking it again per turn
   * is what makes `/connect` take effect without restarting the service.
   * Wins over `accessToken` whenever it returns something.
   */
  accessTokenSource?: () => string | Promise<string | undefined> | undefined
  apiKey?: string
  /** API base for auth, model discovery, and GetServerConfig. */
  apiBaseURL?: string
  /** Explicit Cursor agent Run host override. */
  agentBaseURL?: string
  /** @deprecated Use agentBaseURL. Kept as the legacy agent Run host override. */
  baseURL?: string
  headers?: Record<string, string>
  /** Opt in to telemetry on the GetServerConfig endpoint lookup. Defaults to false. */
  telemetryEnabled?: boolean
  /** OpenCode project / worktree directory for request_context collectors. */
  workspaceRoot?: string
  /**
   * Host cache root for Cursor project metadata + model/version caches.
   * Resolves to the native OpenCode cache dir (`XDG_CACHE_HOME`/`~/.cache`)
   * unless explicitly overridden.
   */
  cacheDir?: string
  /** Held-stream policy. Defaults: heartbeat 5s, semantic idle 120s, tool inactivity 10m. */
  continuation?: CursorContinuationOptions
  /** Fresh-turn retry policy. Defaults: 3 attempts, 500ms base, 8000ms cap. */
  retry?: CursorRetryOptions
}

/**
 * The AI SDK provider factory OpenCode loads from `providers.cursor.package`.
 *
 * The host's dynamic provider loader imports this package and calls its first
 * `create*` export with the resolved provider settings, then reads
 * `sdk.languageModel(modelID)`. `createCursor` → `createSdk({ languageModel })`
 * is exactly that contract.
 */
export function createCursor(options: CreateCursorOptions) {
  return createSdk(options)
}

export type { CursorContinuationOptions, CursorContinuationPolicy } from "./session.js"
