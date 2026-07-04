# Phase 9.1 Handoff

## What changed

Phase 9.1 closed the three intentionally deferred small fixes from the 2026-04-09 audit plus the build-script cleanup. Phase A fixed the wrapped-line RTL classification bug in `src/loom/text.ts` and added focused coverage in `tests/loom/text.test.ts`. Phase B fixed stale resonance pruning in `src/loom/resonance.ts` so expired entries are removed even when the currently iterated thread does not share their family, with matching coverage in `tests/loom/resonance.test.ts`. Phase C collapsed the root deploy entrypoint down to worker delegation and added a real root `verify` script spanning loom tests, all three typechecks, worker tests, and the renderer build.

Phase D replaced the ext-app hardcoded production base URL with a sentinel in `app/src/mcp-app.ts`, then rewrote that sentinel inside the worker `resources/read` branch using `new URL(request.url).origin`, including dynamic `connectDomains`. Phase D also added `worker/tests/resources.test.ts` and extended the Phase 9.0 worker export line to expose `handleMCP` for narrow testing. `worker/tests/mocks.ts` was reused unchanged.

## Verification

| Check | Command | Actual |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87 pass, 0 fail` |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `16 pass, 0 fail` |
| Verify script | `bun run verify` | clean end-to-end |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle | `bun run build` | `dist/main.js = 69911 bytes` |
| Worker dry-run | `cd worker && bun run deploy --dry-run && cd ..` | clean; `Total Upload: 383.03 KiB / gzip: 93.71 KiB` |
| Diff scope | `git diff --stat main` | `7 tracked files changed`; untracked files are `docs/PHASE_9_1_CHECKPOINT_A.md`, `docs/PHASE_9_1_HANDOFF.md`, and `worker/tests/resources.test.ts` via `git status --short` |
| Sentinel removed from bundle | `grep -c VELLUM_BASE_URL dist/main.js` | `0` |
| Sentinel IS in ext-app bundle | `grep -c __VELLUM_BASE_URL__ app/dist/mcp-app.html` | `1` |
| Old hardcoded URL gone from worker | `git grep "'https://vellum.linxule.com'" worker/src/` | `0 hits` |
| Old hardcoded URL gone from ext-app | `git grep "'https://vellum.linxule.com'" app/src/` | `0 hits` |

## Suggested commit structure

1. Phase A: `src/loom/text.ts` + `tests/loom/text.test.ts`
2. Phase B: `src/loom/resonance.ts` + `tests/loom/resonance.test.ts`
3. Phase C: `package.json`
4. Phase D: `app/src/mcp-app.ts` + `worker/src/index.ts` + `worker/tests/resources.test.ts`
5. Phase E docs: `docs/PHASE_9_1_CHECKPOINT_A.md` + `docs/PHASE_9_1_HANDOFF.md`

No divergence from the requested five-commit structure is needed.

## Flags for human review

- Bundle size delta vs. baseline is `+27 bytes` (`69884` → `69911`), well inside the spec tolerance.
- Test count delta vs. baseline is loom `82` → `87` (`+5`) and worker `13` → `16` (`+3`), for a net suite delta of `+8` tests.
- `worker/tests/mocks.ts` was not extended in Phase D. The existing 9.0 mock layer already covered `handleMCP` for `resources/read`.
- The only export-surface change beyond the 9.0 baseline line was the expected addition of `handleMCP` to `export { ZOD_SCHEMAS, handleWitness, handleMCP }`.
- Phase D needed a test-wiring judgment call: under `bun test`, importing `../../app/dist/mcp-app.html` yields an `HTMLBundle` object, not the string Wrangler injects in worker builds. The test uses `mock.module(...)` to replace that module with the built HTML string before importing `handleMCP`, keeping production code unchanged.
- The diff-scope row in the spec mixes tracked and untracked expectations. `git diff --stat main` truthfully reports only the 7 tracked edited files; the 3 new files are visible separately in `git status --short`.

## Open items

- M1: split `worker/src/index.ts` remains deferred to Phase 9.2.
- M2: shared renderer runtime between `src/main.ts` and `app/src/mcp-app.ts` remains deferred to Phase 9.2.
- F1/F2/F7 renderer display behavior is still a separate feature pass, not part of this hardening work.
