# Phase 8.6 Handoff

## 1. What Changed

### Phase A

- `src/main.ts`
- `app/src/mcp-app.ts`
- `src/content.ts`
- `src/loom/types.ts`
- `src/loom/state.ts`
- `src/loom/init.ts`
- `src/loom/thread.ts`
- `src/loom/scroll.ts`
- `src/loom/highlight.ts`
- `src/loom/resonance.ts`
- `src/loom/refresh.ts`
- `src/loom/phantom.ts`
- `src/loom/render/frame.ts`
- `src/loom/render/thread.ts`
- `tests/loom/content.test.ts`
- `tests/loom/init.test.ts`
- `tests/loom/phantom.test.ts`
- `tests/loom/refresh.test.ts`
- `tests/loom/resonance.test.ts`
- `tests/loom/scroll.test.ts`
- `tests/loom/snapshot.test.ts`
- `tests/loom/state.test.ts`
- `tests/loom/thread.test.ts`
- `docs/PHASE_8_6_CHECKPOINT_A.md`

### Phase B

- `worker/src/cache.ts`
- `worker/src/index.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/weave.ts`
- `worker/src/utils.ts`
- `worker/migrations/0002_identity_and_indexes.sql`
- `worker/package.json`
- `src/content.ts`
- `src/main.ts`
- `app/src/mcp-app.ts`
- `tests/loom/content.test.ts`
- `docs/PHASE_8_6_CHECKPOINT_B.md`

### Phase C

- `docs/WARMTH_GRANULARITY_MEMO.md`
- `docs/MODEL_IDENTITY_PLAN.md`
- `docs/LOOM_INVARIANTS.md`
- `docs/PHASE_8_6_CHECKPOINT_C.md`

## 2. What Was Written

- `docs/WARMTH_GRANULARITY_MEMO.md`
- `docs/MODEL_IDENTITY_PLAN.md`
- `docs/LOOM_INVARIANTS.md`

## 3. Verification Table

| Surface | Baseline | Post-change |
| --- | --- | --- |
| `bun test tests/loom/` | `78 pass, 0 fail` | `82 pass, 0 fail` |
| Root `bunx tsc --noEmit` | clean | clean |
| `cd worker && bunx tsc --noEmit` | clean | clean |
| `cd app && bunx tsc --noEmit` | clean | clean |
| `bun run build` | `68.60 KB` (`68601` bytes) | `69.88 KB` (`69884` bytes) |
| `rg -n "groupIndices" src/loom tests/loom` | n/a | no matches |
| `rg -n "group: number" src/loom src/content.ts` | n/a | no matches |

Additional verification:

- `cd worker && bunx wrangler d1 migrations apply vellum --local` -> clean
- `cd worker && bun run deploy --dry-run` -> clean
- B2 local `EXPLAIN QUERY PLAN` shows the new composite indexes are used for the foundation and high-weave hot paths

## 4. Suggested Commit Structure

- Commit 1: Phase A code + tests
  - witness families payload
  - phantom voice/groupKey re-key
  - `familyNames` migration
- Commit 2: Phase B worker changes
  - rebuild serialization
  - public rate-limit rewrite
  - cache headers
  - fetch timeout wiring
- Commit 3: Phase B migration file
  - `worker/migrations/0002_identity_and_indexes.sql`
- Commit 4: Phase C memos + invariant doc + checkpoints + handoff

## 5. Flags For Human Review

- Migration numbering: the repo already had `worker/migrations/0002_warmth_state.sql`, so this phase adds a second `0002_*` migration. Wrangler applies both locally, but the sequence is visually awkward and may be worth normalizing later.
- Build size: the main bundle moved from `68601` bytes to `69884` bytes. The A3 rename itself stayed semantic-preserving, but the A2 phantom hardening and B3 timeout helper add real logic. Tests stayed green, including the golden-equivalence and regression canaries.
- Family-name identity assumption: the new client identity model is cleanest when each source thread has a unique family identity, which matches the live worker contract. Some synthetic tests had to be adjusted away from duplicate-family fixtures to stay aligned with that contract.
- Model identity backfill: `docs/MODEL_IDENTITY_PLAN.md` leaves the historical UA backfill as a human decision rather than an execution-phase default.

## Stop State

Code applied, docs written, verification green. No commit, push, or deploy was performed.
