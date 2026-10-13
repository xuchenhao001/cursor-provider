# cursor-caveman-provider

Fork of [cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider) that runs **caveman-engine** on large user prompts and tool outputs **before** encoding them for Cursor's `agent.v1` API.

OpenChamber uses the same OpenCode `cursor` provider, so compression applies there too once this build is loaded.

## Prerequisites

- [Bun](https://bun.sh) (build and tests)
- **caveman-engine** on disk (`npm i -g @caveman-ai/cli` then `caveman setup --install`, or `~/.caveman/bin/caveman-engine`)
- Optional: **caveman-mcp** so the model can call `caveman_retrieve` for full bytes

Compression is **fail-open**. If the engine is missing or cannot shrink the payload, the original text is sent.

## Build

```bash
cd upstream
bun install
bun run build
bun test
```

## Enable in OpenCode

Point plugins at the built OpenCode 2 entry (adjust path if needed):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "file:///Users/chenhaoxu/git/cursor-caveman-provider/upstream/dist/plugin-opencode2.js"
  ],
  "provider": {
    "cursor": {
      "npm": "file:///Users/chenhaoxu/git/cursor-caveman-provider/upstream/dist/index.js",
      "name": "Cursor (caveman)",
      "models": {}
    }
  }
}
```

Restart the OpenCode service after changing config:

```bash
opencode service restart
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CAVEMAN_COMPRESS` | on | Set `0` or `false` to disable |
| `CAVEMAN_COMPRESS_MIN_BYTES` | `512` | Minimum string size to compress |
| `CAVEMAN_ENGINE_BIN` | auto | Path to `caveman-engine` |

## What gets compressed

- Latest user message text on each Run (not the recovery rebase placeholder)
- Tool results written back on exec continuation
- Tool observations included in seed history (compaction / rebase paths)

Not compressed: system prompts, recovery tool output, strings under the size floor, and text that already carries a caveman `… N lines elided (caveman) …` marker (so resent history is never re-elided).

## Recovery

When the engine shrinks a block it stores the exact original in `~/.caveman/ccr.db` and reports a handle (`ccr_<hex>`) on stderr. The provider appends one line to the compressed text so the model can pull the full bytes back:

```
recover: call caveman_retrieve with recovery_handle="ccr_…" to get these bytes back in full.
```

`caveman_retrieve` is provided by caveman's MCP server (`caveman-mcp`). The raw original is also always available via `caveman-engine retrieve <handle>`. Compression is fail-open: if the engine is missing, errors, or does not shrink the payload, the original text is sent unchanged.

See [PLAN.md](./PLAN.md) for design notes.
