# Phase 9.2 Handoff

## What changed

Phase 9.2 completed the worker-only M1 split of `worker/src/index.ts` into nine focused files with no renderer edits and no behavior changes. The extracted modules are `worker/src/schemas.ts`, `worker/src/hmac.ts`, `worker/src/jsonrpc.ts`, `worker/src/analytics.ts`, and `worker/src/handlers/{mcp,state,witness,admin}.ts`. `worker/src/index.ts` is now an 86-line router/CORS entrypoint with the load-bearing narrow export line preserved.

The narrow test surface remains intact: `worker/src/index.ts` still exports `ZOD_SCHEMAS`, `handleWitness`, and `handleMCP`, so the four existing worker test files continue to import from `../src/index` unchanged. `pensieveHtml` stays imported in exactly two places: `worker/src/handlers/mcp.ts` for the `resources/read` rewrite path and `worker/src/index.ts` for the `/ext-app` standalone fallback route.

## Verification

| Check | Command | Actual |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87 pass, 0 fail` |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `16 pass, 0 fail` |
| Verify script | `bun run verify` | clean end-to-end |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle | `bun run build && wc -c dist/main.js` | `69911 bytes` |
| Worker dry-run | `cd worker && bun run deploy --dry-run && cd ..` | clean; `Total Upload: 383.31 KiB / gzip: 94.42 KiB` |
| Narrow exports | `grep -n "export.*handleMCP\|export.*handleWitness\|export.*ZOD_SCHEMAS" worker/src/index.ts` | `86:export { ZOD_SCHEMAS, handleWitness, handleMCP }` |
| Reduced entrypoint size | `wc -l worker/src/index.ts` | `86` |
| File layout | `ls worker/src && ls worker/src/handlers` | matches allowlist: `schemas.ts`, `hmac.ts`, `jsonrpc.ts`, `analytics.ts`, `handlers/{mcp,state,witness,admin}.ts` plus untouched existing files |
| Diff scope | `git diff --stat main` + `git status --short` | tracked diff is the `worker/src/index.ts` shrink; new allowlist files are untracked and visible via `git status --short` |

## Suggested commit structure

1. Phase A: `worker/src/schemas.ts` + `worker/src/index.ts`
2. Phase B: `worker/src/hmac.ts` + `worker/src/index.ts`
3. Phase C: `worker/src/jsonrpc.ts` + `worker/src/analytics.ts` + `worker/src/index.ts`
4. Phase D: `worker/src/handlers/*.ts` + `worker/src/index.ts`
5. Phase E: no-op verification pass; no separate commit needed unless the reviewer wants an explicit checkpoint marker
6. Phase F docs: `docs/PHASE_9_2_CHECKPOINT_A.md` + `docs/PHASE_9_2_HANDOFF.md`

## Flags for human review

- `worker/src/index.ts` is now `86` lines, within the spec target range, and still ends with `export { ZOD_SCHEMAS, handleWitness, handleMCP }`.
- Renderer output stayed byte-identical to baseline: `dist/main.js` remained `69911` bytes before and after the worker refactor.
- Worker dry-run upload drift stayed within the spec tolerance: baseline `383.03 KiB / 93.71 KiB gzip` to final `383.31 KiB / 94.42 KiB gzip`.
- `git diff --stat main` only reports tracked edits, so it understates the actual scope until files are staged; `git status --short` is the reliable view for the new allowlist files in this worktree.
- The expected worker test stderr from `witness-rebuild.test.ts` still appears during green runs: the mocked failed warmth update intentionally logs `Failed to update warmth for silence`.

## Open items

- No code blockers. The Phase 9.2 refactor is complete within the allowlist.
- Per instruction, no commit was created, no push was attempted, and no deploy was run beyond the required `--dry-run`.
