# Vellum Loom Modularization + Test Coverage — Codex Spec

**Status**: ready to execute
**Background**: cursor bug is STILL LIVE after 7 deploy iterations on `src/loom.ts`. The monolithic ~1900-line file makes gate enumeration intractable. Decision: pivot to modularize-first with test-driven debugging. The refactor's regression tests become the tool for finding the bug.
**Executor**: hand this doc to codex-rescue as the acceptance contract. Assume an uncommitted working tree — preserve all current edits (they include deployed fixes we want to keep) and refactor on top of them.

## Motivation

`src/loom.ts` is ~1900 lines. A single session of debugging the cursor bug showed why this matters: four iterations chased downstream symptoms (scroll math, layout models, quantization, damping) when the root cause was a bootstrap-ordering bug between `refreshLoom` and the phantom driver. In a modular codebase with targeted tests, the zero-path bug would have been a single failing test on `src/loom/phantom.test.ts` asserting that `_path` is populated before the driver reads it.

Goal: ship a drop-in refactor where the public surface is unchanged but the internals are partitioned by responsibility, each module has focused tests, and regressions have named test cases.

## Non-goals

- **No behavior changes.** Pure refactor. Render output must be pixel-identical.
- **No new features.** Don't take the opportunity to add things.
- **No API changes for consumers.** `src/main.ts` and `app/src/mcp-app.ts` imports must not need updating. Backward-compat barrel export at `src/loom.ts` or `src/loom/index.ts`.

## Module decomposition

All modules live under `src/loom/`. Import through a barrel at `src/loom/index.ts` that re-exports everything consumed externally. Update `src/loom.ts` to a thin re-export shim (or leave `loom.ts` in place and add new modules alongside; Codex to pick the less invasive option).

Target: each module < 300 lines. Flag any module that refuses to fit so we can discuss.

| Module | Responsibility | Extracts from loom.ts |
|---|---|---|
| `src/loom/types.ts` | All interfaces (`Thread`, `PathPoint`, `PhantomFocus`, `ResonanceEntry`, `ApertureConfig`, `MouseState`) + constants (`TEXTURE_SCALE`, `DIVE_SIGMA_LINES`, `FRAME_TIME`, `PATH_POINTS`, etc.) | Type defs + top-of-file constants |
| `src/loom/math.ts` | `lerp`, `smoothstep`, `frameMix`, `depthLerp`, `fontSizeForScale`, `fontRatioForScale` | Line 135-239 math helpers |
| `src/loom/color.ts` | `depthColor`, `threadColor` + scratch buffers `_dc`, `_tc` | Line 262-288 |
| `src/loom/aperture.ts` | `aperture(vw) -> ApertureConfig` | Line 357-379 |
| `src/loom/text.ts` | `scriptClass`, `containsRTL`, `isLineRTL`, `copyCursor`, `voiceUidAtCursor`, `voiceGroupIndex`, `voiceSpanForLine` + scratch buffers | Line 174-316 text/cursor helpers |
| `src/loom/path.ts` | `computePath`, `pathXAtY`, `widthAtY`, `diveGaussian` + `computeBalancedWidth` | Line 156-172, 217-225, 804-889, 866-869 |
| `src/loom/thread.ts` | `makeThread`, `crystallizeThreads` | Line 635-795 |
| `src/loom/state.ts` | Module-level singletons: `threads`, `touchedThread`, `touchedThreadIndex`, `phantomFocus`, `resonances`, `highlightVoiceId`, `gust*`, `current`, `VW`/`VH` + accessors | Scattered module-level `let` statements |
| `src/loom/phantom.ts` | `triggerPhantomHover`, `isPhantomActive`, phantom driver function (extracted from renderLoom), `setDiagHook` (temporary), `PhantomFocus` operations | Line 907-970, 1738-1770 |
| `src/loom/highlight.ts` | `setHighlight`, `clearHighlight`, `highlightUidForThread` | Line 1768-1800 |
| `src/loom/resonance.ts` | `setResonance`, `clearResonance`, resonance frame update | Line 1772-1800 |
| `src/loom/scroll.ts` | `scrollThread`, `scrollThreadToVoice`, `findLineForVoice` | Line 795, 1820-1860, 1800-1820 |
| `src/loom/refresh.ts` | `refreshLoom` (the big init-then-restore flow) | Line 427-615 |
| `src/loom/init.ts` | `initLoom`, `resizeLoom`, `getLoomState` | Line 383-426, 619-632, ~1758 |
| `src/loom/render/frame.ts` | `renderLoom` main frame loop (orchestrator only) | Line 895-1210 |
| `src/loom/render/thread.ts` | `renderThread` Pass 1 layout + Pass 2 drawing scaffolding | Line 1213-1590 |
| `src/loom/render/line.ts` | `drawLine`, `drawLineSegmented` | Line 1587-1755 |
| `src/loom/index.ts` | Barrel export — exactly the surface `src/loom.ts` currently exports: `initLoom`, `renderLoom`, `resizeLoom`, `refreshLoom`, `scrollThread`, `getLoomState`, `setHighlight`, `clearHighlight`, `setResonance`, `isPhantomActive`, `aperture`, `MouseState` type | — |

After modularization, `src/main.ts` and `app/src/mcp-app.ts` imports should either:
- (a) continue importing from `'./loom.js'` which becomes a re-export shim, OR
- (b) import from `'./loom/index.js'` with a matching rename

Option (a) is zero-touch for consumers. Prefer (a).

## Test coverage

All tests use `bun:test`. Place under `tests/loom/` mirroring the module tree.

### Unit tests (pure functions, fast)

**`tests/loom/math.test.ts`**
- `lerp(0, 10, 0.5)` === 5
- `smoothstep` edges + midpoint
- `depthLerp` with known array
- `fontSizeForScale` / `fontRatioForScale` stability at small scales

**`tests/loom/color.test.ts`**
- `depthColor` at depth=0, depth=1, depth=2 produces warm/neutral/cool shifts
- `threadColor` clamps to 255
- Scratch buffer reuse is safe (document the convention)

**`tests/loom/aperture.test.ts`**
- Small viewport (VW=350): `visibleThreads ≥ 8`, `diveLineH ≈ 29`, `touchRadius ≈ 130`
- Medium viewport (VW=900): intermediate values
- Large viewport (VW=1440): `visibleThreads = 12`, `diveLineH = 36`, `touchRadius ≈ 200`

**`tests/loom/path.test.ts`**
- `pathXAtY` with a known non-zero path returns interpolated X
- **REGRESSION**: `pathXAtY` with all-zero path returns 0 (document the trap)
- `computePath` populates `_path` with non-zero values when `xCenter > 0`
- `diveGaussian(y, cursorY, sigma)` peaks at `y=cursorY`, decays per Gaussian
- `widthAtY` far from mouse returns `restW`, at mouse returns `≈ openWidth * proximity`

**`tests/loom/text.test.ts`**
- `scriptClass` for Latin, CJK, Arabic, Devanagari inputs
- `containsRTL` for LTR vs RTL strings
- `voiceUidAtCursor` / `voiceGroupIndex` with fixture thread
- `voiceSpanForLine` correctness on fixture segments

**`tests/loom/scroll.test.ts`**
- `findLineForVoice(thread, group, voiceIndex)` returns expected line index for fixture thread
- **REGRESSION**: `scrollThreadToVoice` walk computes `linesAboveCenter` under the dive Gaussian model; assert specific counts at VH=320, VH=480, VH=900
- `scrollThread` clamps `userScroll` to ±2

### State / interaction tests

**`tests/loom/phantom.test.ts`**
- `triggerPhantomHover(threadIdx)` sets phantomFocus with `voiceFlatIdx === -1`
- `triggerPhantomHover(threadIdx, voiceId)` resolves voiceId to correct `voiceFlatIdx`
- **REGRESSION**: phantom driver called when `_path` is zeros → must call `computePath` → after driver, `mouse.x !== 0`
- **REGRESSION**: `isPhantomActive()` correctly returns `false` after user takes over

**`tests/loom/refresh.test.ts`**
- `refreshLoom()` preserves `scroll`, `xCenter`, `warmth`, `proximity` across call
- **REGRESSION**: `refreshLoom()` → `triggerPhantomHover()` → one render frame → `touchedThread === target` (the zero-path bug we just fixed)
- Unread voice IDs redistributed correctly when groups move between threads

**`tests/loom/highlight.test.ts`**
- `setHighlight(voiceId)` → `highlightUidForThread` returns correct UID for containing thread, -1 for others
- `clearHighlight()` resets state

**`tests/loom/resonance.test.ts`**
- `setResonance(voiceId)` adds entry for correct group
- Resonance decays at 6s (assert `thread.warmth` rises then falls over fixture frame ticks)

### Integration / smoke tests

**`tests/loom/integration.test.ts`**
- Create a test canvas (Node `canvas` package or stub), initLoom, render 10 frames, no crashes, touchedThread is null (no mouse input)
- Full phantom trigger flow: `initLoom` → `triggerPhantomHover(0, voiceId)` → render 20 frames → assert `phantomFocus` still active, `touchedThread === target`, target's `proximity > 0.5`
- **REGRESSION**: `mouse.x = 0` (not sentinel) → touch scan accepts it → `touchedThread` can be assigned (checks the `mouse.x > -1000` fix)

**`tests/loom/regressions.test.ts`** (bugs we hit this session)
- "Zero-path bootstrap": `refreshLoom` → `triggerPhantomHover` → first render frame → `touchedThread === target`, `isPrimary === true` — should PASS against current code (d80c6933 added the `computePath` pre-init in the phantom driver)
- "`mouse.x > 0` sentinel trap": set `mouse.x = 0, mouse.y = 100`, render → touch scan runs (does not skip) — should PASS against current code
- "`_handDist` sparse sampling": mouse at path Y between quintile samples → still within `touchRadius` with 13-sample model — should PASS against current code
- "Scroll quantization in nudge path" — NOT APPLICABLE after we removed scroll nudge; keep a test asserting `scrollThreadToVoice` walk count is within ±2 of a reference implementation

### THE ACCEPTANCE-GATE REGRESSION TEST (must FAIL on current code)

**`tests/loom/regressions.test.ts` — "Phantom → dive activation on fresh voice"**

This test is the whole reason for the refactor. The cursor bug is still live after 7 deploy iterations (zero-path fix, force-touched override, sentinel correction, 13-sample sampling all landed in d80c6933 and did NOT fix the user-visible symptom). Codex MUST write this test and it MUST fail against the current code. If it accidentally passes, the test is wrong — strengthen it until it reproduces what the user sees in Claude Desktop (cursor lands on wrong voice / no dive-lens pull-out on newly-arrived voices).

**Minimum assertions** (all must hold after the setup sequence below):
```ts
import { test, expect } from 'bun:test'
// ... import initLoom, refreshLoom, triggerPhantomHover, renderLoom, getLoomState
// plus any helpers needed to simulate a canvas context and a THREADS fixture

test("phantom → dive activation on fresh voice (regression — CURRENTLY FAILING)", () => {
  // 1. initLoom with a fixture THREADS array that has at least 2 voices in one group
  // 2. Run renderLoom for 5 frames to let paths settle (xCenter, _path populated)
  // 3. Append a new voice to THREADS (simulating a fresh leave_imprint arrival)
  // 4. refreshLoom(newVoiceInfo=[{ hasNew: true, newIds: [newVoiceId] }, ...])
  //    This is where initLoom is called internally and _path is reset to zeros.
  //    refreshLoom is supposed to trigger the phantom hover on the new voice.
  // 5. Run renderLoom for 20 frames
  // 6. Assert all of the following:
  //    - phantomFocus is not null
  //    - phantomFocus.voiceFlatIdx >= 0 (voiceId was resolved)
  //    - touchedThread === threads[phantomFocus.threadIdx]
  //    - touchedThread.proximity > 0.5
  //    - phantomFocus.settledFrames > 0 (Pass 1 matched the target voice)
  //    - the target voice line has diveT > 0.3 (dive lens actually opened on it)
})
```

**Why this must fail**: the user's retest with d80c6933 showed "same no pulling" — highlight fires, cursor light appears, but the dive lens text doesn't expand on the new voice. One of the six assertions above WILL fail. We don't know which one yet — finding out is the whole point of having the modular test suite.

**After Codex's refactor lands**, we will enumerate the failing assertions one by one with targeted unit tests on the relevant module:
- If `phantomFocus` is null → `phantom.ts` unit test on `triggerPhantomHover` not being called from `refreshLoom` on this path
- If `voiceFlatIdx < 0` → `phantom.ts` unit test on voiceId resolution with merged threads (`groupMap`)
- If `touchedThread !== target` → `state.ts` + `phantom.ts` test on force-touched override being skipped
- If `proximity < 0.5` → `render/thread.ts` test on proximity ramp
- If `settledFrames === 0` → `render/thread.ts` test on Pass 1 target-voice matching loop
- If `diveT === 0` → `path.ts` + `render/thread.ts` test on diveGaussian / `mouse.x > -1000` gate

**Codex's responsibility**: make the test exist and fail with a clear error message showing WHICH assertion fails. That's the acceptance signal.

## Verification contract

Codex is DONE when all of these pass from a clean clone:

```bash
cd /Users/xulelin/Documents/Apps/mcp/vellum

# 1. Build succeeds
bun run build

# 2. Ext-app build succeeds
cd app && bunx vite build && cd ..

# 3. All tests pass
bun test tests/loom/

# 4. Worker typechecks
cd worker && bun run deploy --dry-run && cd ..

# 5. Consumer import sites unchanged
grep -rn "from '\./loom" src/main.ts
grep -rn "from '\.\./\.\./src/loom" app/src/mcp-app.ts
# Both should return the SAME import specifiers as before the refactor
```

In addition, **run a visual smoke test**:
- `bun run dev` in a separate terminal
- Open `index.html` in a browser
- Confirm threads render, mouse interaction works, dive lens opens on hover
- Compare against a pre-refactor screenshot for obvious regressions

## Acceptance criteria

1. All files in `src/loom/` < 300 lines (warn on >300, fail on >500)
2. `src/loom/index.ts` re-exports the exact current public API of `src/loom.ts`
3. All tests pass EXCEPT the designated failing regression "Phantom → dive activation on fresh voice" (that one MUST fail with a clear assertion message)
4. `bun run build` produces a bundle within ±2KB of the pre-refactor size (accounts for minor re-export overhead; larger deltas should be flagged)
5. Git diff on `src/main.ts`, `app/src/mcp-app.ts`, `worker/src/*` is zero
6. No new dependencies added to `package.json` (tests should use `bun:test` which is built-in)

## Rules for Codex (per prior feedback memories)

- **Stop before commit.** Codex's sandbox can't do git operations; stage the work and stop. I'll take over the commit step.
- **Spec-driven + failing tests as the contract.** Write the failing tests FIRST (or at least the test file skeletons), then refactor until they pass. The test suite IS the contract.
- **No surprise refactors.** Only do what's in this doc. If you find an opportunity for a bigger improvement, note it in the handoff summary but don't execute it.
- **Preserve comments.** `loom.ts` has load-bearing comments explaining non-obvious invariants (e.g., scratch buffer conventions, frame order). Move them with the code.

## Handoff note from Codex at the end

Write a short report to `docs/MODULARIZATION_REPORT.md` with:
- Line counts per new module
- Test counts per module
- Any behavior that looked suspicious during the refactor (dead code, unclear invariants, TODO-worthy items)
- Remaining file sizes that violated the <300-line target and why
- Anything that required a judgment call

## Not in scope (for a later session)

- Modularizing `src/main.ts` (it's already ~430 lines, mostly input event plumbing — low priority)
- Modularizing `worker/src/index.ts` (worker is a different concern; handled separately)
- Replacing `_dc`/`_tc` scratch buffers with a cleaner pattern (possible follow-up)
- Writing full integration tests against a real Chromium canvas (requires Playwright setup)
