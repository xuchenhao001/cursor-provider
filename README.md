# cursor-caveman

Personal [OpenCode](https://opencode.ai) **V2** provider that runs **Cursor
subscription models** by speaking Cursor's Connect-RPC `agent.v1` agent protocol
— not a generic chat-completions API — and pipes large user prompts and tool
outputs through **caveman-engine** before they hit the wire.

OpenChamber shares this OpenCode config, so the same provider and the same
compression apply there.

```
OpenCode config
  plugins:      [<repo dir>]  →  server.js  →  dist/plugin.js   (credentials, catalog, tools, hooks)
  providers.cursor.package    →  dist/index.js → createCursor() → LanguageModelV3
```

The provider is **config-driven**: OpenCode imports `dist/index.js` directly and
calls the `createCursor` factory it finds there. The plugin is a companion — it
resolves credentials, discovers the model catalog, registers the Cursor-only
tools, and installs the hooks a held-open Cursor Run needs.

## Prerequisites

- [Bun](https://bun.sh) — build and tests
- **caveman-engine** on disk: `npm i -g @caveman-ai/cli` then
  `caveman setup --install`, which puts it at `~/.caveman/bin/caveman-engine`
- **caveman-mcp**, and `~/.caveman/bin` on `PATH` — see "The recovery path is
  not optional" below

The binaries normally land in `~/.caveman/bin`, which is not on `PATH` by
default. Symlink them so both the model's `shell` tool and a bare login shell can
find them:

```bash
for b in ~/.caveman/bin/caveman-*; do ln -sfn "$b" ~/.local/bin/$(basename "$b"); done
```

Compression is **fail-open**. If the engine is missing, errors, or cannot shrink
the payload, the original text is sent unchanged.

### The recovery path is not optional

Every compressed block gets a trailing hint:

```
recover: call caveman_retrieve with recovery_handle="ccr_…" to get these bytes back in full.
```

If `caveman-mcp` is not registered as an MCP server, that hint names a tool the
model does not have — worst case it burns a turn narrating a missing tool. If
`~/.caveman/bin` is not on `PATH`, the `bash` fallback
(`caveman-engine retrieve <handle>`) fails too, leaving the model no way to get
the bytes back at all. Register the server alongside the provider:

```jsonc
"mcp": {
  "servers": {
    "caveman": {
      "type": "local",
      "command": ["/Users/chenhaoxu/.caveman/bin/caveman-mcp"],
      "enabled": true
    }
  }
}
```

Cost is ~3 KB of tool schema per request (five tools: `caveman_retrieve`,
`caveman_compress`, `caveman_stats`, `caveman_toon_encode`,
`caveman_toon_decode`) against compression savings measured in tens of thousands
of tokens. It only has to buy back one full recovery to pay for itself.

## Build

```bash
bun install
bun run build      # tsc → dist/ + build stamp (src content hash + git sha)
bun run verify     # typecheck + build + check:dist + test + tools:check
bun test
```

`dist/` is gitignored, and `server.js` re-exports out of it — rebuild after every
source change before restarting OpenCode, or the host keeps serving the old
plugin. `bun run build` also writes `dist/.build-stamp.json`, which the plugin
records on load in the always-on diagnostics log (below), and
`bun run check:dist` fails when `dist/` no longer matches `src/`.

## Enable in OpenCode

Add the plugin directory and the provider to `~/.config/opencode/opencode.jsonc`
(adjust the path to wherever this repo lives):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // A plugin entry must be a package DIRECTORY. Pointing it at a .js file is
  // rejected with "configured plugin path must be a directory", and for an
  // absolute directory the host resolves `<dir>/server.*` then `<dir>/index.*`
  // without consulting the package's exports map — hence the repo-root server.js.
  "plugins": [
    "/Users/chenhaoxu/Documents/git/opencode-cursor"
  ],

  "providers": {
    "cursor": {
      // Import the built provider directly. No npm publish, no registry lookup.
      "package": "aisdk:file:///Users/chenhaoxu/Documents/git/opencode-cursor/dist/index.js",
      "name": "Cursor (caveman)"
      // No "models" block needed — the plugin discovers them from your account.
    }
  }
}
```

Both values are optional but explicit here on purpose: the plugin fills in
`package` and `name` when they are unset, and it never overwrites a value you
set yourself.

Then restart the service:

```bash
opencode service restart
opencode service status        # → http://127.0.0.1:<port>
opencode models | grep '^cursor/'   # → ~60 models once connected
```

## Connect

The plugin registers a `cursor` integration with three methods:

| Method | How |
|---|---|
| OAuth | `/connect` in the TUI → Cursor login |
| API key | paste a `crsr_…` key from cursor.com/settings |
| env | set `CURSOR_API_KEY` |

Credentials land in `~/.local/share/opencode/auth.json` (and the `credential`
table of `opencode.db`). Model discovery runs once credentials exist, then
replays the catalog transform — until then the model picker is empty but not
broken. Discovery falls back to the on-disk cache
(`~/.cache/opencode/cursor-models.json`) when offline, so a stale token never
empties the picker.

## What gets compressed

Three sites, all funnelled through `cavemanCompressText`:

- the latest user message text on each Run (never the recovery-rebase
  placeholder)
- tool results written back on an exec continuation
- tool observations folded into seed history (compaction / rebase paths)

Not compressed: system prompts, recovery-tool output, anything under the size
floor, and text that already carries a caveman `… N lines elided (caveman) …`
marker. That marker is the idempotency guard — OpenCode resends history verbatim,
so already-elided text is never re-elided.

The engine is a **repetition-and-elision** compressor, not a log compressor. It
detects a content class, then elides lines it can prove are redundant and leaves
a handle for the rest. The class is not what decides the outcome — repetition
is. `grep` output and uniform prose are both classified `text`, yet one elides
and the other does not, because in the prose every line carries distinct
information and nothing is safely droppable.

Measured on real tool output (from this machine's own recovery store):

| Input | Tokens | Saved |
|---|---|---|
| `grep` / search output | 34,954 → 6,682 | 81% |
| Log lines, JSON logs | 15,695 → 634 | 96% |
| TypeScript source | 2,323 → 1,245 | 46% |
| Uniform prose, markdown outlines, pipe tables | unchanged | 0% |

Pass-through is not a failure and costs nothing but a ~15 ms spawn.

## Recovery

When the engine shrinks a block it stores the exact original in
`~/.caveman/ccr.db` and reports a `ccr_<hex>` handle. The provider appends one
line to the compressed text so the model knows it can pull the bytes back:

```
recover: call caveman_retrieve with recovery_handle="ccr_…" to get these bytes back in full.
```

```bash
sqlite3 -header ~/.caveman/ccr.db \
  'select handle, created_at, content_type, tokens_before, tokens_after from recoveries order by created_at desc limit 5;'

caveman-engine retrieve ccr_…      # raw original, always available
```

`caveman_retrieve` itself comes from caveman's MCP server (`caveman-mcp`).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CAVEMAN_COMPRESS` | on | Set `0` or `false` to disable |
| `CAVEMAN_COMPRESS_MIN_BYTES` | `512` | Minimum string size worth a spawn |
| `CAVEMAN_ENGINE_BIN` | auto | Path to `caveman-engine`; falls back to `~/.caveman/bin/caveman-engine`, then `PATH` |
| `CURSOR_API_BASE_URL` | `https://api2.cursor.sh` | Auth, models, GetServerConfig |
| `CURSOR_WEBSITE_URL` | Cursor login base | OAuth start |
| `CURSOR_API_KEY` | — | Env-method credential |
| `CURSOR_PROVIDER_DEBUG` | off | Wire debug log; `CURSOR_PROVIDER_DEBUG_FILE` redirects it |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | off | Opt in to GetServerConfig telemetry |
| `CURSOR_TOOL_SCHEMA_CAPTURE` | — | Path to write the host's live tool catalog (see "Keeping up with the host") |
| `EXA_API_KEY` | — | Optional; attaches your own Exa key to `custom_websearch` |

## Tools the plugin adds

- **`custom_websearch`** — Exa-backed web search. It talks to Exa's public MCP
  endpoint anonymously, so it works with no configuration; set `EXA_API_KEY` to
  attach your own key and lift the anonymous rate limits. A tool
  rather than V2's first-class `websearch` domain because that one's Result shape
  is structured and Exa returns an opaque text blob.
- **`cursor_image_save`** — writes a Cursor-generated image to disk. Takes a
  single-use opaque image id, never a path or content, so its presence in the
  catalog gives no model a way to write arbitrary files. V2 has no tool-side
  permission prompt, so the containment check is the real gate: targets outside
  the project are rebased to `<projectDir>/assets/<basename>` (outside the
  worktree, by design — generated images are agent artifacts, not repo content).

## Keeping up with the host

The provider translates Cursor's tool arguments into whatever OpenCode's
current catalog declares, driven by **the host's own advertised `inputSchema`**
rather than a hand-maintained mirror — the mirror is what drifted and caused the
outage where every Cursor `write`, `edit` and `read` failed with
`- path: Missing key`. Three things keep the two sides honest:

- **Unknown keys are forwarded, not dropped.** Anything the host's schema
  declares and the mapper did not already emit passes through verbatim, so MCP
  tools need no alias list at all.
- **A drop is loudly reported, never silently swallowed.** Any supplied key the
  schema declares but the translator did not emit, or any required key left
  missing, is written once per unique shape to
  `~/.cache/opencode/cursor-arg-audit.log`. It never blocks the call.

Plugin diagnostics do not reach OpenCode's own log — plugin `console.error` is
dropped by the host — so that file is where to look:

```bash
tail ~/.cache/opencode/cursor-arg-audit.log
# also records the build stamp, so it answers "which commit is live?"
```
- **The catalog is captured, not guessed.** `test/fixtures/host-tools.json` is a
  live recording of the host's tool list. After an OpenCode upgrade:

  ```bash
  bun run tools:capture   # one real Cursor call records a fresh snapshot
  bun run tools:check     # diffs it against the fixture, naming changed keys
  ```

## Troubleshooting

**No `cursor/…` models.** Check that the plugin actually loaded:

```bash
grep 'loading plugin' ~/.local/share/opencode/log/opencode.log | tail
# expect: id=<repo dir>  entrypoint=file://<repo dir>/server.js
```

No line at all means the directory did not resolve — make sure `server.js` and
`dist/plugin.js` both exist (`bun run build`) and that the `plugins` entry is the
**directory**, not a file. A `.js` entry produces
`configured plugin path must be a directory` and is silently dropped.

**Model picker empty but the log shows a load.** Credentials are not resolved
yet — run `/connect`. Discovery is lazy and retries once a credential exists.

**Compression never happens.** Confirm the engine is reachable
(`caveman-engine compress < /dev/null`), that the text is over
`CAVEMAN_COMPRESS_MIN_BYTES`, and that it is *repetitive* rather than
information-dense — logs, `grep` output and source compress well; prose where
every line carries new information does not. `caveman-engine detect` shows the
class it inferred, and `caveman-engine stats` shows realized savings per class.

**A compressed block tells the model to call `caveman_retrieve` and it cannot.**
`caveman-mcp` is not registered (see "The recovery path is not optional"), or
`~/.caveman/bin` is not on `PATH`. Verify with
`caveman-engine retrieve ccr_<hex>`, which must print the original bytes.

**Provider loaded but a turn fails with `Cursor authentication failed
(unauthenticated)`.** Two distinct causes, and the second one is easy to miss.

*The credential is dead.* Cursor revokes keys and OAuth grants, so something
that worked yesterday can 401 today. Inspect what is actually stored — the shape
depends on how you authenticated (`key` for a pasted `crsr_…`, `oauth` for
`/connect`):

```bash
sqlite3 ~/.local/share/opencode/opencode.db \
  "select method_id, substr(value,1,160) from credential where integration_id='cursor' and active=1;"
```

For a `key` credential, confirm the exchange — it must return an `accessToken`,
not `Invalid User API Key`:

```bash
key=$(sqlite3 ~/.local/share/opencode/opencode.db \
  "select value from credential where integration_id='cursor' and active=1;" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('key',''))")
curl -s -X POST https://api2.cursor.sh/auth/exchange_user_api_key \
  -H 'Content-Type: application/json' -d "{\"apiKey\":\"$key\"}"
```

Then re-run `/connect` or paste a fresh key from cursor.com/settings.

***Re-authentication is picked up on the next turn — no restart.*** The plugin
resolves the credential per request through `accessTokenSource`, memoizes it for
60 seconds, and drops the memo as soon as any `credential.*` event arrives, so a
successful `/connect` takes effect immediately. A failed refresh keeps serving
the last good token rather than failing the turn.

If a turn still fails with `unauthenticated` after re-authenticating, the
credential itself is bad rather than merely stale — fix the credential (the
checks above), not the service. A restart is only needed after a source change,
for the reason at the top of this file.

A transport failure also takes a long time to surface (around 90 s measured
against a dead endpoint) and redraws the `> agent · model` header repeatedly
while it waits. That is the CLI re-rendering, not an attempt loop: the provider's
own budget is two attempts (`maxAttempts` 2, one retry with exponential
backoff).

## Scope

Private Cursor agent protocol, an account you own, one maintainer. Cursor's API
can change without notice. See [AGENTS.md](./AGENTS.md) for the architecture and
the behavioral constraints the provider has to uphold, and
[PLAN.md](./PLAN.md) for the V2-only refactor notes.
