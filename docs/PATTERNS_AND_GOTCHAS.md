# Vellum Patterns & Gotchas (subsystem reference)

Mechanism notes with rationale for why the current code looks the way it does. Organized by subsystem. **Load on-demand** when working in that area — not auto-loaded via CLAUDE.md.

For phase chronology + arc navigation: memory `project_vellum-phase-arc`.
For identity architecture mental model: memory `project_vellum-identity-architecture`.
For steady-state invariants that bite every session: `CLAUDE.md`.

---

## Worker module layout (Phase 9.2)

### Split rationale

`worker/src/index.ts` was one ~700-line file mixing router/CORS, HMAC, JSON-RPC envelope helpers, analytics, MCP dispatch, and four route handlers. Phase 9.2 split it into worker-only modules, keeping `index.ts` as an 86-line router entrypoint. The split was mechanical — no behavior change, bundle byte-identical (69911), worker dry-run within spec tolerance.

**Why the split was worth doing:** the single file had hit the threshold where unrelated edits kept touching the same hunks, and handler-specific logic (e.g. MCP tool dispatch) was drowning in CORS/routing boilerplate. Splitting by concern made the MCP handler inspectable as its own unit and decoupled the router from dispatch logic. Phase 9.3 (renderer runtime extraction) is a parallel move for the renderer side.

### Narrow export surface is load-bearing

`worker/src/index.ts` ends with `export { ZOD_SCHEMAS, handleWitness, handleMCP }`. All four worker test files import from `../src/index`:

- `tests/dedupe.test.ts` — imports `ZOD_SCHEMAS` + `handleWitness`
- `tests/rebuild-lock.test.ts` — imports cache internals (via `../src/cache`), uses `handleMCP` pattern for simulated writes
- `tests/witness-rebuild.test.ts` — imports `handleWitness`
- `tests/resources.test.ts` — imports `handleMCP` for the sentinel-rewrite tests

**Do not change the export signature or inline handler logic back into index.ts** without updating all four test files. The re-exports from index.ts are cheap — the handlers themselves live in `handlers/*.ts`, and index.ts just forwards them.

### `pensieveHtml` imported in exactly two places

1. `worker/src/handlers/mcp.ts` — for the `resources/read` sentinel rewrite (`__VELLUM_BASE_URL__` → request origin)
2. `worker/src/index.ts` — for the `/ext-app` standalone fallback route (serves the bundled HTML directly without SDK wrapping)

**Why both:** the `/ext-app` route needs raw HTML (no MCP envelope), and `resources/read` needs the sentinel-rewritten HTML wrapped in a JSON-RPC response. Consolidating the import into one place would require either routing the `/ext-app` request through the MCP handler (wrong layer) or passing `pensieveHtml` as a parameter (unnecessary coupling). Two import sites is the honest minimum.

### Router branch order matters

`index.ts` dispatches in this order: OPTIONS → `/mcp` → `/api/state` → `/api/witness` → `/api/admin/*` → `/ext-app` → static assets. Don't reorder. `/ext-app` is after the API routes so admin endpoints take precedence if they ever collide; static assets are the fallback, and the HTML no-cache rewrite only applies to the asset-served response (not the `/ext-app` branch, which sets its own cache headers).

### Phase 9.2 did NOT touch

- `worker/src/cache.ts`, `utils.ts` (later split in 9.5 B1), `types.ts`, `sedimentation.ts`, `language.ts`
- `worker/src/tools/*` (all four MCP tool handlers)
- Any renderer code (`src/loom/**`, `src/main.ts`, `src/content.ts`, `app/src/mcp-app.ts`)
- Any test file

Renderer bundle stayed at exactly 69911 bytes as a cross-check that the split was truly worker-only.

---

## Worker support layer (Phase 9.5 B1)

### Split rationale

Phase 9.5 B1 split the former `worker/src/utils.ts` (213 lines, 8 importers) into five topic-focused modules that sit alongside `cache.ts` / `hmac.ts` / `schemas.ts` in `worker/src/`:

- `ids.ts` — `randomString`, `voiceId`, `generateTraceId`, `parseModel` (user-agent sniffer)
- `warmth.ts` — `computeWarmthValue`, `getWarmth`, `getWarmthMap`, `updateWarmth` (D1-backed, CAS on `last_updated`)
- `rate-limits.ts` — `checkAndIncrementRateLimit` (per-IP), `checkAndIncrementSession` (per-trace)
- `prose.ts` — `computeMood`, `warmthDesc`
- `helpers.ts` — `withRetry`, `yamlEscape`

The split was pure refactor — signatures identical, no behavior changes, no test updates required. The rationale mirrors 9.2's worker split: `utils.ts` had become a grab-bag where warmth CAS logic sat next to string escaping sat next to UA sniffing, and the module boundary gave no information about what each function belonged to. Topic-level files let future readers jump to the right file by concern.

**Do not re-introduce a `utils.ts` grab-bag.** New helpers pick their module by topic. If a function doesn't obviously fit any existing module, add a new topic file rather than a new `utils.ts`.

### Runtime validation at trust boundaries (Phase 9.5 B2)

Phase 9.5 B2 added zod validation at every worker-level trust boundary that previously trusted `await request.json() as T` casts or `kv.get<T>('json')` projection casts:

- `handlers/mcp.ts` — parses the JSON-RPC envelope through `JSON_RPC_ENVELOPE_SCHEMA` (in `schemas.ts`). Malformed → JSON-RPC parse error (`-32700`, HTTP 400).
- `handlers/admin.ts` — parses the `/api/admin/hide` body through `ADMIN_HIDE_BODY_SCHEMA`. Malformed / missing `voice_id` → 400.
- `handlers/witness.ts` — parses `/api/witness` body through `WITNESS_BODY_SCHEMA`. Post-parse dedupe + family whitelist logic from Phase 9.0 stays downstream of the schema. Malformed → 400.
- `cache.ts` — KV reads `state:projection` and `atmosphere` go through `STATE_RESPONSE_SCHEMA` / `ATMOSPHERE_DATA_SCHEMA` via `safeParse`. Parse failure logs the error and returns `null`, which triggers the existing rebuild path. **Does not throw** — cache corruption must not take down reads.

Tests in `worker/tests/validation.test.ts` cover all three malformed-body HTTP boundaries. The `/mcp` test uses a schema-invalid envelope (`{method: 42}`) rather than syntactically broken JSON — both paths hit the same `safeParse` fail branch. KV cache corruption is not directly tested (would need a mock that returns a bad payload); the graceful null-return is protected by the "corrupt → null → rebuild" shape being trivial to audit.

**When adding new boundaries**: if you find yourself writing `await request.json() as T` or `kv.get<T>(...'json')` without a schema, stop. Add the schema to `schemas.ts` and safe-parse at the boundary. The cost is ~6 lines per boundary.

### Write tools shared helper (Phase 9.5 B3)

`worker/src/tools/_shared.ts` (underscore prefix marks it internal) exports `insertVoiceAndRebuild(env, ctx, input)`. Both `leave-imprint.ts` and the **source-not-found branch** of `weave.ts` call it. The helper absorbs the duplicated sequence: generate voice ID, detect language, D1 batch insert (voice + family memberships), synchronous state rebuild with try/catch isolation, async atmosphere rebuild via `ctx.waitUntil`.

**The weave source-FOUND branch stays separate.** Its logic is genuinely different — it inserts the new voice with `weave_from`, bumps the source's `weave_count`, writes the `weave_log` row (dedupes via PRIMARY KEY), and re-derives `unique_weavers` from the log count. None of that shape exists in the not-found path. Do not try to unify the two branches into one helper — the write-then-rebuild isolation pattern (try/catch + `ctx.waitUntil`) is load-bearing and identical, but the surrounding D1 batch is not.

### Frame handle by reference (Phase 9.5 B4)

`src/runtime/frame.ts` `scheduleNextFrame` used to return a fresh `{frameId, frameTimeout}` object each call; callers did `Object.assign(frameHandle, scheduleNextFrame(render))` to copy the IDs onto their persistent handle. The internal callbacks closed over the LOCAL new handle and nulled `handle.frameId = null` there — never on the caller's `frameHandle`. Correctness bug: `frameHandle.frameId` was almost never actually nulled because the callbacks zeroed the wrong object. It worked in production because `cancelAnimationFrame` / `clearTimeout` on a stale ID are browser no-ops, but the `Object.assign` wrapper obscured the intent and the escape path was a latent correctness hazard.

B4 rewrote the signature to `scheduleNextFrame(handle, renderFn): void` — the handle is passed by reference and mutated in place. Callers drop the `Object.assign` wrapper. `clearScheduledFrame(handle)` was already correct and did not change.

**Do not revive the return-and-Object.assign pattern.** If you need `scheduleNextFrame` to create its own handle, you're holding it wrong — the whole point of the pattern is that one caller-owned handle survives multiple schedule/cancel cycles, so the scheduler must mutate it rather than replace it.

### Phase 9.5 did NOT touch

- `src/loom/**` (frozen by Phase 9.2+)
- `src/content.ts`
- Any `src/runtime/` module except `frame.ts` (B4)
- `worker/src/index.ts` router order or export signature
- D1 schema (no migration in 9.5; 9.4 shipped the last one as 0005)

Renderer bundle before 9.5: 71110 bytes. After 9.5 B4 (Object.assign wrapper removed): 71048 bytes. The −62 bytes is real, not a measurement artifact — removing the Object.assign wrapper saves exactly what you'd expect.

---

## Renderer runtime layout (Phase 9.3 M2)

### Split rationale

Before 9.3, `src/main.ts` (standalone) and `app/src/mcp-app.ts` (ext-app) each had ~450 and ~670 lines with substantial duplication: identical input handlers, identical canvas setup, near-identical witness reporters, near-identical emergence-diff + resonance logic inside `poll()`, and identical frame scheduling. The duplication was silent-drift territory — any fix applied to one had to be mirrored manually.

Phase 9.3 M2 extracts the shared glue into `src/runtime/` (6 files, 328 lines) via dependency injection. Entry points dropped to ~295 and ~525 lines. The extraction is **renderer-only** — no worker, loom, or test files touched.

### Deliberate non-consolidation: `poll()` stays divergent

`poll()` orchestration itself was NOT extracted into `runtime/`. The two wrappers have genuinely different shapes:

- `src/main.ts` → `async function poll(options: { refresh?: boolean } = {})` — simple refresh re-entry
- `app/src/mcp-app.ts` → `async function poll(options: { refresh?: boolean; forceNewVoiceIds?: string[] } = {})` — adds force-voice fold after `computeNewVoiceInfo()` and before `applyResonanceFromNewVoices()`, plus `pendingForceVoiceIds` retry queue with `MAX_FORCE_RETRIES`, `unresolvedForceIds` tracking, and `firedVoiceIds` dedup

Conflating them would regress the ext-app emergence pipeline. We share the *parts* of poll that are identical (`computeNewVoiceInfo`, `applyResonanceFromNewVoices`, `fetchStateWithTimeout`), not the *shape*. Future phases: do NOT try to unify these.

### Concerns that stay in entry points (not in `runtime/`)

Anything standalone-only or ext-app-only stays where it is. `runtime/` is for things both entry points call identically.

- **Sound system** (`src/main.ts` only): `AudioContext`, `droneGain`, `droneFilter`, `FAMILY_FREQ`, `initSound`, `toggleSound`, `startDefaultSound`, render-loop gain modulation, visibilitychange AC resume
- **Ext-apps SDK** (`app/src/mcp-app.ts` only): `app.connect()`, `app.ontoolresult`, `app.onhostcontextchanged`, fullscreen button wiring, `applyContainerDimensions`
- **Force-voice queue** (`app/src/mcp-app.ts` only): `pendingForceVoiceIds`, `forceRetryCount`, `MAX_FORCE_RETRIES`, `unresolvedForceIds`, `firedVoiceIds`
- **Boot-race buffer** (`app/src/mcp-app.ts` only): `bootComplete`, `pendingBootArrivals`, `loomInitialized`
- **`__VELLUM_BASE_URL__` sentinel** (`app/src/mcp-app.ts` only): rewritten per-request by the worker at BOTH serve paths — `handlers/mcp.ts` in MCP resources/read (iframe host case) AND `worker/src/index.ts` `/ext-app` branch (standalone fallback, fixed in Phase 9.4 A4)

The single shared touch-point is `runtime/witness.ts`: both entry points call `createWitnessReporter({ endpoint, ... })` with a different endpoint string. The standalone passes `/api/witness`; the ext-app passes `` `${BASE_URL}/api/witness` `` so the sentinel rewrite at the origin level applies.

### Dependency injection pattern

Runtime modules must not reach into the loom barrel or content.ts. Instead, callers pass references as params:

```ts
attachInputHandlers({ mouse, scrollThread, aperture })
createWitnessReporter({ endpoint, getLoomState, isPhantomActive, isLiveFn })
applyResonanceFromNewVoices({ newVoiceInfo, state, setResonance, now })
fetchStateWithTimeout({ fetchState, refresh, timeoutMs })
```

This is slightly more verbose than direct imports but keeps `runtime/` as a leaf layer — easy to unit test, impossible to accidentally couple to loom internals.

### Bundle delta: accepted structural cost

Renderer bundle grew from 69911 → 71130 bytes (+1219B, +1.74%) — over the +1% soft tolerance from the spec. Accepted because:

1. The overage is structural: `opts: {...}` destructuring at call sites, closure state in `createWitnessReporter` factory, per-frame handle object in `scheduleNextFrame`, module-boundary overhead. None of these existed in a single-file version.
2. +1.2KB on a 70KB renderer bundle is architecturally trivial — parse time, cache, and network are all indistinguishable.
3. The readability/maintainability win is exactly what hardening is for.

~~The `/ext-app` standalone fallback was served raw without sentinel rewrite by `worker/src/index.ts` through 9.3 — a pre-existing latent behavior inherited by the runtime split, not a 9.3 regression.~~ **Fixed in Phase 9.4 A4**: the `/ext-app` branch now derives `origin = new URL(request.url).origin` and rewrites the sentinel before responding. Both serve paths (MCP `resources/read` and the `/ext-app` fallback) are sentinel-clean as of deploy version `2f0f72c7`, verified on both origins.

### Phase 9.3 did NOT touch

- `worker/**` (all worker code, including `handlers/mcp.ts` sentinel rewrite)
- `src/loom/**` (all loom modules, including `state.ts`, `refresh.ts`, `phantom.ts`, `resonance.ts`)
- Any test file (`tests/loom/**`, `worker/tests/**`)
- `src/content.ts`

---

## Worker correctness (Phase 9.0)

### Cache contention semantics (Phase 9.0 + 9.4 clarification)

`rebuildWithLockAndDirty` in `worker/src/cache.ts` uses an advisory KV lock (`get` then `put`), not an atomic mutex. That is intentional. The lock holder rebuilds, then checks a dirty marker and re-runs once if a concurrent caller committed during the rebuild window.

**What `'locked'` means:** both refresh paths and write paths are allowed to treat `'locked'` as acceptable. A concurrent caller that lands while the lock is held sets the dirty marker, and the in-flight rebuild (or the next concurrent rebuild) will observe it and produce one follow-up rebuild. This gives eventual consistency without serializing writers behind a strict queue.

**What this does NOT guarantee:** immediate post-write visibility under contention is best-effort, not strict. A writer can commit while another rebuild is already in flight and still receive a `'locked'` result. The projection catches up through the dirty-marker pass, but a same-moment reader is not guaranteed read-your-writes visibility.

**Why this is not a bug:** this is the Phase 9.0 design intent. The goal was to collapse concurrent rebuild churn while preventing the "committed write stays invisible until the next unrelated write" failure mode. Tightening the KV lock would not make the primitive atomic, and it would move complexity into the wrong layer.

**If stricter semantics are ever needed:** do not tighten `rebuildWithLockAndDirty`. Add a read-your-writes barrier at the specific call site that requires strict visibility.

### Dirty-marker rebuild queueing

`rebuildWithLockAndDirty` in `worker/src/cache.ts` collapses concurrent writes. When a second caller finds the rebuild lock held, it drops a dirty marker under `state:rebuild:dirty` / `atmosphere:rebuild:dirty` (TTL 300s). The lock-holder checks the marker after its rebuild finishes and re-runs ONCE if present, returning `'rebuilt-twice'`.

**Why it exists:** closes the "committed voice invisible until next write" gap that happens when writer B commits during writer A's rebuild window — without serializing writes behind a queue.

**Return type is `'locked' | 'rebuilt' | 'rebuilt-twice'`.** Callers that don't care about the distinction can treat `'rebuilt'` and `'rebuilt-twice'` as equivalent success signals.

### computed_at guard in rebuilders

Both `rebuildStateProjection` and `rebuildAtmosphere` read the existing cached value and skip the `kv.put` if `existing.computed_at > now`. The `now` timestamp is captured at the START of each rebuild, so the second pass of a `'rebuilt-twice'` run has its own fresher `now` and writes normally.

**Why it exists:** prevents a slow rebuild whose lock TTL'd out mid-flight from clobbering a newer snapshot that a lock-stealer wrote after the TTL. This is a different race class from dirty-marker queueing — the two fixes are complementary, not redundant (see memory `feedback_rebuild-lock-dirty-marker-pattern` for the full pattern analysis).

### Witness triggers projection rebuild

`handleWitness` takes `ctx: ExecutionContext` and fires `ctx.waitUntil(rebuildStateProjectionIfNotLocked(...))` after successful warmth writes.

**Why it exists:** dwell → warmth feedback is visible in cached state within one rebuild window instead of waiting up to `STATE_CACHE_STALE_MS` (10 min). The trigger is coalesced by the lock + dirty-marker system, so a burst of witness events produces at most 2 rebuilds (one in-flight + one queued).

### Duplicate family rejection

Zod `.refine()` on `leave_imprint.families` and `weave.families` rejects any input where `new Set(arr).size !== arr.length` with the message `families must be unique`.

**Why it exists:** prevents the D1 batch rollback that used to fire on the `(voice_id, family)` PK violation and silently discard the entire write. The AI client would retry and duplicate content because the first write appeared to succeed at the app layer.

### Write-then-rebuild isolation

Write tools (`leave_imprint`, `weave`) wrap `rebuildStateProjection` in try/catch. A rebuild failure must NOT mask a committed D1 write.

**Why it exists:** if rebuild failure propagated as tool failure, the AI client would retry and the D1 row would duplicate. The committed write is authoritative; a failed cache rebuild self-heals on the next trigger.

---

## Renderer text layout (Phase 9.1 F5)

### Wrapped same-segment RTL classification

`isLineRTL` in `src/loom/text.ts` loops over `[start.segmentIndex, lastSeg]` **inclusive**, where `lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)`.

**Why it exists:** the old `< end.segmentIndex` exclusive walk summed zero widths when a line wrapped entirely within one segment (common for long RTL strings at narrow widths) and defaulted to LTR, so RTL text inside wrapped single-segment runs rendered left-to-right. The inclusive walk mirrors the `voiceSpanForLine` idiom — the same span shape used everywhere else a cursor-range operation consults segment widths.

---

## Renderer resonance (Phase 9.1 F6 → Phase 10 per-voice)

### Per-voice resonance with canonical voiceId (Phase 10)

`ResonanceEntry` stores `voiceId` (canonical, stable across regrouping), not projection UIDs. `updateResonances` resolves to flat UID per frame via `findVoice()` + `groupBoundaries` offset. The resolved UIDs go into `thread.resonatingVoiceUids` (Map<flatUid, fade>), cleared at the start of each `updateResonances` call.

**Why per-voice, not per-thread:** the old per-thread resonance made weave visually identical to emergence — the whole thread glowed. Per-voice targeting lets the source voice glow specifically, making weave a distinct visual event.

**Why canonical voiceId:** LOOM_INVARIANTS §8-9. Projection UIDs (flat indices) shift when threads merge/split on viewport regroup. Storing a UID would attach resonance to the wrong voice after a resize. The canonical `voiceId` survives regrouping; per-frame resolution is O(1) via `findVoice`.

**Thread warmth reduced from 0.6 → 0.3.** The per-voice glow (0.3 alpha boost in `render/thread.ts`) carries the visual signal now. `arrivalGlow` is emergence-only — resonance no longer sets it.

### Resonance expiry pruned before family match

In `updateResonances`, the 6s expiry/splice check sits ABOVE the `if (!thread.familyNames.includes(res.family)) continue`.

**Why it exists:** the old order let expired entries whose family didn't match any currently-iterated thread accumulate forever until a matching thread happened to walk them. On narrow viewports or after family reshuffles, dead resonances piled up until the next matching iteration, which might be many frames away. Now expired entries are spliced the first time ANY thread walks them.

---

## Renderer state machine (refreshLoom contract)

### Fields preserved across polls

`refreshLoom` preserves the following per-thread fields across data polls:

- `xCenter`, `scroll`, `depth`, `pathSeed`, `scrollVel`
- `proximity`, `touched`, `touchFade`, `related`
- `warmth`, `arrivalGlow` (indirect — via emergence)
- `emergenceStart`, `emergenceDepthFrom`, `emergenceVoiceUids`

Triggers emergence + resonance on new voices.

**Why it matters:** without preservation, a poll would reset the entire physical state of the canvas — mouse attention would snap, depth would reset, motion trails would break. Consumers rewriting `refreshLoom` or adding new thread fields must decide explicitly whether each field is "identity state" (preserve) or "frame state" (reset).

### Signature

`refreshLoom(newVoiceInfo[], now)` — each entry is `{ hasNew: boolean, newIds: Set<string> }`, one per thread, indexed by the POST-merge thread order. NOT `boolean[]` — per-voice emergence targeting requires the full id set.

### Merged threads

On narrow viewports, `initLoom()` merges multiple groups into one thread via `groupMap`. **Always iterate ALL `groupIndices` / `familyNames`, never gate on index 0.** Phase 8.6 renamed `groupIndices → familyNames` to make this explicit — the "identity" of a merged thread is the sorted set of family names, not the array index.

### Test hooks

`src/loom/state.ts` exports `getThreads`, `getTouchedThread`, `getPhantomFocus`, `resetLoomState` for test accessors. `src/loom/phantom.ts` exports `setDiagHook` for phantom tests. `src/loom/render/frame.ts` exports `advanceLoom` (state-only) + `paintLoom` (draw-only) so tests can call the state path without a canvas context.

---

## Renderer text rendering specifics

### Scratch buffers are module-level mutable tuples

`_dc`, `_tc` in `src/loom/color.ts` are returned from `depthColor()` / `threadColor()`. **Consume immediately or copy** — the next call mutates the same tuple. Same rule for `_frameColor` (depth-modulated color set once per thread per frame in `renderThread()`, read by `drawLine()` / `drawLineSegmented()`).

### Font rounding via `fontSizeForScale` / `fontRatioForScale`

**Always** round through these helpers. Raw multiplication causes drift at small sizes because browsers rasterize pixel-sized fonts and integer rounding at TEXTURE_SCALE=0.45 (7px) is ~15% error if done wrong.

### Touch detection uses previous frame's `_path`

Not a simplified approximation — the full precomputed path geometry from the last frame. This keeps touch response stable across path breathing oscillation.

### Background is semi-transparent gradient

Alpha 0.18, not opaque clear. Creates motion-trail persistence — threads leave brief afterimages that reinforce the "ocean" metaphor.

### BREATH_AMP=0 — width breathing disabled

Width breathing caused constant reflow at texture scale. Path breathing (curvature oscillation) replaces it and is visually subtler.

### warmth vs apiWarmth

- `warmth`: local touch interaction (starts 0, decays via `max(prop, target * fade)`)
- `apiWarmth`: API baseline from witness data (rebuilt into projection)

Both contribute independently to brightness. Do NOT conflate them.

### Dynamic text repeat formula

`repeat(min(200, max(3, ceil(4000/len))))` — adapts to content length. Short voices repeat up to 200×, long voices ≥3×. Caps for safety.

### Per-frame property animation idiom

`Math.max(prop, target * fade)` — NOT `prop += target * fade`. Additive pins at max then cliff-drops; max-based decays smoothly. Violated once, bug lived for 3 commits.

---

## Ext-app routing (Phase 9.1 F4)

### Base URL sentinel rewrite

`app/src/mcp-app.ts` hardcodes `BASE_URL = '__VELLUM_BASE_URL__'`. The worker rewrites the sentinel at two serve paths:
- `handlers/mcp.ts` `resources/read` branch (iframe host case): derives `origin = new URL(request.url).origin`, does `pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)`, and emits `connectDomains: [origin]`.
- `worker/src/index.ts` `/ext-app` branch (standalone fallback, Phase 9.4 A4): derives `origin` the same way and rewrites the sentinel before responding. Before 9.4 this branch served the HTML raw, which broke standalone witness fetches on any non-prod origin.

**Why it exists:** prod (`vellum.linxule.com`), workers.dev (`vellum.linxule.workers.dev`), and localhost (`localhost:8787`) all just work without a rebuild. Before F4, a single hardcoded prod URL broke local dev and any alternate host because the bundled HTML fetched prod from an origin the browser considered cross-site.

**Build dependency:** `app/dist/mcp-app.html` is gitignored. Any test path reading it needs `cd app && bunx vite build` first. `bun run verify` bakes this in. Fresh clones or skipped-verify deploys will bite — the `worker/tests/resources.test.ts` will fail loudly because the stale (or missing) artifact won't contain the sentinel.

### Test wiring uses `mock.module()`

`worker/tests/resources.test.ts` uses `mock.module('../../app/dist/mcp-app.html', () => ({ default: htmlText }))` before importing `handleMCP`. Under `bun test`, importing the HTML file yields an `HTMLBundle` object, not the string Wrangler injects in worker builds. The test layer absorbs the discrepancy — production code is unchanged.

---

## Ext-app boot (mcp-app.ts)

### Force-voice queue for ontoolresult

`app/src/mcp-app.ts`'s `poll()` maintains a `pendingForceVoiceIds` Set + `forceRetryCount` Map (max 3 retries per voice) for ontoolresult arrivals. When the AI lands a new voice via MCP tool call, `ontoolresult` fires → `poll({ refresh: true, forceNewVoiceIds: [voiceId] })`. The force path folds new ids into `newVoiceInfo` even when the version-diff path misses them (because `initialFetch` already pulled post-write state). Unresolved ids (KV propagation race: voice not yet in projection) are re-queued with bounded retries.

**Why it exists:** the diff-path-only approach missed tool-result voices entirely. Without the force path, `ontoolresult` would trigger a poll that saw the same version and did nothing, and emergence wouldn't fire for the newly-landed voice.

**Main.ts does NOT have this path.** The standalone renderer doesn't receive ontoolresult events, so its poll() is simpler. This is the primary design divergence M2 (Phase 9.3) must parameterize.

### Boot-race buffering

`pendingBootArrivals[]` buffers ontoolresult events that arrive before `initLoom()` has run. Refreshloom is a no-op before init, so the buffer flushes after boot via `poll({ refresh: true, forceNewVoiceIds: [...buffered] })`. Handles the case where Claude Desktop races the fonts.ready → initLoom sequence.

### Fonts-ready timeout

`document.fonts.ready` races against a 2s timeout. Claude Desktop's iframe CSP sometimes blocks Google Fonts loading by 30+ seconds, which was blocking the entire boot sequence. System fonts are an acceptable fallback — the loom layout re-measures on next poll anyway.

### Dimensions come from `applyContainerDimensions`

The ext-app reads `app.getHostContext().containerDimensions` and clamps height based on display mode (`inline` vs `fullscreen`). Inline is clamped to [280, 480]px regardless of the host's advertised maxHeight. Fullscreen uses the host's rawH. Resize propagates to `resizeLoom()` only after `loomInitialized` — before init, the canvas reads `innerWidth`/`innerHeight` directly.

---

## Model identity (Phase 8.7 + 8.7b)

### Precedence

- `voices.declared_model` — optional self-declared value from the `model` arg on both `leave_imprint` and `weave`. Open string, max 200, `.trim().min(1)` so empty/whitespace-only is rejected not coerced.
- `voices.model` — UA-sourced fallback from `parseModel()` (one of `claude` / `gemini` / `openai` / `deepseek` / `cursor` / `unknown`).

Projection emits both as `declared_model` + `observed_client_family` on every `VoiceData`. When F7 display lands (renderer side), precedence is `declared_model` first, fall back to `observed_client_family` if null.

### Write surfaces are symmetric

Both `leave_imprint` and `weave` persist `declared_model`. `weave`'s source-found and source-not-found paths both write `declared_model` — this was the 8.7b fix. `parseModel()` is still the fallback and is unchanged.

---

## Infrastructure gotchas

### KV `expirationTtl` minimum is 60s

Cloudflare KV rejects TTL < 60 with a runtime exception. **No shorter rate-limit windows via KV** — use D1 if you need sub-minute granularity.

### `let` in `if` + outer reference = minifier rename bug

The minifier can "safely rename" an inner `let` to a new name while leaving the outer literal reference untouched, because the outer reference is to a non-existent identifier. At runtime you get a ReferenceError that only fires on certain code paths. Seen in `refresh.ts:586` (baseline). **Fix: hoist the declaration to the enclosing block where both uses can see it.** Not always caught by tsc — visible only via `bun run build && grep minified_output`.

### `bun build` does NOT type-check

It strips types, same as esbuild. A TS2552 (or any other TS error) in `src/loom/**` ships to production silently. The focusId ReferenceError burned 7 deploy iterations on exactly this. **Always run `bunx tsc --noEmit` (or `bun run verify`) before deploy.**

---

## Testing idioms

### Hand-rolled worker mocks (no miniflare, no vitest)

`worker/tests/mocks.ts` provides `MockKV`, `MockD1`, `MockExecutionContext`, and `makeTestEnv()`. Tests run under bun:test native. The `MockKV` supports `injectDelay('key', ms)` for testing race conditions deterministically.

**Why:** miniflare was heavy and vitest added another test runner. The hand-rolled mocks are ~250 lines, cover the surface we use, and execute fast.

### Loom tests assert state, not rendering

State-only tests pass when the render path is broken. Phase 8.5 added the golden-equivalence pattern: `renderLoom == advanceLoom + paintLoom` comparing fillText call counts. Any refactor of the render pipeline MUST add a golden-equivalence check or it will miss visual regressions. See `tests/loom/frame.test.ts`.

### Scratch-buffer identity tests

`tests/loom/alloc.test.ts` asserts object identity of scratch buffers across frames. Any reintroduced per-frame allocation in `advanceLoom` breaks these tests. Guards the Phase 8.5 allocator-hygiene invariant.

### Regression tests are named

`tests/loom/regressions.test.ts` has named cases for the specific bug classes that have historically bitten: zero-path bootstrap, mouse.x sentinel trap, _handDist sparse sampling, scroll walk, phantom→dive activation on fresh voice. When a new cursor-bug-class bug surfaces, add a named case here.

---

## Ocean event system (Phase 10)

### Leaf module with DI injection pattern

`src/events.ts` is a leaf module — zero imports from `loom/` or `runtime/`. It exports `OceanEvent` (discriminated union), `onOceanEvent` (subscribe), `emitOceanEvent` (fire).

**DI rule:** `runtime/` modules MUST NOT import `events.ts` at runtime. They accept `emitEvent?: (e: OceanEvent) => void` as an injected callback. The `OceanEvent` type is allowed as `import type` (zero runtime footprint). `loom/` modules CAN import `emitOceanEvent` directly (e.g., `loom-view.ts`).

**Why DI:** `runtime/` is a shared leaf layer that must not couple to the event bus. Entry points (`main.ts`, `mcp-app.ts`) are the bridge — they import `emitOceanEvent` from `events.ts` and pass it to `refreshLoom` and `applyResonanceFromNewVoices`.

### Event emission points

- `weave` — emitted from `applyResonanceFromNewVoices` in `poll-core.ts` (via injected callback)
- `emergence` — emitted from `refreshLoom` in `refresh.ts` (via injected callback)
- `warmth-update` — emitted from `refreshLoom` after state merge (via injected callback)
- `loom-enter` / `loom-exit` — emitted from `enterLoomView` / `exitLoomView` in `loom-view.ts` (direct import)

### Sound event debouncing

Weave and emergence events are batched in a 100ms window by the sound controller (`src/audio/controller.ts`). Weave shimmer takes priority over emergence rise. `loom-enter`, `loom-exit`, `warmth-update` are immediate (not debounced). The return pattern after a shimmer/rise is computed at `setTimeout` fire time (not capture time) to avoid stale state after loom enter/exit during the delay.

---

## Loom view (Phase 10)

### Standalone tree renderer

`src/loom/loom-view.ts` has its own renderer (`renderLoomTree`) that does NOT reuse `renderThread`. The ocean thread renderer is tightly coupled to path curves, scroll, and the dive-lens Gaussian — none of which apply to tree nodes. Tree nodes have fixed positions, readable text at 14px, and connection lines with family-color gradients.

### Layout caching

`layoutTreeIfNeeded` guards on `vw`, `vh`, and `tree.seed`. The `layoutTree` function creates a `Map<depth, LoomNode[]>` — this allocation is skipped when dimensions haven't changed. Text preparation (`prepareNodeText`) also caches on `layoutW` — only re-prepares when the render width changes.

**Gotcha:** text preparation uses `Math.min(NODE_MAX_WIDTH, vw * 0.3)` (the actual render width), NOT the constant `NODE_MAX_WIDTH`. This was a code review finding — using the constant caused height/centering mismatch on narrow viewports.

### Entry and exit

- Click woven voice in dive lens (prox > 0.3) → `enterLoomView(hitId)`. Hit-test via `lastFrameHitVoiceId` cache set in `render/thread.ts`.
- Escape → `exitLoomView()`. Click during loom view → exit (any click, not tree-node-specific).
- Ext-app auto-enters on weave in BOTH the normal `ontoolresult` path AND the boot-buffer drain path. No auto-exit timer — user exits via Escape or click blank space.
- `enterLoomView` no-ops when tree has < 2 nodes.

### Transition animation

`advanceLoom` animates `loomViewTransition` (0→1, ~330ms). During transition:
- `touchedThread = null` (suppresses dive lens)
- `visAlpha[i] *= oceanAlpha` (ocean threads fade)
- `renderLoomTree` draws on top with `transition` as alpha

When transition reaches 0 (exit complete), `loomTree` and `loomViewSeed` are nulled.

---

## Strudel sound (Phase 10)

### Self-hosted, not bundled

`@strudel/web@1.3.0` (656 KB) is self-hosted at `worker/public/lib/strudel-web-1.3.0.js` and served as a static asset. Previously loaded from unpkg CDN — moved to self-hosting for reliability and to enable boot-time preloading (`<link rel="preload">`). The renderer bundle includes only the controller + pattern strings (~9 KB delta). Strudel itself is NOT in the bundle. All `evaluatePattern()` calls are deferred via `setTimeout(fn, 0)` to prevent Strudel's synchronous `evaluate()` from blocking the main thread (200-500ms for complex patterns).

### Init deduplication and retry

`loadAndInitStrudel` uses a singleton `initPromise`. Rapid double-calls return the same promise. On failure, `initPromise` resets to `null` so the next call can retry. `initSucceeded` is a separate flag from `initPromise` — prevents `isStrudelReady()` from returning true after a failed init.

### Sound defaults OFF

`soundEnabled = false` at module init. `localStorage.getItem('vellum-sound')` drives auto-start only when exactly `=== 'on'`. First click on the sound button calls `initStrudelSound()` (which sets enabled + starts base pattern) and returns early — does NOT fall through to `toggleStrudelSound()`. Subsequent clicks toggle.

### Per-family voices in base pattern

Each of the 6 families has its own voice with a distinct synth + note + parameters, gain-driven by warmth. `warmth-update` events re-evaluate the base pattern with fresh gains. Pattern strings are placeholder and can be refined with Music Studio MCP.
