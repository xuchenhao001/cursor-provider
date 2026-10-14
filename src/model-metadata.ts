import { CURSOR_MODEL_CAPABILITIES, CURSOR_MODEL_CONTEXTS } from "./pricing-data.js"

export type CursorModelContext = {
  maxContext?: number
  maxContextForMaxMode?: number
}

export type CursorModelCapabilities = {
  supportsImages: boolean
}

export function getDocumentedCursorModelContext(
  modelId: string,
): CursorModelContext | undefined {
  const context = (CURSOR_MODEL_CONTEXTS as Record<string, CursorModelContext>)[modelId]
  return context ? { ...context } : undefined
}

export function getDocumentedCursorModelCapabilities(
  modelId: string,
): CursorModelCapabilities | undefined {
  const capabilities = (
    CURSOR_MODEL_CAPABILITIES as Record<string, CursorModelCapabilities>
  )[modelId]
  return capabilities ? { ...capabilities } : undefined
}

/**
 * Union of the two capability sources, not a precedence chain.
 *
 * Cursor's IDE-facing `AvailableModels.supports_images` flag under-reports:
 * it tracks what the IDE's agent tab lets the user attach, so models whose
 * backend accepts images (Composer 2.5, kimi-k2.7-code) can report `false`
 * while docs.cursor.com still lists Images for them. The docs matrix can lag
 * the other way too (grok-4.5/4.6 and glm-5.2 are API-true, docs-false).
 * Advertise image input when either source says so; only models neither
 * source claims stay text-only.
 */
export function resolveCursorModelSupportsImages(
  modelId: string,
  availableModelsValue?: boolean,
): boolean {
  if (availableModelsValue === true) return true
  if (getDocumentedCursorModelCapabilities(modelId)?.supportsImages === true) return true
  return availableModelsValue ?? false
}
