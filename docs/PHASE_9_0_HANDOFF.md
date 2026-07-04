# Phase 9.0 Handoff

## What changed

Phase 9.0 stayed worker-only and closed the four targeted worker findings from the 2026-04-09 audit. Phase A added duplicate-family rejection to the two write zod schemas and deduped witness families before warmth writes and analytics. Phase B replaced the simple rebuild lock helper with a dirty-marker-aware helper so concurrent writes collapse into one follow-up rebuild instead of dropping committed writes on the floor. Phase C wired `handleWitness` into the projection rebuild path via `ctx.waitUntil(...)`, so dwell-driven warmth changes become visible promptly in cached state. Phase D removed the duplicate `rebuildStateProjectionWithLock` wrapper from `worker/src/index.ts`, switched `handleState` over to the consolidated helper, and added `computed_at` guards in both cache rebuilders so a slower snapshot cannot clobber a newer one.

Phase E added the worker test surface under `worker/tests/` with hand-rolled mocks only. No migrations were added. No renderer files were touched. Nothing under `app/**` changed. `worker/src/types.ts` and `parseModel()` were left untouched.

## Verification

| Check | Command | Actual |
|---|---|---|
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit` | clean |
| Loom tests (baseline) | `bun test tests/loom/` | `82 pass, 0 fail` |
| Worker tests (new) | `cd worker && bun test tests/` | `13 pass, 0 fail` |
| Renderer build | `bun run build` | `dist/main.js = 69884 bytes` |
| Worker dry-run deploy | `cd worker && bun run deploy --dry-run` | clean; `Total Upload: 382.91 KiB / gzip: 93.66 KiB` |
| Diff scope | `git diff --stat main` | `worker/package.json`, `worker/src/cache.ts`, `worker/src/index.ts` in tracked diff |
| Lock key grep | `git grep "state:rebuild:lock" worker/src/` | `worker/src/cache.ts:const STATE_REBUILD_LOCK_KEY = 'state:rebuild:lock'` |
| Old lock wrapper grep | `git grep "rebuildStateProjectionWithLock" worker/src/` | `0 hits` |

`git diff --stat main` only reports tracked edits. New allowed-scope files are still present and visible via `git status --short`:

```text
 M worker/package.json
 M worker/src/cache.ts
 M worker/src/index.ts
?? docs/PHASE_9_0_CHECKPOINT_A.md
?? worker/tests/
```

## Suggested commit structure

1. Phase A: `worker/src/index.ts`
2. Phase B: `worker/src/cache.ts`
3. Phase C: `worker/src/index.ts`
4. Phase D: `worker/src/index.ts` and `worker/src/cache.ts`
5. Phase E: `worker/package.json` and `worker/tests/**`
6. Docs: `docs/PHASE_9_0_CHECKPOINT_A.md` and `docs/PHASE_9_0_HANDOFF.md`

If the human prefers a collapsed history, commits 1-4 can be squashed into one correctness commit, with tests and docs left separate.

## Flags for human review

- The zod refine error surface now returns the explicit message `families must be unique` for duplicate-family write requests.
- `rebuildStateProjectionIfNotLocked` and `rebuildAtmosphereIfNotLocked` now return `'locked' | 'rebuilt' | 'rebuilt-twice'`. Existing call sites discard the return except `handleState`, where the widened value is now reflected in analytics.
- The worker tests use valid in-schema family names (`silence`, `light`) rather than the spec’s placeholder `song`, because the real enum is fixed and rejecting invalid families would not test duplicate-handling.
- No `_testable.ts` shim was needed. The narrow export route from `worker/src/index.ts` worked cleanly in this worktree.

## Open items / next phase

- F4: ext-app base URL injection
- F5: `isLineRTL` same-segment wrap bug
- F6: resonance expiry leak
- M1: split `worker/src/index.ts`
- M2: shared renderer runtime between `src/main.ts` and `app/src/mcp-app.ts`
- M3: deploy-script collapse and a real verify script

These remain intentionally deferred to Phase 9.1 and were not touched here.
