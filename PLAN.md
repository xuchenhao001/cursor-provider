# Cursor provider with caveman compression

See [README.md](./README.md) for install and config. Implementation lives in `upstream/` (fork of cursor-opencode-provider 0.6.7).

Compression hook: `upstream/src/caveman/compress.ts`, wired from `upstream/src/language-model.ts` for user text, exec tool output, and seed-history tool observations.

## Implementation notes

- **Upstream pin:** cursor-opencode-provider 0.6.7, commit `889ad0bf981c0c325100134d86be87f426bc940f` (detached HEAD in `upstream/`). Rebase the three `cavemanCompressText` call sites when upgrading.
- **Engine contract (verified against the real `caveman-engine`, darwin/arm64):** `caveman-engine compress` reads stdin (64 MiB cap), writes compressed bytes to stdout, and emits ONE **flat** JSON report on stderr. Relevant fields: `content_type`, `tokens_before`, `tokens_after`, `ratio`, `recovery_handle` (`ccr_<hex>`, omitted on pass-through), `method`, `lossless_to_model`, and an optional `error` code (`cave_ccr_unavailable`). The parser in `compress.ts` reads `recovery_handle` from the top level and tolerates a nested `result`/`Result` wrapper.
- **Recovery:** originals are stored by the engine in `~/.caveman/ccr.db` (override with `CAVEMAN_CCR_DB`). `caveman-engine retrieve <handle>` returns the byte-exact original — round-trip verified.
- **Idempotency:** `shouldSkipCavemanCompress` refuses to re-compress any string already carrying the engine's `… N lines elided (caveman) …` marker, so resent history is never double-elided.
- **Wiring under OpenCode 2.0.22:** the global config loads `dist/plugin-opencode2.js` via the `plugins` array and sets `provider.cursor.npm` to `file://…/dist/index.js`. `opencode debug config` confirms the provider resolves as `aisdk:file://…` (the local build, not the published npm package), so the compression hook is live. `CURSOR_OPENCODE2_DEV_ENTRY` is NOT needed because the `npm` override already redirects the catalog.
- **Tests:** `bun test test/caveman-compress.test.ts` — 7 pass (4 unit fail-open/idempotency guards + 3 real-engine integration: log shrinks keeping the ERROR line, handle recovers the original byte-for-byte, re-compress keeps error+marker). Full upstream suite: 978 pass, 1 pre-existing environmental failure in `test/context.test.ts` (reproduces on a clean 0.6.7 checkout; subagent discovery picks up `agents/build`/`agents/plan` from this machine — unrelated to the fork).
