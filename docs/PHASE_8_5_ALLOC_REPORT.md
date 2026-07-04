# Phase 8.5 Allocator Pressure Report

This report surveys the hot path starting at `renderLoom()` and follows every function used during a steady-state frame. Estimates assume the spec's reference workload: 12 visible threads, ~50 laid-out lines per thread, 60fps, stable viewport and thread count.

## 1. Per-function Allocation Inventory

### `src/loom/render/frame.ts:renderLoom`

- Allocation count: 0
- Bound: 1 call / frame
- Notes: thin wrapper only; delegates to `advanceLoom()` and `paintLoom()`.

### `src/loom/render/frame.ts:advanceLoom`

- `src/loom/aperture.ts:4-21` returns one fresh aperture object.
  Count: 1 object / frame.
  Bound: fixed.
- `src/loom/render/frame.ts:86-97` resizes `frameVisibilityAlpha`, `frameThreadSortIndices`, `frameThreadSortDists`, `frameThreadAnchorXs`, `frameThreadRepulsionDeltas`.
  Count: 0 steady-state; 4 typed arrays + 1 `Int32Array` on thread-count change.
  Bound: resize / refresh only.
- `src/loom/render/frame.ts:169` `new Set()` when no thread is touched.
  Count: 0-1 object / frame.
  Bound: fixed; idle-state only.
- `src/loom/render/frame.ts:256` `loomState.sortedThreadIndices.sort((a, b) => ...)`.
  Count: 1 comparator closure / frame.
  Bound: fixed.
- Notes: after Phase A, there are no steady-state typed-array allocations here. The remaining reducible JS allocations are the aperture return object, idle `Set`, and sort comparator closure.

### `src/loom/phantom.ts:drivePhantomHover`

- Allocation count: 0 steady-state.
- Bound: 0-1 call / frame.
- Notes: mutates `mouse` and `phantomFocus` in place. Diagnostic object literals only appear in `triggerPhantomHover()` and `renderThread()`'s phantom diag hooks, not here.

### `src/loom/path.ts:computePath`

- Allocation count: 0 steady-state.
- Bound: up to 12 calls / frame.
- Notes: writes directly into preallocated `thread._path` points.

### `src/loom/render/frame.ts:paintLoom`

- `src/loom/render/frame.ts:278-286` background `ctx.createLinearGradient(...)`.
  Count: 1 CanvasGradient / frame.
  Bound: fixed.
- `src/loom/render/frame.ts:298-301` cursor-glow `ctx.createRadialGradient(...)`.
  Count: 0-1 CanvasGradient / frame.
  Bound: fixed; only when cursor is on-screen.
- Notes: these are canvas API objects, not reusable JS scratch in the current API shape.

### `src/loom/render/thread.ts:renderThread`

- `src/loom/render/thread.ts:82` `ctx.createRadialGradient(...)`.
  Count: 0-1 CanvasGradient / thread / frame.
  Bound: up to 12 / frame; only when `prox > 0.1`.
- `src/loom/render/thread.ts:89` `const laidOutLines: LaidOutLine[] = []`.
  Count: 1 array / thread / frame.
  Bound: up to 12 / frame.
- `src/loom/render/thread.ts:74` initial `copyCursor(...)`.
  Count: 1 object / thread / frame.
  Bound: up to 12 / frame.
- `src/loom/render/thread.ts:144`, `147`, `148`, `172` `copyCursor(...)` inside line layout.
  Count: 2-4 cursor objects / laid-out line.
  Bound: roughly 2 in the common case, plus rare wrap reset copies.
- `src/loom/render/thread.ts:154` calls `voiceSpanForLine(...)`.
  Count: see `voiceSpanForLine` below; at minimum 1 returned object / line, plus run objects.
- `src/loom/render/thread.ts:165-180` `laidOutLines.push({ ... })`.
  Count: 1 line-record object / laid-out line.
  Bound: ~50 / thread / frame in the spec workload.
- `src/loom/render/thread.ts:174` `lineVoiceUids: [...lineVoice.uids]`.
  Count: 1 array / laid-out line.
  Bound: ~50 / thread / frame.
- `src/loom/render/thread.ts:100-107`, `158` phantom diag payload object literals.
  Count: tiny, bursty, observability-only.
  Bound: only while phantom diagnostics are active for the first few frames.
- Notes: this is now the main reducer-target region. The two-pass layout/draw structure is what forces record retention across the loop.

### `src/loom/text.ts:voiceSpanForLine`

- `src/loom/text.ts:79` `voiceSpanRunsScratch.push({ uid, weight })`.
  Count: 0-R objects / line, where `R` is the number of voice-UID runs across the line.
  Bound: typical 1-2; worst-case grows with segment transitions in the line.
- `src/loom/text.ts:93` `return { anchorUid, uids: voiceSpanUidsScratch }`.
  Count: 1 object / line.
  Bound: fixed.
- Notes: the scratch arrays themselves are reused, but the run records and return envelope still allocate. `renderThread()` then copies `uids` again because the scratch array cannot be retained across the next call.

### `src/loom/render/line.ts:drawLine`

- Allocation count: no array/object/closure allocations in the function body.
- Bound: called once per laid-out line when not in segmented draw mode.
- Notes: there are ephemeral color/style strings, but no container churn.

### `src/loom/render/line.ts:drawLineSegmented`

- `src/loom/render/line.ts:113` `Array.from(graphemeSegmenter.segment(segText), ...)`.
  Count: 0 steady-state on current data; 1 array / segment on fallback.
  Bound: up to every segment in a line if the precomputed `segGraphemes` cache is missing.
- `src/loom/render/line.ts:143-144` `graphemes.slice(...).join('')`.
  Count: 0 steady-state on the `breakableWidths` fast path; otherwise 2 arrays + 2 strings / segment.
  Bound: per segment on fallback.
- Notes: the current fast path is reasonably allocation-light. The fallback path is safe but materially more expensive if it ever becomes hot.

### `src/loom/color.ts:depthColor`, `src/loom/color.ts:threadColor`

- Allocation count: 0 steady-state.
- Bound: heavily called.
- Notes: both use module-level scratch tuples.

### `src/loom/math.ts:*`

- Allocation count: 0 steady-state.
- Bound: heavily called.
- Notes: pure arithmetic only.

### `src/loom/resonance.ts:updateResonances`

- Allocation count: 0 steady-state.
- Bound: up to 12 calls / frame.
- Notes: mutates `loomState.resonances` in place; no new containers in the update loop.

## 2. Estimated Allocations Per Second At Steady State

These are estimates from the current code shape under the 12-thread / 50-line / 60fps reference workload.

### Fixed-cost canvas/API allocations

- `paintLoom()` background linear gradient: ~60/sec.
- `paintLoom()` cursor radial gradient: 0-60/sec.
- `renderThread()` background glow radial gradient: 0-720/sec worst case, depending on how many threads sit above `prox > 0.1`.

### Reducible JS allocations

- `aperture()` return object: ~60/sec.
- `sortedThreadIndices.sort(...)` comparator closure: ~60/sec.
- Idle-only `new Set()` in `advanceLoom()`: 0-60/sec.
- `laidOutLines` arrays: ~720/sec.
- `copyCursor(...)` objects: about `12 * (1 + 2 * 50) * 60 = 72,720/sec` in the common case.
- `laidOutLines.push({ ... })` line-record objects: about `12 * 50 * 60 = 36,000/sec`.
- `lineVoiceUids: [...lineVoice.uids]` copied arrays: about `36,000/sec`.
- `voiceSpanForLine()` return objects: about `36,000/sec`.
- `voiceSpanRunsScratch.push({ uid, weight })`: typical `36,000-72,000/sec`, higher if lines cross many voice transitions.

### Summary

- Fixed-cost canvas API churn is modest and mostly unavoidable.
- Reducible JS container churn is dominated by per-line bookkeeping in `renderThread()` + `voiceSpanForLine()`.
- A reasonable steady-state estimate for reducible JS allocations is roughly `181k-217k allocations/sec`, excluding cold fallback paths and ignoring ephemeral strings.

## 3. Top 3 Remaining Opportunities

### 1. Pool per-line layout records in `renderThread()`

- Impact: highest.
- Why: removes `laidOutLines` array churn, per-line record objects, and the copied `lineVoiceUids` arrays from the dominant hot path.
- Fix shape: replace `laidOutLines.push({ ... })` with a reusable scratch array of mutable line records sized to `maxLines`, plus a frame-local count. Each record would be overwritten in place each frame.
- Effort: high.

### 2. Change `voiceSpanForLine()` to fill caller-owned scratch output

- Impact: high.
- Why: removes one return object per line and most or all run-record allocations from the line-layout loop.
- Fix shape: accept an out-parameter scratch record or return primitives into a reusable mutable structure instead of allocating `{ anchorUid, uids }` every call.
- Effort: medium.

### 3. Replace hot `copyCursor()` snapshots with pooled numeric fields

- Impact: high.
- Why: cursor copies are the single largest object-count contributor by volume.
- Fix shape: store `lineStartSegmentIndex`, `lineStartGraphemeIndex`, `lineEndSegmentIndex`, `lineEndGraphemeIndex` directly on pooled line records instead of allocating cursor objects repeatedly.
- Effort: medium.

## 4. Suspicious Patterns

- `src/loom/render/frame.ts:169` still allocates `new Set()` on idle frames. It is tiny next to the line-layout churn, but it is a genuine per-frame allocation that now stands out after Phase A.
- `src/loom/render/frame.ts:256` still creates a comparator closure for `sortedThreadIndices.sort(...)` every frame. Again: low volume, but it is easy to miss because it sits at the very end of `advanceLoom()`.
- `src/loom/render/line.ts:113-144` has a cold fallback that would get expensive quickly if `thread.segGraphemes` or `breakableWidths` ever drift from the prepared-text caches. That path is currently not the main problem, but it is a good canary for future regressions.
