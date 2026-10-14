import { CURSOR_API_HOST, CURSOR_PROVIDER_ID } from "./shared.js"
import { createCursorLanguageModel } from "./language-model.js"
import type { CreateCursorOptions } from "./index.js"

/**
 * Host-neutral provider construction shared by the package entry (`index.ts`)
 * and the V2 companion plugin (`plugin.ts`). Nothing here imports a host plugin
 * API, so both the config-driven `aisdk:file://` loader and the plugin's own
 * `aisdk.hook("sdk")` can call `createSdk` without a plugin-API dependency.
 */

/** Minimal AI SDK provider surface OpenCode expects from an `aisdk` package. */
export type CursorSdk = {
  languageModel(modelId: string): ReturnType<typeof createCursorLanguageModel>
}

export function createSdk(options: CreateCursorOptions): CursorSdk {
  const providerId = options.name || CURSOR_PROVIDER_ID
  return {
    languageModel(modelId: string) {
      return createCursorLanguageModel(modelId, providerId, options)
    },
  }
}

/**
 * Whether an OpenCode `aisdk` package string refers to this provider.
 *
 * Matches on the provider id first (the common case once the catalog entry is
 * ours), then on the package specifier so a bare package name, an
 * `aisdk:`-prefixed form, or a resolved `dist/index.js` file URL all hit.
 *
 * `cursor-provider` is the current package and directory name; the two retired
 * names stay matched so a stale checkpoint or an older config still resolves
 * instead of silently dropping the provider.
 */
export function isCursorPackage(pkg: string, providerID: string): boolean {
  if (providerID === CURSOR_PROVIDER_ID) return true
  return (
    pkg.includes("cursor-provider") ||
    pkg.includes("cursor-caveman") ||
    pkg.includes("cursor-opencode-provider") ||
    /[/\\](?:cursor-provider|opencode-cursor|cursor-caveman)[/\\]dist[/\\]index\.js$/.test(pkg)
  )
}

/** API base for auth, model discovery, and GetServerConfig. */
export function cursorApiBaseURL(): string {
  return process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

export function cursorGetServerConfigTelemetryEnabled(): boolean {
  return (
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "1" ||
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "true"
  )
}
