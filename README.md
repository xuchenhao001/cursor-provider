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
- Optional: **caveman-mcp**, so the model can call `caveman_retrieve` to pull
  full bytes back by handle

Compression is **fail-open**. If the engine is missing, errors, or cannot shrink
the payload, the original text is sent unchanged.

## Build

```bash
bun install
bun run build      # tsc → dist/
bun test
```

`dist/` is gitignored, and `server.js` re-exports out of it — rebuild after every
source change before restarting OpenCode, or the host keeps serving the old
plugin.

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

The engine compresses **log-shaped** input well (JSON logs, log dumps, repeated
identical lines). Prose, markdown outlines, and tables come back unchanged —
that is the engine's decision, not a failure.

Measured on a live turn: a 19.5 KB JSON-log prompt went **6168 → 146 tokens**.

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
| `EXA_API_KEY` | — | Enables the `custom_websearch` tool |

## Tools the plugin adds

- **`custom_websearch`** — Exa-backed web search (needs `EXA_API_KEY`). A tool
  rather than V2's first-class `websearch` domain because that one's Result shape
  is structured and Exa returns an opaque text blob.
- **`cursor_image_save`** — writes a Cursor-generated image to disk. Takes a
  single-use opaque image id, never a path or content, so its presence in the
  catalog gives no model a way to write arbitrary files. V2 has no tool-side
  permission prompt, so the containment check is the real gate: targets outside
  the project are rebased to `<projectDir>/assets/<basename>` (outside the
  worktree, by design — generated images are agent artifacts, not repo content).

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
(`~/.caveman/bin/caveman-engine compress < /dev/null`), that the text is over
`CAVEMAN_COMPRESS_MIN_BYTES`, and that it is log-shaped rather than prose.

**Provider loaded but a turn fails with an auth error.** The stored `crsr_` key
is exchanged for a JWT on demand; a rotated or revoked key fails that exchange.
Re-run `/connect`.

## Scope

Private Cursor agent protocol, an account you own, one maintainer. Cursor's API
can change without notice. See [AGENTS.md](./AGENTS.md) for the architecture and
the behavioral constraints the provider has to uphold, and
[PLAN.md](./PLAN.md) for the V2-only refactor notes.
