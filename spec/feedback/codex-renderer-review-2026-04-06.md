# Codex Renderer Review — 2026-04-06

Reviewed against:

- `spec/renderer.md`

Reviewed files:

- `src/content.ts`
- `src/main.ts`
- `src/loom.ts`

Validated bundle behavior with:

- `bun build src/main.ts --outdir /tmp/vellum-dist --target browser --sourcemap`

## Findings

### P1

1. The live Worker thread metadata is still being dropped before it reaches the renderer, so two of the spec’s core live behaviors never happen. `src/content.ts:56-61` rewrites `THREADS` down to `{ text, lang, families }` only, and `src/loom.ts:467-570` only accepts `Voice[]` plus a scalar `warmth` argument that is initialized from local state, not from `/api/state`. As a result:
   - `thread.warmth` in `src/loom.ts:853-855, 977-980, 1249, 1308` is only the local touch afterglow, not `ThreadData.warmth` from the Worker.
   - `texture_density` is never consumed anywhere after being typed in `src/content.ts:23-29`.
   - The spec’s “warmth brightness” and “texture density” behaviors in `spec/renderer.md` are therefore not implemented in the live integration.

### P2

1. `refreshLoom()` is not doing the spec’s per-family diff; it tears down and rebuilds the entire loom on any version change. `src/main.ts:176-186` calls `refreshLoom()` whenever `version` changes, and `src/loom.ts:410-441` immediately snapshots some fields, calls `initLoom()`, and restores a subset by array index. This does satisfy “skip re-prepare if version unchanged,” but once the version changes it does much more work than the spec intends and loses the finer-grained “only rebuild changed threads” behavior described in `spec/renderer.md:202-241`.

2. Arrival detection is count-based, not ID-based, so it misses real arrivals whenever additions and removals net out to the same count. In `src/main.ts:177-185`, the poller captures only `prevVoiceCounts`, and `src/loom.ts:430-441` sets `arrivalGlow` only when `newCount > oldCount`. The spec explicitly calls for diffing voice IDs per thread. A moderation hide plus a new arrival in the same family, or any same-count replacement, will rebuild the thread but produce no bioluminescence pulse.

3. `refreshLoom()` only preserves position-ish fields and discards active interaction state. `src/loom.ts:412-428` restores `xCenter`, `scroll`, `restingDepth`, `pathSeed`, `warmth`, and `scrollVel`, but it drops `touched`, `touchFade`, `userScroll`, `proximity`, `related`, `arrivalGlow`, and the current `touchedThread` identity. `initLoom()` also resets `holdTime` and `immersion` at `src/loom.ts:404-405`. That means a poll during active reading collapses the current dive state even though the spec says refresh should preserve continuity.

4. Witness reporting over-reports touch dwell by the renderer’s synthetic touch persistence window. On touch end, `src/main.ts:114-122` intentionally keeps `mouse.x` / `mouse.y` active for `aperture(innerWidth).touchPersistence`, and that persistence is 2-4 seconds in `src/loom.ts:345-353`. `checkWitness()` in `src/main.ts:160-170` keys off `getLoomState()` rather than real touch end, so a human who stops touching can still be counted as dwelling for up to several extra seconds. That is materially different from the spec’s “report dwell on release” behavior.

5. Thread identity is preserved by internal array position, not by family key. `src/loom.ts:420-428` restores saved state to `threads[i]`, and the glow path also assumes `threads[i].groupIndices[0]` corresponds to the same logical thread across refreshes (`src/loom.ts:433-438`). This works today only because the Worker happens to emit families in a stable fixed order. The spec’s polling example is keyed by `thread.family`; this implementation is less robust than the design contract.

### P3

1. `arrivalGlow` decay is frame-based rather than time-based. `src/loom.ts:974-980` multiplies by `0.97` once per render, which gives the intended ~2 second fade only near 60fps. On slower devices, or while the tab is throttled and `src/main.ts:190-203` is rendering at 10fps, the glow persists much longer than designed.

2. The dynamic text composition step from the spec has not been applied. `src/loom.ts:472-474` still uses `(baseText + ' ').repeat(20)` instead of a target-length repeat calculation. That means live thread density still does not vary with the number of voices in the way `spec/renderer.md:172-183` describes.

## No Finding

1. The mutable `THREADS` export is working correctly in the current Bun browser bundle. Source-side, `src/content.ts:56-61` reassigns the exported binding and `src/main.ts:178` / `src/loom.ts:376-381, 434-435, 520, 595` read it at use time rather than snapshotting it into local constants. I also checked the generated Bun bundle and confirmed it emits a shared `THREADS` variable, so there is no bundler-specific live-binding break in the current build.

2. `main.ts` does implement the narrow “skip re-prepare if version unchanged” requirement. `src/main.ts:180-185` fetches fresh state and returns early when the version is unchanged. The gap is not the version gate itself; the gap is that a changed version triggers a whole-loam rebuild instead of the spec’s targeted per-thread refresh.

## Overall

The integration’s biggest remaining problem is not the ES module trick; that part is fine in the current bundle. The real gap is that the renderer is still effectively operating on downgraded `Voice[][]` content, so the Worker’s live per-thread metadata never drives brightness or density, and `refreshLoom()` is acting as a rebuild-with-index-restoration shim rather than the incremental per-family diff described in the spec. Witness reporting also needs another pass because the current touch-persistence behavior inflates dwell times by seconds on mobile.
