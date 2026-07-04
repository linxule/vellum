# Loom Invariants

This document records the load-bearing invariants of `src/loom/**`. Each invariant includes the rationale (what it prevents) and the tests that enforce it. If you change a file under `src/loom/`, reread this doc first and confirm the edit does not violate any invariant without updating both the tests and this document.

## Identity layers

Loom uses three identity layers:

- **Canonical domain**: voice ids, family names, weave state. These are the durable identities.
- **Projection**: thread array index, column slot, group index. These are view-specific and can change when the viewport or refresh state changes.
- **Ephemeral attention**: phantom focus, resonance, warmth. These are transient and must be re-resolved from canonical identity each frame.

The rule across the renderer and worker is simple: domain logic may read projections, but it must never persist or reconcile on them.

## 1. Scratch buffer consumption

**Rule.** Module-level scratch buffers must be consumed before any other call into the same function. Never store them across frames. Never alias them.

**Where.**
- `src/loom/color.ts` — `_dc` (depthColor) and `_tc` (threadColor) return module-mutable tuples
- `src/loom/text.ts` — `voiceSpanRunsScratch` array
- `src/loom/thread.ts` — scratch arrays used inside `makeThread`

**Why.** These buffers exist to avoid per-frame allocation pressure. A caller that holds a `_dc` reference across a second `depthColor()` call will observe the second call overwriting the first's result. We fixed a broken pool optimization in `text.ts:76-81` during P1 (the `??` branch always allocated) — the scratch convention must not drift back in.

**Enforcement.**
- `tests/loom/color.test.ts` verifies back-to-back `depthColor()` calls return the same array with overwritten values
- `tests/loom/text.test.ts` exercises `voiceSpanForLine` with a fixture that would break on cross-run aliasing

**Breakage symptom.** Sporadic pixel color drift, especially on overlapping threads — almost impossible to reproduce in tests because the aliasing depends on call order timing.

## 2. Path initialization safety

**Rule.** All threads start with `_path` as `PATH_POINTS + 1` all-zero points. Any reader of `_path` before the first `computePath()` on that thread gets an all-zero path, which must be handled gracefully (typically: skip layout, skip touch scan, no drawing).

**Where.**
- `src/loom/thread.ts:makeThread` — initializes `_path: Array.from({length: PATH_POINTS + 1}, () => ({x: 0, y: 0}))`
- `src/loom/phantom.ts:drivePhantomHover` — must call `computePath` before reading `_path` for the phantom target (the "zero-path bootstrap" regression)
- `src/loom/render/frame.ts:advanceLoom` — touch scan reads the *previous* frame's `_path` by design

**Why.** Before the first render frame, all thread paths are zeros. If `drivePhantomHover` reads this to position the cursor, mouse lands at (0, 0) and immediately escapes the phantom focus. This fired as a real bug and became the "Zero-path bootstrap" regression test.

**Enforcement.**
- `tests/loom/regressions.test.ts` — "Zero-path bootstrap" — triggers phantom on frame 0 and verifies `thread._path` has non-zero points after one drive call
- `tests/loom/phantom.test.ts` — "phantom driver initializes an all-zero path before reading from it"
- `tests/loom/thread.test.ts` — "makeThread initializes all mutable-per-frame fields to zero / Infinity / empty" — asserts `_path` is all zeros at init

**Breakage symptom.** Phantom fires but immediately exits; `touchedThread` flickers for one frame then returns to `null`.

## 3. Phantom state machine consistency

**Rule.** `loomState.phantomFocus` is either `null` or a fully-initialized `PhantomFocus` object. No partial states. Re-triggering replaces the prior focus atomically.

**Where.**
- `src/loom/phantom.ts:triggerPhantomHover` — constructs and assigns the full object
- `src/loom/phantom.ts:drivePhantomHover` — user takeover sets `phantomFocus = null` (all-or-nothing)
- `src/loom/refresh.ts:refreshLoom` — calls `triggerPhantomHover` which handles the atomic replace

**Why.** If a partial `phantomFocus` leaks through, downstream code (`render/thread.ts` phantom-track / phantom-capture events, `render/frame.ts` force-touched override) reads fields on an undefined-shaped object and crashes.

**Enforcement.**
- `tests/loom/phantom.test.ts` — all five phantom tests exercise trigger / takeover / out-of-range safety
- `tests/loom/phantom.test.ts` — "userTookOver boundary: mouse.lastMove === phantomFocus.start does NOT count as takeover" pins the strict `>` comparison
- `tests/loom/phantom.test.ts` — "triggerPhantomHover on an out-of-range thread index is a no-op" pins the range check

**Breakage symptom.** Runtime `TypeError: Cannot read properties of null` on `phantomFocus.threadIdx` or similar, or phantom never exits despite user action.

## 4. Family-name stability during refresh

**Rule.** `familyNames` and `groupBoundaries` can shift when viewport regrouping occurs (merged threads split / unmerged threads merge). Any cached offsets (e.g., `newVoiceUids` local indices, voice-to-line mappings) must be recomputed after `refreshLoom()`.

**Where.**
- `src/loom/init.ts:initLoom` — assigns `familyNames` via `i % poolSize` distribution
- `src/loom/init.ts:resizeLoom` — does NOT touch `familyNames` (same thread count)
- `src/loom/refresh.ts:refreshLoom` — rebuilds threads via `initLoom`, redistributes unread `newVoiceIds` by family membership

**Why.** On a narrow → wide resize transition, `refreshLoom` must migrate the unread marker state from the merged thread's voice UID space to the newly-unmerged thread's UID space. Miss this and unread markers point to the wrong lines, or silently vanish.

**Enforcement.**
- `tests/loom/init.test.ts` — "groupMap slot assignment is consistent across aperture breakpoints" walks 7 viewport widths
- `tests/loom/refresh.test.ts` — "unread voice ids are redistributed when viewport regrouping moves a group"

**Breakage symptom.** Unread markers disappear or highlight the wrong voice after a resize.

## 5. Mouse sentinel convention

**Rule.** `mouse.x > -1000` means "cursor is on-screen". Sentinel values `-9e3` and `-9000` are used for initialization and for "off-screen"; any comparison with `||` on a numeric field that legitimately takes 0 is a bug.

**Where.**
- `src/loom/render/frame.ts:advanceLoom` — touch scan gate `if (mouse.x > -1000)`
- `src/loom/render/frame.ts:paintLoom` — cursor glow gate `if (mouse.x > -1000)`
- `src/loom/phantom.ts:drivePhantomHover` — `mouse.y > -1000` for the capture-Y fallback (was `mouse.y ||` which treated real 0 as missing; fixed in P1.1)

**Why.** A real cursor at `(0, 0)` is a valid position on the canvas — the top-left corner. Using `||` to test for presence treats 0 as "missing" and breaks the touch scan at the top edge.

**Enforcement.**
- `tests/loom/regressions.test.ts` — "mouse.x > 0 sentinel trap" — moves the cursor to `x = 0` and verifies touch scan still fires
- `tests/loom/integration.test.ts` — "mouse.x = 0 sentinel still participates in touch scan"

**Breakage symptom.** Hover detection dead at the top edge (`y = 0`) or the left edge (`x = 0`).

## 6. Frame ordering contract

**Rule.** `advanceLoom()` must run before `paintLoom()` in the same frame. Between the two calls, `loomState.currentAperture`, `loomState.currentMouse`, and `loomState.frameVisibilityAlpha` are valid.

**Where.**
- `src/loom/render/frame.ts:renderLoom` — thin wrapper enforces the order
- `src/loom/render/frame.ts:advanceLoom` — writes the shared frame-local fields
- `src/loom/render/frame.ts:paintLoom` — reads the shared frame-local fields; no-op if `currentAperture` is null

**Why.** `paintLoom` was split from `renderLoom` so external tools can inspect state between advance and paint, and so a low-power renderer can skip paint without skipping state advancement. The split relies on the shared frame-local fields — if `paintLoom` runs without a prior `advanceLoom`, the render would use stale or null state.

**Inside advance**, the internal ordering is also load-bearing:
1. `drivePhantomHover()` — may overwrite `mouse.x/y` from phantom target
2. gust / current oscillator advance
3. visAlpha computed
4. per-thread touch scan — reads previous frame's `_path`
5. phantom force-touched override
6. per-thread state updates (proximity, warmth, scroll, depth, xCenter)
7. immersion / holdTime
8. `computePath()` per thread — updates `_path` for THIS frame
9. `sortedThreadIndices.sort` — by depth + proximity

The touch scan reads the *previous* frame's `_path` (before `computePath` runs) because the frame ordering wouldn't make sense otherwise — `computePath` takes the current mouse, which we haven't settled via the touch scan yet. The one-frame lag is imperceptible at 60 fps.

**Enforcement.**
- `tests/loom/frame.test.ts` — "advanceLoom never calls any ctx.* method" (throwing-ctx proof)
- `tests/loom/frame.test.ts` — "paintLoom is a no-op when called without a preceding advanceLoom"
- `tests/loom/frame.test.ts` — "renderLoom = advanceLoom + paintLoom (split produces the same draws)"

**Breakage symptom.** Black screen (paintLoom no-op), or state advancement without rendering, or missing cursor glow / hover rendering.

## 7. Snapshot isolation

**Rule.** `getLoomSnapshot()` returns a deep-copied read-only view. Callers may store it across frames without observing mutations.

**Where.**
- `src/loom/state.ts:getLoomSnapshot` — copies `loomState.threads.map` into a fresh array; each thread's `familyNames` is spread into a new array
- `src/loom/types.ts:LoomSnapshot` — type contract

**Why.** The snapshot API exists so MCP tools (current and future), tests, and debug tools can inspect state without reaching into internals or taking mutable references. If the snapshot shares references with `loomState`, a caller that holds a snapshot across `refreshLoom()` would see old threads disappear, new threads appear, unread counts change under their feet — the exact behavior the snapshot was meant to avoid.

**Enforcement.**
- `tests/loom/snapshot.test.ts` — "snapshot warmth does not observe later mutations to loomState"
- `tests/loom/snapshot.test.ts` — "mutating snapshot familyNames does not affect loomState"
- `tests/loom/snapshot.test.ts` — "getLoomSnapshot returns the expected stable shape"

**Breakage symptom.** MCP tools return stale or drifting data; tests pass in isolation but fail when run with other tests that mutate state.

---

## Cross-cutting rules that aren't invariants but are load-bearing

**No `performance.now()` inside `src/loom/**`.** All timed functions accept an explicit `now` parameter (defaulting to `performance['now']()` at parameter-default time for backward compat). This was the P2 work. `grep -rn "performance\.now" src/loom/` must return zero matches. The rule exists because hidden clock dependencies caused spurious test failures and made it impossible to thread a consistent test clock through a render loop.

**Type-check before every deploy.** `bun build` strips types without checking them. A TS2552 (the `focusId` incident) shipped to production and ran as a ReferenceError because `bun build` never saw the type error. Pre-deploy checklist: `bun test tests/loom/ && bunx tsc --noEmit && bun run build`. The CLAUDE.md pre-deploy check already documents this.

**No further file splits.** The current 19-module shape (16 in `src/loom/` + 3 in `src/loom/render/`) is the correct grain. `render/thread.ts` (~290 lines) and `render/frame.ts` (~360 lines) are large but coherent — don't split them into sub-files. Internal function-level refactors inside a single file are fine (e.g., the advance/paint split inside `render/frame.ts`).

## 8. Identity layers

**Rule.** Projection identities never flow backward into domain logic. Thread array index, column slot, and group index are view projections only. Use voice ids and family names for persistence, reconciliation, and refresh-time matching.

```ts
// bad: positional identity becomes a key
const key = threadIdx

// good: canonical identity survives reshuffles
const key = voiceId
```

**Where.**
- `src/main.ts` and `src/loom/state.ts` — witness attribution must use the touched thread's family set, not `families[0]`
- `src/loom/refresh.ts` — refresh rekeys state from canonical thread identity, not array position
- `src/loom/phantom.ts` — phantom resolution starts from `voiceId` or `groupKey`, never a cached thread position

**Why.** View projections shift when threads merge, split, or reorder. If code stores them as durable identity, state is silently attached to the wrong family or thread after refresh.

## 9. Phantom focus is voice-keyed

**Rule.** `phantomFocus` targets a voice, not a thread slot. Store `voiceId` when available, fall back to `groupKey` only when there is no voice, and resolve `threadIdx` and `voiceFlatIdx` from live state on every frame.

```ts
phantomFocus = {
  voiceId: 'memory-0',
  groupKey: null,
}
const threadIdx = findThreadForVoice(voiceId)
```

**Where.**
- `src/loom/phantom.ts` — `triggerPhantomHover()` records canonical identity; `drivePhantomHover()` recomputes the live target each frame
- `tests/loom/phantom.test.ts` — reshuffle, missing-voice, and fallback coverage pin the resolution behavior

**Why.** `loomState.threads` can rebuild while a phantom is held. A cached positional thread index can drift to a different column and keep steering the cursor at the wrong target.

## 10. Witness credits all merged families

**Rule.** Witness dwell time is distributed across every family in the touched thread. On merged columns, do not pick the first family from the set or treat the set as a single canonical winner.

```ts
await witness({ families: [...touchedThread.families], dwell_s })
```

**Where.**
- `src/main.ts` — `onThreadRelease()` builds the family list for the touched thread
- `worker/src/index.ts` — `/api/witness` accepts the family list and applies warmth per family
- `tests/loom/init.test.ts` — narrow viewport coverage exercises merged-thread attribution

**Why.** Merged columns share one visible thread. If warm credit only goes to the first family, the others stay cold even though the user saw them in the same highlighted column.
