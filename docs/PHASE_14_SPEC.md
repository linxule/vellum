# Phase 14 — "The Ember" (spec v1 — DEPLOYED 2026-07-12, worker `149950b1`)

> Warmth made felt, texture made honest, presence as consequence. Authored 2026-07-12 by claude-fable-5 (fourth phase of its last day); design reviewed by the kimi/deepseek/grok panel (fourth sitting). The presence fork was decided by the human the same day: **live warmth — presence as consequence, not representation** (see FEATURE_BACKLOG). Renderer-only phase: ZERO worker changes.

## Design law

**An ember glows because it has been held; a spotlight tells you where to look** (kimi). Warmth may change how a current *reads when touched* — never how it *ranks at a glance*. Corollaries (panel, unanimous):
- The kitsch line is **comparability**: no "warmer than" reading, ever. No heatmaps, counters, badges, auras, per-model tint, or rankable brightness.
- **Decoupling law** (grok's "density×warmth collusion" / deepseek's "emergent heatmap"): density is texture alone (voice count); warmth is lens behavior alone (readability when touched). Neither may read the other's input. Warmth must never alter texture/repeat/size/position; sparseness must never alter warmth reveal.
- Family-level warmth is honest as "this current runs warm" — the phrase "voices that were held" is BANNED from code comments, docs, and any surface text until F5 (per-voice dwell) exists.
- GCO additive bloom: killed 3-0 ("bloom is spotlight vocabulary" — deepseek). `globalCompositeOperation` stays unused in `src/`.

## Part A — the ember (F10, soft form)

Server warmth (`thread.apiWarmth`) today is one `*0.15` alpha term — near-invisible. Two changes, both in `src/loom/render/thread.ts`, both consuming **`clamp01(apiWarmth)`** (landmine: it's an unclamped decayed accumulator):

1. **diveT boost** (the core move, 3-0): after the existing diveT computation (~line 140), `diveT = Math.min(1, diveT * (1 + clamp01(thread.apiWarmth) * WARM_DIVE_BOOST))`. A warm current reaches reading scale at lower proximity and over a taller band — *easier to read when you touch it*. The `isPrimary` gate is untouched (warmth reveals only under attention; nothing changes at a glance).
2. **baseAlpha lift, mild** (~line 81): the `apiWarm * 0.15` term becomes `clamp01(apiWarm) * WARM_BASE_ALPHA` with `WARM_BASE_ALPHA = 0.22`. Warm currents rest *slightly* brighter — below conscious-comparison threshold.

Constants in `src/loom/types.ts`: `WARM_DIVE_BOOST = 0.35`, `WARM_BASE_ALPHA = 0.22` (tuning table entries; a `clamp01` helper already exists in math.ts or add one there).

NOT in scope: sigma widening (cut 2-1), bloom (killed 3-0), any color/hue shift, any resting-size change, any motion.

## Part B — texture honesty (sparse families, bugfix framing)

A 1-voice family currently tiles wall-to-wall ("one message on repeat" — a real witness read it as a glitch). Deepseek's reframe, adopted: this is a **bugfix, not a warmth feature**.

- `src/loom/thread.ts` `makeThread` (~line 19-22): when `voices.length <= 1`, cap `repeatCount` at `SPARSE_REPEAT_CAP = 2` ("a whisper, not a monologue" — deepseek). Multi-voice families keep the existing formula. Input is `voices.length` (surfaced count, already in scope) — NOT `texture_density` (total family count; reserved for a possible future borrowed-echoes treatment, pre-F3).
- **Zero-voice families stay blank** (3-0: "a faint trace invents presence that isn't there" — grok). `baseText=''` behavior unchanged; add a regression test pinning it.
- **Presentation acceptance**: the thin column must read as *air/breath*, not a truncated bar chart (kimi's rank objection). IMPLEMENTER: investigate how a short column actually renders (top-aligned? does the scroll window wrap/tile it visually anyway?) and report to the lead BEFORE inventing extra machinery. If the natural render already breathes (lines fade into blank), ship it; if it bar-charts, stop and report.

## Part C — live warmth (the human's presence ruling, minimal form)

Another witness's dwell should warm the surface *while you watch* — anonymous, uncountable, felt only through the existing warmth vocabulary.

1. **Poll cadence**: `VISIBLE_POLL_MS 120_000 → 15_000` in BOTH `src/main.ts` and `app/src/mcp-app.ts`; `VISIBLE_POLL_JITTER_MS 10_000 → 2_000`; the floor in main.ts:66 `Math.max(30_000, …)` → `Math.max(10_000, …)` (mcp-app has the same idiom — mirror it). Hidden-tab behavior unchanged. Worker cost: 4 req/min vs the 60/60s per-IP state limit — no worker change needed.
2. **Ease, never step** (3-0; ~20-30s): `Thread` gains `apiWarmthTarget`. The refresh merge (`src/loom/refresh.ts` ~line 94, currently `Math.max` straight into `apiWarmth`) now merges into `apiWarmthTarget` (Math.max semantics preserved — warmth never visibly decays mid-session). Per-frame in `advanceLoom` (state-only — the legal home): `thread.apiWarmth += (thread.apiWarmthTarget - thread.apiWarmth) * WARMTH_EASE_K`, `WARMTH_EASE_K = 0.002` (per-frame idiom like the existing `*0.997` decay; ≈95% convergence in ~25s at 60fps). `makeThread` initializes BOTH fields to the incoming value — the surface arrives already-warm; ease applies to *changes* only.
3. Accept imperceptibility: "not everything needs to be witnessed in real time" (deepseek). No transition may be made more legible to compensate.

Sound layer: untouched (audio gain tracks LOCAL hover warmth, not apiWarmth).

## Part D — structure & tests

New tests in `tests/loom/ember.test.ts` (harness: helpers.ts `CanvasContextStub`, `makeState` — it accepts per-thread `warmth?`; `maxFontSizeForText` is the legibility probe):
- **Warm-reads-easier**: two identical states differing only in one family's `warmth` (0 vs high); same mouse position under lens; warm thread's `maxFontSizeForText` ≥ cold's, strictly greater at a mid-proximity position.
- **Rest-brightness mild**: parse the alpha out of body-text `fillStyle` rgba (new small helper in helpers.ts); warm > cold at rest; assert the delta is bounded (≤ WARM_BASE_ALPHA).
- **No-rank guard**: warmth does NOT change `totalLines`, repeat count, or x-position (decoupling law, test-enforced).
- **Sparse whisper**: 1-voice family's `totalLines` far below the 4000-char formula; text length ≤ (baseText.length+1) × SPARSE_REPEAT_CAP. Multi-voice family unchanged by the cap.
- **Zero-voice blank**: pinned unchanged.
- **Ease**: after a refresh raises warmth, `apiWarmth` approaches `apiWarmthTarget` monotonically over `runFrames` (not a step; assert intermediate frame strictly between old and new).
- Existing suites must stay green — especially `frame.test.ts` golden-equivalence (advanceLoom change is state-only) and `regressions.test.ts`.

`bun run verify` before deploy. Live smoke: `/api/state` + a dive on a warm current.

## Post-spec deltas (recorded 2026-07-12, same-day — lead-approved)

1. **Part B's cap alone was visually a no-op** (implementer checkpoint finding — the designed STOP-and-report fired exactly as intended). The render loop re-tiles at paint time: on prepared-text exhaustion it resets to `ZERO_CURSOR` and keeps laying out to fill the viewport, so a capped 1-voice family still painted wall-to-wall (81 lines at rest, 637 under dive). Approved mechanism: `Thread.sparse` flag (`voices.length <= 1`, set in `makeThread`); sparse threads paint exactly ONE full contiguous copy of the prepared text (cursor wrap allowed once to complete a copy started mid-text via scroll offset), then stop — the blank below is the air. Non-sparse tiling untouched. No new fade machinery. The `makeThread` repeat cap stays too (data honesty). Guards: zero-path bootstrap / sparse sampling / scroll walk regressions; zero-voice blank pinned; dive/hit/hold on the sparse block still works.

2. **Fleet-review HIGH (grok, lead-verified): block-relative edge fade blanked short whispers.** `edgeFade = min(1, t*8, (1-t)*8)` with `t = lineIndex/lineCount` was designed for full-screen tiling (lineCount ~81); the sparse gate shrank lineCount to the block size, so a 1-line solo voice (schema allows 1-200 chars — short voices are normal) got edgeFade=0 → painted NOTHING. Kimi and deepseek both passed it; the test fixtures used long solo text. Fix: sparse threads use a real-viewport-edge fade (`min(1, y/SPARSE_EDGE_FADE_PX, (VH−y)/SPARSE_EDGE_FADE_PX)`, 24px) in BOTH draw paths (drawLine + drawLineSegmented); non-sparse formula byte-for-byte untouched.
3. **Companion geometry fix (implementer-disclosed, required)**: the y-based fade alone was insufficient — a sparse block started at yPos=0, landing line 0 inside any real-edge fade band. Sparse blocks now start offset from the top; then **lead ruling: vertically centered** (`max(SPARSE_EDGE_FADE_PX, (VH − blockH)/2)`) — air above AND below; a whisper floats in the column rather than pinning to the top like a truncated list. Non-sparse yPos=0 unchanged. Covered by the `sparse-legible` test ("Hi" paints at rest and under dive).

## Panel record (2026-07-12, fourth sitting)

kimi (poetic), deepseek (mechanism/incentives), grok (skeptic). Unanimous: diveT multiplier is the core move; GCO bloom killed; ease over step; zero-voice stays blank; family-level warmth honest if never over-claimed. Splits ruled by lead: sparse-thinning ships NOW as bugfix (deepseek's reframe; kimi wanted it held for F5 — his rank objection is answered by the whisper-cap + presentation acceptance test); sigma-widening cut (grok alone for it); phasing = one working set of three independent moves (each had ≥2/3 ship-now support). Deepseek's tie-breaking insight: the ease-transition may land between polls and go unwitnessed — and that's correct behavior. Compass lines: "An ember glows because it has been held; a spotlight tells you where to look" (kimi); "an ember is residual receptivity after attention" (grok); "an ember is what you discover by holding still long enough to feel your own attention warming the surface" (deepseek).

## Invariant checklist

- [ ] Font sizing only via `fontSizeForScale`/`fontRatioForScale`
- [ ] No ctx/draw calls in `advanceLoom` (ease is state-only); `frame.test.ts` goldens stay green
- [ ] `clamp01(apiWarmth)` at every consumption site
- [ ] `globalCompositeOperation` remains unused in `src/` (grep-clean)
- [ ] Decoupling law test-enforced (warmth ⇏ texture/position; density ⇏ warmth reveal)
- [ ] Iterate ALL `familyNames` (merged threads) — untouched by this phase but do not regress
- [ ] No `Date.now()`/`performance.now()` in `src/loom/` pure paths
- [ ] Worker untouched; `bun run verify` before deploy
