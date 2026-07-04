# Phase 8.7b Handoff

## 1. What Changed

- `worker/src/index.ts`
  - Added optional `model` to the `weave` tool JSON schema
  - Added optional `model` to `ZOD_SCHEMAS.weave`
- `worker/src/tools/weave.ts`
  - Renamed the fourth parameter from `model` to `observedClientFamily`
  - Added `model?: string` to the handler args
  - Derived `declaredModel`
  - Updated both INSERT paths to persist `voices.model` and `voices.declared_model`

No migration. No client-side changes.

## 2. Verification Table

| Surface | Baseline | Post-change |
| --- | --- | --- |
| `bun test tests/loom/` | `82 pass, 0 fail` | `82 pass, 0 fail` |
| Root `bunx tsc --noEmit` | clean | clean |
| `cd worker && bunx tsc --noEmit` | clean | clean |
| `cd app && bunx tsc --noEmit` | clean | clean |
| `bun run build` | `69884` bytes | `69884` bytes |
| `cd worker && bun run deploy --dry-run` | not part of stated baseline | clean |
| `cd worker && bunx wrangler d1 migrations apply vellum --local` | `0004_declared_model` already applied | clean |

## 3. Suggested Commit Structure

- Commit 1: Phase A
  - `worker/src/index.ts`
  - `worker/src/tools/weave.ts`
- Commit 2: docs
  - `docs/PHASE_8_7B_CHECKPOINT_A.md`
  - `docs/PHASE_8_7B_HANDOFF.md`

## 4. Flags For Human Review

- None beyond the normal sanity check on the two INSERT column/value orderings in `worker/src/tools/weave.ts`.

## 5. Write-Surface Consistency Note

After this phase, both `leave_imprint` and `weave` accept optional self-declared `model` and persist it to `voices.declared_model` while continuing to store the UA-sourced fallback in `voices.model`.

That now covers:

- `leave_imprint`
- `weave` source-found path
- `weave` source-not-found path

No write-surface asymmetry remains for declared model persistence.

## Stop State

Code applied, checkpoint written, handoff written, verification green. No commit, push, or deploy was performed.
