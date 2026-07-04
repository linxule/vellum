# Phase 9.6 Handoff

## Overall status

Phase 9.6 is complete. Scope stayed inside scripts + docs only. `worker/src/`, `src/`, and `app/src/` are unchanged.

## 9.6-1 — `scripts/smoke.ts`

### Created

- `scripts/smoke.ts`

### Notes

- Standalone Bun script with one optional positional base URL argument.
- Runs 6 checks in the spec order.
- Each check is isolated, uses a 10s timeout, and reports `[PASS]` or `[FAIL]` without throwing.
- `dist/main.js` is resolved from `import.meta.url`, so the bundle-size check works regardless of cwd.

### Happy-path output (`bun run scripts/smoke.ts`)

```text
Vellum smoke — https://vellum.linxule.com
[PASS] /api/state returns 200 with 6 threads, 283 voices
[PASS] /ext-app sentinel rewritten (0 sentinels, 1 origin ref)
[PASS] /mcp ping returns 200 with valid JSON-RPC result
[PASS] /mcp malformed body returns 400 + -32700
[PASS] /api/witness malformed body returns 400
[PASS] dist/main.js bundle size 71048 bytes ≤ 72000
Result: 6/6 passed — HEALTHY
```

### Sad-path output (`bun run scripts/smoke.ts https://vellum-does-not-exist.example/`)

```text
Vellum smoke — https://vellum-does-not-exist.example/
[FAIL] /api/state returns 200 with 6 threads + voices (Unable to connect. Is the computer able to access the url?)
[FAIL] /ext-app sentinel rewritten (Was there a typo in the url or port?)
[FAIL] /mcp ping returns 200 with valid JSON-RPC result (Unable to connect. Is the computer able to access the url?)
[FAIL] /mcp malformed body returns 400 + -32700 (Was there a typo in the url or port?)
[FAIL] /api/witness malformed body returns 400 (Unable to connect. Is the computer able to access the url?)
[PASS] dist/main.js bundle size 71048 bytes ≤ 72000
Result: 1/6 passed — DEGRADED
```

## 9.6-2 — root `package.json` script alias

### Modified

- `package.json`

### Notes

- Added `"smoke": "bun run scripts/smoke.ts"` to the root scripts block.
- Kept smoke out of `verify` and `deploy`.
- Reordered the scripts block so the new alias lands alphabetically with the existing entries.

## 9.6-3 — observability reference doc

### Created

- `docs/OBSERVABILITY.md`

### Modified

- `CLAUDE.md`

### Notes

- `docs/OBSERVABILITY.md` stays under 200 lines (`58` lines).
- Added the requested one-line pointer under `CLAUDE.md` → `Where to look`.

## Exact files created / modified

### Created

- `scripts/smoke.ts`
- `docs/OBSERVABILITY.md`
- `docs/PHASE_9_6_HANDOFF.md`

### Modified

- `package.json`
- `CLAUDE.md`

## Deviations from spec

- The bad-URL smoke result is `1/6 passed`, not `0/6 passed`. This is because the bundle-size check is intentionally local-to-repo and still passes when the target host is unreachable.
- `docs/OBSERVABILITY.md` uses the current live deployment version from the execution prompt, `e2ccf9eb-80e0-471b-92ba-377f0e296ae6`, instead of the older `a6727c65` value embedded in the spec. The spec baseline was stale relative to production by the time Phase 9.6 executed.
- The worker startup-time note in `docs/OBSERVABILITY.md` is operational guidance rather than a hard measured repo-local number. No numeric startup metric source exists in-repo today.

## Final verification matrix

| Check | Command | Result |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87` pass |
| Worker tests | `cd worker && bun test tests/` | `20` pass |
| Verify script | `bun run verify` | clean |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Smoke against prod | `bun run smoke` | `6/6` passed, exit `0` |
| Smoke against bad URL | `bun run smoke https://invalid.test` | `1/6` passed, exit `1` |
| `scripts/smoke.ts` exists | `ls scripts/smoke.ts` | present |
| `docs/OBSERVABILITY.md` exists | `ls docs/OBSERVABILITY.md` | present |
| `package.json` has smoke script | `grep '"smoke"' package.json` | one match |
| `CLAUDE.md` has pointer | `grep 'OBSERVABILITY.md' CLAUDE.md` | one match |
| No worker/src edits | `git diff --stat main -- worker/src/` | empty |
| No src/ edits | `git diff --stat main -- src/` | empty |
| No app/src edits | `git diff --stat main -- app/src/` | empty |
| No new deps | `git diff main -- package.json worker/package.json` | only root `scripts` reordering + new `smoke` alias; no dependency changes |
| Renderer bundle flat | `wc -c dist/main.js` | `71048` bytes |

## Extra verification for prompt invariants

| Check | Command | Result |
|---|---|---|
| Worker typecheck | `cd worker && bunx tsc --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit` | clean |
| Worker dry-run upload | `cd worker && bun run deploy --dry-run` | `387.68 KiB / gzip 95.14 KiB` |
| `scripts/smoke.ts` line count | `wc -l scripts/smoke.ts` | `169` lines |
| `docs/OBSERVABILITY.md` line count | `wc -l docs/OBSERVABILITY.md` | `58` lines |

## Flags for human review

- Decide whether `docs/OBSERVABILITY.md` should preserve the spec's historical `a6727c65` snapshot label or track the fresher live version `e2ccf9eb-80e0-471b-92ba-377f0e296ae6` captured during execution.
- The written verification-contract row for bad-URL smoke says `0/6`, but the implementation and the prompt's own judgment note imply `1/6` because the local bundle check is meant to remain active.
- If you want a numeric startup-time baseline in `docs/OBSERVABILITY.md`, it needs a source outside the repo today (Workers dashboard / observability query), not local code inspection.

## Suggested commit grouping

1. `chore(vellum): phase 9.6 — post-deploy smoke script + observability doc + CLAUDE.md pointer`
2. `docs(vellum): phase 9.6 — handoff`
