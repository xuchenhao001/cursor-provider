# cursor-caveman

Personal OpenCode **V2-only** Cursor provider + companion plugin. It runs Cursor
subscription models by speaking Cursor's Connect-RPC `agent.v1` protocol (not a
generic chat-completions API), and pipes large user prompts / tool outputs
through **caveman-engine** before they are encoded for the wire.

**Stack:** TypeScript (ESM, `"type": "module"`), Bun for install/test, `tsc` for
build. Runtime deps: `@ai-sdk/provider@3.0.15`, `protobufjs@^7.6.5`. The V2
plugin API is imported **type-only** from the devDependency `@opencode/plugin`
(pinned to the host's version, currently `2.0.27`), so the built plugin carries
no runtime dependency on the plugin package.

## Non-negotiables

- **OpenCode V2 only.** No OpenCode 1.x, no 1.18 (`/v2/promise`) plugin API, no
  2.0-beta type mirror, no compatibility-layer package. One plugin entry, one
  provider factory, one config shape. If a host-only API differs, fix it in this
  repo — never reintroduce a second entrypoint.
- **This is a personal project with one maintainer.** No npm publishing, no
  upstream-fork hygiene, no release/version gate, no pricing-coverage publish
  check. Do not add publish machinery back.
- **Caveman compression stays inside the provider.** It cannot move to a V2
  `session.hook("context")` hook: Cursor Runs are held open across `doStream`
  returning, and the compression sites fire deep inside the Run continuation,
  not at request-context time. See "Caveman contract" below.
- **Fail open, always.** A missing engine, a crashing engine, an engine that
  returns something larger than its input, a timeout — every one of those sends
  the original text unchanged. Compression must never be able to break a turn.

## Build / test

```bash
bun install
bun run build            # tsc → dist/ + build stamp (must re-run before any file:// smoke test)
bun run typecheck        # tsc --noEmit  (src/ only — test/ has a pre-existing backlog)
bun test                 # 971 pass; 1 known machine-local context.test.ts failure
bun run verify           # typecheck + build + check:dist + test + tools:check
bun run check:dist       # fails when dist/ no longer matches src/
bun run tools:capture    # re-record test/fixtures/host-tools.json (one Cursor call)
bun run tools:check      # diff the live host schema against that fixture
bun run test:node-http2  # build + real Node HTTP/2 session-cleanup check
bun run test:watch
bun run generate:pricing # refresh src/pricing-data.ts from Cursor docs
```

`dist/` is gitignored and `server.js` re-exports out of it, so a stale `dist/`
silently serves the host an old plugin. **Build after every source edit that
affects a live OpenCode session**, then `opencode service restart`. `bun run
build` writes `dist/.build-stamp.json` (src content hash + git sha), and the
plugin writes it to the always-on diagnostics log on load — see that section
for why it cannot simply be a `console.error`. `bun run check:dist` fails when
the stamp no longer matches `src/`.

## Always-on diagnostics

Plugin `console.error` does **not** reach `~/.local/share/opencode/log/opencode.log`.
Verified 2026-10-14: after a `msg="loading plugin"` entry for this repo, the only
`[cursor-provider]` hit in a 46 MB log was our own shell command echoed back by
the host, and a foreground `opencode run --standalone` surfaced nothing either.
So every `console.error` diagnostic in this repo has been unreachable in
production — fatal for the arg audit, whose dedupe emits the informative line
exactly once *ever*.

`src/diagnostics.ts` is the always-on path: best-effort append to
`<cache>/cursor-arg-audit.log` (0600, rotated past 256 KB, never throws). One
line per distinct signature, so it cannot grow without bound. `trace()` still
carries detail, but only under `CURSOR_PROVIDER_DEBUG=1`, so it can never be the
always-on channel. The build stamp and every arg-audit drop write here.

## How OpenCode loads this (hard-won, do not "simplify")

The host's plugin loader treats every entry in `plugins` as follows:

1. A `file://` URL or relative path is resolved to an absolute path first.
2. If that path is a **file**, the entry is dropped with
   `configured plugin path must be a directory`. A `.js` file can never be a
   plugin entry.
3. For an **absolute directory** the host resolves `<dir>/server.*` and then
   `<dir>/index.*` via `Bun.resolveSync`. It does **not** consult the
   directory's `package.json` `exports` map.
4. The `exports`-by-name path (`pkg/server`, then `pkg`) is taken only for
   **npm-installed** packages, which arrive with a package name attached.
5. A resolver miss is silent — there is no log line at all. If a plugin seems
   not to load, check for `msg="loading plugin"` in
   `~/.local/share/opencode/log/opencode.log` before anything else.

That is why `server.js` exists at the repo root: a one-line
`export { default } from "./dist/plugin.js"`. `package.json` also declares
`exports["./server"]` so the npm-installed path finds the same module. Both
point at `dist/plugin.js`; `exports["."]` / `main` point at `dist/index.js`,
which is the **provider** factory and is never loaded as a plugin.

Configured plugin entry = this repo's **directory**, not a file:

```jsonc
"plugins": ["/Users/chenhaoxu/Documents/git/opencode-cursor"]
```

## Architecture

```
OpenCode V2 host
  ├── plugins: [<this repo dir>]  →  server.js  →  dist/plugin.js   (companion)
  └── providers.cursor.package    →  dist/index.js → createCursor() → LanguageModelV3
        ├── session.ts        held-open Run stream + exec bridge
        ├── context/          RequestContext from OpenCode discovery
        ├── protocol/         protobuf encode/decode, tools, thinking, interactions
        └── transport/        Connect-RPC over HTTP/2
```

| Area | Path | Notes |
|------|------|--------|
| Provider factory | `src/index.ts` | `createCursor` → `{ languageModel }` |
| V2 plugin | `src/plugin.ts` | Plain `{ id: "cursor.provider", setup }` default export; type-only `@opencode/plugin` import |
| Catalog | `src/catalog.ts` | `applyCursorProvider` / `applyCursorModels`; `CURSOR_AISDK_PACKAGE` fallback |
| Credentials | `src/integration.ts` | `integration.transform`; oauth / key / env methods; `resolveCursorAccessToken` |
| Host-neutral core | `src/plugin-core.ts`, `src/model-config.ts` | No host plugin API imports |
| Language model | `src/language-model.ts` | AI SDK `LanguageModelV3` (`doStream` / `doGenerate`) |
| Session | `src/session.ts` | Held-open agent Run + pending exec correlation |
| Auth / models | `src/auth.ts`, `src/models.ts` | API-key exchange, JWT refresh, `cursor-models.json` cache |
| Agent host | `src/agent-url.ts` | `GetServerConfig` → region-specific Run host (in-memory memo) |
| Request context | `src/context/` | Rules, skills, agents, plugins, git, layout, env |
| Host paths | `src/context/paths.ts` | OpenCode cache/data defaults; project metadata under `<cache>/projects/<slug>/` |
| Wire protocol | `src/protocol/` | Framing, messages, tools, thinking, checksums, device id |
| Patch synthesis | `src/protocol/apply-patch.ts` | patch-tool envelopes for hosts that withhold `edit`/`write` |
| Interactions | `src/protocol/interactions.ts` | AskQuestion / SwitchMode / CreatePlan bridges |
| Plan execution | `src/plan-execution-kickoff.ts` | CreatePlan Yes → `session.switchAgent("build")` + `session.prompt` |
| Image generation | `src/protocol/generate-image.ts`, `src/image-staging.ts`, `src/image-save.ts` | Approval + containment-gated byte write |
| Shell wrapper | `src/shell-timeout.ts` | Foreground timeouts / background shells over the host `shell` tool |
| Caveman | `src/caveman/compress.ts` | Engine spawn, idempotency marker, recovery hint |
| Pricing | `src/pricing.ts`, `src/pricing-data.ts` | Cursor docs → cost tiers |
| Transport | `src/transport/connect.ts` | HTTP/2 bidi + unary RPC |

Package exports: `.` → provider factory, `./server` and `./plugin` → the V2
plugin (same module).

## What the plugin registers

`setup()` wires, in order:

- `ctx.integration.transform` — integration `cursor` with an `oauth` method, a
  `key` method (`crsr_…` API key from cursor.com/settings), and an `env` method
  reading `CURSOR_API_KEY`.
- `ctx.provider.transform` — provider `cursor` (`integrationID`, `name`, and
  `package` **only when unset or still the bare id**; config owns those) plus
  one upsert per discovered model carrying `limit` / `cost` / `capabilities`.
- `ctx.aisdk.hook("sdk")` — builds the Cursor SDK with a resolved access token.
  It deliberately does **not** bail on a pre-set `event.sdk`: the host's dynamic
  provider hook is itself a fallback with its own `if (o.sdk) return` guard and
  builds a tokenless SDK, so whether it runs before or after us is a
  registration-order detail we must not depend on. Match on our own package and
  always overwrite.
- `ctx.aisdk.hook("language")` — fills in a missing language model.
- `ctx.tool.transform` — adds `custom_websearch` (Exa's public MCP endpoint,
  anonymous by default; `EXA_API_KEY` attaches your own key) and
  `cursor_image_save` (single-use opaque image id, never a path or content).
- `ctx.tool.hook("execute.before" / "execute.after")` — the shell wrapper. Kept
  as tool hooks because V2 has no `toolCallID` correlation in `ctx.shell.hook`.
- `ctx.session.hook("context")` — records the owning agent (compaction marker)
  and the session directory. This is the only place V2 names the agent, and the
  provider derives the same session id from request headers.
- Model discovery + `ctx.provider.reload()`, then `resolveAgentUrl` so the first
  turn does not pay for `GetServerConfig`.

Credentials are resolved lazily, cached for `TOKEN_TTL_MS` (60 s), and the cache
is dropped on any `credential.*` event — so a `/connect` lands on the next turn
with no restart. `setup()` runs before the user has connected, so only a
**successful** resolution is ever memoized: caching the first (empty) answer
would pin the process to "no credentials" forever and models would never appear
even after a successful `/connect`. A failed refresh keeps serving the last good
token rather than failing the turn, and the TTL means the next turn retries.

**Per-turn token source — `accessTokenSource`.** `ctx.aisdk.hook("sdk")` fires
once per package, so whatever token is baked into `CreateCursorOptions` there is
frozen for the life of the process: before this existed, a credential written
*after* the SDK was built was never seen, and observed 2026-10-14 a post-`/connect`
session kept failing with `unauthenticated` until `opencode service restart`.
`doStreamImpl` and `reopenWithUserMessage` now call `resolveTurnAccessToken`
(`src/auth.ts`) per turn, which prefers `accessTokenSource` over the static
string and fails open to it when the source throws or yields nothing — so the
config-driven `providers.cursor.package` path with no plugin still works
unchanged. Keep both fields; the static one is not dead code.

## Caveman contract

Three compression sites in `src/language-model.ts`, all funnelled through
`cavemanCompressText` (`src/caveman/compress.ts`):

1. the latest user message text on each Run (never the recovery-rebase
   placeholder);
2. tool results written back on an exec continuation;
3. tool observations folded into seed history (compaction / rebase paths).

**Two tiers, in this order.** The engine *infers* its content type, and a few
words of prose in front of a large structured payload flip it from `json`/`log`
(which elide) to `text` (which passes through). Measured on a 46 KB JSON array:
20,293 → 315 tokens bare, 0% with one English sentence prepended — so the most
common real prompt, "here's my log, why is it broken", saved nothing at all.
So the whole message is tried first, and only if that passes through are the
largest blank-line-separated blocks retried individually, leaving every byte of
the blocks that do not move untouched. Observed live on an attached file
(`<file name=…>\n{json}\n</file>`): 16,972 → 384 tokens.

Two shapes used to defeat the block tier and now have explicit fallbacks, both
inside `compressLargestBlocks`:

- **Fenced payload** (` ```json … ``` `): the fence alone flips the inference to
  `text`, so the block is retried with the fences stripped and restored around
  the compressed interior. Verified 11,455 → 1,037 bytes with the fence intact.
- **No blank line after the instruction**: with nothing to split on the message
  is one block and never separates, so it falls back to splitting at the first
  newline — the instruction line stays verbatim, only the tail is sent to the
  engine. Verified 11,471 → 1,053 bytes.

Both are tried as-is first and only fall through when the ordinary attempt
passed through, so a payload that already compresses keeps its original path
and its original recovery handle. Both still fail open: an unrecognised wrapper
returns the input untouched.

Never compressed: system prompts, recovery-tool output, anything under
`CAVEMAN_COMPRESS_MIN_BYTES` (512), and anything already carrying the engine's
`… N lines elided (caveman) …` marker. That marker is the idempotency guard —
OpenCode resends history verbatim, so re-eliding already-elided text would waste
a spawn and risk double-marking. Never strip it to "re-compress".

The engine emits one flat JSON object on **stderr** and the compressed text on
**stdout**. When it shrinks a block it stores the exact original in
`~/.caveman/ccr.db` and reports a `ccr_<hex>` handle; the provider appends one
line telling the model to call `caveman_retrieve` to get the bytes back.
`caveman_retrieve` is provided by `caveman-mcp`, and the raw original is always
available via `caveman-engine retrieve <handle>`.

The engine is a **repetition-and-elision** compressor, not a log compressor. It
detects a content class (`caveman-engine detect` reports `log` / `code` /
`text` / `tabular`; the registry carries 14 transforms) and then elides lines it
can prove are redundant. The class is not the discriminator — repetition is.
`grep` output and uniform prose are both `text`, yet grep elides 81% and the
prose 0%, because in the prose every line carries distinct information. Measured
from this machine's own `recoveries` store: grep/search output 34,954 → 6,682
tokens, logs 15,695 → 634, TypeScript source 2,323 → 1,245, uniform prose /
markdown outlines / pipe tables unchanged. Pass-through is not a bug; it costs
only a ~15 ms spawn, which is flat from 600 B to 67 KB, so `CAVEMAN_COMPRESS_MIN_BYTES`
is about absolute savings, not latency.

**The recovery hint is only actionable if `caveman-mcp` is registered** as an
MCP server in the host config — otherwise the appended `recover:` line names a
tool the model does not have and the model may burn a turn narrating that. The
`bash` fallback (`caveman-engine retrieve <handle>`) additionally needs
`~/.caveman/bin` on `PATH`; it is not there by default, so symlink the binaries
into `~/.local/bin`. Both were wired up and verified byte-exact (sha256 match
against the stored original) on 2026-10-14. Registry also exposes a
`caveman.engine.toolschema.v1` transform eligible only for `tool_schema`
segments, which this provider never feeds it — the next place to look for
savings, since tool schemas are a fixed per-request cost.

## Tool contract (schema-driven arg translation)

`src/protocol/tool-contract.ts` is the single answer to "what keys does the
host accept?". The `filePath` outage was one instance of a whole class: we
hand-mirrored the host's argument schema, and the mirror drifted. The module
builds a `ToolContract` per tool **from the host's own `inputSchema`** in
`requestContext.tools`, so the mirror cannot drift — the host is the source of
truth on every single turn.

Pipeline, in this order, inside `mapCursorArgsToOpencode`
(`src/protocol/tools.ts`):

1. `cleanRawArgs` — strip Cursor-only fields and protobuf empty-string defaults.
2. `applyInboundAliases` — **proven** renames only (`filePath`→`path`,
   `file_text`→`content`, …). Each entry is documented by the host's migration
   notice or a recorded production failure. Do not add speculative entries.
3. `applySchemaDrivenAliases` — renames the *host's declaration* authorises:
   rename `<from>`→`<to>` only when the schema declares `<to>`, does not
   declare `<from>`, and the caller supplied `<from>`. Two-sided, so it is the
   only alias kind that is safe to grow without a recorded failure
   (`script`→`code` for browser-mcp).
4. `buildOpencodeArgs` — the tool's own mapping, including the manual branches
   (`grep`→`glob`, `write` bytes, …).
5. `forwardDeclaredKeys` — anything the host's schema declares and we did not
   already emit passes through verbatim. This is why MCP tools need no alias
   list at all: their keys arrive under their correct names.
6. `auditEmittedArgs` + `reportArgAudit` — **audit-only, never block.** A
   supplied key the host declares but we did not emit (the silent half), or a
   required key left missing (the loud half), is written once per distinct
   signature to the always-on diagnostics log. Keys supplied but undeclared are
   `trace()`-only, since they are frequently handled semantically.

Rules that must not be relaxed:

- **Fail open everywhere.** No contract for a tool → keys pass through
  unchanged. Unknown `inputSchema` shape (`schemaKnown: false`) → no
  forwarding, no aliasing, no audit. A missing contract has never failed a turn
  and never will.
- **The contract is informational, not an allowlist.** Never reject a call
  because of it; Cursor's own executor may legitimately send fields that are
  absent from the advertised schema.
- `test/fixtures/host-tools.json` is a **live capture** of `requestContext.tools`
  (recorded with `CURSOR_TOOL_SCHEMA_CAPTURE`, `bun run tools:capture`), not
  hand-written and not derived from a binary. `bun run tools:check` diffs a fresh
  capture against it and names the changed keys — run it after an OpenCode
  upgrade. It exits 0 with a warning when no live snapshot exists.
- `test/tool-contract.test.ts` is the regression gate: alias direction, required
  keys, forwarding, and the audit's never-block guarantee.

## Critical behavioral constraints

- **Prompt-cache context:** freeze and persist the stable `RequestContext` base
  (rules, env, repository, git, layout) per Cursor `conversation_id`; rediscover
  tools/MCP, skills, subagents and plugin metadata every Run and overlay them
  deterministically. Reuse the prior materialized object when its protobuf bytes
  are unchanged.
- **Advertisement and permission are independent, and advertisement must never
  fluctuate.** A varying tool set changes the RequestContext shape and costs the
  whole prompt cache, so `resolveTurnToolState` re-advertises the last real
  catalog on *every* zero-tool turn — compaction, title generation, summarization
  alike. A zero-tool call is never "a smaller catalog"; it is the lifecycle
  signal for a Run OpenCode opens **alongside** the real one, and Cursor replays
  the entire agentic turn on it. On cold start, when no catalog is cached, a
  session-keyed zero-tool Run must wait for a sibling `doStream` to publish the
  first real catalog; cancellation is the only escape. Never time out to an empty
  advertisement, never invent or filter the enabled set. Permission is computed
  separately from what actually arrived (`allowTools`), so those turns advertise
  fully but refuse execution — which is why bridged interactions (SwitchMode,
  CreatePlan) gate on `allowTools`, not on advertisement.
- **Tool results:** strip OpenCode's `read` XML envelope before returning
  content to Cursor so the model cannot echo wrappers into writes — but keep the
  *meaning* of the truncation footer: OpenCode caps reads at 50 KB, so re-state
  the cap or the model treats a capped read as the whole file. Native
  `read_args` → `read_result` is the path models actually use; its structured
  `truncated` flag is not sufficient alone, so the content also carries a
  `[Partial read: …]` marker. Whole-file writes / overwriting Add File patches
  that echo the marker are rejected; targeted edits are not. Never mark a read
  the caller bounded itself with `offset`/`limit`.
- **OpenCode V2 tool ids and arg keys (the `filePath` outage).** V2 renames
  three builtins and rejects the old ids — `bash` → `shell`, `task` →
  `subagent`, `apply_patch` → `patch` — and renames the file-target arg key
  `filePath` → `path`. Every exec mapping therefore targets the V2 ids
  (`HOST_SHELL_TOOL`, `HOST_SUBAGENT_TOOL`, `APPLY_PATCH_TOOL`) and emits
  `path`; the retired ids and key are still *accepted* on the way in
  (`isShellTool`, `isSubagentTool`, `isApplyPatchTool`, `argFilePath`) so a
  stale checkpoint or an older catalog keeps working. Getting this wrong is
  silent and total: OpenCode's validator strips an unknown key and answers
  `- path: Missing key`, so before this was fixed **every** Cursor `write`,
  `edit` and `read` failed and not one file ever changed on disk. The `subagent`
  tool additionally takes `agent` / `sessionID` where 1.x took `subagent_type` /
  `task_id`. Never reintroduce the old names as literals — derive from the
  advertised catalog when a choice is needed. That derivation is now the
  **tool contract** section above; read it before touching any arg mapping.
- **Plan-agent awareness.** `plugin.ts` records the owning agent per session
  (`session-agent.ts`, from `session.hook("context")`), and
  `buildOpenCodeInteractionGuidance` reads it. OpenCode enforces `plan` with
  `permissions.push(effect: "deny")` on `*`, and no tool in the catalog says
  so — without the note the model learns it by attempting the edit (observed
  live: 610 host denials across 40 sessions). The guidance therefore never
  names `plan_enter` / `plan_exit` / `todowrite`, which V2 does not ship: an
  instruction telling the model to call a tool the host rejects is strictly
  worse than silence.
- **Write content:** `WriteArgs` has six fields, and `file_bytes` (#5) plus
  `encoding_hint` (#6) carry the content whenever Cursor sends bytes instead of
  `file_text`. Cursor's own executor prefers bytes when non-empty. Never move
  those two into `CURSOR_INTERNAL_KEYS` — they are content, not metadata.
- **Edit-tool substitution:** `remapEditToolsForCatalog` translates Cursor's
  native write/edit exec requests into the host's patch-tool envelopes, keyed
  **only** off the advertised tool set — never off a model id or a host version.
  `advertisedPatchTool` picks whichever id the host offered this turn (`patch` in
  V2, `apply_patch` in 1.x). Rationale and upstream citations live in
  `src/protocol/apply-patch.ts`.
- **AskQuestion bridge:** Cursor's native AskQuestion is an inbound
  `InteractionQuery` (#3), not an exec request, and it is the one interaction
  OpenCode can genuinely satisfy — so translate it into the host `question` tool
  rather than refusing it. Refusing made models narrate "the AskQuestion tool is
  unavailable" and answer in prose while `question` sat advertised and never once
  called. Strip a *trailing* catch-all option (OpenCode's `custom` adds its own),
  map answer labels back to option ids with anything unmatched becoming
  `freeform_text`, and keep Cursor CLI's reason strings verbatim. `run_async`
  replies `async{}` at once and delivers answers later through
  `ConversationAction.async_ask_question_completion_action` echoing the server's
  own `AskQuestionArgs` **bytes**. Only unbridgeable turns (no advertised
  `question`, or `allowTools=false`) reject, and the reason must name the real
  cause.
- **SwitchMode bridge:** Cursor's native SwitchMode is an inbound
  `InteractionQuery` (#4) with `SwitchModeArgs{target_mode_id, explanation?,
  tool_call_id}`; the CLI blocks until `approved{}` / `rejected{reason}` and has
  no async variant. OpenCode 2.0 ships **no** `plan_enter` / `plan_exit` tool —
  its only model-callable primary switch is `ctx.session.switchAgent`, which a
  provider cannot reach — so translate rather than refuse: `plan`/`spec` →
  *enter plan*, every other non-empty target → *leave plan*, carried as the
  `SwitchModeTargetTag` strings (`plan_enter` / `plan_exit`) that
  `mapSwitchModeTarget` returns. Entering needs no host tool and is approved
  outright; leaving degrades to the `question` prompt so the user still
  approves before execution starts. After approval, record the Cursor unified
  mode per OpenCode session and inject a CLI-shaped `<system_reminder>` on
  subsequent Runs via `takeActiveCursorModeReminder`. Do not spawn `subagent`s
  for SwitchMode itself. Resolve the channel from the canonical tool catalog
  alone, never from host identity. A lifecycle turn (`allowTools=false`)
  soft-acks with `approved{}` and must not mutate session mode.
- **CreatePlan bridge:** Cursor's `create_plan_request_query` (#7) writes plain
  markdown and returns a `file://` `plan_uri`; it never writes into the project
  worktree and never into Cursor's own `~/.cursor` — host-native locations only
  (`hostPlansDir` in `src/context/paths.ts`). Body is plain markdown.
  **Writing a plan never asks; executing one always does**, and every host
  reports that through one contract — `success` means the user approved
  execution, `error` means the plan was written but not accepted. Never let a
  refinement request return success: Cursor then implements the plan the user
  just asked to change. **The user must be able to read the plan before
  approving it.** Cursor routes the plan body through the interaction query,
  never the text stream, so on the emulated path `renderPlanReviewMessage` emits
  the plan into the assistant message *before* the question — not into the
  question text, because OpenCode renders the question dock outside its scrollbox
  and a full plan there pushes the conversation off screen. Only an explicit
  "Yes" approves. The gate is armed only while `isCursorPlanModeActive`, never on
  a lifecycle turn. On approval, `plan-execution-kickoff.ts` calls
  `ctx.session.switchAgent({ sessionID, agent: "build" })` then
  `ctx.session.prompt(...)` — relying on the model to raise SwitchMode back is
  **not** a gate (observed live: the model wrote the plan and ended the turn, so
  nothing ever asked). A SwitchMode whose target is already in effect
  auto-approves, as Cursor's own IDE handler does.
- **Image generation:** Cursor approves via `InteractionQuery` #12, generates
  server-side, then writes the image with an ordinary write exec to
  `<artifactsFolder|projectFolder>/assets/<basename>` and branches on the host's
  `WriteResult.permission_denied`. The display `generate_image_tool_call.result
  .image_data` is **preview only** — Cursor CLI feeds it to its terminal image
  cache, which falls back to reading the path off disk. Never write from that
  frame; the bytes would land twice. Non-text bytes are staged
  (`src/image-staging.ts`) for the `cursor_image_save` tool, which mirrors
  OpenCode's own `write` gate: `external_directory` for a target outside the
  project (the by-design default), then `edit` with a worktree-relative pattern;
  roots are realpath-resolved on both sides. Then the bytes are written verbatim.
  A refusal returns Cursor's own `WriteResult.permission_denied` (#3). **The tool
  takes only a single-use opaque id** — never a path or content — so its presence
  in the catalog gives no model a way to write arbitrary files. Keep it that way.
  **V2 has no tool-side permission prompt**: `ToolContext` has no `ask()` and
  `ctx.permission` exposes only `list`/`get`/`reply` plus an `evaluate` hook, so
  `ask` is a traced no-op and `resolveContainedImagePath` is the real gate.
  `remapCursorImageWritePath` maps Cursor's target onto a real host location: the
  advertised `project_folder` and the workspace pass through, anything else is
  rebased to `<projectDir>/assets/<basename>` rather than refused — landing
  there, outside the worktree, is the intended default. Do not "fix" it to write
  into the workspace. The commit tool must not return `attachments`: OpenCode
  gates media-in-tool-result on an allowlist no third-party provider can join, so
  media is always extracted into a trailing user message, which stops the next
  turn from looking like a tool continuation, opens a fresh Run, and strands the
  pending write result.
- **Legacy edit reads:** `edit_tool_call` uses a private `read_args` →
  whole-file `write_args` transaction. For the exact correlated regular file
  inside the real workspace, answer the private read directly with complete
  content up to Cursor's 50 MB edit limit; OpenCode's 50 KB read cap is unsuitable
  here. External paths and symlink escapes must first pass through the
  permission-aware read.
- **Persisted KV blobs:** a Cursor checkpoint holds content-addressed references
  and is not independently replayable. At successful `TurnEnded`, persist only
  blobs reachable from the latest checkpoint. If decoding fails or a referenced
  hash is absent, retain the complete set rather than write an incomplete
  restart snapshot.
- **Checkpoint transport budget:** inspect the checkpoint-reachable KV graph
  before opening the next Run. Above 100 MiB, or when reachability cannot be
  proved complete, rotate `conversation_id` and rebase from OpenCode's
  authoritative history instead of replaying hundreds of megabytes through
  `get_blob`. Report checkpoint-envelope bytes, reachable blob bytes, and
  seed/wire estimates separately; blob bytes are not tokens.
- **Run write backpressure:** response-required protocol writes must be
  serialized per stream and await HTTP/2 drain. Never queue successive KV
  `get_blob` replies after `write()` returns false, and never let a heartbeat
  misattribute an already-pending response write.
- **Cursor-authoritative token totals:** Cursor's checkpoint
  `ConversationStateStructure.token_details` (#5) is the authoritative context
  snapshot. Expose `used_tokens` / `max_tokens` / category breakdown under
  `providerMetadata.cursor.context` and make AI SDK input + output equal
  `used_tokens`. Held-Run tool boundaries emit the last-known occupancy snapshot
  (`output=1` so the footer updates, remaining occupancy on input/cache) plus
  `providerMetadata.copilot.totalNanoAiu: 0` — OpenCode's only getUsage cost
  override — so snapshots are not billed as new prompts. At `TurnEnded`/`stop`,
  emit the billed occupancy snapshot once with no Copilot override. If a Run
  supplies no token details, retain the prior checkpoint snapshot as
  `checkpoint-previous-turn` / `stale: true`. Never reinterpret `TurnEnded` as
  context occupancy, and never emit per-step occupancy *deltas* (the TUI would
  then show only the increment). Keep this display snapshot separate from
  `resumeCheckpoint` — display state must not make stale transport state
  retry-eligible.
- **Session lifecycle:** `SessionManager` holds a Cursor Run open past `doStream`
  returning whenever a tool exec is still pending, so a later continuation can
  resume it. Registering a *new* Run for the same `openCodeSessionId` closes any
  still-open prior Run for that id. `maxOpenSessions` (default 24) is a hard
  backstop that force-closes the oldest open session rather than accumulating
  streams until Cursor closes the whole shared HTTP/2 connection.
- **Agent host:** resolve via `GetServerConfig`
  (`agentUrlConfig.agentnUrl`). Memoize once per process in memory; never write to
  disk; never silently fall back to a legacy global host on failure.
- **URL options:** `apiBaseURL` (auth / models / GetServerConfig) vs
  `agentBaseURL` (Run stream) are separate. Legacy `baseURL` aliases
  `agentBaseURL` only.
- **Host validation:** explicit agent overrides and GetServerConfig results must
  be HTTPS `*.cursor.sh`; reject others.
- **Telemetry:** `GetServerConfig` sends `telem_enabled: false` by default; opt in
  via `telemetryEnabled` or `CURSOR_GET_SERVER_CONFIG_TELEMETRY`.
- **Device identity:** stable OS-derived device ids (CLI-shaped). Inventing new
  fingerprints risks "too many devices" errors.
- **Compaction cache stability:** compaction and the following normal rebase must
  rotate `conversation_id` and discard checkpoints/blobs, but they transfer the
  frozen workspace context base and the prior materialized-byte comparison seed
  to the new id. Live tools/MCP/skills/agents are still rediscovered; reuse the
  complete RequestContext only when the refreshed encoding is byte-identical.
- **Cache diagnostics:** Cursor exposes read/write counters only once at
  `TurnEnded`, aggregated across its held Run — it has no per-model-call cache
  splits. Do not manufacture them. Start every cache/token investigation with
  [`docs/cache-log-runbook.md`](docs/cache-log-runbook.md).
- **Personal use:** private Cursor agent protocol; account you own; the API can
  change without notice.

## Context this provider sends to Cursor

`src/context/build.ts` builds Cursor `RequestContext` from OpenCode-shaped
discovery: the first of `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` walking up to
the git worktree, global `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`,
`instructions` globs from merged `opencode.json(c)`, `.opencode`
agents/skills/plugins plus `.claude` / `.agents` skill fallbacks, and git +
project layout + env. Keep parity with OpenCode's own discovery when changing it,
and update `test/context.test.ts` alongside.

## Env / paths

| Variable / path | Role |
|-----------------|------|
| `CAVEMAN_COMPRESS` | `0` / `false` disables compression |
| `CAVEMAN_COMPRESS_MIN_BYTES` | Floor before a spawn (default `512`) |
| `CAVEMAN_ENGINE_BIN` | Engine override; otherwise `~/.caveman/bin/caveman-engine`, then `PATH` |
| `CURSOR_API_BASE_URL` | Auth, models, GetServerConfig (default `https://api2.cursor.sh`) |
| `CURSOR_WEBSITE_URL` | OAuth login base |
| `CURSOR_API_KEY` | Env-method credential (`crsr_…`) |
| `CURSOR_PROVIDER_DEBUG` | Wire debug log (`CURSOR_PROVIDER_DEBUG_FILE` to redirect) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Opt in GetServerConfig telemetry |
| `EXA_API_KEY` | Optional Exa key for `custom_websearch`; works anonymously without it |
| `XDG_CACHE_HOME` / `XDG_DATA_HOME` | OpenCode cache / data base (`~/.cache/opencode`, `~/.local/share/opencode`) |
| `<cache>/cursor-models.json` | Model cache (263 KB; makes model listing work offline) |
| `<cache>/cursor-arg-audit.log` | Always-on diagnostics: arg-audit drops + the loaded build stamp |
| `<cache>/cursor-conversations/*.pb.gz` | Per-session restart snapshot, updated at successful `TurnEnded`, expires after 24 h |
| `<cache>/projects/<slug>/` | Cursor project metadata (`project_folder` / `workspace_project_dir`) |
| `~/.caveman/ccr.db` | caveman-engine recovery store (`recoveries` table: handle, tokens before/after, original bytes) |
| OpenCode auth | `~/.local/share/opencode/auth.json`, mirrored into the `credential` table of `~/.local/share/opencode/opencode.db` |

## Working conventions

- Minimal, targeted changes. Fix root causes; no temporary workarounds.
- Keep `README.md` accurate when behavior the user cares about changes (config
  shape, auth, env vars, caveman contract, limitations).
- Tests live in `test/` (Bun test). Mirror protocol/context behavior with unit
  tests when changing encode/decode or discovery.
- `test/context.test.ts` has one known machine-local failure (extra `agents/build`,
  `agents/plan` discovered on this machine) inherited from upstream 0.6.7. It is
  not a regression; do not "fix" it by loosening the assertion.
- `bun test` does not typecheck `test/`; `bun run typecheck` covers `src/` only.
