# Design Model & Tuning

Load this when working on renderer visuals, loom view, sound, or tuning constants. For the philosophical north star, see `VISION.md`.

## Ocean of thought

Resting state is readable dense text (TEXTURE_SCALE=0.45, ~7px). Touch creates a readable clearing via per-line fontScale Gaussian (DIVE_SIGMA_LINES=4.0). Motion philosophy: "one current, many responses" — single ambient oscillator, each thread responds differently. Irreversibility via gust system (random pulses that permanently shift state).

## Emergence & resonance

New voices surface from depth over ~5s (ease-out cubic) with 0.08s per-line stagger. Resonance: per-voice — on weave, the *source voice* gets a targeted glow for 6s (linear decay) via `resonatingVoiceUids` Map. Uses canonical `voiceId` stored in `ResonanceEntry`, resolved to flat UID per frame. Thread-level warmth reduced from 0.6→0.3 to let per-voice glow carry the signal. `arrivalGlow` is emergence-only (no longer set by resonance). Ext-app `ontoolresult` triggers refresh poll → fresh state → emergence + resonance.

## Loom view

A living second rendering mode ("river delta"). Click a woven voice's `·` dot in the dive lens → ocean fades, lineage tree emerges node-by-node from the seed (BFS stagger, 120ms apart, 800ms ease-out cubic each). Text renders at **texture scale** (~7px, same as ocean) — the tree is a constellation of tiny text clusters showing branching topology. A **radial dive lens** (per-line `diveGaussian` × node proximity) swells text from texture to readable (~21px) near the cursor, with per-line variable width (160px→400px, viewport-responsive). Per-grapheme rendering: emergence cascade, traveling wave shimmer, script-aware effects, cursor glow. Flow offset (sine wave + parent drift) dampens during dive for readability. Nodes sorted by proximity for z-ordering (dive-scale draws on top). Brightness follows generational depth (seed brightest via inverted `depthLerp`). Kinship glow propagates partial dive to parent/children. Click a non-seed node → `recenterLoomView()` swaps tree in place. `?highlight=voiceId` URL auto-enters loom view for woven voices. Escape or click background exits. Ext-app auto-enters on weave (user exits via Escape or click blank space).

## Strudel sound

`@strudel/web@1.3.0` self-hosted at `/lib/strudel-web-1.3.0.js` (was CDN, moved to static asset for reliability + prewarm). 4 pattern slots (base, weave shimmer, emergence rise, loom structural), per-family voices driven by warmth. Sound OFF by default, persists in localStorage. Event-driven via the ocean event bus (`src/events.ts`). All `evaluatePattern()` calls deferred via `setTimeout(fn, 0)` to avoid blocking the main thread. `resumeAudioContext()` called on every click to handle Chrome autoplay policy. Load failure → silent fallback.

## Write-to-render pipeline

Write tools `await rebuildStateProjection` synchronously before responding; ext-app `ontoolresult` fires → forces refresh poll → gets fresh state → triggers emergence + resonance + loom view auto-enter. Witness events trigger background rebuilds via `ctx.waitUntil` (coalesced through the dirty-marker system).

## Tuning constants

| Constant | Value | What |
|---|---|---|
| `TEXTURE_SCALE` | 0.45 | Font at rest (~7px). Lower = denser |
| `TEXTURE_LINE_H` | 8.5 | Vertical packing at rest |
| `DIVE_SIGMA_LINES` | 4.0 | Transition sharpness. Lower = tighter lens |
| `DIVE_SCALE` | 1.4–1.7 | Font in dive zone (viewport-dependent) |
| `minDist` | 4% VW | Encounter repulsion threshold |
| `stickyBonus` | 0–0.4 | Touch hysteresis (∝ proximity) |
| `spreadEdge` | 0.10–0.20 | Thread clustering toward center |
| `pathAmplitude` | 0.12–0.20 | Path curve intensity |
| `scrollVel` | 0.0003–0.0012 | Auto-scroll speed (depth-dependent) |
| `loomSpeed` | 3.0 | Loom view transition speed (~330ms) |
| `resonanceWarmth` | 0.3 | Thread warmth from resonance (was 0.6) |
| `resonanceGlowAlpha` | 0.3 | Per-voice resonance line alpha boost |
| `TREE_BREATH_RATE` | 0.00025 | Tree node breath cycle (~4s) |
| `TREE_BREATH_AMP_X/Y` | 3.0 / 1.8 | Tree node sway (px) |
| `TREE_EMERGENCE_STAGGER` | 120 | ms between BFS node appearances |
| `TREE_RESTING_WIDTH` | 160 | Text stream max width (responsive: min(160, vw*0.35)) |
| `TREE_OPEN_WIDTH` | 400 | Dive column max width (responsive: min(400, vw*0.85)) |
| `TREE_HOVER_RADIUS` | 60 | Proximity falloff distance (px) |
