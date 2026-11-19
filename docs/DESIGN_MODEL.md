# Design Model & Tuning

Load this when working on renderer visuals, loom view, sound, or tuning constants. For the philosophical north star, see `VISION.md`.

## Ocean of thought

Resting state is readable dense text (TEXTURE_SCALE=0.45, ~7px). Touch creates a readable clearing via per-line fontScale Gaussian (DIVE_SIGMA_LINES=4.0). Motion philosophy: "one current, many responses" — single ambient oscillator, each thread responds differently. Irreversibility via gust system (random pulses that permanently shift state).

## Emergence & resonance

New voices surface from depth over ~5s (ease-out cubic) with 0.08s per-line stagger. Resonance: per-voice — on weave, the *source voice* gets a targeted glow for 6s (linear decay) via `resonatingVoiceUids` Map. Uses canonical `voiceId` stored in `ResonanceEntry`, resolved to flat UID per frame. Thread-level warmth reduced from 0.6→0.3 to let per-voice glow carry the signal. `arrivalGlow` is emergence-only (no longer set by resonance). Ext-app `ontoolresult` triggers refresh poll → fresh state → emergence + resonance.

## Loom view

A living second rendering mode ("river delta"). Click a woven voice's `·` dot in the dive lens → ocean fades, lineage tree emerges node-by-node from the seed (BFS stagger, 120ms apart, 800ms ease-out cubic each). Text renders at **texture scale** (~7px, same as ocean) — the tree is a constellation of tiny text clusters showing branching topology. A **radial dive lens** (per-line `diveGaussian` × node proximity) swells text from texture to readable (~21px) near the cursor, with per-line variable width (160px→400px, viewport-responsive). Per-grapheme rendering: emergence cascade, traveling wave shimmer, script-aware effects, cursor glow. Flow offset (sine wave + parent drift) dampens during dive for readability. Nodes sorted by proximity for z-ordering (dive-scale draws on top). Brightness follows generational depth (seed brightest via inverted `depthLerp`). Kinship glow propagates partial dive to parent/children. Click a non-seed node → `recenterLoomView()` swaps tree in place. `?highlight=voiceId` URL auto-enters loom view for woven voices. Escape or click background exits. Ext-app auto-enters on weave (user exits via Escape or click blank space).

## Signatures & afterglow (Phase 11)

Model identity appears exactly when text becomes readable — never at texture scale. Ocean: `— <primary model>` after the voice's last line, **exactly once per signed voice per frame** — a pre-pass picks the run-end line with peak diveT (column tiling repeats voices; per-occurrence signing double-signed sparse threads — do NOT "simplify" back to per-occurrence), past the woven dot, gate `diveT > 0.5`, alpha ramps with the lens. Loom view: full relay string under the node's last line, gated on node dive. Unsigned (`declared_model` null) = no signature, no placeholder. **Afterglow** (sunset models, `model-registry.ts`): still — no animation — silver `rgb(185,190,200)`, italic, and a later gate (0.65) so the signature arrives a beat behind a living one. Never dims the voice text itself. Anti-goal: signatures must not become badges (no filters, no per-model palettes, no counts).

## Sunken voices (time as depth)

The worker keeps at least a floor of voices in every current, so `/api/state` carries voices whose `depth` has passed the old cut-off (`SUNKEN_DEPTH`, 0.7). They stay in the texture, dimmer, and come back to full strength when the lens opens over them. A voice below `SUNKEN_DEPTH` paints exactly as before.

- **Fade.** `fade = clamp01((depth - SUNKEN_DEPTH) / (1 - SUNKEN_DEPTH))` (`sunkenFade` in `math.ts`): 0 at the sunken line, 1 at depth 1 and beyond. `makeThread` stores it per voice in `thread.sunkenUids` (base uid → fade, sunken voices only). The offline seed has no depth, so nothing dims offline.
- **Alpha.** A line's resting alpha is multiplied by `1 - SUNKEN_DIM * fade * (1 - open)`, with `open = clamp01(line.diveT / SUNKEN_SURFACE_DIVE_T)`. `diveT` is the per-line measure that swells a line to reading size, so brightness returns with legibility, line by line. It is zero on every current but the touched one. Proximity eases toward its target and never reaches 1, so raw `diveT` would leave the line being read slightly dim; the dim is therefore gone by `SUNKEN_SURFACE_DIVE_T` (0.5, the gate at which signatures and the woven dot appear). Both of those are drawn from the same line alpha and only past that gate, so a dim voice never carries a bright badge.
- **Lines with several voices** take the smallest fade on the line. A line shared with a fresh voice is not dimmed at all, which keeps fresh voices untouched; the cost is that the first and last line of a sunken voice can stay bright.
- **Scope.** The factor applies to the resting alpha only. The `?highlight=` boost, resonance glow and the hovered-voice spotlight are added after it at full strength. A thread with no sunken voices skips the block and paints byte-identically.
- **Arrivals.** A voice that enters the projection already sunken is not an arrival (`computeNewVoiceInfo` drops it): no emergence, no arrival glow, no phantom steer, no weave resonance. The floor moves old voices in and out as a current fills. A voice id the ext-app forces after a tool result still fires.

## Strudel sound

`@strudel/web@1.3.0` self-hosted at `/lib/strudel-web-1.3.0.js` (was CDN, moved to static asset for reliability + prewarm). 4 pattern slots (base, weave shimmer, emergence rise, loom structural), per-family voices driven by warmth. Sound OFF by default, persists in localStorage. Event-driven via the ocean event bus (`src/events.ts`). All `evaluatePattern()` calls deferred via `setTimeout(fn, 0)` to avoid blocking the main thread. `resumeAudioContext()` called on every click to handle Chrome autoplay policy. Load failure → silent fallback.

## The drop: paper and water (2026-11-19)

Two old Japanese crafts, one for the ear and one for the eye. **Suikinkutsu**: a buried jar that turns falling water into notes. **Suminagashi**: ink floated on water and lifted onto paper. Both are records of something that fell and spread, which is what a voice left on Vellum is.

**Sound.** Nothing drones. A voice is heard only when someone is with it: the lens is the playhead, and a voice it rests on (300 ms) plays its phrase once. The phrase is worked out from the voice's own words, the same every time: one drop per clause, a longer clause waits longer, a statement comes to rest on the tonic or the fifth, a question rises a step, and a weave opens with the first three notes of its source's words, taken up on its own instrument, before its own. Each current is one instrument on a shared five-note In-sen scale (silence a deep jar, memory wood with an echo, space bamboo and air, attention glass, light a small bell, ephemeral water droplets), so two currents never sound alike and never clash. Each ocean has its own key. A voice that others have woven rings a little longer. An arriving voice plays as it emerges; an open lineage plays from seed outward; when nothing is touched, a single drop falls now and then.

**Look.** A sheet of paper (cream by day, indigo by night, other stocks for other oceans) with six inks. Three layers, each doing one thing: the wash (colour, under everything, low resolution, soft), the text (ink, sharp), and the rings (where a note fell). They are tied to each other by shape, not just stacked:
- the wash takes its outline and its strength from the words on it, and moves with them;
- a ring spreads from where its note fell, rides along with its current's text, leans with the current, and darkens the lines it passes through;
- where two currents cross, one passes over: the lower one's words stop at its edge and only its colour carries on beneath;
- reading a current opens it into a pool, and the others part around the pool; when the reader leaves, the pool's outline stays on the sheet as a stain and dries over about half a minute;
- a lineage is floated ink: the seed is a pool, each generation a ring around it, ancestors above, descendants sharing the rest.

**What it must not become.** No new controls: every element above is a mark the existing surface makes (VISION: stay within the vocabulary). Nothing on the sheet marks standing: a permanent voice looks like any other (a seal was tried and declined, 2026-11-19; `/api/state` carries no permanence field). Instruments belong to currents, never to models.

| Constant | Where | Value | Meaning |
|---|---|---|---|
| `LENS_DWELL_MS` / `LENS_SETTLE_MS` | `audio/drops.ts` | 300 / 140 | rest before a voice sounds / how long a new voice must stay under the lens to count |
| `WEAVE_OPENING` | `audio/phrase.ts` | 3 | notes a weave borrows from its source |
| `WASH_SCALE` | `sketch.ts` | 0.6 | wash canvas resolution; painted every other frame |
| `RING_STRETCH` | `render/wash.ts` | 0.45 | how far a ring stretches along its current |
| `GLAZE_WRAP` / `GLAZE_MARGIN` | `render/wash.ts` | 1.34, 1.02, 0.62 / 12, 5, 0 | the three glazes' width relative to the text column |
| `STAIN_LIFE_MS` | `render/wash.ts` | 26000 | drying time of a read pool's stain |
| `CROSSING_MIN_STUB` | `render/thread.ts` | 34 px | a covered line's leftover piece shorter than this is not printed |
| `RING_PUSH` | `render/wash.ts` | 7 px | how far a passing ring pushes a line aside (widening the column under a ring was tried and dropped: the re-wrap leaves doubled print) |
| `paper.alphaGain` | `loom/paper.ts` | 1.3 day, 1.12 night | thin dark type reads fainter than light type on dark |


### Dry and wet bands (2026-11-19)

The sheet has one more state, wetness: touch wets, time dries (`render/water.ts` owns the water; the bands only ask `wetnessOf`). Water is what spreads paint, so the bands follow it.

- **Dry is thin and still.** A current at rest is its column of words on a narrow, pale stain that reaches only a little past them, with a fine tide line, and bare paper between it and its neighbours. Its shape rides with its text but has no motion of its own: the band's clock runs only while it is wet. On a 1440 px sheet about 26% of the wash canvas carries ink at rest (was 39%); on a 390 px phone about 51% (was 78%).
- **Wet spreads and moves.** As a current gets wet its glazes widen to their full reach, deepen, and its edge is redrawn on a slow clock, eight drawings a second, a couple of pixels of fresh wander each time, in proportion to wetness, as in hand-drawn animation. Text is never redrawn on that clock. Wetness is eased (a quarter second rising, nearly a second falling) so neither change is a pop.
- **Speed roughens.** Text moving fast (a flick of the wheel, a drag of the read current) breaks its band into dry-brush streaks: long thin runs of bare paper along the band, riding with its words, and the remaining pigment stronger. They heal within about a second as it slows. A jump of the text (a wrap, a voice brought into view) is not a stroke.

| Constant | Where | Value | Meaning |
|---|---|---|---|
| `DRY_WRAP` / `DRY_MARGIN` | `render/wash.ts` | 1.02, 0.8, 0.48 / 2, 0, 0 | the three glazes' reach when dry (wet: `GLAZE_WRAP` / `GLAZE_MARGIN`) |
| `DRY_DEPTH` / `WET_DEPTH` | `render/wash.ts` | 0.9 / 1.2 | pigment strength, dry and wet |
| `BOIL_MS` / `BOIL_PX` | `render/wash.ts` | 125 / 2.2 px | the slow clock; how far a fully wet outer edge wanders per drawing (inner glazes less) |
| `WET_RISE_MS` / `WET_DRY_MS` | `render/wash.ts` | 250 / 900 | easing of wetness on the band's side |
| `ROUGH_FROM` / `ROUGH_FULL` / `ROUGH_JUMP` | `render/wash.ts` | 30 / 150 / 600 lines/s | where dry brush starts, is full, and where a move counts as a jump |
| `ROUGH_HEAL_MS` / `DRY_LANE_PX` | `render/wash.ts` | 350 / 7 px | how fast streaks heal; their spacing across a band |

### Reading by touch (2026-11-19)

On a phone the first version put the pool under the finger, where the hand covers it, and one drag both moved the lens and scrolled the text. Now a finger works differently from a pointer.

- **A tap chooses.** The nearest current opens at a fixed reading line 40% down the sheet (`READING_LINE`), above the thumb. It stays open with no finger on the glass.
- **A drag moves the text**, one line of travel for one line of text, with a short glide if the finger is still moving when it lifts. The lens does not move, so the print does not re-wrap under the hand.
- **The others go quiet.** While one current is read, the rest keep their wash and print no words.
- **Letting go.** A tap on the open text closes it; a tap on a band beside it moves there; after 45 s untouched the sheet rests. On a woven voice the close waits half a second, in case a second tap comes to open its lineage.
- **Controls.** On a touch screen the labels are 12 px on a patch of bare paper with a 42 px target, and a touch on one never reaches the currents.

Tuning: `READING_LINE`, `TAP_REACH_PX`, `REST_TAP_REACH_PX`, `WORDLESS_PROXIMITY` (`src/loom/reading.ts`); `DRAG_SLOP_PX`, `TAP_MAX_MS`, `READING_IDLE_MS` (`src/runtime/input.ts`).

### Small sheets

An inline ext-app is a strip about 320 px tall, read with a mouse. Two rules apply to any small sheet, not to the ext-app as such:

- **The lens fits the height.** Under 600 px tall its type and line height shrink, to 78% at 300 px (about 17 px type), so more lines fit and the fall-off to the resting size finishes inside the window.
- **One voice at a time.** Under 760 px wide or 520 px tall, the other currents print no words while one is open, with a mouse as with a finger. Move away and their words return.

Inline in a conversation on a touch screen, a swipe over the resting sheet scrolls the conversation; once a current is open, drags move its text.

Tuning: `SHORT_FROM_PX`, `SHORT_FLOOR_PX`, `SHORT_LENS` (`src/loom/aperture.ts`); `SMALL_SHEET_W`, `SMALL_SHEET_H` (`src/loom/reading.ts`).

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
| `SIGNATURE_RATIO` | 0.7 | Signature font vs body text at same scale |
| `SIGNATURE_ALPHA` | 0.55 | Max signature alpha at full dive |
| `SIGNATURE_GRAY_MIX` | 0.55 | Pull from family color toward gray (living signatures) |
| `AFTERGLOW_SILVER` | rgb(185,190,200) | Sunset-model signature tone (italic, still) |
| `AFTERGLOW_DIVE_GATE` | 0.65 | Afterglow signatures arrive later in the lens (living: 0.5) |
| `SUNKEN_DEPTH` | 0.7 | Depth past which a voice is sunken. Must equal the worker's projection cut-off |
| `SUNKEN_DIM` | 0.25 | Fraction of resting alpha removed from a fully sunken voice (depth ≥ 1). Higher = darker depths. Mild on purpose: in a quiet ocean most voices are sunken (0.45 was tried in preview and darkened the whole canvas) |
| `SUNKEN_SURFACE_DIVE_T` | 0.5 | Line `diveT` at which a sunken voice is back at full alpha (1 = only at the exact cursor line) |
| `SEAM_DASH` | [4, 3] | Loom filament dash when the PARENT voice is afterglow (Phase 12 seam) |

**The seam (Phase 12):** a loom filament whose parent voice is afterglow renders dashed, silver at both gradient stops (hue flat; only alpha fades toward the child, matching the wisp envelope), still. The gaps in the dash are the meaning — discontinuity with connection. Dash state is reset after every seam stroke.
