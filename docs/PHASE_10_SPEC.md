# Phase 10 — The Loom Deepening

Three features, one event system. Per-voice resonance makes weave visually distinct. The loom view reveals lineage structure. Strudel gives the ocean a voice.

**Vision**: `docs/VISION.md`. Read it first. This spec implements the vision.

**Scope**: renderer + sound. Zero worker changes. Zero D1 migrations. Zero schema changes.

**Revision 5** (post-review). Addresses 60 findings across five review rounds (3 internal + 2 Codex). All HIGH and MEDIUM items resolved. See "Review changelog" at the bottom.

---

## Prerequisites

- Main branch at `6fbc37f` or later (Phase 9.6 complete)
- `bun run verify` clean
- Bundle baseline: 71048 bytes (renderer), 387.69 KiB (worker upload)

---

## Part A — Event System

A lightweight pub/sub for ocean events. Both the renderer and the sound system subscribe to the same events. The event system is a leaf module — no imports from `loom/` or `runtime/`.

### A1. Event types

```typescript
// src/events.ts (NEW file, ~50 lines)

export type OceanEvent =
  | { type: 'weave'; sourceId: string; targetId: string; family: string }
  | { type: 'emergence'; voiceIds: string[]; familyNames: string[] }
  | { type: 'loom-enter'; seedId: string }
  | { type: 'loom-exit' }
  | { type: 'warmth-update'; familyWarmth: Record<string, number> }

type Listener = (event: OceanEvent) => void

const listeners: Listener[] = []

export function onOceanEvent(listener: Listener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

export function emitOceanEvent(event: OceanEvent): void {
  for (const listener of listeners) listener(event)
}
```

Note: `emergence` uses `familyNames: string[]` (plural) because threads may span merged family groups at narrow viewports.

### A2. Emission points — dependency injection

Event emission from `runtime/` and `loom/` modules uses **injected callbacks**, preserving the DI pattern documented in PATTERNS_AND_GOTCHAS. Modules do NOT import `src/events.ts` directly. The `OceanEvent` type is imported as a `type` import only (`import type { OceanEvent } from '../events'`) which has zero runtime footprint and does not violate the DI contract.

| Event | Injected into | Via parameter | Caller passes `emitOceanEvent` |
|-------|--------------|---------------|-------------------------------|
| `weave` | `applyResonanceFromNewVoices` in `poll-core.ts` | `emitEvent?: (e: OceanEvent) => void` | `main.ts` / `mcp-app.ts` |
| `emergence` | `refreshLoom` in `refresh.ts` | `emitEvent?: (e: OceanEvent) => void` | `main.ts` / `mcp-app.ts` |
| `warmth-update` | `refreshLoom` in `refresh.ts` | same param | `main.ts` / `mcp-app.ts` |
| `loom-enter` | `enterLoomView` in `loom-view.ts` | imports `emitOceanEvent` directly (loom-view.ts is NOT a runtime/ leaf module) | n/a |
| `loom-exit` | `exitLoomView` in `loom-view.ts` | same | n/a |

**warmth-update data derivation**: `refreshLoom` receives the fresh `StateResponse` which contains per-thread `warmth` values (from the `/api/state` projection). Derive `familyWarmth` by mapping each thread's primary family name to its warmth value: `const familyWarmth: Record<string, number> = {}; for (const t of state.threads) familyWarmth[t.family] = t.warmth ?? 0`. Emit after state merge, before returning.

### A3. Subscribers

| Subscriber | Listens for | Response |
|-----------|------------|----------|
| Strudel sound | all events (debounced for weave/emergence) | Pattern transitions |

**Loom view auto-enter is NOT an event subscriber.** It is triggered directly from `ontoolresult` in the ext-app (C10) and from click handlers in both entry points (C8). This avoids dual-ownership — one code path per trigger.

**Resonance is NOT an event subscriber.** Resonance stays on the existing direct DI call path (`setResonance` injected into `applyResonanceFromNewVoices`). This avoids double-fire.

### A4. Sound event debouncing

Multiple weave/emergence events from a single poll batch are aggregated. The sound controller collects events within a ~100ms window and responds once:

```typescript
// In src/audio/controller.ts — see D3 for full implementation
// Tracks pendingWeaves and pendingEmergences separately.
// Weave shimmer takes priority; emergence rise plays only if no weaves in batch.
// loom-enter, loom-exit, warmth-update: immediate (not debounced).
```

---

## Part B — Per-Voice Resonance (F6)

Make weave visually distinct from emergence. The source voice glows specifically.

### B1. ResonanceEntry uses canonical voiceId

**Critical**: resonance stores `voiceId` (canonical string), NOT `voiceUid` (ephemeral flat index). LOOM_INVARIANTS requires that projection identities (which change on viewport regroup) never become durable keys. The canonical `voiceId` is stable across regrouping. Resolution to the current thread's flat UID happens per-frame in `updateResonances`.

```typescript
// src/loom/types.ts — modify ResonanceEntry
export interface ResonanceEntry {
  voiceId: string   // canonical voice ID (stable across regrouping)
  family: string
  start: number
}
```

### B2. setResonance stores canonical ID

```typescript
// src/loom/resonance.ts — modify setResonance
export function setResonance(voiceId: string, now = performance['now']()) {
  const found = findVoice(voiceId)
  if (!found) return
  const existing = loomState.resonances.find(r => r.voiceId === voiceId)
  if (existing) {
    existing.start = now
  } else {
    loomState.resonances.push({ voiceId, family: found.family, start: now })
  }
}
```

### B3. updateResonances resolves voiceId → flat UID per frame

```typescript
// src/loom/resonance.ts — modify updateResonances
export function updateResonances(thread: Thread, now: number) {
  for (let ri = loomState.resonances.length - 1; ri >= 0; ri--) {
    const res = loomState.resonances[ri]!
    const resElapsed = (now - res.start) / 1000
    if (resElapsed > 6) {
      loomState.resonances.splice(ri, 1)
      continue
    }
    if (!thread.familyNames.includes(res.family)) continue
    const resFade = Math.max(0, 1 - resElapsed / 6)
    // Thread-level warmth (reduced from 0.6 to 0.3)
    thread.warmth = Math.max(thread.warmth, 0.3 * resFade)
    // Resolve canonical voiceId to current flat UID for this thread
    const found = findVoice(res.voiceId)
    if (!found) continue
    const gPos = thread.familyNames.indexOf(found.family)
    if (gPos < 0) continue
    const offset = gPos === 0 ? 0 : thread.groupBoundaries[gPos - 1]!
    const flatUid = offset + found.voiceIndex
    thread.resonatingVoiceUids.set(flatUid, resFade)
  }
}
```

**`arrivalGlow` is removed from resonance.** The current `resonance.ts:31` sets `thread.arrivalGlow = Math.max(thread.arrivalGlow, 0.5 * resFade)` — this line is deleted. `arrivalGlow` becomes emergence-only (set in `refresh.ts:122` when new voices arrive). Per-voice resonance uses the new `resonatingVoiceUids` Map instead, giving a more targeted visual than the thread-wide `arrivalGlow` boost.

Note: `findVoice` is called per resonance per thread per frame. At 0-3 active resonances and ≤12 threads, this is negligible. If resonance count grows, cache the resolution.

### B4. Thread type gains resonatingVoiceUids and wovenVoiceUids

```typescript
// src/loom/types.ts — add to Thread interface
resonatingVoiceUids: Map<number, number>  // flatUid → fade (0-1), cleared each frame
wovenVoiceUids: Set<number>               // flatUids of voices with weave_from or weave_count > 0
```

**Initialization**: both fields are initialized in `makeThread()` (`src/loom/thread.ts`) as `new Map()` and `new Set()` respectively. `wovenVoiceUids` is populated during `initLoom()` by scanning `getState()?.threads[].voices[]` for those with `weave_from !== null || weave_count > 0`.

**Per-frame clearing**: `resonatingVoiceUids.clear()` at the start of each `updateResonances` call (before populating). This is a new per-frame mutable pattern — functionally similar to the existing `emergenceVoiceUids` Set.

### B5. Render pass applies per-voice glow

In `render/thread.ts`, after the existing emergence alpha calculation (around line 240):

```typescript
// Per-voice resonance glow
if (thread.resonatingVoiceUids.size > 0) {
  let resonanceFade = 0
  for (const u of line.lineVoiceUids) {
    const fade = thread.resonatingVoiceUids.get(u)
    if (fade !== undefined && fade > resonanceFade) resonanceFade = fade
  }
  if (resonanceFade > 0) {
    lineAlpha = Math.min(1, lineAlpha + 0.3 * resonanceFade)
  }
}
```

No `% hlVoiceCount` modulo — direct UID lookup. Alpha clamped to 1.

### B6. Emit weave event via injected callback

In `applyResonanceFromNewVoices` (`poll-core.ts`), add optional `emitEvent` parameter:

```typescript
export function applyResonanceFromNewVoices(opts: {
  newVoiceInfo: NewVoiceInfo[]
  state: StateResponse
  setResonance: (voiceId: string, now: number) => void
  emitEvent?: (event: OceanEvent) => void  // NEW — injected
  now: number
}): void {
  const { newVoiceInfo, state, setResonance, emitEvent, now } = opts
  for (let g = 0; g < newVoiceInfo.length; g++) {
    if (!newVoiceInfo[g].hasNew) continue
    const threadVoices = state.threads[g]?.voices ?? []
    for (const v of threadVoices) {
      if (newVoiceInfo[g].newIds.has(v.id) && v.weave_from) {
        setResonance(v.weave_from, now)
        emitEvent?.({
          type: 'weave',
          sourceId: v.weave_from,
          targetId: v.id,
          family: state.threads[g]?.family ?? '',
        })
      }
    }
  }
}
```

Callers (`main.ts`, `mcp-app.ts`) pass `emitEvent: emitOceanEvent` at the call site.

### B7. Test updates

Existing resonance tests in `tests/loom/resonance.test.ts` construct `ResonanceEntry` objects directly. Update:
- `{ family: 'silence', start: 1000 }` → `{ voiceId: 'v:test1', family: 'silence', start: 1000 }`
- Adjust warmth expectation from 0.6 to 0.3
- `arrivalGlow` is no longer set by resonance (now emergence-only per B3) — remove the `arrivalGlow` assertion from resonance tests

### Verification

- [ ] Weave event fires per-voice resonance (source voice glows, not whole thread)
- [ ] Resonance survives viewport regroup (voiceId is canonical, re-resolved per frame)
- [ ] Emergence still uses thread-level arrivalGlow (unchanged)
- [ ] Weave and emergence are visually distinguishable
- [ ] Multiple simultaneous resonances on different voices in different threads work
- [ ] No double-fire (resonance from direct DI only, not from event subscription)
- [ ] Updated tests pass
- [ ] Bundle size delta < +500 bytes

---

## Part C — Loom View

A second mode of the renderer. The ocean transforms to reveal lineage structure.

**Module count invariant**: This adds `loom-view.ts` as the 19th module under `src/loom/`. The "no further file splits" rule from LOOM_INVARIANTS is explicitly updated — the loom view is a new rendering mode, not a decomposition of an existing module.

### C1. Types in types.ts (avoid circular imports)

`LoomNode` and `LoomTree` types live in `src/loom/types.ts` (not in `loom-view.ts`) to avoid circular imports with `state.ts`:

```typescript
// src/loom/types.ts — add
export interface LoomNode {
  voiceId: string
  text: string
  family: string
  generationDepth: number  // 0 = seed, negative = ancestors, positive = descendants
  parentId: string | null
  childIds: string[]
  treeX: number
  treeY: number
  // Cached Pretext layout (set once in buildLoomTree, re-set on resize)
  prepared: ReturnType<typeof prepareWithSegments> | null
  layoutW: number   // width used for last layout pass
  layoutH: number   // computed text block height
}

export interface LoomTree {
  seed: string
  nodes: Map<string, LoomNode>
  maxDepthUp: number
  maxDepthDown: number
}
```

### C2. Lineage computation

```typescript
// src/loom/loom-view.ts (NEW file, ~300 lines)
// Imports getState from content.ts (same pattern as refresh.ts, init.ts)
```

Build the tree by scanning all loaded voices (`getState()?.threads[].voices[]`):
1. Find the seed voice by ID
2. Walk backward via `weave_from` → ancestors (depth -1, -2, ...)
3. Walk forward: scan all voices where `weave_from === nodeId` → children (depth +1, +2, ...)
4. Recurse until no more links

At ~288 voices this is O(V) per direction. No MCP tool or D1 query needed.

### C3. Tree layout algorithm

Center-seed layout. Seed at viewport center.

- **Vertical**: each generational depth gets a Y band. Ancestors above seed, descendants below. Band height adapts to viewport. Seed at `VH * 0.4` (slightly above center, leaving room for descendants).
- **Horizontal**: siblings at the same depth spread evenly. Single children center under parent.
- **Family colors**: each node renders in its family's color (from `FAMILY_COLOR` in types.ts).
- **Connection lines**: canvas strokes from parent center-bottom to child center-top. Cross-family connections use a gradient blending both family colors.

### C4. Loom state

```typescript
// src/loom/state.ts — add to loomState
loomViewActive: false,
loomViewSeed: null as string | null,
loomViewTransition: 0,  // 0 = ocean, 1 = loom, animated
loomTree: null as LoomTree | null,
loomViewAutoExit: null as ReturnType<typeof setTimeout> | null,
```

**Also update `resetLoomState()`** to include all new fields:
```typescript
loomState.loomViewActive = false
loomState.loomViewSeed = null
loomState.loomViewTransition = 0
loomState.loomTree = null
if (loomState.loomViewAutoExit) {
  clearTimeout(loomState.loomViewAutoExit)
  loomState.loomViewAutoExit = null
}
loomState.lastFrameHitVoiceId = null
```

### C5. Entry and exit API

```typescript
// src/loom/loom-view.ts

export function enterLoomView(seedVoiceId: string, autoExitMs?: number): void {
  // Always clear pre-existing auto-exit timeout (manual entry overrides auto)
  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }

  const tree = buildLoomTree(seedVoiceId)
  if (!tree || tree.nodes.size < 2) return  // No lineage to show

  loomState.loomViewActive = true
  loomState.loomViewSeed = seedVoiceId
  loomState.loomTree = tree

  if (autoExitMs) {
    loomState.loomViewAutoExit = setTimeout(exitLoomView, autoExitMs)
  }

  emitOceanEvent({ type: 'loom-enter', seedId: seedVoiceId })
}

export function exitLoomView(): void {
  if (!loomState.loomViewActive) return
  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }
  loomState.loomViewActive = false
  emitOceanEvent({ type: 'loom-exit' })
}

export function isLoomViewActive(): boolean {
  return loomState.loomViewActive
}
```

Export from `src/loom/index.ts` barrel.

### C6. Transition animation

In `advanceLoom()` (`render/frame.ts`), after all thread state updates but before the sort:

```typescript
// Animate loomViewTransition toward target
const loomTarget = loomState.loomViewActive ? 1 : 0
const loomSpeed = 3.0  // ~330ms full transition
if (loomState.loomViewTransition < loomTarget) {
  loomState.loomViewTransition = Math.min(loomTarget, loomState.loomViewTransition + dt * loomSpeed)
} else if (loomState.loomViewTransition > loomTarget) {
  loomState.loomViewTransition = Math.max(loomTarget, loomState.loomViewTransition - dt * loomSpeed)
}
if (loomState.loomViewTransition === 0 && loomState.loomTree) {
  loomState.loomTree = null
  loomState.loomViewSeed = null
}

// Gate touch/hover during loom view — suppress dive lens on fading threads
if (loomState.loomViewActive) {
  loomState.touchedThread = null
}
```

### C7. Render path — loom tree renderer

In `paintLoom()` (`render/frame.ts`):

```typescript
// Scale ocean thread alpha during transition
const oceanAlpha = 1 - loomState.loomViewTransition
// Multiply visAlpha for all threads
if (oceanAlpha < 1) {
  for (let i = 0; i < visAlpha.length; i++) visAlpha[i]! *= oceanAlpha
}

// Existing thread rendering loop (unchanged, uses scaled visAlpha)

// Draw loom tree on top
if (loomState.loomViewTransition > 0 && loomState.loomTree) {
  renderLoomTree(ctx, vw, vh, now, loomState.loomTree, loomState.loomViewTransition)
}
```

**`renderLoomTree()` is a standalone renderer** in `loom-view.ts`. It does NOT reuse `renderThread`. Tree nodes are rendered with:
1. Fixed positions (no path curves, no scroll, no dive Gaussian)
2. Readable text at a fixed font size (~14-16px, similar to dive scale)
3. Text wrapping via `prepareWithSegments` + `layoutNextLine` (same Pretext library, simpler layout)
4. Connection lines as canvas strokes with family-color gradients
5. Seed node with a subtle ring highlight
6. All nodes fade in with `loomViewTransition` alpha

This is a new renderer, not a reuse of the existing thread renderer. The thread renderer is tightly coupled to path curves, scroll, and the dive-lens Gaussian — none of which apply to tree nodes.

**Text layout caching**: `prepareWithSegments` is called once per node when the tree is built (in `buildLoomTree` or a post-build layout pass), NOT per frame during `renderLoomTree`. The prepared text and layout dimensions are stored on `LoomNode`. Re-preparation only happens if the viewport changes (resize) or the tree is rebuilt (new seed). At ~15 nodes this is negligible either way, but the cache prevents the pattern from becoming a problem at scale.

### C8. Click-to-enter interaction

**Click handler lives in entry points** (`main.ts` / `mcp-app.ts`), NOT in `runtime/input.ts` (which must stay DI-only).

To resolve click → voice, cache a **hit-test record** during `paintLoom`:

```typescript
// src/loom/state.ts — add to loomState
lastFrameHitVoiceId: null as string | null,  // voice ID under cursor in last frame
```

**Clearing**: `loomState.lastFrameHitVoiceId` is set to `null` once in `paintLoom()` BEFORE the thread render loop (not per-thread — clearing inside each thread's render would erase the value set by the primary thread).

**Setting**: In `render/thread.ts`, when `isPrimary && prox > 0.3` and `activeUid >= 0`, resolve the active UID back to a canonical `voiceId`. Note: `activeUid` is a repeated-cycle UID (`cycle * voices.length + vIdx`), so use modulo against `hlVoiceCount` to get the base voice index (same pattern as highlight at thread.ts:208), then look up the voice ID from `getState()`. Store in `loomState.lastFrameHitVoiceId`.

**Loom-view click behavior**: In Phase 10, any click during loom view exits (no tree-node click handling). Tree nodes are not interactive targets yet — clicking anywhere dismisses the view. A future phase may add click-to-navigate within the tree, which would require a separate tree hit-test cache (the ocean's `lastFrameHitVoiceId` is not populated during loom view because C6 sets `touchedThread = null`).

Then in `main.ts`:
```typescript
document.addEventListener('click', () => {
  const hitId = loomState.lastFrameHitVoiceId
  if (isLoomViewActive()) {
    exitLoomView()
    return
  } else if (hitId) {
    const state = getState()
    // Check if voice has lineage
    const voice = /* find voice in state by hitId */
    if (voice && (voice.weave_from || voice.weave_count > 0)) {
      enterLoomView(hitId)
    }
  }
})
```

### C9. Keyboard handler

```typescript
// In src/main.ts and app/src/mcp-app.ts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isLoomViewActive()) exitLoomView()
})
```

### C10. Ext-app auto-trigger

In `app/src/mcp-app.ts`, in the ontoolresult handler for weave (after the existing resonance call around line 377), AND in the boot-buffer drain path:

```typescript
// Normal path (post-poll):
if (weaveSourceId && findVoice(weaveSourceId)) {
  enterLoomView(weaveSourceId, 12_000)
}

// Boot-buffer drain path (after initLoom, around line 499):
// Same logic for any buffered weave results
```

### C11. Loom indicator on woven voices

In `render/thread.ts`, when rendering in the dive lens (`diveT > 0.5`), check `thread.wovenVoiceUids`:

```typescript
const baseUid = hlVoiceCount > 0 ? line.lineVoiceAnchorUid % hlVoiceCount : line.lineVoiceAnchorUid
if (thread.wovenVoiceUids.has(baseUid) && line.diveT > 0.5) {
  // Draw subtle indicator — a small mark at low opacity near the voice text
  // Exact glyph TBD during implementation. Must be invisible at texture scale.
}
```

Design constraint: the loom view entry requirement (dive lens active, `prox > 0.3`) is intentional. Users must first touch a woven voice to read it, then click the indicator. This preserves the "discovery through presence" principle from the vision.

### Verification

- [ ] Loom view builds correct tree from weave_from links
- [ ] Center-seed layout: ancestors above, descendants below, siblings horizontal
- [ ] Transition animation smooth (~330ms), touch suppressed during transition
- [ ] Connection lines with family-color gradients
- [ ] Click-to-enter works in dive lens on woven voices (via hit-test cache)
- [ ] Escape exits loom view
- [ ] Ext-app auto-enters on weave (normal + boot-buffer paths), auto-exits 12s
- [ ] Both renderers support manual entry
- [ ] Loom indicator visible at dive scale, invisible at texture scale
- [ ] Ocean threads fade during transition
- [ ] `resetLoomState()` cleans up all new fields including timer
- [ ] LoomTree/LoomNode types in types.ts (no circular imports)
- [ ] New exports from loom barrel index.ts
- [ ] No changes to worker/src/ or D1

---

## Part D — Strudel Sound

Replace the 4-oscillator drone with Strudel-powered sound. Uses `@strudel/web@1.3.0` for headless pattern evaluation. Upgrade path to `@strudel/repl` (with visible editor) available for future phases.

### D1. Package choice and CDN loading

**`@strudel/web@1.3.0`** (1.55 MB unpacked) — the headless browser bundle. NOT `@strudel/repl` (5.17 MB, includes CodeMirror editor UI). The `evaluate()` API is identical in both — switching to `@strudel/repl` later is additive (add `<strudel-editor>`, gain visual editor), not a rewrite.

```typescript
// src/audio/strudel-loader.ts (NEW file, ~60 lines)

const STRUDEL_CDN = 'https://unpkg.com/@strudel/web@1.3.0'

let initPromise: Promise<void> | null = null
let initSucceeded = false

export async function loadAndInitStrudel(): Promise<void> {
  if (initSucceeded) return                  // Already done
  if (initPromise) return initPromise        // In-flight — deduplicate (both callers await same promise)

  initPromise = (async () => {
    try {
      // Load @strudel/web (includes core, mini, tonal, transpiler, webaudio + superdough)
      await loadScript(STRUDEL_CDN)

      const { initStrudel } = (window as any)
      if (!initStrudel) throw new Error('Strudel not loaded')

      // initStrudel handles initAudioOnFirstClick internally.
      // @strudel/web's defaultPrebake calls registerSynthSounds(), which provides:
      //   sine/saw/triangle/square/supersaw/pulse/pink/white/brown/crackle
      // For dirt-samples (percussion, texture), load via samples() in prebake:
      await initStrudel({
        prebake: async () => {
          const { samples } = (window as any)
          if (samples) await samples('github:tidalcycles/dirt-samples')
        },
      })
      initSucceeded = true
    } catch (e) {
      initPromise = null  // Allow retry on next call (only after settled rejection)
      throw e             // Re-throw so callers can catch
    }
  })()

  return initPromise
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Script load failed: ${src}`))
    document.head.appendChild(script)
  })
}

export function isStrudelReady(): boolean { return initSucceeded }
```

### D2. Pattern library with per-family voices

```typescript
// src/audio/patterns.ts (NEW file, ~140 lines)

export interface PatternParams {
  familyGains: Record<string, number>  // 0-1 per family, from warmth map
}

// All synths are superdough built-ins (registered by @strudel/web's defaultPrebake).
// NO @strudel/soundfonts dependency. GM instrument names (gm_pad_warm, etc.) are NOT available.
const FAMILY_NOTES: Record<string, string> = {
  attention: 'c4', silence: 'c1', space: 'g3',
  ephemeral: 'c5', memory: 'c2', light: 'c6',
}
const FAMILY_SYNTHS: Record<string, string> = {
  attention: 'supersaw',  // warm pad (detuned unison)
  silence: 'sawtooth',    // cello-like (filtered saw + vibrato)
  space: 'triangle',      // airy, open
  ephemeral: 'sine',      // flute-like (sine + breathy noise)
  memory: 'triangle',     // bass (filtered low triangle)
  light: 'sine',          // pure shimmer
}
const FAMILY_PARAMS: Record<string, string> = {
  attention: '.unison(5).spread(0.3).cutoff(900).resonance(3)',
  silence: '.cutoff(1500).resonance(3).vib(5).vibmod(10)',
  space: '.fmi(1.5).fmh(3).cutoff(2000)',
  ephemeral: '.noise(0.06).hcutoff(500)',
  memory: '.cutoff(300)',
  light: '.fmi(2).fmh(5.01)',
}

export function basePattern(params: PatternParams): string {
  // Build per-family stack entries with warmth-driven gains
  const familyVoices = Object.entries(FAMILY_NOTES).map(([fam, note]) => {
    const gain = (params.familyGains[fam] ?? 0.1) * 0.3  // scale warmth to audio gain
    const synth = FAMILY_SYNTHS[fam] ?? 'sine'
    const extra = FAMILY_PARAMS[fam] ?? ''
    return `  note("${note}").s("${synth}")${extra}.gain(${gain.toFixed(3)}).attack(1.5).release(2.5).room(0.7)`
  }).join(',\n')

  return `setcps(0.375)\nstack(\n  note("c2").s("sine").gain(0.2).attack(2).release(3).room(0.85).roomsize(8).lpf(perlin.range(120, 280).slow(12)),\n${familyVoices}\n)`
}

export function weavePattern(): string {
  // FM bell shimmer — sine with harmonic FM for metallic quality
  return `setcps(0.5)\nstack(\n  note("c5 e5 g5 c6").s("sine").fmi(3).fmh(2).attack(0.01).decay(0.3).sustain(0).gain(0.12).room(0.5).delay(0.15).delaytime(0.125).delayfeedback(0.3)\n)`
}

export function emergencePattern(): string {
  // Rising swell — sine with modulated filter
  return `setcps(0.375)\nstack(\n  note("c3").s("sine").gain(sine.range(0.05, 0.2).slow(2)).attack(1).release(2).lpf(sine.range(150, 600).slow(3)).room(0.7)\n)`
}

export function loomPattern(params: PatternParams): string {
  // Structural, spatial — supersaw pad with heavy reverb + delay
  return `setcps(0.25)\nstack(\n  note("c2 g2").s("sine").gain(0.15).attack(2).release(4).room(0.9).roomsize(9).delay(0.3).delaytime(0.25).delayfeedback(0.5),\n  note("e4").s("supersaw").unison(3).spread(0.2).degradeBy(0.7).gain(0.1).attack(2).release(3).room(0.85).cutoff(1200)\n)`
}
```

**Per-family voices are wired** in `basePattern()` — each of the 6 families has its own voice with warmth-driven gain. Pattern will be composed and refined using Music Studio MCP in the polish phase.

### D3. Sound controller

```typescript
// src/audio/controller.ts (NEW file, ~120 lines)

import type { OceanEvent } from '../events'
import { onOceanEvent } from '../events'
import { loadAndInitStrudel, isStrudelReady } from './strudel-loader'
import { basePattern, weavePattern, emergencePattern, loomPattern, type PatternParams } from './patterns'

export { isStrudelReady }  // re-export so main.ts imports from one place

let soundEnabled = false  // default OFF for new visitors
let currentPatternName: string = 'base'
let lastWarmth: Record<string, number> = {}
let eventSubscribed = false  // guard: subscribe only once

// Debounce state for batched events (A4)
let pendingWeaves = 0
let pendingEmergences = 0
let debounceTimeout: ReturnType<typeof setTimeout> | null = null

// Returns true if init succeeded, false on failure (silent fallback).
// Callers check the return value before updating UI state.
export async function initStrudelSound(): Promise<boolean> {
  try {
    await loadAndInitStrudel()
  } catch (e) {
    console.error('Strudel init failed (silent fallback):', e)
    return false  // CDN failure → silent, no error to user
  }

  soundEnabled = true
  localStorage.setItem('vellum-sound', 'on')

  // Start base pattern
  evaluatePattern(basePattern(currentParams()))

  // Subscribe to events (only once — guard prevents duplicate handlers on retry)
  if (!eventSubscribed) {
    onOceanEvent(handleOceanEvent)
    eventSubscribed = true
  }
  return true
}

function evaluatePattern(code: string): void {
  if (!soundEnabled) return
  try {
    const { evaluate } = (window as any)
    if (evaluate) evaluate(code, true)
  } catch (e) {
    console.error('Pattern evaluation failed:', e)
  }
}

function stopSound(): void {
  try {
    const { hush } = (window as any)
    if (hush) hush()
  } catch { /* silent */ }
}

function currentParams(): PatternParams {
  return { familyGains: lastWarmth }
}

function handleOceanEvent(event: OceanEvent): void {
  if (event.type === 'weave') {
    pendingWeaves++
    if (!debounceTimeout) debounceTimeout = setTimeout(flushBatchedEvents, 100)
    return
  }
  if (event.type === 'emergence') {
    pendingEmergences++
    if (!debounceTimeout) debounceTimeout = setTimeout(flushBatchedEvents, 100)
    return
  }
  handleImmediateEvent(event)
}

function flushBatchedEvents(): void {
  debounceTimeout = null
  const returnPattern = currentPatternName === 'loom' ? loomPattern(currentParams()) : basePattern(currentParams())
  if (pendingWeaves > 0) {
    // Weave shimmer takes priority (it's the creative act)
    evaluatePattern(weavePattern())
    setTimeout(() => evaluatePattern(returnPattern), 3000)
  } else if (pendingEmergences > 0) {
    // Emergence rise (only if no weaves in this batch — weave subsumes emergence)
    evaluatePattern(emergencePattern())
    setTimeout(() => evaluatePattern(returnPattern), 4000)
  }
  pendingWeaves = 0
  pendingEmergences = 0
}

function handleImmediateEvent(event: OceanEvent): void {
  switch (event.type) {
    case 'loom-enter':
      currentPatternName = 'loom'
      evaluatePattern(loomPattern(currentParams()))
      break
    case 'loom-exit':
      currentPatternName = 'base'
      evaluatePattern(basePattern(currentParams()))
      break
    case 'warmth-update':
      lastWarmth = event.familyWarmth
      // Re-evaluate current pattern with fresh warmth
      if (currentPatternName === 'base') evaluatePattern(basePattern(currentParams()))
      break
  }
}

// Per-frame modulation via Superdough's master gain
export function modulateSound(proximity: number, immersion: number): void {
  if (!soundEnabled) return
  try {
    const ac: AudioContext | undefined = (window as any).getAudioContext?.()
    const controller = (window as any).getSuperdoughAudioController?.()
    const masterGain: GainNode | undefined = controller?.output?.destinationGain
    if (!ac || !masterGain) return

    const targetGain = 0.02 + proximity * 0.025 + immersion * 0.02
    masterGain.gain.setTargetAtTime(targetGain, ac.currentTime, 0.1)
  } catch { /* silent */ }
}

// Toggle (called from sound button)
export function toggleStrudelSound(): boolean {
  if (soundEnabled) {
    stopSound()
    soundEnabled = false
    localStorage.setItem('vellum-sound', 'off')
  } else {
    soundEnabled = true
    localStorage.setItem('vellum-sound', 'on')
    evaluatePattern(basePattern(currentParams()))
  }
  return soundEnabled
}
```

**Key changes from v1**: uses `evaluate()` and `hush()` globals from `@strudel/web` (not editor.evaluate). Volume via `controller.output.destinationGain` (documented Superdough master output). Sound default OFF with localStorage persistence.

### D4. Integration in main.ts

```typescript
// Remove: AC, soundOn, droneGain, droneFilter, FAMILY_FREQ, initSound
// Remove: sound modulation block in render()
// Keep: sound toggle button, first-gesture handler structure

import { initStrudelSound, modulateSound, toggleStrudelSound, isStrudelReady } from './audio/controller'
// isStrudelReady is re-exported by controller.ts from strudel-loader.ts

// Check localStorage for returning visitors
const savedSoundPref = localStorage.getItem('vellum-sound')

// First-gesture handler (replace existing startDefaultSound):
// Only auto-inits for returning visitors who previously enabled sound.
// Does NOT toggle — just loads. The toggle button is the explicit control.
async function startDefaultSound(e: Event) {
  if ((e.target as HTMLElement)?.id === 'sn') return
  if (savedSoundPref === 'on') {
    await initStrudelSound()  // returns false on failure (silent fallback built-in)
  }
  document.removeEventListener('click', startDefaultSound)
  document.removeEventListener('touchstart', startDefaultSound)
}

// Sound toggle button:
// First click: inits Strudel (which sets soundEnabled=true and starts playing).
// Subsequent clicks: toggle on/off. No double-flip because init and toggle
// are separate code paths — init is only called when !isStrudelReady().
document.getElementById('sn')!.addEventListener('click', async () => {
  if (!isStrudelReady()) {
    // First activation: init loads Strudel and starts the base pattern.
    // initStrudelSound returns false on failure — don't update UI if it failed.
    const ok = await initStrudelSound()
    if (!ok) return  // Init failed (CDN blocked, etc.) — button stays in "off" state
    // Update UI to reflect sound-on state (init already set soundEnabled=true)
    const el = document.getElementById('sn')!
    el.textContent = 'sound \u00b7'; el.style.opacity = '.7'
    return  // Do NOT fall through to toggleStrudelSound
  }
  // Subsequent clicks: toggle
  const on = toggleStrudelSound()
  const el = document.getElementById('sn')!
  el.textContent = on ? 'sound \u00b7' : 'sound'
  el.style.opacity = on ? '.7' : '.3'
})

// In render():
modulateSound(st.proximity, st.immersion)

// Tab visibility (replace existing AC.resume logic):
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    try {
      const ac = (window as any).getAudioContext?.()
      if (ac?.state === 'suspended') ac.resume()
    } catch { /* silent */ }
  }
})
```

### D5. Ext-app: sound enabled

Both renderers initialize Strudel sound. The ext-app (`app/src/mcp-app.ts`) imports the same `src/audio/controller.ts` and follows the same initialization pattern:

- First-gesture handler (touch/click inside the iframe triggers `initStrudelSound()`)
- `modulateSound()` called per-frame in the ext-app render loop
- Events (weave, emergence, loom enter/exit) fire naturally from the shared event system
- localStorage sound preference is shared if standalone and iframe are same-origin

**Iframe audio policy**: some MCP client hosts may restrict iframe audio. The graceful fallback (CDN failure → silent) covers this. If `AudioContext` creation fails or is blocked, the ext-app continues without sound.

**Vite build impact**: `src/audio/controller.ts` and `src/audio/patterns.ts` are inlined into the single-file HTML bundle. Strudel itself loads at runtime from CDN (not bundled). The `__VELLUM_BASE_URL__` sentinel rewrite is unaffected — audio uses CDN URLs, not relative paths.

### D6. Deferred composable platform elements

The following are NOT in Phase 10 scope but the architecture supports them:
- **Per-slot parameter customization** (filter cutoffs, tempos per pattern) — add to `PatternParams`
- **External pattern injection** (patterns from KV/D1) — evaluate any code string via `evaluate()`
- **AI-composed patterns** (MCP tool for pattern authoring) — future worker tool + stored patterns
- **Visible editor** (swap `@strudel/web` for `@strudel/repl`, add `<strudel-editor>`) — additive upgrade

### Verification

- [ ] `@strudel/web@1.3.0` loads from CDN
- [ ] Built-in synths (supersaw, sawtooth, sine, triangle) produce audible ambient sound
- [ ] Dirt-samples load via `samples('github:tidalcycles/dirt-samples')` in prebake
- [ ] Base pattern plays after first click (only if localStorage says 'on')
- [ ] Sound defaults OFF for new visitors
- [ ] Sound preference persists in localStorage
- [ ] Weave events trigger shimmer (debounced for batches), returns to base
- [ ] Loom-enter shifts to loom pattern, loom-exit returns to base
- [ ] `destinationGain` responds to proximity/immersion per-frame
- [ ] Sound toggle mutes/unmutes via `hush()` / `evaluate()`
- [ ] Tab visibility pause/resume works
- [ ] CDN failure → silent fallback, no error to user
- [ ] Ext-app iframe sound works on first touch/click inside iframe
- [ ] Ext-app gracefully silent if iframe audio policy blocks
- [ ] No hidden DOM elements (no `<strudel-editor>`, just script tags)

---

## File change map

### New files
| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/events.ts` | ~50 | Ocean event pub/sub (leaf module) |
| `src/loom/loom-view.ts` | ~300 | Loom tree computation + entry/exit + layout + tree renderer |
| `src/audio/strudel-loader.ts` | ~60 | CDN load + Strudel init (built-in synths + dirt-samples) |
| `src/audio/patterns.ts` | ~140 | Pattern library (4 slots, per-family voices) |
| `src/audio/controller.ts` | ~120 | Sound controller + event debouncing + per-frame modulation |
| `src/audio/strudel.d.ts` | ~20 | Ambient type declarations for Strudel window globals |

### Modified files
| File | Changes |
|------|---------|
| `src/loom/types.ts` | `ResonanceEntry` uses `voiceId` (canonical), `Thread` gains `resonatingVoiceUids` + `wovenVoiceUids`, add `LoomNode` + `LoomTree` types |
| `src/loom/state.ts` | Add loom view state fields + `lastFrameHitVoiceId`, update `resetLoomState()` |
| `src/loom/resonance.ts` | Per-voice targeting with canonical voiceId, per-frame UID resolution |
| `src/loom/thread.ts` | Init `resonatingVoiceUids` + `wovenVoiceUids` in `makeThread()` |
| `src/loom/init.ts` | Populate `wovenVoiceUids` from state during init |
| `src/loom/render/frame.ts` | Transition animation in `advanceLoom`, touch suppression, loom tree render call + ocean alpha scaling in `paintLoom` |
| `src/loom/render/thread.ts` | Per-voice resonance glow (no modulo), loom indicator on woven voices, hit-test voiceId caching |
| `src/loom/index.ts` | Export `enterLoomView`, `exitLoomView`, `isLoomViewActive` |
| `src/runtime/poll-core.ts` | Add `emitEvent?` param to `applyResonanceFromNewVoices` |
| `src/main.ts` | Replace sound with Strudel, add click + keyboard handlers, pass `emitEvent` to poll/refresh, localStorage sound preference |
| `app/src/mcp-app.ts` | Auto-enter loom view on weave (normal + boot-buffer), keyboard handler, pass `emitEvent`, import + init Strudel sound, add `modulateSound()` to render loop |
| `tests/loom/resonance.test.ts` | Update ResonanceEntry construction + warmth/arrivalGlow expectations |
| `tests/loom/thread.test.ts` | Update `makeThread()` shape assertions for new fields (`resonatingVoiceUids`, `wovenVoiceUids`) |
| `tests/loom/state.test.ts` | Update `resetLoomState()` assertions for new loom view fields |
| `docs/LOOM_INVARIANTS.md` | Update "17-module" → "19-module" (loom-view.ts added) |

### Untouched
- `worker/src/**` — zero worker changes
- `src/runtime/input.ts` — stays DI-only, no click handler added here
- `src/content.ts` — types unchanged
- D1 migrations — no schema changes

---

## Execution phases

### Phase A: Foundation (event system + per-voice resonance)
- `src/events.ts` (new)
- B1-B7: Per-voice resonance with canonical voiceId
- Tests: resonance targeting, regrouping survival, event emission via DI
- Deploy gate: `bun run verify` clean

### Phase B: Loom view
- C1-C11: All loom view work
- Tests: tree building, layout, transition, click hit-test, state reset
- Deploy gate: `bun run verify` clean, manual visual check

### Phase C: Strudel sound
- D1-D6: All Strudel work
- Tests: manual audio check (no automated audio tests)
- Deploy gate: `bun run verify` clean, sound plays on click, events trigger patterns

### Phase D: Integration + polish
- End-to-end: weave → resonance → loom view → sound
- Visual polish: loom indicator glyph, transition easing, connection lines
- Sound polish: pattern tuning with Music Studio MCP
- Deploy + smoke

---

## Hard invariants

1. `bun run verify` passes at every phase boundary
2. Zero changes to `worker/src/**`
3. Zero D1 migrations
4. Bundle size increase < 5 KB (renderer only — Strudel loads from CDN, but loom-view + audio controller + events add ~700 lines of source)
5. Loom tests pass (some updated for resonance changes)
6. 20 worker tests pass (untouched)
7. **Sound defaults to OFF** for new visitors. Persists in localStorage.
8. Strudel CDN failure → silent fallback, no error to user
9. Loom view with < 2 nodes in tree → no-op
10. Ext-app auto-exit loom view after 12 seconds
11. No hidden DOM elements from Strudel (`@strudel/web` is headless)
12. `src/loom/` modules remain the shared renderer — both entry points use them
13. Resonance uses canonical `voiceId`, resolved to flat UID per frame (LOOM_INVARIANTS compliant)
14. Event emission from `runtime/` uses DI (injected callbacks, no direct imports from `events.ts`)
15. LOOM_INVARIANTS updated: module count 17 → 19 (LOOM_INVARIANTS currently says 17; reality is 18 files; adding loom-view.ts makes 19. Update the invariant doc as a pre-requisite.)

---

## Verification contract

| # | Check | Expected |
|---|-------|----------|
| 1 | `bun run verify` | Clean |
| 2 | `bun test tests/loom/` | All pass (updated resonance tests) |
| 3 | `cd worker && bun test tests/` | 20 pass |
| 4 | `bunx tsc --noEmit` | Clean (root + worker + app) |
| 5 | Renderer bundle size | < 76000 bytes |
| 6 | Worker upload size | Unchanged (~387 KiB) |
| 7 | Weave event → source voice glows (not whole thread) | Visual confirm |
| 8 | Emergence → thread glows (unchanged behavior) | Visual confirm |
| 9 | Resonance survives viewport resize (canonical ID) | Visual confirm |
| 10 | Click woven voice in dive lens → loom view | Visual confirm |
| 11 | Escape → exit loom view | Visual confirm |
| 12 | Ext-app weave → auto loom view → auto exit 12s | Visual confirm |
| 13 | Sound OFF by default for new visitor | Audio confirm |
| 14 | Sound ON after toggle, persists on reload | Audio confirm |
| 15 | Weave → shimmer sound (debounced for batches) | Audio confirm |
| 16 | Loom enter → sound shifts | Audio confirm |
| 17 | Ext-app sound plays on touch inside iframe | Audio confirm |
| 18 | Strudel CDN blocked → no error, silent | Network confirm |
| 19 | `git diff --stat main -- worker/src/` | Empty |
| 20 | Emergence → sound rise (when no weaves in batch) | Audio confirm |
| 21 | Warmth-update → base pattern re-evaluates with new gains | Audio confirm |
| 22 | Loom-view click outside tree → exit | Visual confirm |
| 23 | Ext-app boot-buffer drain → auto-enter loom for buffered weaves | Visual confirm |
| 24 | Strudel init failure → retry succeeds on next sound button click | Audio confirm |
| 25 | Rapid double-click on sound button → no duplicate init | Console confirm |

---

## Review changelog (v1 → v2 → v3 → v4 → v5)

### v4 → v5 fixes (Codex round 4 validation)

| # | Issue | Source | Fix applied |
|---|-------|--------|-------------|
| 57 | C1 `LoomNode` missing cached Pretext/layout fields referenced by C7 | Codex r4 | C1: added `prepared`, `layoutW`, `layoutH` fields to `LoomNode` |
| 58 | A2 warmth-update paragraph breaks Markdown table (rows after it don't render as table) | Codex r4 | A2: moved paragraph below table, fixed `apiWarmth` → `warmth` wording |
| 59 | Changelog title says `v1 → v2 → v3`, missing v4 | Codex r4 | Updated to `v1 → v2 → v3 → v4 → v5` |
| 60 | Changelog item 44 says `initDone` instead of `initPromise` | Codex r4 | Fixed variable name |

### v3 → v4 fixes (Codex round 3 + internal consistency check)

| # | Issue | Source | Fix applied |
|---|-------|--------|-------------|
| 43 | GM instrument names (gm_pad_warm, gm_cello, etc.) don't exist in @strudel/web — only in @strudel/soundfonts which was removed | Codex r3 | D2: FAMILY_SYNTHS replaced with superdough built-ins (supersaw, sawtooth, sine, triangle) + per-family params |
| 44 | Init state machine race: rapid double-click starts duplicate inits | Codex r3 | D1: return existing in-flight `initPromise`; only reset after settled rejection |
| 45 | initStrudelSound swallows errors but D4 assumes it throws | Codex r3 | D3: returns Promise\<boolean\>, D4 checks return value |
| 46 | isStrudelReady not re-exported from controller.ts | Codex r3 | D3: explicit re-export from controller.ts |
| 47 | Duplicate event subscription on re-init/retry | Codex r3 | D3: eventSubscribed guard flag |
| 48 | Stale "GM soundfonts load via @strudel/soundfonts" in verification | Codex r3 + Internal | D verification: replaced with built-in synth + dirt-samples checks |
| 49 | Verification contract missing 6 user-visible behaviors | Codex r3 | Added rows 20-25 (emergence sound, warmth modulation, loom click-outside, boot-buffer auto-enter, init retry, rapid clicks) |
| 50 | C7 tree text layout: prepareWithSegments per frame wasteful | Codex r3 | C7: text prepared once at tree build, cached on LoomNode |
| 51 | C8 loom-view click: no tree hit-test, ambiguous wording | Codex r3 | C8: any click exits in Phase 10, tree click deferred to future phase |
| 52 | Vision "master gain + filter" but D3 only has gain | Codex r3 | VISION.md: filter noted as Phase 10 deferral |
| 53 | File map missing test file updates | Codex r3 + Internal | File map: added thread.test.ts, state.test.ts, LOOM_INVARIANTS.md |
| 54 | LOOM_INVARIANTS says 17 modules, reality is 18 | Internal | Invariant 15: corrected to 17 → 19 with doc update note |
| 55 | B3 removes arrivalGlow from resonance implicitly | Internal | B3: explicit note that arrivalGlow is now emergence-only |
| 56 | C11 lineVoiceAnchorUid needs % hlVoiceCount for high repeat counts | Internal | C11: added modulo conversion before wovenVoiceUids lookup |

### v2 → v3 fixes (Codex round 2 + internal feasibility check)

| # | Issue | Source | Fix applied |
|---|-------|--------|-------------|
| 31 | @strudel/soundfonts is ESM, classic script load fails | Codex r2 | D1: use samples('github:...') in prebake instead of separate CDN load |
| 32 | Sound button first-click double-flip (init + toggle) | Codex r2 | D4: separate init path (return early) from toggle path |
| 33 | D4 uses isStrudelReady() without importing | Codex r2 | D4: added to import line |
| 34 | Loom auto-enter dual ownership (A3 + C10) | Codex r2 | A3: removed loom from subscriber table, C10 is single owner |
| 35 | Emergence sound lost in debounce | Codex r2 | D3: separate pendingWeaves + pendingEmergences tracking |
| 36 | GM instrument names wrong (gm_pad_2_warm) | Codex r2 | D2: corrected to gm_pad_warm, gm_pad_new_age |
| 37 | isStrudelReady() true after failed init | Codex r2 | D1: separate initSucceeded flag, reset initDone on rejection |
| 38 | Bundle size cap < 73000 unrealistic | Codex r2 | Raised to < 76000, invariant < 5 KB delta |
| 39 | lastFrameHitVoiceId missing from resetLoomState | Codex r2 | C4: added to reset block |
| 40 | Hit-test cache clearing per-thread overwrites | Codex r2 | C8: clear once in paintLoom before loop, set from primary only |
| 41 | OceanEvent type needed in poll-core | Codex r2 | A2: type-only import noted as acceptable (zero runtime) |
| 42 | Ext-app sound (was "no sound") | User requirement | D5: both renderers init Strudel, iframe graceful fallback |

### v1 → v2 fixes (three independent reviews)

| # | Issue | Source | Fix applied |
|---|-------|--------|-------------|
| 1 | Strudel: wrong package (@strudel/repl → @strudel/web) | All 3 reviewers | D1 rewritten for @strudel/web@1.3.0 headless API |
| 2 | Strudel: editor.evaluate() needs DOM element | All 3 reviewers | Uses global evaluate()/hush() from @strudel/web |
| 3 | Strudel: AudioContext timing | Feasibility | initAudioOnFirstClick handled by initStrudel; gesture handler wraps init |
| 4 | Strudel: audio graph interception fragile | Feasibility | Uses destinationGain directly (documented Superdough master output) |
| 5 | Sound default ON → OFF | Vision reviewer + Backlog | D3/D4: default off, localStorage persistence |
| 6 | voiceUid is projection identity, not canonical | Codex | B1-B3: store voiceId, resolve per-frame |
| 7 | Cross-thread voiceUid collision | Codex | Eliminated by using canonical voiceId |
| 8 | % hlVoiceCount modulo bug | Vision reviewer | B5: direct lookup, no modulo |
| 9 | Double-fire (event + DI) | Codex | A3: resonance removed from event subscribers |
| 10 | Event emission breaks DI | Vision + Feasibility | A2: injected callbacks, not imports |
| 11 | loom-view.ts violates module count | Vision reviewer | Invariant 15: explicit update |
| 12 | Sound event batching | Codex | A4: 100ms debounce window |
| 13 | Click handler can't go in input.ts | All 3 reviewers | C8: moved to entry points with hit-test cache |
| 14 | wovenVoiceUids needed on Thread | Feasibility | B4: added, populated in initLoom |
| 15 | Gate touch during loom view | Feasibility | C6: touchedThread = null when active |
| 16 | enterLoomView: clear pre-existing timeout | Vision reviewer | C5: always clear first |
| 17 | Alpha clamp | Feasibility | B5: Math.min(1, ...) |
| 18 | Per-family voices not wired | Vision reviewer | D2: basePattern generates per-family stack |
| 19 | Composable platform deferred | Vision + Codex | D6: explicit deferred section |
| 20 | LoomTree type circular import | Codex | C1: types in types.ts |
| 21 | resetLoomState missing fields | Codex | C4: all fields + timer cleanup |
| 22 | GM soundfonts not loaded by default | Strudel research | D1: prebake loads dirt-samples; v4 switched to built-in synths (GM names removed) |
| 23 | Boot-buffer path for ext-app auto-enter | Codex | C10: both paths noted |
| 24 | FAMILY_COLOR not FAMILY_COLORS | Codex | C3: corrected to FAMILY_COLOR |
| 25 | Loom tree text rendering underspecified | Codex | C7: explicitly standalone renderer, not reuse |
| 26 | Emergence event uses family (singular) but threads span merged groups | Feasibility | A1: changed to familyNames (plural) |
| 27 | Strudel CDN failure not silent | Codex | D3/D4: try/catch with silent fallback |
| 28 | Sound toggle contradicts itself | Codex | D4: clean toggle via toggleStrudelSound() |
| 29 | strudel.d.ts for type safety | Feasibility | File change map: new ambient declarations file |
| 30 | resonatingVoiceUids init in makeThread not initLoom | Feasibility + Codex | B4: initialized in makeThread() |
