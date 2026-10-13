import type { Model } from "@opencode/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { CURSOR_PROVIDER_ID } from "./shared.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "./models.js"
import { modelsToConfig } from "./model-config.js"
import { toOpenCode2Costs, type OpenCodeModelCost } from "./pricing.js"

/**
 * Provider and model registration for OpenCode V2's `provider.transform` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT
 * reimplemented here: we run the shared `modelsToConfig` and translate its
 * output into V2's `Model.Info` shape, so every surface exposes an identical
 * model list.
 *
 * The provider's `package` is owned by config (`providers.cursor.package` in
 * opencode.jsonc). This module only fills it in when the config left it empty,
 * so the host resolves the AI SDK entry point from the user's config rather
 * than from a value baked in here.
 */

/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID

/**
 * Self-healing default for `provider.package`.
 *
 * `dist/plugin.js` sits next to `dist/index.js`, which exports `createCursor`.
 * The host's dynamic provider hook imports `file://` specs directly (no
 * `npm.add`), so a plugin-only setup works without publishing anything.
 */
export const CURSOR_AISDK_PACKAGE = `aisdk:${new URL("./index.js", import.meta.url).href}`

/**
 * `Provider.Info` without Effect's compile-time brands.
 *
 * Brands (`Provider.ID`, `Integration.ID`) erase at runtime, but they still
 * make a plain string unassignable, so every write goes through this alias.
 */
type MutableProvider = {
  readonly id: string
  name: string
  package: string
  integrationID?: string
}

/**
 * The subset of `Model.Info` this catalog fills in, brands erased for the same
 * reason as `MutableProvider` above.
 */
type MutableModel = {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  limit: { context: number; output: number }
  variants: Array<{ id: string; settings: Record<string, unknown> }>
  status: Model.Info["status"]
  enabled: boolean
  time: { released: number }
  cost: ReturnType<typeof toOpenCode2Costs>
  settings?: Record<string, unknown>
}

/**
 * Register (or update) the Cursor provider entry. `editor.update` is an
 * upsert, so this is safe on every replay of the transform.
 */
export function applyCursorProvider(editor: ProviderEditor): void {
  editor.update(CURSOR_PROVIDER_ID, (provider) => {
    const target = provider as unknown as MutableProvider
    target.name = "Cursor"
    // Links the provider to the integration that stores its credentials, so
    // `connection.active(...)` resolves the token the user set up via /connect.
    target.integrationID = CURSOR_INTEGRATION_ID
    // Config owns this. Derive the local entry point only as a fallback so a
    // plugin-only setup still routes Cursor models at a built `dist/index.js`.
    if (!target.package) target.package = CURSOR_AISDK_PACKAGE
  })
}

/** Translate one `modelsToConfig` entry into V2's `Model.Info` shape. */
function applyModelEntry(editor: ProviderEditor, id: string, entry: Record<string, any>): void {
  const options = entry.options as Record<string, unknown> | undefined
  // Long-context and Fast entries get synthetic OpenCode ids (`<id>-1m`,
  // `<id>-fast`, `<id>-1m-fast`) while still addressing the same Cursor model
  // on the wire. V1 smuggled that through provider options; V2 has a
  // first-class `modelID` for exactly this.
  const wireId =
    typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
      ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
      : id

  const variants = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter(
        (modality: unknown): modality is string => typeof modality === "string",
      )
    : ["text"]
  const outputModalities = Array.isArray(entry.modalities?.output)
    ? entry.modalities.output.filter(
        (modality: unknown): modality is string => typeof modality === "string",
      )
    : ["text"]

  // `models.update` upserts: it materialises a default entry when the id is
  // new, so discovery can extend a config-declared model list rather than
  // replacing it.
  editor.models.update(CURSOR_PROVIDER_ID, id, (model) => {
    const target = model as unknown as MutableModel
    target.id = id
    target.modelID = wireId
    target.providerID = CURSOR_PROVIDER_ID
    target.name = entry.name
    target.capabilities = {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    }
    target.limit = { context: entry.limit.context, output: entry.limit.output }
    target.variants = variants
    target.status = "active"
    target.enabled = true
    target.time = { released: 0 }
    target.cost = toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined)
    // Carries the default variant parameters (and the wire id) through to
    // doStream as provider options.
    if (options) target.settings = { ...options }
  })
}

/** Register every discovered Cursor model. Safe to re-run; `update` upserts. */
export function applyCursorModels(editor: ProviderEditor, models: ModelInfo[]): void {
  const config = modelsToConfig(models)
  for (const [id, entry] of Object.entries(config)) {
    applyModelEntry(editor, id, entry as Record<string, any>)
  }
}
