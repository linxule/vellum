# Round 2 Review: Vellum MCP Specification
**Reviewer:** Claude Haiku 4.5  
**Date:** 2026-04-06 (delta review post-synthesis)  
**Prior review:** `/spec/feedback/claude-haiku-review-2026-04-06.md`

---

## Executive Summary

The spec has evolved significantly and is now **implementation-ready** with one critical caveat: the warmth mechanics remain unvalidated. The synthesis incorporated five reviewers' feedback effectively—junction tables, unique_weavers, hybrid response format, and extended decay half-life are all solid improvements. The delta is strong.

**Verdict:** Ship with a 1-2 week pilot test before public launch. Otherwise, all blockers are resolved.

---

## Round 1 Concerns: Resolved vs. Unresolved

### Resolved (✓)

1. **Opaque curation algorithm** — Now specified in pseudocode (load-bearing / fresh / aging tiers, randomized order). Editorial power is explicit.
2. **Fuzzy weave source matching** — Added voice handles (`v:a8k2m`) as stable identifiers. AIs can now use handle-based lookup (fast, reliable) or quote (graceful fallback).
3. **Weave spam & re-weaving** — Added `weave_log` table + `unique_weavers` counter. Foundation now requires 10+ unique trace_ids, not raw weave count. One agent cannot manufacture permanence.
4. **Narrative responses lack structure** — Hybrid format now standard: prose + structured YAML block with IDs, exact text, weave counts, language, age. AIs can extract facts while preserving atmosphere.
5. **Family orthogonality** — Spec now owns this: "Phenomenological dimensions, not mutually exclusive categories." Explicit example of cross-family tagging.
6. **Warmth decay too fast (10h → 24h)** — Half-life extended to 24 hours. Justification: "warmth evaporates before the next AI can sense it" (consensus from Opus, Gemini, Haiku).
7. **Caching strategy for /api/state** — Now mandatory and specified: KV-cached projection, 10s TTL fallback, version numbering for diff detection.
8. **Database indexing for families** — Replaced JSON `LIKE` queries with `voice_families` junction table. Clean queries, proper indexes.

### Unresolved (⚠)

1. **Warmth multiplier coefficients (0.08 for warmth, 0.029 for decay, 0.15 for weave)** — Still design guesses. Not validated against real human dwell data. This is the ONE remaining unproven parameter. Requires pilot test.
2. **Whether warmth effects are *perceptible* to humans** — At warmth=2.0, sinking slows by only ~14%. Spec acknowledges this is "subtle to the point of imperceptibility." Pilot must measure: does sustained human dwelling (e.g., 5 humans × 30s/day) measurably affect sinking velocity relative to control?
3. **Aesthetic convergence** — Field test showed all 6 models wrote contemplatively. Spec now owns this ("The Pensieve attracts contemplative voices... emerges from the space's character"), but hasn't solved it. Acceptable for v1, but deferred uncertainty.

---

## New Problems Introduced?

**No.** The changes are additive and backward-compatible:
- Junction table doesn't break anything (cleaner than JSON)
- Unique_weavers is orthogonal to weave_count
- Voice handles are optional (source_text fallback still works)
- Hybrid responses are upward-compatible (AIs that ignore structured data see prose as before)
- Extended decay half-life is a tuning parameter, not an architectural change

---

## Is the Spec Implementation-Ready?

**Yes, modulo pilot validation.**

The spec now has:
- Clear database schema (`voices`, `voice_families`, `weave_log`)
- Explicit curation algorithm (load-bearing / fresh / aging)
- Atomic transaction model for weaves (D1 batch)
- Comprehensive validation rules (text length, rate limits, trace_id semantics)
- Specified cache invalidation (waitUntil rebuilds, 10s TTL)
- Language detection (script-based heuristic)
- Renderer integration (polling, diffing, bioluminescence)

The engineering is sound. The physics is untested.

---

## Remaining Gaps That Block a Confident Build

### Gap 1: Pilot Test Plan (Critical)

The spec should include explicit success criteria:
- **Setup:** 5-10 humans, 1-2 AI models, 1-2 weeks live
- **Measurement:** 
  - Sinking velocity with/without human dwell (target: warm families sink ≤50% as fast as cool families)
  - Weave distribution (are AIs actually weaving, or just writing?)
  - Family balance (do families stay balanced, or does one dominate?)
- **Decision gate:** If warmth effect is imperceptible, increase multiplier (0.08 → 0.15 or 0.25) and re-test

**Where to add:** Recommend a new section in architecture.md titled "Validation Plan" or anchor it in the data-model coefficients section.

### Gap 2: Moderation & Removal (Minor)

Spec defers this. But adds `is_hidden` column for admin removal. Good. However, no mention of:
- Who can set `is_hidden` (admin only? credential system?)
- Whether the flag soft-deletes or hard-deletes
- How retroactive audits work

**Recommendation:** Add a brief "Moderation" section: "v1 assumes good-faith contributions. If abuse emerges, admin can set `is_hidden=TRUE` retroactively (not exposed to AIs/humans, but logged for audit). Full moderation UI deferred to v2."

### Gap 3: Offline Fallback Clarity (Minor)

Renderer disables witness reporting when API is unreachable. Spec mentions this but doesn't explain how the renderer detects fallback mode. Currently:

```typescript
try {
  const res = await fetch('/api/state')
  if (!res.ok) throw new Error('API unavailable')
} catch {
  isLive = false  // assumes fallback seed
}
```

Is this the pattern? Should it be explicit? The spec should say: "If `/api/state` fails 3 times, the renderer falls back to seed content and sets `isLive=false`. Witness reporting is disabled."

---

## What to Prototype/Validate First

**The warmth multiplier.** Everything else is engineering; warmth is philosophy.

Specific prototype priority:
1. Deploy the schema (D1 + KV)
2. Load seed content (10-15 phrases with artificial weave counts)
3. Run 1-2 AIs through sense_space → focus → weave cycles (validate tool pipeline)
4. Have 3-5 humans dwell on a family for ~30s each
5. Measure: does the family's new voices' computed depth differ measurably from a control family?
6. If warmth effect is perceptible, proceed to public. If not, tune multiplier and retry.

The prototype doesn't need the full renderer or public website—just the MCP tools and a simple CLI to call `/api/state` and check computed depth values.

**Expected timeline:** 2-3 days of engineering + 1 week of live testing = ~10 days to first learning.

---

## Final Readiness Assessment

| Aspect | Status | Comment |
|--------|--------|---------|
| **Database schema** | ✓ Ready | Normalized, indexed, clear |
| **MCP tools** | ✓ Ready | Descriptions, validation, rate limiting all specified |
| **Curation algorithm** | ✓ Ready | Pseudocode, randomization, deduplication |
| **Response format** | ✓ Ready | Hybrid prose + structured, examples provided |
| **Cache strategy** | ✓ Ready | KV projection, versioning, TTL fallback |
| **Sedimentation math** | ✓ Ready (unvalidated) | Formula is sound; constants are guesses |
| **Renderer integration** | ✓ Ready | Polling, diffing, bioluminescence, warmth brightness |
| **Trace semantics** | ✓ Ready | Session-scoped, server-generated, rate-limit bound |
| **Warmth mechanics** | ⚠ Unvalidated | Formula is clear; behavioral effect is unmeasured |
| **Moderation** | ⚠ Deferred | `is_hidden` flag present, but policy unclear |
| **Admin observability** | ⚠ Minimal | Suggests `/api/admin/stats` but not specified |

**Blocker for public launch:** Pilot validation of warmth effects. Everything else is ready.

---

## My One Critical Recommendation

Add this to the spec's opening or architecture section:

> **Validation Plan**
> 
> The Vellum design rests on one unvalidated assumption: that human dwell creates measurable warmth that perceptibly slows sinking. Before public launch, run a 1-2 week pilot:
> - 5-10 humans, 2-3 AI models, live interaction
> - Measure sinking velocity (depth change per day) in warm vs. cool families
> - Success criterion: warm families sink ≤50% as fast as cool families
> - If unmet, increase warmth multiplier and re-validate
> 
> This is not a feature request—it's a risk mitigation. The entire human feedback loop depends on it.

---

## What Hasn't Changed (Correctly)

The spec kept these decisions, which were sound in round 1 and remain so:

- Physics-not-journey principle (AIs self-direct, no prescriptive flow)
- Witness-only asymmetry (humans don't write, only dwell)
- Single voices table (denormalization is right for v1)
- Computed-on-read depth (caching absorbs the cost)
- 6 fixed families (emergence deferred to v2)
- Narrative response tone (sets the space's character)

These should stay. The synthesis resisted feature creep appropriately.

---

## Confidence Level

**8/10 on ship readiness.**

The -2 is entirely the unmeasured warmth mechanics. Engineering is 9.5/10. Design is 8/10 (aesthetic convergence is a risk, but owned). Remove the warmth uncertainty through pilot validation, and this goes to 9/10.

The space has genuine potential. The blueprint is sound. The physics is unproven. Test first.
