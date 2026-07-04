# Phase 9.3 Handoff

## What changed

### Phase A
- Added [`src/runtime/input.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/input.ts) with shared mouse/touch/wheel attachment and private touch-end timeout state.
- Replaced the duplicated input handler blocks in [`src/main.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/main.ts) and [`app/src/mcp-app.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/app/src/mcp-app.ts) with `attachInputHandlers({ mouse, scrollThread, aperture })`.

### Phase B
- Added [`src/runtime/canvas.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/canvas.ts) with `setupCanvas()` and private `syncCanvasSize()` state.
- Swapped both entry points to shared canvas bootstrap while keeping their render loops local.

### Phase C
- Added [`src/runtime/witness.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/witness.ts) with `createWitnessReporter()`.
- Parameterized the fetch endpoint so standalone still posts to `/api/witness` and ext-app still posts to `${BASE_URL}/api/witness`.

### Phase D
- Added [`src/runtime/poll-core.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/poll-core.ts) with `computeNewVoiceInfo`, `applyResonanceFromNewVoices`, and shared timeout fetch.
- Kept both `poll()` wrappers local. In [`app/src/mcp-app.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/app/src/mcp-app.ts), the force-voice fold still runs after `computeNewVoiceInfo()` and before the resonance walk.

### Phase E
- Added [`src/runtime/frame.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/frame.ts) with shared mouse-velocity updates and frame scheduling helpers.
- Each entry point still owns its own frame-handle state and local `scheduleFrame()` wrapper.

### Phase F
- Added [`src/runtime/index.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/index.ts) barrel.
- Kept the entry points on direct runtime-module imports after testing, because barrel indirection did not reduce the renderer bundle.

### Phase G
- Added [`docs/PHASE_9_3_CHECKPOINT_A.md`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/docs/PHASE_9_3_CHECKPOINT_A.md) with the provided baseline anchor.
- This handoff captures the final verification matrix and the one open item.

## Verification table

| Check | Command | Actual | Status |
|---|---|---|---|
| Loom tests | `bun test tests/loom/` | `87 pass, 0 fail` | PASS |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `16 pass, 0 fail` | PASS |
| Verify script | `bun run verify` | clean end-to-end | PASS |
| Root typecheck | `bunx tsc --noEmit` | clean | PASS |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean | PASS |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean | PASS |
| Renderer bundle delta | `bun run build && wc -c dist/main.js` | `71130` bytes; allowed `69221..70610` | FAIL |
| Ext-app build | `cd app && bunx vite build && cd ..` | clean | PASS |
| Runtime module count | `ls src/runtime` | `canvas.ts frame.ts index.ts input.ts poll-core.ts witness.ts` | PASS |
| Entry point size reduction | `wc -l src/main.ts app/src/mcp-app.ts` | `301` / `531` | PASS |
| Sentinel intact in ext-app bundle | `grep -c "__VELLUM_BASE_URL__" app/dist/mcp-app.html` | `1` | PASS |
| No edits to tests | `git diff --stat main -- tests/ worker/tests/` | empty | PASS |
| No edits to loom | `git diff --stat main -- src/loom/` | empty | PASS |
| No edits to worker | `git diff --stat main -- worker/` | empty | PASS |

## Suggested commit structure

1. Phase A+B: input + canvas extraction and both entry-point drop-ins.
2. Phase C: witness extraction and endpoint parameterization.
3. Phase D: poll-core helpers and local `poll()` rewiring, with ext-app force-voice flow preserved.
4. Phase E+F: frame helpers, runtime barrel, and import cleanup.
5. Phase G: checkpoint + handoff docs.

## Flags for human review

- Renderer bundle delta is `+1219` bytes versus the `69911` baseline, or about `+1.74%`.
- Entry-point reductions are substantial: [`src/main.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/main.ts) went `449 -> 301`, and [`app/src/mcp-app.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/app/src/mcp-app.ts) went `672 -> 531`.
- Judgment call: [`src/runtime/index.ts`](/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-93/vellum/vellum/src/runtime/index.ts) was created per spec, but direct imports were retained in the entry points because switching through the barrel did not improve the measured renderer bundle.
- Witness parameterization is limited to the endpoint string; highlight flow remains split per entry point exactly as specified.

## Open items

- The renderer bundle is over tolerance: `71130` bytes vs max allowed `70610`. I did not paper over this with out-of-scope edits or spec changes; all other verification rows are green.
