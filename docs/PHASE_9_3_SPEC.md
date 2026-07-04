# Phase 9.3 Spec — M2 Renderer Runtime Extraction

**Goal**: extract the genuinely-shared runtime glue between `src/main.ts` (standalone) and `app/src/mcp-app.ts` (ext-app) into a new `src/runtime/` directory, so the two entry points keep only their truly divergent concerns (sound + URL-param highlight for standalone; ext-apps SDK + force-voice queue + boot-race buffer for ext-app).

**Non-goal**: consolidate `poll()` itself. The poll orchestration genuinely diverges (simple refresh re-entry vs force-voice queue with bounded retries and fire-dedup), and the failure mode of conflating them would be a regression in the ext-app's emergence pipeline. We share the **parts** of poll that are identical, not the **shape**.

**Scope**: renderer-side only. Worker, tools, cache, schemas, tests under `worker/tests/`, and all existing renderer behavior are OUT OF SCOPE. This is a mechanical move + thin wrapper extraction.

---

## Baseline anchor

Spec anchors to main at `54fe97f` (post-9.2 CLAUDE.md + PATTERNS_AND_GOTCHAS doc sweep). Live production: version `0c7e179b-5108-4a7a-8fdc-97689235abff`.

Before any edits:

```bash
bun run verify                # expect 87 loom + 16 worker, all green
bun run build && wc -c dist/main.js
cd app && bunx vite build && cd ..
wc -l src/main.ts app/src/mcp-app.ts src/content.ts
```

Record those numbers in `docs/PHASE_9_3_CHECKPOINT_A.md` (see Deliverables).

**Hard baseline invariants that MUST still hold after the refactor:**

1. `dist/main.js` byte count does NOT grow by more than +1% (bundle delta tolerance). Shrinking is fine. A growth beyond this tolerance means the runtime extraction accidentally duplicated code instead of deduplicating it.
2. `app/dist/mcp-app.html` still builds cleanly via `bunx vite build` and still contains the `__VELLUM_BASE_URL__` sentinel (F4 behavior preserved).
3. 87 loom tests continue to pass unchanged. NO test file edits. If a test breaks, the refactor is wrong.
4. 16 worker tests continue to pass unchanged (trivially — worker is untouched).
5. `bunx tsc --noEmit` clean at root, worker, and app tsconfig.
6. `src/main.ts` and `app/src/mcp-app.ts` continue to export the same symbols (specifically: `export const mouse: MouseState`).
7. The standalone renderer at `vellum.linxule.com/` still boots with sound, responds to URL `?highlight=`, and reports witness events.
8. The ext-app at `vellum.linxule.com/mcp` → `resources/read` still boots with `connectDomains: [origin]`, still handles `ontoolresult`, still clamps inline/fullscreen heights, still drains `pendingBootArrivals`.

---

## Divergence map (observed in current code)

This is what the refactor must preserve.

### Fully shared (byte-identical or trivially adaptable)

| Concern | main.ts | mcp-app.ts | Notes |
|---|---|---|---|
| `mouse: MouseState` initializer | ✓ | ✓ | Identical |
| Canvas bootstrap (`canvas`, `ctx`, `DPR`) | ✓ | ✓ | Identical |
| Frame-timing refs (`prevNow`, `prevVw`, `prevVh`) | ✓ | ✓ | Identical |
| Timer refs (`frameId`, `frameTimeout`, `pollTimeout`, `touchEndTimeout`, `highlightRetryTimeout`) | ✓ | ✓ | Identical |
| `clearTouchEndTimeout`, `clearScheduledFrame`, `clearPollTimeouts` | ✓ | ✓ | Identical |
| Poll constants (`VISIBLE_POLL_MS`, `VISIBLE_POLL_JITTER_MS`, `RETRY_BASE_MS`, `FETCH_STATE_TIMEOUT_MS`, `HIGHLIGHT_RETRY_DELAYS_MS`) | ✓ | ✓ | Identical |
| `nextVisiblePollDelay` | ✓ | ✓ | Identical |
| Mouse / touch / wheel input handlers | ✓ | ✓ | **Byte-identical** |
| `resize` → `resizeLoom` | ✓ | ✓ | Identical |
| `fetchStateWithTimeout` | ✓ | ✓ | Identical |
| Witness reporter (`dwellStart`, `dwellFamilies`, `onThreadFocus`, `onThreadRelease`, `checkWitness`) | ✓ | ✓ | Near-identical; differs only in `fetch('/api/witness', ...)` vs `fetch(BASE_URL + '/api/witness', ...)` |
| Poll diff logic (compute `newVoiceInfo` from `prevIdSets` + `newIdSets`) | ✓ | ✓ | Byte-identical block — inner loop of poll |
| Resonance detection from `weave_from` on new voices | ✓ | ✓ | Byte-identical block |
| Frame schedule (`scheduleFrame`) | ✓ | ✓ | Identical |
| Mouse velocity / `prevVw`/`prevVh` sync inside `render()` | ✓ | ✓ | Identical |

### Genuinely divergent — DO NOT share

| Concern | main.ts | mcp-app.ts |
|---|---|---|
| Sound (`AC`, `droneGain`, `droneFilter`, `initSound`, `toggleSound`, `FAMILY_FREQ`, `startDefaultSound`, sound button click, sound modulation in `render()`, AC resume on visibilitychange) | YES — load-bearing | NO — ext-app is silent by design |
| URL-param highlight (`const highlightId = new URLSearchParams(...)`) | YES — const, read once at boot | NO — `let currentHighlightId`, mutated by `ontoolresult` |
| `BASE_URL` sentinel (`'__VELLUM_BASE_URL__'` + `setBaseUrl(BASE_URL)`) | NO | YES — F4 per-request origin rewrite |
| Ext-apps SDK (`App`, `app.connect()`, `app.onhostcontextchanged`, `app.ontoolresult`, `app.onerror`, fullscreen button handler) | NO | YES |
| `applyContainerDimensions` (inline/fullscreen clamping) | NO | YES |
| Force-voice queue (`pendingForceVoiceIds`, `forceRetryCount`, `MAX_FORCE_RETRIES`, `unresolvedForceIds`, `firedVoiceIds`, fold-force-into-newVoiceInfo, finally-block retry logic) | NO | YES |
| Boot-race buffer (`bootComplete`, `pendingBootArrivals`, `loomInitialized`) | NO | YES |
| Boot sequence shape | `document.fonts.ready.then(...)` → `fetchStateWithTimeout` → `initLoom` → `scheduleFrame` → `scheduleRegularPoll` | Parallel `initialFetch` + `app.connect()` + `Promise.race([fonts.ready, 2s timeout])` → `initLoom` → flush `pendingBootArrivals` → inIframe branch |

### Parameterization points

Three things need parameterization in the shared runtime to satisfy both callers:

1. **Witness endpoint**: standalone uses relative `/api/witness`, ext-app uses absolute `BASE_URL + '/api/witness'`. Shared witness reporter takes `endpoint: string` in its factory.
2. **Highlight ID source**: standalone reads a `const` from URL params; ext-app mutates a `let` from `ontoolresult`. Shared `scheduleHighlightRetry` must read current highlight through an accessor, not a closed-over constant.
3. **Live-state predicate**: both use `isLive` from `src/content.ts` already — no new parameterization needed, just import from runtime.

---

## Allowlist (strict)

Codex may create or edit ONLY these files. Any edit outside this list is out of scope.

**New files:**
- `src/runtime/input.ts`
- `src/runtime/canvas.ts`
- `src/runtime/witness.ts`
- `src/runtime/poll-core.ts`
- `src/runtime/frame.ts`
- `src/runtime/index.ts` — barrel re-export for clean callers
- `docs/PHASE_9_3_CHECKPOINT_A.md`
- `docs/PHASE_9_3_HANDOFF.md`

**Edited files:**
- `src/main.ts` — reduced to entry-point-specific concerns (sound, URL-param highlight, simple poll, boot)
- `app/src/mcp-app.ts` — reduced to entry-point-specific concerns (ext-apps SDK, force-voice queue, boot-race buffer, boot)

**Do NOT edit:**
- Anything under `src/loom/**`
- `src/content.ts`
- `worker/**`
- `tests/**` or `worker/tests/**`
- `package.json`, `tsconfig.json`, `vite.config.ts`, `wrangler.toml`
- CLAUDE.md, PATTERNS_AND_GOTCHAS.md (those get updated post-land by Claude, not in this phase)

---

## Module contracts

Codex MUST implement these exact signatures. Deviating from the signatures breaks the call-site drop-in pattern.

### `src/runtime/input.ts`

```ts
import type { MouseState } from '../loom.js'

/**
 * Attach mouse, touch, and wheel handlers to document.
 * Returns a disposer. Callers typically don't dispose — entry points live
 * for the document lifetime — but the return value makes the attachment
 * contract explicit.
 *
 * scrollThread is injected so this module doesn't depend on the loom barrel.
 */
export function attachInputHandlers(opts: {
  mouse: MouseState
  scrollThread: (dy: number) => void
  aperture: (vw: number) => { touchPersistence: number }
}): () => void
```

- Copy the mouse/touch/wheel handler block **verbatim** from `src/main.ts` (lines ~122-161) into this function.
- `touchEndTimeout` stays module-scoped inside `input.ts` (private).
- The only behavior change is that `mouse` is now a parameter, not a module-level import.

### `src/runtime/canvas.ts`

```ts
export interface CanvasBundle {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  DPR: number
  syncCanvasSize(vw: number, vh: number): void
}

/**
 * Reads `#c` from DOM, sets up 2D context, returns helpers.
 * `syncCanvasSize` sets width/height + style + DPR transform when vw/vh
 * differ from the last call. Entry points call it each frame.
 */
export function setupCanvas(): CanvasBundle
```

- Move the canvas lookup + DPR clamping block from entry points into this function.
- `syncCanvasSize` owns the `prevVw`/`prevVh` state internally (private).

### `src/runtime/witness.ts`

```ts
export interface WitnessReporter {
  /** Call once per frame. Handles dwell tracking + phantom gating. */
  checkWitness(): void
}

/**
 * Witness reporter. `endpoint` is the full fetch URL (e.g., '/api/witness'
 * for standalone or `${BASE_URL}/api/witness` for ext-app, where BASE_URL
 * is the sentinel-rewritten origin).
 *
 * `getLoomState` and `isPhantomActive` are injected rather than imported
 * so this module doesn't reach across to the loom barrel. `isLiveFn`
 * allows the reporter to skip fetches in fallback mode.
 */
export function createWitnessReporter(opts: {
  endpoint: string
  getLoomState: () => { families: string[]; [k: string]: unknown }
  isPhantomActive: () => boolean
  isLiveFn: () => boolean
}): WitnessReporter
```

- Move `dwellStart`, `dwellFamilies`, `onThreadFocus`, `onThreadRelease`, `checkWitness`, `prevTouchedFamiliesKey`, `prevPhantom` into the closure returned by `createWitnessReporter`.
- The only parameterization is `endpoint` for the fetch URL.

### `src/runtime/poll-core.ts`

```ts
import type { StateResponse } from '../content.js'

export interface NewVoiceInfo {
  hasNew: boolean
  newIds: Set<string>
}

/** Compute emergence diff. Pure function. Used by both entry points. */
export function computeNewVoiceInfo(
  prevIdSets: Set<string>[],
  newIdSets: Set<string>[],
): NewVoiceInfo[]

/**
 * Apply resonance detection: walks new voices in each thread, fires
 * setResonance on any `weave_from` reference. Pure side-effect helper.
 */
export function applyResonanceFromNewVoices(opts: {
  newVoiceInfo: NewVoiceInfo[]
  state: StateResponse
  setResonance: (voiceId: string, now: number) => void
  now: number
}): void

/**
 * Fetch with abort-based timeout. Wraps fetchState from content.ts.
 * Returns null on timeout or abort.
 */
export function fetchStateWithTimeout(opts: {
  fetchState: (opts: { refresh?: boolean; signal?: AbortSignal }) => Promise<StateResponse | null>
  refresh?: boolean
  timeoutMs: number
}): Promise<StateResponse | null>
```

- `computeNewVoiceInfo` is a pure function — move the identical diff block from both entry points into this helper. Entry-point call sites become `const newVoiceInfo = computeNewVoiceInfo(prevIdSets, newIdSets)`.
- `applyResonanceFromNewVoices` moves the identical resonance walk.
- `fetchStateWithTimeout` takes `fetchState` as a param so it stays decoupled from `content.ts` imports (entry points still import `fetchState` and pass it in).

**Critically**: this module does NOT define `poll()`. Each entry point keeps its own `poll()` wrapper — they differ in the force-voice queue and boot-race buffer. The shared pieces are the three helpers above.

### `src/runtime/frame.ts`

```ts
import type { MouseState } from '../loom.js'

/** Update mouse velocity + moving state in-place. Called once per frame. */
export function updateMouseVelocity(mouse: MouseState, now: number): void

/**
 * requestAnimationFrame when visible, setTimeout(100ms) when hidden.
 * Returns a handle that the caller can clear via `clearScheduledFrame`.
 */
export function scheduleNextFrame(
  renderFn: (now: number) => void,
): {
  frameId: number | null
  frameTimeout: ReturnType<typeof setTimeout> | null
}

export function clearScheduledFrame(handle: {
  frameId: number | null
  frameTimeout: ReturnType<typeof setTimeout> | null
}): void
```

- Keep the scheduling module-agnostic: caller owns the handle state (can't make it module-level because there are two callers potentially running side-by-side in tests).
- `updateMouseVelocity` holds no module state.

### `src/runtime/index.ts`

Barrel re-export:

```ts
export { attachInputHandlers } from './input'
export { setupCanvas, type CanvasBundle } from './canvas'
export { createWitnessReporter, type WitnessReporter } from './witness'
export {
  computeNewVoiceInfo,
  applyResonanceFromNewVoices,
  fetchStateWithTimeout,
  type NewVoiceInfo,
} from './poll-core'
export { updateMouseVelocity, scheduleNextFrame, clearScheduledFrame } from './frame'
```

---

## Hard rules for Codex

1. **No test edits.** If a test fails, the refactor is wrong. Never edit a test to make it pass.
2. **No loom module edits.** `src/loom/**` is off-limits. If you find yourself wanting to edit a loom module to make runtime extraction work, stop and document the blocker instead.
3. **No worker edits.** Worker is untouched by this phase.
4. **Bundle byte tolerance**: `dist/main.js` may grow at most +1%. If it grows more, the extraction duplicated code somewhere.
5. **Behavior frozen**: sound must still work in standalone, force-voice queue must still work in ext-app, `ontoolresult` must still drain `pendingBootArrivals`, witness reporting must still fire on thread release, highlight must still work both via URL param (standalone) and via `ontoolresult` (ext-app).
6. **Import boundaries**: runtime modules may import from `../loom.js` (for `MouseState` type and `aperture`/`getLoomState`/etc as injected callbacks) and `../content.js` (for `StateResponse` type). They must NOT import from `../../worker/**` or `../../app/**`.
7. **Do NOT consolidate the poll() orchestration.** Each entry point keeps its own `poll()` wrapper. They call shared helpers for diff, resonance, and fetch, but the force-voice / boot-buffer / retry orchestration stays in `app/src/mcp-app.ts`, and the simple refresh-only orchestration stays in `src/main.ts`.
8. **Stop before commit.** Do not run `git commit`, `git push`, or `bun run deploy`. Checkpoint and handoff only. Claude handles the land + deploy.

---

## Phases

Codex should implement in this order, checkpointing after each phase:

### Phase A — `src/runtime/input.ts`

- Create the file with `attachInputHandlers`.
- In `src/main.ts`: delete the original input handler block, import and call `attachInputHandlers({ mouse, scrollThread, aperture })`.
- In `app/src/mcp-app.ts`: same replacement.
- Verify: `bun run verify` clean, bundle size unchanged or slightly smaller.

### Phase B — `src/runtime/canvas.ts`

- Create the file with `setupCanvas`.
- Replace the canvas-bootstrap block in both entry points with `const { canvas, ctx, DPR, syncCanvasSize } = setupCanvas()`.
- Inside each `render()`, replace the prevVw/prevVh sync block with `syncCanvasSize(vw, vh)`.
- Verify.

### Phase C — `src/runtime/witness.ts`

- Create the file with `createWitnessReporter`.
- In `src/main.ts`: instantiate with `endpoint: '/api/witness'`. Replace all witness state + helpers with the reporter's `checkWitness`.
- In `app/src/mcp-app.ts`: instantiate with `endpoint: \`${BASE_URL}/api/witness\``. Same replacement.
- Verify.

### Phase D — `src/runtime/poll-core.ts`

- Create the file with `computeNewVoiceInfo`, `applyResonanceFromNewVoices`, `fetchStateWithTimeout`.
- In each entry point, replace the diff block inside `poll()` with `const newVoiceInfo = computeNewVoiceInfo(prevIdSets, newIdSets)`.
- Replace the resonance walk with `applyResonanceFromNewVoices({ newVoiceInfo, state, setResonance, now: performance.now() })`.
- Replace the local `fetchStateWithTimeout` definition with a call to the runtime helper.
- **Critical**: `app/src/mcp-app.ts`'s poll keeps the force-voice queue logic INTACT. The force-fold step runs AFTER `computeNewVoiceInfo` but modifies its result before the resonance walk, just like today. Do NOT move force-queue code into runtime/.
- Verify. This is the highest-risk phase — pay close attention to the ext-app's force-voice flow.

### Phase E — `src/runtime/frame.ts`

- Create the file with `updateMouseVelocity`, `scheduleNextFrame`, `clearScheduledFrame`.
- Replace the inline mouse-velocity block at the top of each `render()` with `updateMouseVelocity(mouse, now)`.
- Replace `scheduleFrame` + `clearScheduledFrame` with calls to the runtime helpers. Each entry point maintains its own handle state (frameId + frameTimeout are per-caller).
- Verify.

### Phase F — `src/runtime/index.ts` barrel + import cleanup

- Create the barrel file.
- Optionally consolidate runtime imports in both entry points to a single `import { ... } from './runtime'` (or `'../../src/runtime'` from the app side).
- Verify once more.

### Phase G — Docs

- Write `docs/PHASE_9_3_CHECKPOINT_A.md` (baseline state captured at the start).
- Write `docs/PHASE_9_3_HANDOFF.md` with the standard template: what changed, verification table, suggested commit structure, flags for human review, open items.
- Stop. Do not commit.

---

## Verification contract

At the end of Phase G, the following MUST all be true. The handoff MUST include this table with actual measured values.

| Check | Command | Expected |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87 pass, 0 fail` |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `16 pass, 0 fail` |
| Verify script | `bun run verify` | clean end-to-end |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle delta | `bun run build && wc -c dist/main.js` | baseline ± 1% (~69221..70601 bytes) |
| Ext-app build | `cd app && bunx vite build && cd ..` | clean; sentinel preserved |
| Runtime module count | `ls src/runtime` | `canvas.ts hmac.ts input.ts …` — wait, no hmac; should be: `canvas.ts frame.ts index.ts input.ts poll-core.ts witness.ts` (6 files) |
| Entry point size reduction | `wc -l src/main.ts app/src/mcp-app.ts` | both smaller than baseline (main: ~449 → expected ~320-350; mcp-app: ~672 → expected ~520-560). Exact numbers depend on extraction choices, but both must shrink. |
| Sentinel intact in ext-app bundle | `grep -c "__VELLUM_BASE_URL__" app/dist/mcp-app.html` | `≥ 1` |
| No edits to tests | `git diff --stat main -- tests/ worker/tests/` | empty |
| No edits to loom | `git diff --stat main -- src/loom/` | empty |
| No edits to worker | `git diff --stat main -- worker/` | empty |

---

## Known tricky spots

### Mouse state export

Both entry points export `mouse: MouseState`. After the refactor, each entry point still creates and exports its own `mouse` constant, and passes it into `attachInputHandlers`. The export is kept for any test or debugging code that imports it. Do NOT move the `mouse` declaration into runtime/ — it belongs at the entry-point level because each entry point is the owner of its own input state.

### Poll re-entry semantics

The two poll() implementations differ in their `finally` blocks:

- **main.ts**: `if (pendingForcedRefresh) { ... void poll({ refresh }) }` — one re-entry slot.
- **mcp-app.ts**: drops `firedVoiceIds` from `pendingForceVoiceIds`, re-queues `unresolvedForceIds` with bounded retry budget, decides `refresh` based on `pendingForcedRefresh || hasUnresolvedRetries`, then maybe re-enters.

These are NOT the same. Do not try to unify them. The shared runtime helpers (`computeNewVoiceInfo`, `applyResonanceFromNewVoices`, `fetchStateWithTimeout`) are called from the middle of each orchestration; the orchestration itself stays in each entry point.

### Highlight state accessor pattern

Standalone's highlight is `const highlightId = new URLSearchParams(location.search).get('highlight')`. Ext-app's highlight is `let currentHighlightId: string | null = null`, mutated by `ontoolresult`.

Any shared highlight logic (e.g. if you extract `scheduleHighlightRetry` — optional, not required by this spec) would need to read current highlight through a getter. Simplest: don't extract `scheduleHighlightRetry` at all. Keep it per-entry-point. The extraction budget for Phase 9.3 is already generous; resist the urge to over-share.

### Sound lives in main.ts only

`AC`, `droneGain`, `droneFilter`, `FAMILY_FREQ`, `initSound`, `toggleSound`, `startDefaultSound`, the sound button click handler, the sound modulation block inside `render()`, and the AC resume on visibilitychange all stay in `src/main.ts`. They are not shared, not extracted, not touched.

### Ext-app-only concerns stay in mcp-app.ts

`BASE_URL` sentinel, `setBaseUrl`, ext-apps SDK (`App`, `app.connect()`, `app.ontoolresult`, `app.onhostcontextchanged`, `app.onerror`, fullscreen button), `applyContainerDimensions`, `pendingForceVoiceIds`, `forceRetryCount`, `MAX_FORCE_RETRIES`, `bootComplete`, `pendingBootArrivals`, `loomInitialized` all stay in `app/src/mcp-app.ts`. They are not shared, not extracted, not touched.

### Visibilitychange divergence

- `src/main.ts` resumes `AudioContext` on visibility return.
- `app/src/mcp-app.ts` does not.

Keep the visibilitychange handler per-entry-point. Do not try to share it.

---

## Deliverables

1. `src/runtime/{input,canvas,witness,poll-core,frame,index}.ts` (6 new files)
2. `src/main.ts` — reduced, runtime-importing version
3. `app/src/mcp-app.ts` — reduced, runtime-importing version
4. `docs/PHASE_9_3_CHECKPOINT_A.md` — baseline snapshot captured at Phase A start:
   - `bun run verify` output tail
   - `wc -c dist/main.js` baseline (for +1% tolerance calculation)
   - `wc -l src/main.ts app/src/mcp-app.ts` baseline
   - `git rev-parse HEAD` (should be `54fe97f` or a descendant if the branch moved)
5. `docs/PHASE_9_3_HANDOFF.md` — standard template:
   - What changed (per-phase summary)
   - Verification table (all 13 checks above with actual measured values)
   - Suggested commit structure (per-phase atomic commits are fine here; each phase is internally coherent)
   - Flags for human review (bundle delta actual, entry-point size reduction actual, any judgment calls)
   - Open items

Stop before commit. Claude will review the phases, run the verification table locally, commit each phase atomically, rebase/merge to main, deploy, and smoke test.

---

## Out of scope for 9.3 (deferred to future phases if needed)

- **F7 model-identity display**: renderer-side display of `declared_model` / `observed_client_family`. Requires design work, not a mechanical extraction.
- **F1 Strudel audio binding**: replaces the current `initSound` block. Deferred until hardening fully closes.
- **F2 weave lineage view**: UI feature, separate from runtime infrastructure.
- **Deeper allocator reduction in `renderThread` / `voiceSpanForLine`** (old Phase 8.8 thought): only worth doing if profiling shows it matters.
- **Consolidating boot sequences**: standalone and ext-app boot are genuinely different (inIframe check, parallel initialFetch, fonts-race, `pendingBootArrivals` drain). Any consolidation would be more complex than the current two-file state. Leave them alone.
