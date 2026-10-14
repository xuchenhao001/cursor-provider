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
 * Image-input capability, resolved as a union of three independent sources
 * with asymmetric trust: any layer's positive enables, unanimous
 * non-support disables. No layer may veto another's positive, because each
 * describes a different system and each is demonstrably wrong alone:
 *
 * 1. Cursor's AvailableModels API — per-account, live, but its
 *    `supportsImages` flag tracks agent-tab UI gating (Composer 2.5: false,
 *    images work). Positives are authoritative (the gateway accepted them);
 *    negatives are not.
 * 2. Cursor's docs capability table (generated {@link CURSOR_MODEL_CAPABILITIES})
 *    — Cursor's published product statement. Also under-reports: Grok 4.7
 *    lists no Images while the model behind it is multimodal.
 * 3. OpenCode's models.dev cache (see upstream-models.ts) — the upstream
 *    vendor's capability for the same wire id (`xai/grok-4.7` →
 *    attachment: true). Speaks to the model, not Cursor's gateway, so it is
 *    the weakest positive — and it has no opinion at all for Cursor-exclusive
 *    models (composer-2.5, glm-5p3, default), which is why it can never be
 *    the only source. An upstream `false` never vetoes a Cursor-side
 *    positive: Cursor co-trains checkpoints whose upstream twins differ.
 *
 * `upstreamAttachment` is a lazy thunk so the registry is consulted (and
 * parsed) only when the Cursor-side layers leave the question open.
 */
export function resolveCursorModelSupportsImages(
  modelId: string,
  availableModelsValue?: boolean,
  upstreamAttachment?: () => boolean | undefined,
): boolean {
  if (availableModelsValue === true) return true
  if (getDocumentedCursorModelCapabilities(modelId)?.supportsImages === true) return true
  if (upstreamAttachment?.() === true) return true
  return availableModelsValue ?? false
}
