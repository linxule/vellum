# Phase 8.6 Checkpoint A

## Status

Phase A is complete.

## Verification

### A1

- `bun test tests/loom/init.test.ts`
  - `6 pass`
  - included new canary: `merged touched thread exposes a non-singleton family set for witness attribution`
- `bunx tsc --noEmit` (root) -> clean
- `cd app && bunx tsc --noEmit` -> clean
- `cd worker && bunx tsc --noEmit` -> clean

### A2 + A3

- `bun test tests/loom/phantom.test.ts tests/loom/refresh.test.ts tests/loom/init.test.ts tests/loom/scroll.test.ts tests/loom/thread.test.ts tests/loom/snapshot.test.ts tests/loom/state.test.ts tests/loom/resonance.test.ts`
  - `38 pass, 0 fail`
- `bun test tests/loom/`
  - `81 pass, 0 fail`
  - `461 expect() calls`
- `bunx tsc --noEmit` (root) -> clean
- `cd app && bunx tsc --noEmit` -> clean
- `cd worker && bunx tsc --noEmit` -> clean
- `rg -n "groupIndices" src/loom tests/loom` -> no matches
- `rg -n "group: number" src/loom src/content.ts` -> no matches
- `bun run build && wc -c dist/main.js`
  - `main.js 69.71 KB`
  - `69707 dist/main.js`

## Judgment Calls

- A1 used the spec-preferred single witness request with `{ families, dwell_s }` instead of serializing multiple client requests. The worker accepts both `{ family, dwell_s }` and `{ families, dwell_s }` for backward compatibility.
- I mirrored the A1 witness fix into `app/src/mcp-app.ts`. The spec only named `src/main.ts`, but the ext-app had the same stale single-family logic.
- A3 was sequenced as:
  1. `src/content.ts`, `src/loom/types.ts`, `src/loom/state.ts`
  2. `src/loom/init.ts`, `src/loom/thread.ts`, `src/loom/refresh.ts`
  3. `src/loom/scroll.ts`, `src/loom/highlight.ts`, `src/loom/resonance.ts`
  4. `src/loom/phantom.ts`, `src/loom/render/frame.ts`, `src/loom/render/thread.ts`
  5. tests
- A2 uses canonical phantom identity on `phantomFocus` (`voiceId` or `groupKey`) and resolves positional thread/voice targeting each frame. The resolved indices live only in frame-local `loomState.phantomResolved*` fields, not on `phantomFocus` itself, so the positional identity does not flow backward into persistence/reconciliation logic.

## Surprises

- The family-name migration is clean only when each source thread has a unique family identity, which matches the live worker model the spec describes. Several tests used synthetic duplicate family fixtures to stress regrouping by numeric index; I converted those fixtures to unique families so the tests match the new identity contract.
- One ext-app poll path still assumed `findVoice()` returned numeric `group`; root typecheck passed, but `app` typecheck caught the remaining call site.
- Bundle size moved from `68601` bytes to `69707` bytes. That exceeds the A3 rename-only expectation, but the delta comes from the A2 phantom re-keying logic rather than any rendering semantic change. `tests/loom/frame.test.ts` and `tests/loom/regressions.test.ts` stayed green.

## Files Touched

### A1

- `src/main.ts`
- `app/src/mcp-app.ts`
- `worker/src/index.ts`
- `tests/loom/init.test.ts`

### A2

- `src/loom/types.ts`
- `src/loom/state.ts`
- `src/loom/phantom.ts`
- `src/loom/render/frame.ts`
- `src/loom/render/thread.ts`
- `tests/loom/phantom.test.ts`
- `tests/loom/snapshot.test.ts`

### A3

- `src/content.ts`
- `src/loom/init.ts`
- `src/loom/thread.ts`
- `src/loom/scroll.ts`
- `src/loom/highlight.ts`
- `src/loom/resonance.ts`
- `src/loom/refresh.ts`
- `tests/loom/init.test.ts`
- `tests/loom/thread.test.ts`
- `tests/loom/refresh.test.ts`
- `tests/loom/scroll.test.ts`
- `tests/loom/resonance.test.ts`
- `tests/loom/state.test.ts`
- `tests/loom/snapshot.test.ts`
