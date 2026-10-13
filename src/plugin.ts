import type { Plugin } from "@opencode/plugin"
import { CURSOR_PROVIDER_ID } from "./shared.js"
import {
  createSdk,
  cursorApiBaseURL,
  cursorGetServerConfigTelemetryEnabled,
  isCursorPackage,
} from "./plugin-core.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import { resolveAgentUrl } from "./agent-url.js"
import { sessionActivity } from "./activity.js"
import { fetchOpenCodeWebSearchText, type OpenCodeWebSearchArgs } from "./web-tools.js"
import {
  executeCursorImageSave,
  type ImageSaveResult,
  type ImageSaveToolContext,
} from "./image-save.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "./protocol/generate-image.js"
import {
  captureCursorShellResult,
  cursorShellOriginalCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
} from "./shell-timeout.js"
import { applyCursorModels, applyCursorProvider } from "./catalog.js"
import { applyCursorIntegration, resolveCursorAccessToken } from "./integration.js"
import { markCompactionSession } from "./compaction-marker.js"
import { markSessionDirectory } from "./session-directory.js"
import { trace } from "./debug.js"
import {
  createPlanExecutionKickoffText,
  setPlanExecutionKickoff,
} from "./plan-execution-kickoff.js"
import type { CreateCursorOptions } from "./index.js"

/**
 * Cursor provider companion plugin for OpenCode V2.
 *
 * The provider itself is *not* loaded from here — opencode.json(c) declares
 * `providers.cursor.package`, which the host's dynamic provider hook imports.
 * This plugin is the companion half: credentials (integration + /connect),
 * the discovered model catalog, the Cursor-only tools, and the hooks the
 * held-open Run transport needs (compaction marker, session directory, shell
 * timeout wrapper).
 *
 * Everything is a type-only import from `@opencode/plugin`, so the built
 * `dist/plugin.js` has no runtime dependency on the plugin package: the host
 * reads `id` and `setup` straight off the default export.
 */

type Cleanup = Plugin.Cleanup

async function loadModels(cacheDir: string, accessToken: string | undefined): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (cached?.models.length && isCacheFresh(cached)) return cached.models

  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, { baseURL: cursorApiBaseURL() })
    } catch {
      // Fall through to stale-on-failure below.
    }
  }
  // Preserve offline / stale-cache behavior rather than emptying the picker.
  return cached?.models ?? []
}

const plugin: Plugin.Plugin = {
  id: "cursor.provider",

  setup: async (ctx): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p)
    }

    let models: ModelInfo[] = []

    // ── Credentials ──────────────────────────────────────────────────────────
    await track(ctx.integration.transform(applyCursorIntegration))

    let cachedToken: string | undefined
    let tokenInflight: Promise<string | undefined> | undefined
    /**
     * Cache only a *successful* resolution.
     *
     * On a fresh install `setup()` runs before the user has connected, so the
     * first attempt necessarily returns nothing. Memoizing that would pin the
     * plugin to "no credentials" for the whole process and models would never
     * load, even after a successful /connect.
     */
    const accessToken = async (): Promise<string | undefined> => {
      if (cachedToken) return cachedToken
      tokenInflight ??= resolveCursorAccessToken(ctx.integration).finally(() => {
        tokenInflight = undefined
      })
      const token = await tokenInflight
      if (token) cachedToken = token
      return token
    }

    // ── Catalog ──────────────────────────────────────────────────────────────
    // Runs now with whatever models we have (likely none) and is replayed by the
    // host on every `provider.reload()`, so the async fill below just re-triggers it.
    await track(
      ctx.provider.transform((editor) => {
        applyCursorProvider(editor)
        applyCursorModels(editor, models)
      }),
    )

    // ── AI SDK wiring ────────────────────────────────────────────────────────
    // The config-driven `providers.cursor.package` path also works without this
    // hook: the host's dynamic provider hook imports the package and calls the
    // `createCursor` factory it finds there. That fallback builds an SDK with no
    // access token, though, so this hook must win — and it deliberately does
    // *not* bail on a pre-set `event.sdk`. The dynamic hook is a fallback with
    // its own `if (o.sdk) return` guard; whether it runs before or after us is
    // a registration-order detail we should not depend on, and no other plugin
    // ever produces a Cursor SDK, so overwriting is safe.
    await track(
      ctx.aisdk.hook("sdk", async (event) => {
        if (!isCursorPackage(event.package, event.model.providerID)) return
        const token = await accessToken()
        event.sdk = createSdk({
          name: event.model.providerID || CURSOR_PROVIDER_ID,
          ...(token ? { accessToken: token } : {}),
          // Static fallback only. This hook fires once per model/package, not
          // per session, and the host runs one daemon across many projects — the
          // real per-request directory comes from the session.context hook
          // below via `getSessionDirectory`, which `language-model.ts` prefers.
          workspaceRoot: process.cwd(),
          cacheDir,
          ...event.options,
        } as CreateCursorOptions)
      }),
    )

    await track(
      ctx.aisdk.hook("language", (event) => {
        if (event.language) return
        if (event.model.providerID !== CURSOR_PROVIDER_ID) return
        if (typeof event.sdk?.languageModel !== "function") return
        // `modelID` is the Cursor wire id; `id` may be a synthetic long-context entry.
        event.language = event.sdk.languageModel(event.model.modelID || event.model.id)
      }),
    )

    // V2's tool context has no `ask()` — `ctx.permission` exposes only
    // list/get/reply plus an `evaluate` hook, none of which a tool can await.
    // The interactive confirmation the classic plugin asked for is therefore
    // unavailable here; the write itself stays gated by `executeCursorImageSave`'s
    // containment check, which proves the target resolves inside a workspace root.
    const recordToolAsk = (question: { permission: string; metadata: Record<string, unknown> }): void => {
      trace(
        `image save: no V2 permission prompt available (action=${question.permission} `
          + `metadata=${JSON.stringify(question.metadata)}); relying on containment`,
      )
    }

    // ── Tools ────────────────────────────────────────────────────────────────
    // Web search stays a tool rather than the first-class `websearch` domain:
    // that one's Result shape is structured ({url, title?, content?}) while the
    // Exa backend here returns an opaque text blob — mapping one to the other
    // would mean guessing Exa's payload shape.
    await track(
      ctx.tool.transform((editor) => {
        editor.add({
          name: "custom_websearch",
          description:
            "Search the web for current information using OpenCode's web search backend.",
          input: {
            type: "object",
            properties: {
              query: { type: "string", description: "Web search query" },
              numResults: { type: "integer", minimum: 1, maximum: 20 },
              livecrawl: { type: "string", enum: ["fallback", "preferred"] },
              type: { type: "string", enum: ["auto", "fast", "deep"] },
              contextMaxCharacters: { type: "integer", exclusiveMinimum: 0 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          execute: async (rawInput, context) => {
            const input = rawInput as OpenCodeWebSearchArgs
            const output = await fetchOpenCodeWebSearchText(input, context.signal)
            return {
              content: `Exa Web Search: ${input.query}\n\n${output}`,
              metadata: { provider: "exa" },
            }
          },
        })

        editor.add({
          name: CURSOR_IMAGE_SAVE_TOOL,
          description:
            "Save an image that Cursor generated during this session to its target path. "
            + "Takes only the id of an already-generated image — it cannot write arbitrary "
            + "files, and it is not a general-purpose file writer. You do not normally call "
            + "this: the Cursor provider issues it after an image is generated.",
          input: {
            type: "object",
            properties: {
              image_id: {
                type: "string",
                description: "Id of the pending Cursor-generated image to save",
              },
            },
            required: ["image_id"],
            additionalProperties: false,
          },
          execute: async (rawInput) => {
            const input = rawInput as { image_id?: string }
            const saveCtx: ImageSaveToolContext = {
              worktree: "",
              directory: "",
              ask: async (question) => {
                recordToolAsk(question)
              },
            }
            const result = await executeCursorImageSave(input, saveCtx)
            if (typeof result === "string") {
              return { content: result, metadata: { title: CURSOR_IMAGE_SAVE_TOOL } }
            }
            const typed = result as ImageSaveResult
            return { content: typed.output, metadata: { title: typed.title } }
          },
        })
      }),
    )

    // ── Shell timeout wrapper ────────────────────────────────────────────────
    // Cursor's model can ask for foreground timeouts or background shells; the
    // wrapper file in `shell-timeout.ts` reproduces both against OpenCode's bash
    // tool, which is the only surface that can run them.
    await track(
      ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "bash") return
        prepareCursorShellArgs(event.id, event.input as Record<string, unknown>, {
          preferWrapperCommand: true,
        })
      }),
    )

    await track(
      ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== "bash") return
        try {
          if (event.status !== "completed") return
          const result = event.result as Record<string, any>
          // V2's Tool.Result has no `title`; the shell tool's display title is
          // derived from `input.command`, which the before-hook rewrote into the
          // wrapper. Put the original back so the UI shows what was asked for.
          const original = cursorShellOriginalCommand(event.id)
          const input = event.input as Record<string, unknown> | undefined
          if (original && input && typeof input.command === "string") input.command = original
          if (typeof result.output === "string") {
            result.output = captureCursorShellResult(
              event.id,
              result.output,
              result.metadata as Record<string, unknown> | undefined,
            )
          }
          if (typeof result.content === "string") {
            result.content = captureCursorShellResult(
              event.id,
              result.content,
              result.metadata as Record<string, unknown> | undefined,
            )
          }
          if (result.metadata && typeof result.metadata === "object") {
            const metadata = result.metadata as Record<string, unknown>
            if (typeof metadata.output === "string") {
              metadata.output = sanitizeRegisteredCursorShellOutput(event.id, metadata.output)
            }
          }
        } finally {
          releaseCursorShellEnv(event.id)
        }
      }),
    )

    // ── Compaction marker + session directory ───────────────────────────────
    // There is no `chat.params` channel and the session context hook exposes no
    // provider-options hook — only `system`/`messages`/`tools` are mutable. But
    // it does name the owning agent and the session id, and the provider derives
    // the same session id from request headers, so record both facts here and
    // let doStream read them back via `isCompactionSession` /
    // `getSessionDirectory`.
    await track(
      ctx.session.hook("context", async (event) => {
        markCompactionSession(event.sessionID, event.agent === "compaction")
        try {
          const info = await ctx.session.get({ sessionID: event.sessionID })
          markSessionDirectory(event.sessionID, info.location?.directory)
        } catch {
          // Best effort — falls back to the static workspaceRoot above.
        }
      }),
    )

    // ── Plan execution kickoff ───────────────────────────────────────────────
    // Native `plan_exit` asks the user, then starts a new turn as the build
    // agent. The CreatePlan question path already asks; this is the missing
    // second half, and V2's session domain has the two calls it needs.
    setPlanExecutionKickoff(async ({ sessionID, planPath }) => {
      await ctx.session.switchAgent({ sessionID, agent: "build" })
      await ctx.session.prompt({
        sessionID,
        text: createPlanExecutionKickoffText(planPath),
      })
    })

    // ── Model discovery ──────────────────────────────────────────────────────
    // Idempotent and cheap once satisfied, so it is safe to call from anywhere
    // that might mark the moment credentials became available.
    let modelsLoaded = false
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded) return Promise.resolve()
      ensureInflight ??= (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token)
          if (!discovered.length) return
          models = discovered
          modelsLoaded = true
          // Replays the catalog transform above, this time with models.
          await ctx.provider.reload().catch(() => {})
          if (token) {
            // Resolve the region-specific Run origin so the first turn doesn't
            // pay for GetServerConfig. Best effort: startSession surfaces real
            // failures.
            await resolveAgentUrl(token, {
              apiBaseURL: cursorApiBaseURL(),
              telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
            }).catch(() => {})
          }
        } finally {
          ensureInflight = undefined
        }
      })()
      return ensureInflight
    }

    // On a fresh install the user connects *after* startup, and the host has no
    // "connection established" hook we can key on. Poll briefly so models show
    // up within seconds of /connect instead of requiring a restart. The window
    // is bounded; after it, any session event still triggers a retry.
    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry)
        return
      }
      void ensureModels()
    }, RETRY_INTERVAL_MS)
    // Do not hold the process open on this timer.
    ;(retry as unknown as { unref?: () => void }).unref?.()

    void ensureModels()

    // ── Session activity ─────────────────────────────────────────────────────
    // Doubles as a retry trigger: any host activity after the polling window has
    // closed still gets one more chance to pick up newly-added credentials.
    const unsubscribe = subscribeSessionActivity(ctx, ensureModels)

    return async () => {
      clearInterval(retry)
      unsubscribe?.()
      setPlanExecutionKickoff(undefined)
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

/** Feed OpenCode session events into the shared activity tracker. */
function subscribeSessionActivity(
  ctx: Plugin.Context,
  onEvent?: () => void,
): (() => void) | undefined {
  try {
    const stream = ctx.event.subscribe()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return undefined
    let stopped = false
    void (async () => {
      for await (const event of stream as AsyncIterable<any>) {
        if (stopped) break
        applySessionActivity(event)
        onEvent?.()
      }
    })().catch(() => {})
    return () => {
      stopped = true
    }
  } catch {
    return undefined
  }
}

/**
 * V2 events carry their payload under `data` (V1 used `properties`) and split
 * message traffic into `session.*` variants. Only the session id matters here,
 * and every session event carries one, so the shape is matched loosely.
 */
function applySessionActivity(event: any): void {
  const type = event?.type
  if (typeof type !== "string" || !type.startsWith("session.")) return
  const data = event.data
  const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return

  if (type === "session.deleted") {
    sessionActivity.removeSession(sessionID)
    return
  }
  const parentID = typeof data.parentID === "string" ? data.parentID : undefined
  if (parentID) sessionActivity.linkSession(sessionID, parentID)
  sessionActivity.recordActivity(sessionID)
}

export default plugin
