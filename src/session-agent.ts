/**
 * Session-scoped active agent, recorded from the OpenCode 2.0 plugin's
 * `session.hook("context")` and read back by the provider.
 *
 * This is the same mechanism as `session-directory.ts` / `compaction-marker.ts`.
 * It exists because `event.agent` is the *only* signal a provider gets that a
 * session is running OpenCode's `plan` agent, and without it the model is never
 * told that `edit`/`write`/`patch` are denied outside the plan directory — it
 * simply discovers the fact by attempting them.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */

const MAX_TRACKED_SESSIONS = 256

const activeAgents = new Map<string, string>()

export function markActiveAgent(sessionID: string, agent: string | undefined): void {
  if (!sessionID) return
  // Re-insert to keep insertion order meaningful for the eviction below.
  activeAgents.delete(sessionID)
  if (agent) activeAgents.set(sessionID, agent)
  while (activeAgents.size > MAX_TRACKED_SESSIONS) {
    const oldest = activeAgents.keys().next().value
    if (oldest === undefined) break
    activeAgents.delete(oldest)
  }
}

export function getActiveAgent(sessionID: string | undefined): string | undefined {
  return typeof sessionID === "string" ? activeAgents.get(sessionID) : undefined
}

/** True when the session is running OpenCode's plan agent. */
export function isPlanAgentSession(sessionID: string | undefined): boolean {
  return getActiveAgent(sessionID) === "plan"
}

export function clearActiveAgents(): void {
  activeAgents.clear()
}
