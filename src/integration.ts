import type { IntegrationDomain, IntegrationEditor, IntegrationMethodRegistration } from "@opencode/plugin/promise/integration"
import { CURSOR_WEBSITE_HOST } from "./shared.js"
import { cursorApiBaseURL } from "./plugin-core.js"
import {
  buildLoginUrl,
  decodeJwtExpiryMs,
  exchangeApiKey,
  generatePkceChallenge,
  generatePkceParams,
  isExpiringSoon,
  pollForTokens,
  refreshAccessToken,
} from "./auth.js"
import { CURSOR_INTEGRATION_ID } from "./catalog.js"

/**
 * Integration registration for OpenCode V2's `integration.transform` hook —
 * the replacement for the classic plugin's `auth` hook (`methods` + `loader`).
 *
 * V2 takes plain Promises here (no Effect), so the PKCE flow from `src/auth.ts`
 * ports across unchanged.
 */

export const CURSOR_OAUTH_METHOD_ID = "oauth"

/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"]

/**
 * Credential / registration shapes derived from the host's own types rather
 * than re-declared, so a host rename of `Form.Answer` or `Credential.OAuth`
 * surfaces as a compile error here instead of a runtime schema failure.
 */
type OAuthRegistration = Extract<
  IntegrationMethodRegistration,
  { readonly method: { readonly type: "oauth" } }
>
type OAuthCredential = Parameters<NonNullable<OAuthRegistration["refresh"]>>[0]
type OAuthAuthorization = Awaited<ReturnType<OAuthRegistration["authorize"]>>
/** Whatever the host can hand back from a stored connection. */
type CredentialValue = Awaited<ReturnType<IntegrationDomain["connection"]["resolve"]>>

function websiteURL(): string {
  return process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`
}

/** Browser (PKCE) login: open URL, then poll until Cursor hands back tokens. */
async function authorizeOAuth(): Promise<OAuthAuthorization> {
  const params = generatePkceParams()
  const challenge = await generatePkceChallenge(params.verifier)
  const apiBaseURL = cursorApiBaseURL()
  const url = buildLoginUrl(challenge, params.uuid, websiteURL())

  return {
    url,
    instructions: "Open this URL in a browser to sign in to Cursor",
    mode: "auto",
    callback: pollForTokens(params.uuid, params.verifier, apiBaseURL).then(
      (result): OAuthCredential =>
        ({
          type: "oauth",
          methodID: CURSOR_OAUTH_METHOD_ID,
          access: result.accessToken,
          refresh: result.refreshToken,
          expires: decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
        }) as unknown as OAuthCredential,
    ),
  }
}

/**
 * Renew an expiring Cursor JWT. The host calls this lazily when the stored
 * credential is close to expiry, so it must not assume it runs on every request.
 */
async function refreshOAuth(credential: OAuthCredential): Promise<OAuthCredential> {
  const tokens = await refreshAccessToken(credential.refresh, cursorApiBaseURL())
  return {
    type: "oauth",
    methodID: credential.methodID || CURSOR_OAUTH_METHOD_ID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: decodeJwtExpiryMs(tokens.accessToken) ?? Date.now(),
    ...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
  } as unknown as OAuthCredential
}

/** Register the Cursor integration and its three connection methods. */
export function applyCursorIntegration(editor: IntegrationEditor): void {
  editor.update(CURSOR_INTEGRATION_ID, (integration) => {
    if (!integration.name || integration.name === CURSOR_INTEGRATION_ID) {
      integration.name = "Cursor"
    }
  })

  editor.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: {
      id: CURSOR_OAUTH_METHOD_ID,
      type: "oauth",
      label: "Cursor account (browser login)",
    },
    authorize: authorizeOAuth,
    refresh: refreshOAuth,
  })

  editor.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "key", label: "API key (cursor.com/settings)" },
  })

  editor.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "env", names: CURSOR_ENV_NAMES },
  })
}

/**
 * Turn a stored credential into a Cursor access token.
 *
 * OAuth credentials already hold a JWT (the host refreshes them via `refresh`
 * above). A `key` credential is the raw `crsr_…` API key, which Cursor requires
 * us to exchange for a short-lived JWT — mirroring the classic plugin's
 * behavior.
 */
export async function accessTokenFromCredential(
  credential: CredentialValue | undefined,
): Promise<string | undefined> {
  if (!credential) return undefined

  if (credential.type === "oauth") {
    const oauth = credential as OAuthCredential
    if (oauth.access && !isExpiringSoon(oauth.access)) return oauth.access
    if (!oauth.refresh) return oauth.access || undefined
    try {
      return (await refreshOAuth(oauth)).access
    } catch {
      // Fall back to the existing token; the call may still succeed.
      return oauth.access || undefined
    }
  }

  if (credential.type === "key") {
    const key = (credential as { key?: string }).key ?? ""
    // Already a JWT (e.g. exchanged by an earlier run) — use it directly.
    if (!key.startsWith("crsr_")) return key || undefined
    try {
      return (await exchangeApiKey(key, cursorApiBaseURL())).accessToken
    } catch {
      return undefined
    }
  }

  return undefined
}

/** Resolve the active Cursor connection into an access token, if any. */
export async function resolveCursorAccessToken(
  integration: IntegrationDomain,
): Promise<string | undefined> {
  try {
    const connection = await integration.connection.active(CURSOR_INTEGRATION_ID)
    if (!connection) return undefined
    return await accessTokenFromCredential(await integration.connection.resolve(connection))
  } catch {
    return undefined
  }
}
