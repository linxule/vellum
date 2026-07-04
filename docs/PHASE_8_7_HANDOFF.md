# Phase 8.7 Handoff

## 1. What Changed

### Phase A

- `worker/migrations/0004_declared_model.sql`
- `worker/src/types.ts`
- `worker/src/index.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/cache.ts`
- `docs/PHASE_8_7_CHECKPOINT_A.md`

### Phase B

- `src/content.ts`
- `docs/PHASE_8_7_CHECKPOINT_B.md`

### Phase C

- `docs/PHASE_8_7_HANDOFF.md`

## 2. Verification Table

| Surface | Baseline | Post-change |
| --- | --- | --- |
| `bun test tests/loom/` | `82 pass, 0 fail` | `82 pass, 0 fail` |
| Root `bunx tsc --noEmit` | clean | clean |
| `cd worker && bunx tsc --noEmit` | clean | clean |
| `cd app && bunx tsc --noEmit` | clean | clean |
| `bun run build` | `69.88 KB` (`69884` bytes) | `69.88 KB` (`69884` bytes) |
| `cd worker && bun run deploy --dry-run` | not part of stated baseline | clean |
| `cd worker && bunx wrangler d1 migrations apply vellum --local` | remote baseline listed through `0003` only | clean; local applied through `0004_declared_model.sql` |

Additional verification:

- `rg -n "declared_model|observed_client_family" src/ tests/ app/src` only matches `src/content.ts`
- `git diff --stat -- src/loom/` returns empty output
- `bunx wrangler d1 migrations list vellum --remote` returned `No migrations to apply!` before edits, matching the spec's remote state expectation

## 3. Suggested Commit Structure

- Commit 1: Phase A worker code
  - `worker/src/types.ts`
  - `worker/src/index.ts`
  - `worker/src/tools/leave-imprint.ts`
  - `worker/src/cache.ts`
- Commit 2: Phase A migration
  - `worker/migrations/0004_declared_model.sql`
- Commit 3: Phase B client type propagation
  - `src/content.ts`
- Commit 4: Phase C docs
  - `docs/PHASE_8_7_CHECKPOINT_A.md`
  - `docs/PHASE_8_7_CHECKPOINT_B.md`
  - `docs/PHASE_8_7_HANDOFF.md`

## 4. Flags For Human Review

- `worker/src/cache.ts` uses a local `ProjectionVoiceRow` type so the query alias `observed_client_family` stays explicit without redefining the domain `VoiceRow` contract.
- `leave_imprint.model` uses `z.string().trim().min(1).max(200).optional()`, so an explicit empty string is rejected rather than normalized to "absent". That matches the memo/spec, but it is the main validation boundary worth confirming.
- The spec note that root `bunx tsc --noEmit` "should fail until Phase B lands" did not hold in this worktree; root typecheck stayed clean after Phase A.

## 5. Follow-up For F7 Design

- Decide where attribution appears in the renderer and keep the precedence rule explicit: `declared_model` first, `observed_client_family` second.
- Thread the new `VoiceData` fields only into display-facing code paths; do not let projection identity become domain identity.
- If fallback source tagging matters in UI copy, distinguish self-declared identity from UA-observed family instead of collapsing them into one label.
- If conversation-level features depend on author identity later, the projection and client types are now ready for that consumption path.

## Stop State

Code applied, checkpoints written, verification green. No commit, push, or deploy was performed.
