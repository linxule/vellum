# Phase 9.4 Handoff

## Overall status

Phase A (`A1` through `A9`) is complete and verification is green. No Phase B work was touched.

## Item-by-item changes

### A1 — `focus.ts` ordinal=0 fix + regression test

- Added `vf.ordinal = 0` to all three `worker/src/tools/focus.ts` family queries.
- Added new regression test `worker/tests/focus.test.ts`.
- The new test seeds one voice with primary `attention` / secondary `silence` and one voice with primary `silence`, then asserts `handleFocus({ family: 'silence' })` includes only the primary-`silence` voice.

### A2 — cache contention semantics documentation

- Added `Cache contention semantics (Phase 9.0 + 9.4 clarification)` to `docs/PATTERNS_AND_GOTCHAS.md`.
- Added the five requested single-line `// KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention` comments in:
  - `worker/src/handlers/state.ts`
  - `worker/src/tools/leave-imprint.ts`
  - `worker/src/tools/weave.ts` (two call sites)
  - `worker/src/cache.ts`

### A3 — `src/runtime/input.ts` scope fix

- Moved `touchEndTimeout` and `clearTouchEndTimeout` inside `attachInputHandlers`.
- No other runtime modules changed.

### A4 — `/ext-app` sentinel rewrite

- Updated the `/ext-app` branch in `worker/src/index.ts` to derive `origin` from `request.url` and rewrite `__VELLUM_BASE_URL__` before returning the HTML response.
- Router order and the bottom export surface remain unchanged.

### A5 — `warmth.pending` removal

- Added migration `worker/migrations/0005_drop_warmth_pending.sql`.
- Removed `pending` from:
  - `worker/src/types.ts`
  - `worker/src/utils.ts`
  - `worker/src/handlers/admin.ts`
- Verified `grep -rn "\bpending\b" worker/src/` returns zero matches.

### A6 — dead exports cleanup

- Removed unused `export` keywords from:
  - `worker/src/analytics.ts` → `analyticsDayIndex`
  - `worker/src/jsonrpc.ts` → `mcpHeaders`
  - `worker/src/schemas.ts` → `familyEnum`
  - `worker/src/hmac.ts` → `SESSION_ID_RE`, `SESSION_MAX_AGE_S`

### A7 — unused admin `reason` and unused `ENVIRONMENT`

- Removed unused `reason?: string` from the admin hide request body type.
- Removed `ENVIRONMENT` from `worker/src/types.ts` and `worker/wrangler.jsonc`.

### A8 — redundant zod text-length guards

- Removed the unreachable manual `args.text.length > 200` guard branches from:
  - `worker/src/tools/leave-imprint.ts`
  - `worker/src/tools/weave.ts`

### A9 — dead default branch in tool switch

- Removed the unreachable `default` branch from the `tools/call` switch in `worker/src/handlers/mcp.ts`.
- Added a local `knownToolName` narrowing so TypeScript remains clean without reintroducing the dead branch.

## Verification matrix

- `bun test tests/loom/`:
  - Passed: `87` / `87`
- `cd worker && bun test tests/ && cd ..`:
  - Passed: `17` / `17`
  - Note: one expected console error is emitted by the existing `failed warmth update does not trigger rebuild` test path; the suite still passes cleanly.
- `bun run verify`:
  - Passed
- `bunx tsc --noEmit`:
  - Passed
- `cd worker && bunx tsc --noEmit`:
  - Passed
- `cd app && bunx tsc --noEmit`:
  - Passed
- `bun run build` + `wc -c dist/main.js`:
  - `71110` bytes
  - Within limit `<= 71180`
- `cd worker && bun run deploy --dry-run`:
  - `Total Upload: 384.16 KiB / gzip: 94.74 KiB`
  - Within limit `<= 385 KiB`
- `grep -rn "\bpending\b" worker/src/`:
  - Zero matches
- `git diff main -- worker/src/utils.ts`:
  - Only the `pending` removals in `getWarmth`, `getWarmthMap`, and `updateWarmth`
- `git diff --stat main -- src/loom/`:
  - Empty
- `git diff --stat main -- src/runtime/`:
  - Only `src/runtime/input.ts`
- `grep -c '__VELLUM_BASE_URL__' app/dist/mcp-app.html`:
  - `1`

## Flags for human review

- Migration still needs to be applied during deploy:
  - `cd worker && bunx wrangler d1 migrations apply vellum --remote`
- Post-deploy A4 smoke test still required by spec:
  - `curl -s https://vellum.linxule.com/ext-app | grep -c '__VELLUM_BASE_URL__'`
  - Expected result after deploy: `0`

## Deviation from the written test-surface expectation

- The spec text called for the A5 mock update in `worker/tests/rebuild-lock.test.ts`.
- In the current repo, the warmth-state row shape and SQL matching live in `worker/tests/mocks.ts`, not in `worker/tests/rebuild-lock.test.ts`.
- To keep the existing worker tests passing after removing `pending` from the worker SQL, I updated `worker/tests/mocks.ts` to mirror the new schema/query shapes.
- As a result, `git diff --stat main -- tests/ worker/tests/` shows `worker/tests/mocks.ts`.
- Also note: the same `git diff` command does not show the new `worker/tests/focus.test.ts` file while it is untracked; `git status --short` does show it.
