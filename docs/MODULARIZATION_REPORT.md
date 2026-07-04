# Loom Modularization Report

## Summary

- Refactor completed into the 17 requested modules under `src/loom/`.
- `src/loom.ts` is now a thin re-export shim over `src/loom/index.ts`.
- `src/main.ts`, `app/src/mcp-app.ts`, and `worker/` source remain unchanged.
- Initial state after landing `7e47f79`: **40 passing, 1 failing by design** (the designated cursor regression was captured as a failing test to reach the actual live bug).
- Post P1..P7 foundation hardening: **75 passing, 0 failing** — the designated regression now passes and the failure carve-out has been removed. See `docs/FOUNDATION_HARDENING_REPORT.md` for the phased breakdown and `docs/LOOM_INVARIANTS.md` for the rules the expanded suite enforces.

## Module Line Counts

| Module | Lines |
|---|---:|
| `src/loom/index.ts` | 9 |
| `src/loom/aperture.ts` | 23 |
| `src/loom/highlight.ts` | 23 |
| `src/loom/color.ts` | 25 |
| `src/loom/math.ts` | 26 |
| `src/loom/resonance.ts` | 33 |
| `src/loom/scroll.ts` | 57 |
| `src/loom/state.ts` | 63 |
| `src/loom/init.ts` | 65 |
| `src/loom/phantom.ts` | 71 |
| `src/loom/text.ts` | 99 |
| `src/loom/path.ts` | 102 |
| `src/loom/types.ts` | 129 |
| `src/loom/render/line.ts` | 163 |
| `src/loom/thread.ts` | 168 |
| `src/loom/refresh.ts` | 177 |
| `src/loom/render/frame.ts` | 216 |
| `src/loom/render/thread.ts` | 245 |

All extracted modules are under the `<300` line target. No exceptions were needed.

## Test Counts

| Area | Test File | Tests |
|---|---|---:|
| Aperture | `tests/loom/aperture.test.ts` | 3 |
| Color | `tests/loom/color.test.ts` | 3 |
| Highlight | `tests/loom/highlight.test.ts` | 2 |
| Integration / smoke | `tests/loom/integration.test.ts` | 3 |
| Math | `tests/loom/math.test.ts` | 4 |
| Path | `tests/loom/path.test.ts` | 5 |
| Phantom | `tests/loom/phantom.test.ts` | 4 |
| Refresh | `tests/loom/refresh.test.ts` | 3 |
| Regressions | `tests/loom/regressions.test.ts` | 5 |
| Resonance | `tests/loom/resonance.test.ts` | 2 |
| Scroll | `tests/loom/scroll.test.ts` | 3 |
| Text | `tests/loom/text.test.ts` | 4 |

Indirect coverage only:

- `src/loom/thread.ts`
- `src/loom/state.ts`
- `src/loom/init.ts`
- `src/loom/render/frame.ts`
- `src/loom/render/thread.ts`
- `src/loom/render/line.ts`
- `src/loom/index.ts`

These are exercised through the state, integration, and regression suites rather than through dedicated one-file unit tests.

## Designated Failing Regression

File: `tests/loom/regressions.test.ts`

Name: `Phantom -> dive activation on fresh voice (regression - CURRENTLY FAILING)`

Observed failing assertions after the refactor:

- `touchedThread.proximity > 0.5` failed.
  Observed value: `0.35911944363332127`
- `the target voice line has diveT > 0.3` failed through the render proxy assertion.
  Observed value: maximum rendered font size for `FRESHVOICEGLYPH` was `0px`

Assertions that passed in the same test:

- phantom focus remained active
- `voiceFlatIdx` resolved to a non-negative target
- touched thread resolved to the target `memory` thread
- at least one `phantom-capture` event fired, so Pass 1 did match the target voice at least once

Current hypothesis about the remaining upstream gate:

- The fresh voice is being targeted and captured, but the render path is still failing to convert that capture into a strong dive opening on the newly-arrived line after `refreshLoom()`.
- The failure profile points more toward a post-capture gate than a trigger gate: either the captured target line is not surviving into the visible laid-out line set on subsequent frames, or the proximity / mouse-to-line convergence never reaches the threshold needed to open the dive lens on the new line itself.

## Verification Results

- `bun run build`: passed
- `cd app && bunx vite build`: passed
- `cd worker && bun run deploy --dry-run`: passed in this sandbox, though Wrangler emitted log-file permission warnings before exiting `0`
- `bun test tests/loom/`: **75 pass, 0 fail** after the P6 coverage expansion (was 40 pass / 1 failing-by-design at `7e47f79`)
- `git diff -- src/main.ts app/src/mcp-app.ts worker/`: empty

Bundle size check:

- Current `dist/main.js`: `67409` bytes
- Sibling baseline `dist/main.js`: `65638` bytes
- Delta: `+1771` bytes

This stays within the spec’s `±2KB` bundle-size tolerance.

## Suspicious Behavior / Notes

- The monolith as handed to this worktree had a runtime `ReferenceError` in `refreshLoom()` because `focusId` was block-scoped inside `if (state)` and referenced after that block. The first regression run failed there before reaching the intended live bug. I hoisted the declaration during extraction so the designated regression could reach the actual fresh-voice hover failure. This was the only non-purely-structural judgment call in code motion.
- `threadColor()` and `depthColor()` still use scratch-array reuse. The tests document that this aliasing convention is preserved.
- The all-zero `_path` bootstrap trap is still explicitly covered in `path.test.ts` and the named regression suite.
- The worker dry-run is functionally successful here, but Wrangler cannot write its log file under the sandboxed home directory and prints EPERM warnings while still exiting successfully.

## Judgment Calls

- Preserved the full live export surface, not just the abbreviated list in the spec. The refactor still exports `setDiagHook`, `triggerPhantomHover`, and `clearResonance`, because those were already part of `src/loom.ts`.
- Added internal state accessors in `src/loom/state.ts` so module-level tests can assert against the extracted singletons without widening the public barrel API.
- Left the designated failing regression using a render-observation proxy for the final dive assertion (`FRESHVOICEGLYPH` font size), because the public path still should not expose render-internal line objects just for tests.

## Local Environment Scaffolding

To execute the verification loop inside this isolated worktree, I created local untracked symlinks to the already-installed dependency trees in the sibling main tree:

- `node_modules`
- `app/node_modules`
- `worker/node_modules`

I also created the untracked runtime directory `worker/public/dist/` so the worker predeploy copy step could run. These are environment-only artifacts and not part of the source refactor.
