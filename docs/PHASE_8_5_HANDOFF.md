# Phase 8.5 Handoff

## What Changed

Phase A code/test changes:

- `src/loom/state.ts`
- `src/loom/render/frame.ts`
- `tests/loom/state.test.ts`
- `tests/loom/alloc.test.ts`

Phase B code changes:

- none

Checkpoint and audit docs added:

- `docs/PHASE_8_5_CHECKPOINT_A.md`
- `docs/PHASE_8_5_CHECKPOINT_B.md`
- `docs/PHASE_8_5_ALLOC_REPORT.md`
- `docs/PHASE_8_5_CHECKPOINT_C.md`
- `docs/PHASE_8_5_SPIKE_AUDIT.md`
- `docs/PHASE_8_5_CHECKPOINT_D.md`

## What Was Audited

- Allocator hot-path report: `docs/PHASE_8_5_ALLOC_REPORT.md`
- Spike-readiness audit: `docs/PHASE_8_5_SPIKE_AUDIT.md`

## Verification Table

| Check | Baseline | Post-change | Notes |
| --- | --- | --- | --- |
| `bun test tests/loom/` | 76 pass / 0 fail | 78 pass / 0 fail | expected +2 alloc tests |
| `bunx tsc --noEmit` | clean | clean | root loom project |
| `cd worker && bunx tsc --noEmit` | clean | clean | verified in final sweep |
| `cd app && bunx tsc --noEmit` | clean | clean | verified in final sweep |
| `bun run build` | `67.99 KB` | `68.60 KB` | over Phase A `+500 byte` budget by about `+0.61 KB` |
| `grep -n "new Float32Array" src/loom/render/frame.ts` | 3 hot-path matches | 4 guarded resize-only matches | now only on thread-count change |
| `grep -n "new Int32Array" src/loom/render/frame.ts` | 0 | 1 guarded resize-only match | thread-count change only |
| `grep -n "\.map(" src/loom/render/frame.ts` | 1 hot-path match | 0 | removed the per-frame `map(...).sort(...)` path |
| `grep -n "new Float32Array" src/loom/render/thread.ts` | 0 | 0 | unchanged |
| `grep -n "new Float32Array" src/loom/render/line.ts` | 0 | 0 | unchanged |

## Suggested Commit Structure

1. Commit Phase A code + tests together:
   `src/loom/state.ts`, `src/loom/render/frame.ts`, `tests/loom/state.test.ts`, `tests/loom/alloc.test.ts`
2. Commit the Phase A/B/C/D checkpoint and audit docs together:
   all `docs/PHASE_8_5_*` files from this pass

If the human wants finer granularity, split the docs into:

1. checkpoints
2. allocator report
3. spike audit

## Flags For Human Review

- Bundle size is the only contract miss. Functional verification is green, but `dist/main.js` moved from `67.99 KB` to `68.60 KB`, which exceeds the spec's `68.40 KB` upper bound.
- The spec's grep expectation and its replacement snippet conflict slightly: resize-on-count-change still requires `new Float32Array(...)` / `new Int32Array(...)` sites somewhere in `advanceLoom()`. The hot-path regression is removed, but the guarded reallocation sites remain.
- Phase B found real allocation pressure in `renderThread()` / `voiceSpanForLine()`, but not a low-risk Phase A-style scratch-buffer conversion. The largest remaining churn is per-line record/cursor bookkeeping, documented in `docs/PHASE_8_5_ALLOC_REPORT.md`.
- Worktree setup left untracked dependency symlinks (`node_modules`, `worker/node_modules`, `app/node_modules`) in the project root. Those are environment artifacts, not intended repo content.
