# Plan: cursor-caveman-provider → personal OpenCode V2 project

Goal: turn this fork into a total personal project designed for OpenCode V2 only.
No V1 / 1.18 compatibility, no npm publishing, no upstream-fork hygiene.
Maintainer: you. Decisions already made:

- **Depth:** strip + modernize (keep the protocol/provider core, delete compatibility surfaces).
- **Registration:** config-driven (`providers.cursor.package` in `opencode.json(c)`), plugin is a companion.
- **Layout:** flatten `upstream/` into the repo root.
- **Docs:** replace `AGENTS.md` entirely (drop OCP/fork-identity rules, keep verified-live behavioral notes).

Safety point: tag the current commit (`pre-v2-refactor`) before starting. All work happens on a branch.

---

## Phase 0 — V2 conformance spike (verify before deleting anything)

The old code targets the 2.0 *beta* plugin API (`0.0.0-next-17155`) with 341 hand-copied
types. Stable V2 changed some of this, so verify against the **live** V2 server first.
Docs are the source of truth: <https://opencode.ai/v2/docs/build/plugins>,
<https://opencode.ai/v2/docs/providers>, <https://opencode.ai/v2/docs/config>.

1. **How V2 loads an `aisdk` provider package.** Write a 20-line probe package
   (default export `{ languageModel(id) {...} }`) and declare
   `providers.testprobe.package: "aisdk:file:///…/dist/index.js"`. Confirm:
   - the expected export shape (callable provider factory vs. `languageModel` object —
     the current `createSdk()` returns `{ languageModel }`, check whether the root export
     must *be* that object or a function returning it);
   - a `file://` path works without `npm install`-ing into `<host-cache>/packages/`
     (the V1 note about `CURSOR_OPENCODE2_DEV_ENTRY` suggests the beta host installed
     published packages; confirm what stable V2 does with local paths).
2. **Plugin API surface.** Confirm stable `@opencode/plugin` provides what we port:
   `ctx.integration.transform` + OAuth/key methods, `ctx.provider.transform`
   (add provider + `models.set`), `ctx.tool.transform`, `ctx.tool.hook("execute.before"/"after")`,
   `ctx.session.hook("context")`, `ctx.event.subscribe`. Note: there is **no** `ctx.aisdk`
   domain in stable V2 — provider wiring goes through config/`provider.transform`.
3. **Auth path.** Confirm Cursor OAuth/key storage lands in
   `~/.local/share/opencode/auth.json` via `ctx.integration`, and that
   `ctx.integration.connection.resolve` gives the token the provider needs at runtime.

Exit criterion: a scratch plugin + probe package that streams one turn through a fake
provider in the running V2 server. Everything downstream builds on these answers.

### Phase 0 findings (verified against live OpenCode v2.0.27 + its binary)

1. **Package loading:** `aisdk:file:///abs/path.js` is `import()`ed **directly** by the
   server (Bun), not npm-installed into `<host-cache>/packages/`. Proven: the broken
   cursor path errors `Cannot initialize cursor/grok-4.7: Cannot find module
   '/Users/chenhaoxu/git/.../dist/index.js' imported from /$bunfs/root/chunk-…`.
   → `CURSOR_OPENCODE2_DEV_ENTRY` and the V1 `npm` install-into-cache behavior are obsolete.
2. **Export contract (dynamic path, `opencode.provider.dynamic`):** the loader imports the
   module and calls **the first export whose name starts with `create`**, passing provider
   `options`/settings; it must return an object exposing `languageModel(modelID)` → a
   `LanguageModelV3`. Error if no such export: `Package … has no provider factory export`.
   The existing `createCursor(options)` → `createSdk({ languageModel })` **already
   satisfies this** — so `providers.cursor.package: "aisdk:file://…/dist/index.js"` works
   with zero provider-code change.
3. **Plugin API surface:** stable `@opencode/plugin@2.0.27`, `Plugin.define({ id, setup })`.
   `ctx.aisdk.hook("sdk"/"language")` **still exists** (the docs index omitted it) — the
   plugin can inject the access token by setting `event.sdk` before the dynamic fallback
   (which guards `if (o.sdk) return`). `ctx.catalog` is **gone** → `ctx.provider.transform`
   with `ProviderEditor{ list, get, add, update, remove, models.set/update/remove }`.
   Integration OAuth now uses `form: Form.Fields` + `authorize(answer: Form.Answer)` (was
   `prompts` + `authorize(inputs)`). Tool hooks now always supply `id: Tool.CallID` (the old
   `id ?? callID` dance is unnecessary). Session `context` hook shape is unchanged.
4. **Auth flow:** `ctx.integration.connection.resolve(conn)` returns
   `{type:"oauth", access, refresh, expires}` or `{type:"key", key}` — same as the
   hand-copied beta types, so `opencode2/integration.ts` ports nearly verbatim.
5. **Live config is broken NOW:** `~/.config/opencode/opencode.jsonc` still points at
   `/Users/chenhaoxu/git/cursor-caveman-provider/…` (repo was moved here), producing
   `failed to load plugin` + `Cannot initialize cursor/…` errors in the log. Must repoint
   to the new `dist/` paths (done in Phase 4).

## Phase 1 — Flatten the repo

```
upstream/src            → src/
upstream/test           → test/
upstream/scripts        → scripts/
upstream/{package.json,bun.lock,tsconfig*.json,AGENTS.md} → repo root
upstream/.github/       → DELETE (publish.yml is npm-release machinery)
upstream/DISCLAIMER.md, SECURITY.md → DELETE
upstream/docs/cli-parity.md, host-compat-acceptance.md → DELETE (public-audience docs)
upstream/docs/cache-log-runbook.md → docs/ (keep: real maintainer runbook)
upstream/tasks/lessons.md → evaluate; keep if still relevant, else DELETE
upstream/.claude/       → DELETE (points at upstream's AGENTS.md)
opencode.example.jsonc  → rewrite (V2-native shape, see Phase 4)
README.md, PLAN.md, AGENTS.md → rewrite (Phase 5)
```

`dist/` stays gitignored; `node_modules` reinstalled at root. Keep git history (single
fork commit + our commits on top is fine).

## Phase 2 — Delete V1 / 1.18 / beta surfaces

| Delete | Why |
|---|---|
| `src/plugin.ts` (classic V1 hooks, 415 lines) | V1 plugin API |
| `src/plugin-v2.ts` (1.18 promise API, 41 lines) | V1-lineage API |
| `src/plugin-opencode2.ts` (beta 2.0, 393 lines) | replaced by new `src/plugin.ts` in Phase 3 |
| `src/opencode2/types.ts` (hand-copied beta types) | stable `@opencode/plugin` ships real types |
| `test/opencode2-conformance.types.ts` | conformance hack for the beta API |
| `test/plugin.test.ts`, `test/plugin-opencode2.test.ts` (and parts of others that mock V1 hook shapes) | cover deleted surfaces |
| `scripts/check-cursor-pricing-coverage.ts` + the HARD STOP pricing gate | release machinery for a public package |
| `src/image-save-tool.ts` | classic-plugin-only helper (the host-neutral `image-save.ts` stays) |
| package.json: `peerDependencies` on `@opencode-ai/plugin@^1.17`, devDep `@opencode-ai/plugin-next`, all `exports` subpaths except what remains, `files`/`prepublishOnly`/`repository`/`bugs`/`homepage` pointing at the upstream fork | not a published package |

Keep (V2-agnostic provider core — this is the hard-won part):
`language-model.ts`, `session.ts`, `protocol/*`, `transport/*`, `context/*`,
`auth.ts`, `models.ts`, `agent-url.ts`, `pricing.ts` + `pricing-data.ts`
(personal project still wants cost display; just regenerate manually when Cursor
adds models, no gate), `caveman/*`, `image-staging.ts` / `image-save.ts`,
`web-tools.ts` / `web-search-tool.ts`, `shell-timeout.ts`, `compaction-marker.ts`,
`session-directory.ts`, `activity.ts`, and the rest of the shared modules.

Package identity: rename to `cursor-caveman` (was `cursor-caveman-provider`,
version restart at `1.0.0`, author/repo fields → personal). Keep `CURSOR_*` and
`CAVEMAN_*` env var names unchanged — they're documented behavior, not fork baggage.

## Phase 3 — New V2 plugin (`src/plugin.ts`)

Single entrypoint using stable `Plugin.define({ id: "cursor-caveman", setup })`.
Port from `plugin-opencode2.ts`, adapting to stable API names:

- **Integration/auth** ← `src/opencode2/integration.ts`, rewritten against stable
  `ctx.integration` (methods, `connection.active/resolve`). Keep the memoize-success-only
  token logic (fresh-install ordering documented in the old code).
- **Provider + models** ← replaces `opencode2/catalog.ts`'s `ctx.catalog` calls with
  `ctx.provider.transform`: ensure the `cursor` provider info exists (or just overlay
  onto the config-declared one) and `editor.models.set("cursor", discovered)`.
  Keep `loadModels()` cache-freshness + stale-on-failure behavior.
- **Tools** (`ctx.tool.transform`): `custom_websearch`, `cursor_image_save` — carry over
  verbatim, they're already host-neutral-ish.
- **Shell wrapper** (`ctx.tool.hook("execute.before"/"execute.after")` on `bash`) —
  port as-is. Evaluate in Phase 0 whether stable V2's `ctx.shell.hook("create.before")`
  can replace part of it; only switch if the output-capture behavior
  (`captureCursorShellResult`) can be preserved.
- **Session context hook** (`ctx.session.hook("context")`): compaction marker +
  session directory recording — port as-is (still required: the provider reads these
  back on held-open Runs).
- **Model discovery trigger**: port the poll-until-connected + event-activity retry,
  using `ctx.event.subscribe` with a proper `AbortSignal` cleanup.
- **Plan-execution kickoff**: optionally *restore* — stable V2 has
  `ctx.session.switchAgent` + `ctx.session.prompt`, which the beta lacked (that's why
  the old code disabled it). Restore `plan-execution-kickoff.ts` wiring behind the same
  `allowTools`/plan-mode gates. Do this last, behind its own test run.
- **`isCursorPackage()`**: update matching for the new package name + `file://` dist form.

The plugin no longer constructs the SDK (`createSdk` in `plugin-core.ts` becomes the
package's public export for the config-driven loader; keep it, drop the "shared by
three plugin surfaces" framing).

## Phase 4 — Config + caveman verification

New `opencode.example.jsonc`, V2-native:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "name": "Cursor (caveman)",
      "package": "aisdk:file:///ABS/PATH/dist/index.js", // exact form per Phase 0 finding
      "models": {}
    }
  },
  "plugins": ["file:///ABS/PATH/dist/plugin.js"]
}
```

(Exact key shape depends on Phase 0: if the companion plugin can be dropped into
`~/.config/opencode/plugins/` or `.opencode/plugins/` instead, prefer that and drop the
`plugins` entry.)

Caveman stays inside the provider — the three call sites in `language-model.ts`
(user text, exec output on continuation, seed-history observations) cannot move to a
V2 session hook because held-open Runs never re-enter `session.hook("context")`.
Keep `src/caveman/compress.ts` semantics unchanged: fail-open, 512-byte floor,
idempotency marker, `recover:` line + `caveman_retrieve` handle.

Verification (needs `opencode service restart` after config changes):
1. `bun test` green (minus deleted-surface tests; the 3 real-engine caveman
   integration tests must pass with `~/.caveman/bin/caveman-engine` present).
2. Live: `/connect` Cursor OAuth → `/models` lists subscription models → one agentic
   session with tool calls (held-open continuation), token footer updates, compaction
   turn works, debug log shows caveman compressing large prompts/tool outputs.
3. Regression spot-checks for verified-live behaviors: checkpoint replay after restart,
   read-cap marker not echoed into writes, image generation (if still used), websearch.

## Phase 5 — Docs

- **`AGENTS.md`** (new): commands (`bun install/build/test/typecheck`), architecture
  table, caveman engine contract (stdin → compressed stdout, flat JSON report on
  stderr, `recovery_handle`, `CAVEMAN_*` env), config wiring, and the condensed
  **verified-live behavioral constraints** worth keeping for future maintenance:
  Cursor-authoritative token totals, prompt-cache/frozen-context rules, checkpoint
  transport budget, run write backpressure, session supersession, device identity,
  host validation (`*.cursor.sh`), tool-result read stripping. Drop: OCP boundary,
  fork-identity rules, pricing HARD STOP, release gates.
- **`README.md`**: personal install (Bun, caveman-engine, build, config snippet,
  env table, recovery section). Much of the current README survives with the config
  snippet updated.
- Keep `docs/cache-log-runbook.md` as-is; it's referenced from AGENTS.md material.

## Appendix — existing verified notes to preserve (from current PLAN.md/README)

- Engine contract: `caveman-engine compress` reads stdin (64 MiB cap), compressed
  bytes on stdout, ONE flat JSON report on stderr (`content_type`, `tokens_before`,
  `tokens_after`, `ratio`, `recovery_handle`, `method`, `lossless_to_model`, optional
  `error`). Parser reads `recovery_handle` top-level, tolerates nested `result`.
- Recovery: originals in `~/.caveman/ccr.db` (override `CAVEMAN_CCR_DB`);
  `caveman-engine retrieve <handle>` is byte-exact.
- Idempotency: `shouldSkipCavemanCompress` refuses strings already carrying the
  `… N lines elided (caveman) …` marker.
- Known environmental test note: `test/context.test.ts` had 1 pre-existing failure on
  upstream 0.6.7 (subagent discovery picks up machine-local agents) — unrelated to us.

## Risks

| Risk | Mitigation |
|---|---|
| Stable V2 plugin API differs from beta in integration/provider domains | Phase 0 spike before any deletion; fall back to per-domain shims only if a domain is genuinely missing |
| `file://` provider package loading semantics (install-into-cache vs. direct import) | Probed in Phase 0; worst case the plugin passes `cacheDir`/paths explicitly as today |
| Regressing verified-live Cursor protocol behavior | Provider core is moved, not rewritten; full test suite + live checklist in Phase 4 |
| OpenChamber shares this provider | Config + service restart instructions in README; smoke-test in OpenChamber after Phase 4 |

---

# Execution status

Phases 0–3 are done and committed. Phase 4 (config + live smoke) and Phase 5
(AGENTS.md / README) remain.

## Phase 3 — what was actually built

- `src/catalog.ts` — `applyCursorProvider` / `applyCursorModels` on
  `ctx.provider.transform` (`ProviderEditor`). `provider.update` and
  `models.update` are both upserts (verified against the host binary), so the
  transform is replay-safe. Brand-typed fields (`Model.ID`, `Integration.ID`)
  are written through two small structural aliases (`MutableProvider`,
  `MutableModel`); brands erase at runtime.
- `src/integration.ts` — `applyCursorIntegration` / `resolveCursorAccessToken`
  on `ctx.integration.transform` (`IntegrationEditor`). Credential and
  registration types are *derived* from the host's own types
  (`Extract<IntegrationMethodRegistration, {method:{type:"oauth"}}>`) rather
  than re-declared, so a host rename becomes a compile error here.
- `src/plugin.ts` — the single V2 entry, a plain `{ id, setup }` default export.
  Type-only import from `@opencode/plugin`; `dist/plugin.js` contains **no**
  runtime import of the plugin package (verified in the built output).

## Deviations from the plan, and why

1. **`provider.package` fallback instead of "config only".** Config still owns
   the value; the plugin fills it in *only* when empty, deriving
   `aisdk:<repo>/dist/index.js` from `import.meta.url`. This makes a plugin-only
   setup work without an npm publish and cannot clobber a config value.
2. **The `sdk` hook does not bail on a pre-set `event.sdk`.** The host's dynamic
   provider hook is itself a fallback (`if (o.sdk) return`) and builds an SDK
   with **no access token**. Whether it runs before or after our hook is a
   registration-order detail, so we match on our own package and always
   overwrite. No other plugin ever produces a Cursor SDK.
3. **Plan-execution kickoff restored** (the beta had dropped it). V2's session
   domain now has `switchAgent` + `prompt`, so CreatePlan → Yes starts the
   implementation turn as the `build` agent again.
4. **No tool permission prompt for image save.** V2's `ToolContext` has no
   `ask()`, and `ctx.permission` exposes only `list`/`get`/`reply` plus an
   `evaluate` hook — nothing a tool can await. The write stays gated by
   `resolveContainedImagePath` (the real containment check); the `ask` callback
   is a traced no-op.
5. **Shell wrapper title.** V2's `Tool.Result` dropped `title`; the shell tool's
   display title is derived from `input.command`, which the before-hook rewrites
   into the wrapper. The after-hook restores the original command on the input
   object instead.
6. **`tsconfig.test.json` deleted.** It existed only to typecheck
   `test/opencode2-conformance.types.ts` (the hand-copied beta types). Typechecking
   the whole `test/` tree surfaces a large pre-existing backlog unrelated to this
   refactor, so `typecheck` is now just `tsc --noEmit`.

7. **Plugin entries must be a directory; `exports` is not consulted.** Phase 4
   found the host's loader drops any `plugins` entry that resolves to a *file*
   (`configured plugin path must be a directory`), and for an absolute
   **directory** it resolves `<dir>/server.*` then `<dir>/index.*` via
   `Bun.resolveSync` — it does not read the directory's `package.json` `exports`
   map. That map is only reached for npm-installed packages, which arrive with a
   name attached. A resolver miss is silent (no log line at all), which is why
   the first config attempt appeared to work but loaded nothing. Fix: a root
   `server.js` re-exporting `./dist/plugin.js`, with `plugins` pointing at the
   repo **directory**. `exports["./server"]` kept for the npm path. The plan's
   original `plugins: ["file:///…/dist/plugin.js"]` shape is not valid V2.
8. **`files` / `prepublishOnly` / `check:pricing` dropped.** No publish surface
   for a personal project; `test/fixtures/cursor-pricing-models.txt` survives
   because `test/pricing.test.ts` still reads it. `test:node-http2` restored —
   `test/node-http2-cleanup.mjs` is a real Node HTTP/2 session-cleanup check, not
   a Bun test, so it needs its own script.

## Verification

Static:

- `bun run build` clean; `dist/plugin.js` has zero `@opencode/plugin` runtime
  imports; `dist/index.js` exports `createCursor`.
- `bun run typecheck` clean.
- `bun test`: 914 pass, 1 fail. The single failure is the known machine-local
  `test/context.test.ts` subagent-discovery case, unchanged from upstream 0.6.7.

Live, against OpenCode v2.0.27 (service at `http://127.0.0.1:49374`) with the
global `~/.config/opencode/opencode.jsonc` updated and the service restarted:

- Plugin loads: `msg="loading plugin" id=<repo dir>
  entrypoint=file://<repo dir>/server.js`.
- Provider registered via `/api/provider`: `id=cursor`, **`name="Cursor
  (caveman)"`** (config value preserved by the catalog name guard),
  `package=aisdk:file://…/dist/index.js`, `integrationID=cursor`,
  `activation=enabled`.
- Catalog: **64** `cursor/…` models through `/api/model` and `opencode models`,
  each with real `limit`, `cost` (input/output/cache read+write) and
  `capabilities`.
- Plugin tools live in the session tool catalog: `custom_websearch`,
  `cursor_image_save`.
- Turn end-to-end on `cursor/composer-2.5`: `CURSOR-OK` returned, so credentials
  resolve (V2 `credential` row under `integration_id=cursor`, `crsr_` key
  exchanged for a JWT), the `sdk` hook wins over the host's dynamic loader, and
  the held-open Run transport works.
- **Caveman compresses a live turn.** A 19.5 KB JSON-log prompt produced a new
  `recoveries` row: `ccr_92a6f41022f8…`, `content_type=log`, **6168 → 146
  tokens**, original bytes stored intact. Model replied `CAVEMAN-OK`.
- Engine characterization (informative): compresses log dumps and JSON logs;
  prose, markdown outlines and tables come back `ratio: 0`. So a prose prompt is
  *not* a valid compression test.

Not yet exercised live (regression spot-checks still open from Phase 4):
agentic session with tool calls and a held-open continuation, compaction turn,
checkpoint replay after a service restart, `custom_websearch` (needs
`EXA_API_KEY`), image generation.

### 2026-10-14 — recovery path closed, engine behavior corrected

The `recover:` hint was previously unactionable: `caveman-mcp` was not
registered, and `~/.caveman/bin` was not on `PATH`, so neither
`caveman_retrieve` nor the `bash` fallback existed. Fixed by registering a
`caveman` local MCP server in `~/.config/opencode/opencode.jsonc` (backup
`opencode.jsonc.bak-pre-caveman-mcp`) and symlinking the six caveman binaries
into `~/.local/bin`, which both a bare login shell and the running service
already have on `PATH`. `McpLocalConfig` has `additionalProperties: false` and
no tool filter, so all five tools register — ~3 KB (~770 tokens) of schema per
request, against 44,411 tokens already saved.

Verified byte-exact both ways against real handles (sha256 of the retrieved
bytes equals the stored `original`): `caveman_retrieve` with `verify_only` over
MCP, and `caveman-engine retrieve <handle>` over bash. A live turn's compressed
block (`ccr_667e41f4…`, 8215 → 184 tokens, 26292 B) round-trips exactly.

**Correction to an earlier claim.** Caveman is not "log-shaped only". The
discriminator is repetition, not the detected class: grep output and uniform
prose are both `text`, yet grep elides 81% and prose 0%. Realized savings from
this machine's store — grep/search 34,954 → 6,682, logs 15,695 → 634, TypeScript
2,323 → 1,245, prose/markdown/tables unchanged. Spawn cost measured flat at
15–23 ms from 600 B to 67 KB, so the 512-byte floor is about absolute savings,
not latency.

**Separate issue found, not fixed here:** the stored `crsr_` key now returns
`Invalid User API Key` from `POST /auth/exchange_user_api_key`, so live Cursor
turns fail with `Cursor authentication failed (unauthenticated)`. Compression
still ran on the failing turn (fail-open held), and the README troubleshooting
section now documents the one-line curl to confirm it. Needs `/connect` or a
fresh key from cursor.com/settings.
