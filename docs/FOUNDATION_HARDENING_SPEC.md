# Vellum Loom — Foundation Hardening Spec

**Status**: ready to execute
**Worktree**: `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-harden/vellum/`
**Branch**: `harden/foundation` (cut from main @ `7e47f79`)
**Executor**: codex-rescue, single pass with phase checkpoints
**Stop-before-commit**: yes. Claude reviews and commits.

## Motivation

The 17-module split landed cleanly at `7e47f79` and three parallel audits (Claude Explore, Claude code-reviewer, Codex-rescue) produced a converging picture:

- **Structurally sound** — no import cycles, clean scratch buffer discipline, correct focusId hoist, all four `mouse.x > -1000` sites verified, acyclic import graph.
- **`bunx tsc --noEmit` exits 0** for `src/loom/**`.
- **BUT** feature work on this foundation would hit friction in three specific places:
  1. **Update/draw entanglement** — `renderLoom` in `render/frame.ts` mixes state advancement with painting. Can't add `sense_warmth` MCP tool (no read-model), can't add low-power renderer (skipping paint also skips state advancement), can't unit-test the proximity ramp in isolation.
  2. **Hidden `performance.now()` clock dependencies** — scattered across `refresh.ts:73`, `phantom.ts:25`, `resonance.ts:10,12` while `renderLoom` already takes `now` as a parameter. This trap already caused the phantom→dive regression test to fail spuriously during development. The next timed effect will re-hit it.
  3. **Dead + missing exports** — `triggerPhantomHover` and `clearResonance` are exported but only used internally. `setDiagHook` IS used by ext-app (contra initial audit claim). Meanwhile, per-thread warmth, depth, and phantom state are not exposed via any stable API.

Plus a catalog of smaller improvements from the coverage audit: one real latent bug (`phantom.ts:59` `mouse.y || ...` treats real 0 as missing), one misleading broken-pool optimization (`text.ts:80`), one aliasing trap (`refresh.ts:47-51` shared Set reference), and 8 critical test coverage gaps.

This spec folds all of that into one Codex pass so we land a solid foundation before building features on it.

## Non-goals

- **No further file splits.** The 17-module shape is correct. Do NOT split `render/thread.ts` or `render/frame.ts` into sub-files. Internal function-level split of `render/frame.ts` (advance/paint) is YES, but both functions stay in the same file.
- **No behavior changes.** Render output must remain pixel-identical for all tests. Advance/paint split is pure refactor.
- **No interaction-mode state machine.** That's speculative until we have a concrete pin/selection feature.
- **No typed arrival event payload.** Left for follow-up — would touch both pollers and ext-app, larger blast radius than this pass justifies.
- **No fixing pre-existing project-wide type errors** (Intl.Segmenter, Set iteration, @types/node conflicts). Scope is `src/loom/` only.

## Execution order — 6 phases

Each phase produces a working tree. If you get interrupted, resume from the phase checkpoint. Run `bun test tests/loom/` at the end of every phase to confirm no regression.

---

### Phase 1 — Low-risk code fixes (small, isolated, no API changes)

**1.1 Fix `mouse.y || ...` treating real 0 as missing** — `src/loom/phantom.ts:59`
Current:
```ts
const ny = mouse.y || ... // treats mouse.y === 0 as missing
```
Replace with a sentinel check consistent with `mouse.x > -1000`:
```ts
const ny = mouse.y > -1000 ? (prevY * 0.3 + capturedY * 0.7) : ...
```
Verify the exact semantics by reading the current block — just don't use `||` as a missing check on a numeric-0-valid field. Use `> -1000` or `!== -9e3` (the init sentinel).

**1.2 Copy `prevState.emergenceVoiceUids` Set to avoid cross-frame aliasing** — `src/loom/refresh.ts:47-51`
Current:
```ts
emergenceVoiceUids: t.emergenceVoiceUids,  // shared reference
```
Replace with a defensive copy:
```ts
emergenceVoiceUids: new Set(t.emergenceVoiceUids),
```
Ensures prevState is a true snapshot.

**1.3 Fix or delete the broken pool optimization** — `src/loom/text.ts:80`
Current:
```ts
voiceSpanRunsScratch[voiceSpanRunsScratch.length] ?? { uid, weight }
```
The left-hand side of `??` always evaluates to `undefined` because the scratch array was truncated at line 67. The `??` always allocates. Either:
- Delete the pool optimization entirely and just `voiceSpanRunsScratch.push({ uid, weight })`, OR
- Make the pool actually work (pre-grow the array, use an index pointer, etc.)

Prefer option A (delete). The scratch allocation is not a hot path.

**1.4 Add documentation comment at `src/loom/refresh.ts:126`**

Before the `let focusId: string | null = null` line, add:
```ts
// Hoisted out of `if (state)` to resolve a TS2552 in the baseline monolith.
// DO NOT move the declaration back inside the `if (state)` block — that
// form compiled to a minifier-assisted ReferenceError at runtime because
// the outer `triggerPhantomHover(i, focusId ?? undefined)` referenced a
// block-scoped variable. If `state` is null, focusId stays null and the
// phantom hover fires without a target (voiceFlatIdx = -1) — safe, and
// practically unreachable because refreshLoom is only called post-fetch.
```

**1.5 Add documentation comment at `src/loom/render/frame.ts`**

Near the top of `renderLoom` (before the mouse destructuring), add:
```ts
// Frame ordering contract:
//   1. Mouse deltas computed from previous frame
//   2. drivePhantomHover() — may update mouse.x/y from phantom target
//   3. per-thread touch scan — reads previous frame's _path
//   4. computePath() per thread — updates _path for this frame
//   5. renderThread() paint pass — reads this frame's _path
// Touch scan uses previous-frame _path because computePath hasn't run yet.
// This is intentional (one-frame lag is imperceptible at 60fps) but means
// you cannot reorder computePath above the touch scan without retesting
// proximity ramp + _handDist behavior.
```

**Phase 1 checkpoint**: `bun test tests/loom/` should still show `41 pass, 0 fail`. Commit not required — continue to Phase 2.

---

### Phase 2 — Thread `now` parameter through timed functions

Goal: eliminate all `performance.now()` calls inside `src/loom/**` except in event handlers where no frame time is available. Make the clock explicit and test-injectable.

**2.1 Update signatures**
```ts
// Before
export function refreshLoom(newVoiceInfo?: { hasNew: boolean, newIds: Set<string> }[]): void
export function triggerPhantomHover(threadIdx: number, voiceId?: string): void
export function setResonance(voiceId: string): void
export function setHighlight(voiceId: string): void

// After
export function refreshLoom(newVoiceInfo?: { hasNew: boolean, newIds: Set<string> }[], now?: number): void
export function triggerPhantomHover(threadIdx: number, voiceId?: string, now?: number): void
export function setResonance(voiceId: string, now?: number): void
export function setHighlight(voiceId: string, now?: number): void
```

Each `now` parameter defaults to `performance.now()` internally if omitted:
```ts
export function refreshLoom(newVoiceInfo?: ..., now = performance.now()): void {
  // use `now` everywhere previously using performance.now()
}
```

This preserves backward compat for any caller that doesn't pass `now`, while tests and caller chains can thread a consistent clock.

**2.2 Remove internal `performance.now()` calls** from:
- `src/loom/refresh.ts:73` (`thread.emergenceStart = performance.now()`) → use `now` parameter
- `src/loom/phantom.ts:25` (`start: performance.now()`) → use `now` parameter
- `src/loom/resonance.ts:10,12` (`start: performance.now()`) → use `now` parameter
- Any other site grep reveals inside `src/loom/**`

**2.3 Update internal callers** in `src/loom/**` to pass `now` through:
- `refresh.ts` calls `triggerPhantomHover(i, focusId, now)` — already inside a `refreshLoom(newVoiceInfo, now)` scope, so `now` is available
- Any other internal caller chains

**2.4 Update external callers** in the two consumer files:
- `src/main.ts:316` (the polling block inside the render loop) — if refreshLoom is called from here, pass the current `now`. If it's called from outside a `now` scope, use `performance.now()` explicitly at the call site (explicit is better than implicit default).
- `app/src/mcp-app.ts` — same rule. The ext-app calls refreshLoom and triggerPhantomHover from the `ontoolresult` handler, which doesn't have a frame `now`. Use `performance.now()` explicitly at the call site:
  ```ts
  refreshLoom(newVoiceInfo, performance.now())
  triggerPhantomHover(threadIdx, voiceId, performance.now())
  ```

**2.5 Update test suite** to pass `now` explicitly where it helps determinism:
- `tests/loom/refresh.test.ts` — pass `now` to `refreshLoom(..., now)` where the test already threads `now`
- `tests/loom/regressions.test.ts` "Phantom -> dive activation on fresh voice" — the `performance.now()` re-sync is no longer needed if you pass the test's `now` directly. Simplify. Keep the test passing.
- `tests/loom/phantom.test.ts` — any test that uses `triggerPhantomHover` can pass `now` for determinism

**Phase 2 checkpoint**:
- `bun test tests/loom/` shows 41 pass, 0 fail
- `grep -rn "performance\.now" src/loom/` shows ZERO matches (all moved to parameter defaults or consumer call sites)
- `git diff src/main.ts app/src/mcp-app.ts` shows only the `now` parameter additions and nothing else
- `bun run build` succeeds

---

### Phase 3 — Split `advanceLoom()` from `paintLoom()` inside `render/frame.ts`

Goal: separate state advancement from rendering so (a) state advancement is unit-testable without a canvas stub, (b) a future low-power renderer can skip painting without skipping state, (c) external readers can call `advanceLoom()` without side effects if needed.

**3.1 Identify what goes in advance vs paint**

Read `src/loom/render/frame.ts` carefully. Currently `renderLoom` does:

**Advance operations** (state mutations, should go in `advanceLoom`):
- Mouse delta computation, movement detection
- Gust/pressure decay and regeneration
- Current (ambient oscillator) advancement
- `drivePhantomHover` — phantom driver
- Per-thread touch scan (reads previous `_path`, sets `_handDist`, `touchedThread`)
- Phantom force-touched override
- Per-thread `computePath` calls
- Per-thread `proximity`, `warmth`, `arrivalGlow`, `emergenceStart` decay/ramp
- Resonance array update
- Immersion computation
- Any other state mutation

**Paint operations** (reads state, calls `ctx.*`, should go in `paintLoom`):
- Background fill
- Gradient setup
- Per-thread `renderThread` call (which itself calls drawLine/drawLineSegmented)
- Overlay / immersion dim
- Any other `ctx.*` call

**3.2 Extract the functions**

```ts
// Same file: src/loom/render/frame.ts

export function advanceLoom(
  vw: number,
  vh: number,
  now: number,
  dt: number,
  mouse: MouseState,
): void {
  // ... all state mutations, no ctx ...
}

export function paintLoom(
  ctx: CanvasRenderingContext2D,
  now: number,
): void {
  // ... all rendering, reads state, no mutations ...
}

export function renderLoom(
  ctx: CanvasRenderingContext2D,
  vw: number,
  vh: number,
  now: number,
  dt: number,
  mouse: MouseState,
): void {
  advanceLoom(vw, vh, now, dt, mouse)
  paintLoom(ctx, now)
}
```

Keep `renderLoom` as the public entry point for backward compat. Both consumers (`main.ts`, `mcp-app.ts`) continue calling it exactly as before. `advanceLoom` and `paintLoom` are exposed as additional exports for tests and future features.

**3.3 Handle shared locals**

`renderLoom` currently uses several locals shared between advance and paint phases: the aperture `ac`, viewport dims, frame ratio, etc. Options:
- (a) Compute them twice (once in advance, once in paint) — wasteful but cleanest
- (b) Store them in `loomState` as "current frame" fields — adds mutable state but matches the rest of the module
- (c) Return them from `advanceLoom` and pass to `paintLoom`

Prefer **(b)**: add `loomState.currentAperture`, `loomState.currentVW`, `loomState.currentVH`, `loomState.currentFrameRatio` etc. These are already implicitly "current frame" values. Update them in `advanceLoom`, read in `paintLoom`. Document the invariant: "paintLoom must be called after advanceLoom in the same frame; these fields are only valid between the two calls."

**3.4 Update the barrel**

`src/loom/index.ts` — add `advanceLoom` and `paintLoom` to the re-exports alongside `renderLoom`:
```ts
export { renderLoom, advanceLoom, paintLoom } from './render/frame.js'
```

**3.5 Write smoke tests** in `tests/loom/frame.test.ts` (new file):
- `advanceLoom(...)` mutates proximity/warmth/phantom state without needing a canvas
- `paintLoom(ctx)` called after `advanceLoom(...)` produces identical `fillTextCalls` to the old `renderLoom(ctx, ...)` on the same state (golden test — run one scenario on both, assert byte-identical call lists)
- `advanceLoom(...)` alone does not call any `ctx.*` method (use a proxy ctx that throws on any call)

**Phase 3 checkpoint**:
- All 41 existing tests + new frame.test.ts tests pass
- `bun run build` bundle size within ±2KB of 67.41 KB
- `git diff src/main.ts app/src/mcp-app.ts` shows only Phase 2 changes (no Phase 3 changes — renderLoom is unchanged)
- Manual smoke: `bun run dev` serves without errors (if the canvas init path is testable)

---

### Phase 4 — Read-only snapshot API (`getLoomSnapshot()`)

Goal: expose typed per-thread state so MCP tools, external consumers, and tests can inspect loom state without reaching into internals.

**4.1 Add types** in `src/loom/types.ts`:

```ts
export type LoomThreadSnapshot = {
  family: string
  warmth: number        // local touch interaction warmth
  apiWarmth: number     // API-baseline warmth
  depth: number         // current rendered depth
  restingDepth: number
  proximity: number
  xCenter: number
  scroll: number
  isTouched: boolean
  isPhantomTarget: boolean
  emergenceActive: boolean  // true while emergence animation is running
  unreadCount: number       // newVoiceIds.size
  groupIndices: number[]    // copy, not reference
}

export type LoomSnapshot = {
  ready: boolean
  immersion: number
  current: number           // ambient oscillator phase
  totalProximity: number
  touchedThreadIndex: number  // -1 if none
  phantomActive: boolean
  resonanceCount: number
  threads: LoomThreadSnapshot[]
}
```

**4.2 Add the function** in `src/loom/state.ts` (keep the existing `getLoomState` — it's the aggregates-only path):

```ts
export function getLoomSnapshot(): LoomSnapshot {
  return {
    ready: loomState.ready,
    immersion: loomState.immersion,
    current: loomState.current,
    totalProximity: loomState.proximity,  // or whatever the aggregate is
    touchedThreadIndex: loomState.touchedThreadIndex,
    phantomActive: loomState.phantomFocus !== null,
    resonanceCount: loomState.resonances.length,
    threads: loomState.threads.map((t, i) => ({
      family: t.family,
      warmth: t.warmth,
      apiWarmth: t.apiWarmth,
      depth: t.depth,
      restingDepth: t.restingDepth,
      proximity: t.proximity,
      xCenter: t.xCenter,
      scroll: t.scroll,
      isTouched: t === loomState.touchedThread,
      isPhantomTarget: loomState.phantomFocus?.threadIdx === i,
      emergenceActive: t.emergenceStart > 0 && /* check elapsed < duration if now is available */,
      unreadCount: t.newVoiceIds.size,
      groupIndices: [...t.groupIndices],  // copy
    })),
  }
}
```

Key invariant: the returned object must not share ANY mutable references with `loomState`. Callers must be able to hold the snapshot across frames without observing mutations.

**4.3 Export from barrel** in `src/loom/index.ts`:
```ts
export { getLoomState, getLoomSnapshot } from './state.js'
export type { LoomSnapshot, LoomThreadSnapshot } from './types.js'
```

**4.4 Write tests** in `tests/loom/snapshot.test.ts` (new file):
- `getLoomSnapshot()` returns a stable shape (all fields present, types correct)
- Mutating `loomState.threads[0].warmth` after calling `getLoomSnapshot()` does NOT affect the returned snapshot's warmth value
- Mutating the returned snapshot's `threads[0].groupIndices` array does NOT affect `loomState.threads[0].groupIndices`
- After `initLoom()`, `phantomActive` is false and `touchedThreadIndex` is -1
- After `triggerPhantomHover(0, voiceId, now)`, `phantomActive` is true and `isPhantomTarget` is set on the correct thread

**Phase 4 checkpoint**:
- All tests pass
- Build within ±2KB
- The snapshot API type-checks cleanly in consumer imports (verify by adding a throwaway import in main.ts that you then remove)

---

### Phase 5 — Dead export cleanup + test hygiene fixes

**5.1 Remove dead exports from barrel** `src/loom/index.ts`:
- Remove `triggerPhantomHover` from the barrel (only used internally by `refresh.ts`, which imports from `./phantom.js` directly)
- Remove `clearResonance` from the barrel (not used externally at all)
- **KEEP `setDiagHook`** — it IS used by `app/src/mcp-app.ts:465` (verify with grep before removing anything)

Before removing, run:
```sh
grep -rn "triggerPhantomHover\|clearResonance" src/main.ts app/src/mcp-app.ts worker/src/
```
If either symbol shows up outside `src/loom/`, do NOT remove it from the barrel.

**5.2 Test hygiene fixes** (from the coverage audit):

**5.2.1 Replace font-proxy assertion with diag-hook assertions** in `tests/loom/regressions.test.ts` — the "Phantom -> dive activation on fresh voice" test. Currently asserts `maxFontSizeForText(ctx, 'Ω') >= 11` as a proxy for `diveT > 0.3`. Replace with:

- Add new diag events in `src/loom/render/thread.ts` Pass 1: emit `phantom-diveT` with `{ voiceFlatIdx, diveT, fontSize }` when the target voice's line is processed
- In the test, assert on the diag event's `diveT` field directly: `expect(maxDiveT).toBeGreaterThan(0.3)`
- Keep the font-proxy assertion as a SECONDARY check but demote its severity (either make it an info log or drop)

**Critical**: the new assertion MUST still fail against a hypothetical pre-focusId-hoist baseline. Verify by temporarily reintroducing the focusId ReferenceError (via a local test-only hack) and confirming the test fails with a clear message. Then revert the hack.

**5.2.2 Fix string-based family comparison** in `tests/loom/regressions.test.ts:184`:
```ts
// Before — order-dependent
const targetFamilies = loomState.families.join(',')
if (targetFamilies !== 'memory') { ... }

// After — order-independent via Set
const families = new Set(loomState.families)
if (!(families.size === 1 && families.has('memory'))) { ... }
```

**5.2.3 Add stricter diag hook assertions** in `tests/loom/phantom.test.ts`:
- Assert `phantomTriggerCount === 1` (exactly one trigger), not just `>= 1`
- Assert the trigger payload matches expected threadIdx + voiceId
- Any test that counts `phantom-capture` events should assert the EXPECTED count, not just `> 0`

**5.2.4 Tighten test isolation** in any test that mutates `thread._path`, `thread._handDist`, or `thread._frameColor` directly: add an assertion after the mutation that `initLoom()` or `resetLoomState()` properly resets those fields. If the current `resetLoomState()` doesn't clear these (per coverage audit finding #7), that's a SOURCE fix — update `resetLoomState` in `src/loom/state.ts` to clear them, then add a test that verifies:

```ts
test('resetLoomState clears thread._path and _handDist to initial state', () => {
  installViewport(960, 640)
  withFixedRandom(0.5, () => initLoom())
  const t = getThreads()[0]!
  t._path = Array.from({ length: 61 }, (_, i) => ({ x: 999, y: i }))
  t._handDist = 42
  resetLoomState()
  // After reset, either no threads exist, OR if threads are preserved,
  // their _path is all-zeros and _handDist is Infinity
  // (determine the correct invariant by reading initLoom and document it)
})
```

**5.2.5 Harden timing assumptions** in `tests/loom/refresh.test.ts` and `tests/loom/regressions.test.ts`: once Phase 2 lands, all tests pass `now` explicitly to `refreshLoom`/`triggerPhantomHover`/`setResonance` so wall-clock drift on slow CI cannot cause spurious failures. Any remaining `performance.now()` calls in test code should be captured once at the start of the test, then advanced manually.

**Phase 5 checkpoint**:
- All tests pass
- `git diff src/loom/index.ts` shows only the dead export removal
- `bun run build` succeeds

---

### Phase 6 — Test coverage additions

Goal: add direct unit tests for every untested module + all 8 critical gap tests + moderate + low priority tests from the coverage audit. Target: ~80 total tests.

**6.1 Direct unit tests for untested modules**

Create these new test files. Each should have 2-5 focused unit tests that lock in the current behavior:

- `tests/loom/state.test.ts` — loomState initialization, resetLoomState completeness, accessor correctness
- `tests/loom/init.test.ts` — initLoom at various aperture widths (200, 320, 640, 960, 1440, 2560), groupMap construction determinism, resizeLoom preserves state
- `tests/loom/thread.test.ts` — makeThread field initialization, crystallizeThreads path/_frameColor init, merged group math
- `tests/loom/frame.test.ts` — advanceLoom smoke test (mutates state, no ctx calls), paintLoom smoke test (reads state, produces fillTextCalls), renderLoom = advance + paint equivalence
- `tests/loom/render-thread.test.ts` — renderThread Pass 1 activeUid selection, emergence alpha gate, newVoiceUids propagation, dive lens drawLineSegmented vs drawLine selection
- `tests/loom/render-line.test.ts` — drawLine alpha early exit, drawLineSegmented grapheme vs slice fallback equivalence, RTL handling
- `tests/loom/snapshot.test.ts` — (already added in Phase 4)

The barrel at `src/loom/index.ts` should have no direct tests — it's just re-exports. Verify via "all symbols the barrel exports are exported by at least one source module" check in one of the existing tests.

**6.2 Critical gap tests** (from Explore coverage audit)

Add to the appropriate existing test files:

**6.2.1 `refresh.ts` userEngaged gate with successor arrival** — `tests/loom/refresh.test.ts`
Trigger phantom on thread → run frames until proximity > 0.5 → arrival B lands on same thread → verify emergence animations fire (emergenceStart set, emergenceVoiceUids populated, arrivalGlow > 0) despite proximity > 0.3, because phantomFocus blocks the userEngaged gate.

**6.2.2 `refresh.ts` newVoiceUids rebuild after regrouping** — `tests/loom/refresh.test.ts`
9-group layout → narrow viewport to merge groups → mark unread voice in a merged group → widen viewport → refreshLoom → verify the unread marker flat index corresponds to the correct voice's lines, not off-by-one.

**6.2.3 Phantom capture Y position correctness** — `tests/loom/regressions.test.ts` (extend the existing phantom→dive test or add a new one)
Trigger phantom on a specific voice, log all `phantom-capture` diag events, verify the captured Y matches the measured position of the rendered line for that voice within 1 line-height tolerance. This is much stronger than the current "captureCount > 0" assertion.

**6.2.4 activeUid selection when hover is stale** — `tests/loom/render-thread.test.ts`
Position mouse on a line, scroll layout so hovered line's voice UID no longer matches, verify rendering gracefully falls back (no crash, line still renders at some font size).

**6.2.5 drawLineSegmented grapheme path vs slice fallback alignment** — `tests/loom/render-line.test.ts`
Render the same text once with `breakableWidths` populated (hits grapheme-by-grapheme path) and once with `breakableWidths = null` (hits slice-text fallback). Compare total x-positions of fillText calls. They should agree to within 1 pixel per grapheme.

**6.2.6 userTookOver boundary case** — `tests/loom/phantom.test.ts`
Trigger phantom, set `mouse.lastMove = getPhantomFocus().start` EXACTLY, call drivePhantomHover. Assert phantom is still active (the `>` comparison must exclude equality). This locks in that `lastMove === start` is NOT user takeover.

**6.2.7 resetLoomState completeness** — `tests/loom/state.test.ts`
(Covered in Phase 5.2.4 above)

**6.2.8 groupMap determinism across aperture breakpoints** — `tests/loom/init.test.ts`
For each aperture width (200, 320, 640, 960, 1440, 2560), with a 9-group input, verify `groupMap` produces the same assignment across two independent initLoom calls. Verify no group is orphaned or doubled.

**6.3 Moderate gap tests** (add as time permits, each in the appropriate file)

- `refresh.ts state == null` branch — refreshLoom called before any fetch succeeds, assert no crash, newVoiceIds stays empty
- `phantom.ts triggerPhantomHover` with voiceId from wrong thread — assert voiceFlatIdx = -1, phantom still activates, no crash
- `render/thread.ts` proximity gates 0.1 / 0.2 boundary — test what happens at prox === 0.10001 vs 0.099
- `render/thread.ts isPrimary && prox > 0.2` — test the not-primary-but-high-prox case
- `render/line.ts segScript` out-of-bounds access safety
- `thread.ts groupBoundaries` with malformed groupIndices (defensive check)
- `path.ts mouse.x > -1000` fragility in the -500 trap zone (sentinel boundary)

**6.4 Low-priority tests** (best-effort, skip if running long)

- `aperture.ts` at extreme viewport widths (100px, 3000px)
- `resonance.ts` 6-second decay boundary (5.9s vs 6.0s vs 6.1s)
- `render/frame.ts` gust force mixing across multiple pulses
- `math.ts` smoothstep at exact 0 and 1 inputs
- `text.ts` RTL + CJK + Latin mixed script edge cases

**Phase 6 checkpoint**:
- `bun test tests/loom/` shows at least 75+ tests passing, 0 failing
- All modules have at least one direct unit test file (even if small)
- The designated "Phantom -> dive activation on fresh voice" test still passes
- Coverage is visibly improved when a test fails — failure messages should pinpoint module + behavior

---

### Phase 7 — Documentation + stale report update

**7.1 Write `docs/LOOM_INVARIANTS.md`**

Document the 5 invariants from the coverage audit. Each invariant gets its own section with:
- The invariant statement (one-sentence)
- Where it applies (file:line refs)
- Why it exists (rationale)
- How it's enforced (test refs or assertion)
- What breaks if violated

Invariants:
1. **Scratch buffer consumption**: `_dc`, `_tc` in `color.ts`, `voiceSpanRunsScratch` in `text.ts` — must be consumed before any other call to the same function. Never stored across frames.
2. **Path initialization safety**: all threads start with `_path` as all-zero. Anything reading `_path` before the first `computePath()` on that thread gets garbage. The phantom driver must call `computePath` before reading `_path`.
3. **Phantom state machine**: `phantomFocus` is either null or fully initialized. No partial states. Re-triggering replaces the prior focus.
4. **Group index stability during refresh**: `groupIndices` and `groupBoundaries` can shift when viewport regrouping occurs. Cached `groupOffset` values must be recomputed after `refreshLoom()`.
5. **Mouse.x sentinels**: `mouse.x > -1000` means "cursor is on-screen". Values `-9000` and `-9e3` are init sentinels. The `> -1000` gate correctly rejects them while allowing `x = 0`.

Plus two new invariants from this hardening pass:
6. **Frame ordering contract**: `advanceLoom` must run before `paintLoom` in the same frame. Between the two calls, `loomState.currentAperture`/VW/VH/frameRatio are valid.
7. **Snapshot isolation**: `getLoomSnapshot()` returns a deep-copied read-only view. Callers may store it across frames without observing mutations.

**7.2 Update `docs/MODULARIZATION_REPORT.md`**

Line 8 says `40 pass / 1 failing-by-design`. Update to reflect current state (likely `75+ pass, 0 fail` after this hardening pass). Also note that the designated regression test no longer needs the failure carve-out since it now passes.

**7.3 Document the advance/paint split** in a new section of `docs/LOOM_INVARIANTS.md` or a new `docs/ARCHITECTURE.md`. Briefly explain:
- advanceLoom = state advancement, pure mutation of loomState
- paintLoom = rendering, reads state and calls ctx.*
- renderLoom = thin wrapper that calls both
- When to use which from external code

**Phase 7 checkpoint**: All docs exist and are coherent. `bun test tests/loom/` still passes.

---

## Verification contract

After all phases complete, verify:

```bash
cd /Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-harden/vellum

# 1. All tests pass
bun test tests/loom/
# Expected: 75+ pass, 0 fail

# 2. No performance.now() inside src/loom/
grep -rn "performance\.now" src/loom/
# Expected: zero matches

# 3. Build succeeds within size budget
bun run build
# Expected: dist/main.js ~67-70 KB (allow some growth for new tests/types, but flag if >72 KB)

# 4. Ext-app builds
cd app && bunx vite build && cd ..
# Expected: passes

# 5. Worker dry-run
cd worker && bun run deploy --dry-run && cd ..
# Expected: passes

# 6. Type check clean
bunx tsc --noEmit
# Expected: no NEW errors in src/loom/** (pre-existing project errors are OK)

# 7. Consumer files have minimal diffs
git diff main -- src/main.ts app/src/mcp-app.ts
# Expected: only `now` parameter additions (Phase 2) + setDiagHook import path adjustment if needed
```

## Acceptance criteria

1. All 7 phases complete
2. All verification commands pass
3. `docs/FOUNDATION_HARDENING_REPORT.md` written (see handoff section below)
4. Bundle size within +5 KB of the 67.41 KB baseline (larger tolerance than the refactor pass because we're adding real code)
5. No new `performance.now()` calls added to `src/loom/**`
6. `src/loom/index.ts` barrel has `triggerPhantomHover` and `clearResonance` removed, `advanceLoom` / `paintLoom` / `getLoomSnapshot` added, `setDiagHook` preserved
7. All four `mouse.x > -1000` sites remain present (no accidental reversion)
8. The "Phantom -> dive activation on fresh voice" regression test still passes, ideally with the new diag-hook assertions replacing the font proxy

## Rules for Codex

- **Stop before commit.** Claude picks up the commit step.
- **Spec-driven.** Only do what's in this doc. If you find additional improvements worth making, note them in the handoff report but don't execute.
- **Phase checkpoints.** Run `bun test tests/loom/` at the end of every phase. If tests fail at a checkpoint, fix before proceeding to the next phase. Do NOT accumulate failures.
- **Preserve comments.** Load-bearing comments in the existing code (scratch buffer conventions, frame ordering, attention partition commentary) stay with the code. Move them, don't delete them.
- **No new dependencies.** Everything uses built-in `bun:test`. No Node `canvas` package, no Playwright, no new npm packages.
- **Package manager is `bun`.** Use `bun run`, `bunx`, `bun test`. Never `npm`, `yarn`, `pnpm`, `npx`.
- **No git operations.** Sandbox can't commit cleanly. Stage work, stop.
- **Working directory**: `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-harden/vellum/`. Do not touch the main tree.
- **Node modules**: if the worktree lacks `node_modules`, create symlinks to the main tree's `node_modules` as you did in the modularization pass.

## Handoff report

Write `docs/FOUNDATION_HARDENING_REPORT.md` with:

1. **Summary**: test count before vs after, bundle size delta, phase-by-phase completion status
2. **Phase 1 — code fixes**: list each fix with file:line before/after
3. **Phase 2 — now threading**: list signatures changed, consumer call sites updated, how many `performance.now()` calls removed
4. **Phase 3 — advance/paint split**: list what went into advanceLoom, what went into paintLoom, any tricky shared locals and how you handled them
5. **Phase 4 — snapshot API**: the final `LoomSnapshot` shape, any fields you wanted to add but couldn't
6. **Phase 5 — dead exports + hygiene**: which exports removed, which hygiene issues fixed
7. **Phase 6 — test additions**: count by module, any tests you skipped and why
8. **Phase 7 — docs**: files written, files updated
9. **Anything suspicious** encountered during the refactor — dead code, unclear invariants, TODO-worthy items
10. **Judgment calls**: anything you did that wasn't explicit in the spec, with rationale
11. **Cursor bug status**: the running hypothesis has been that the focusId hoist (already landed in the refactor commit) was the root cause of the live production cursor bug. After your Phase 6 test additions, do any new tests reveal additional cursor-related bugs? If so, document them without fixing — Claude will triage after the audit.

## Not in scope (for a later pass)

- Interaction-mode state machine (pin / selection feature-driven)
- Typed arrival event payload (removes duplication between two pollers — needs feature pressure)
- Further file splits within `render/thread.ts` or `render/frame.ts`
- Fixing project-wide TypeScript errors (Intl.Segmenter etc.)
- Worker / MCP / ext-app audits (separate pass)
- Performance profiling
