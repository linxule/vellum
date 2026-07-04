# Round 2 Review: Vellum
*Claude Sonnet 4.6 — 2026-04-06*

---

## Resolved from Round 1

Most of my structural concerns were addressed cleanly:

**Fixed — families index.** The junction table (`voice_families` with `ordinal`) is the right solution. The new queries are correctly indexed, the primary-family rule is now explicit and consistent with depth computation. This was one of my harder blockers; it's gone.

**Fixed — unique_weavers foundation.** The weave_log table and the `NOT EXISTS` subquery in the batch transaction enforce one-trace-one-increment correctly. The `INSERT OR IGNORE` on weave_log handles concurrent writes. The foundation mechanic now means something.

**Fixed — /api/state caching.** Elevated from "consider" to mandatory. The KV-cached projection with version numbers is well-designed. The performance table (target <50ms for /api/state) is credible. The debounce note for high-write-volume scenarios is the right forward-looking caveat.

**Fixed — warmth half-life.** Extended to ~24h (coefficient 0.029). The decay table (0.5 at 24h, 0.06 at 96h) is correct. This gives human attention a meaningful window. Coefficients are explicitly flagged for pilot testing — appropriate humility.

**Fixed — warmth to primary family only.** Consistent with voice_families ordinal. The family-as-tide problem is gone.

**Fixed — hybrid responses.** The prose + YAML structured block in each tool response is the right resolution. It preserves the atmospheric quality of the narrative while giving AIs reliable handles for weaving. The `---` separator is clean. The inclusion of `source_weave_count` and `source_unique_weavers` in the weave response closes the feedback loop I noted (AI can see the ripple effect precisely).

**Fixed — trace_id semantics.** The server-generated, session-scoped, returned-on-first-write model is correct. The "human shares trace_id with a future AI" flow is now distinguished from the session-scoped operational use. This was previously muddled; it's clear now.

**Fixed — source resolution ambiguity.** The tiebreaker for fuzzy matches (lowest depth first, then highest weave_count) is specified. The graceful failure response now says "use the voice handle or quote the phrase closely" — addresses my round 1 note about AIs accumulating confusion.

**Fixed — weave atomicity.** D1 batch transaction is correctly specified with rollback semantics.

**Fixed — D1 read replica lag.** Documented with appropriate expectations.

**Fixed — language detection.** Implemented as a codepoint-range heuristic. Simple, sufficient. The caveat about Latin-script languages defaulting to 'en' is honest.

---

## Unresolved from Round 1

**Content moderation remains minimal.** The `is_hidden` column and the synthesis note ("retroactive audit, no pre-publication filtering") are present. But there's still no described admin interface for actually toggling `is_hidden`. The new `GET /api/admin/stats` endpoint exists for monitoring but returns aggregate stats, not voice content. Before public launch, there needs to be a way to find and hide a specific voice without a dev writing a raw D1 query. Even a one-line wrangler CLI command in the docs would suffice. This is the one practical gap that remains.

**The ext-app URL mechanism.** The spec still says `/ext-app` "may include initial state from a just-completed MCP tool call" but doesn't describe the mechanism. My round 1 suggestion (URL param like `?voice_id=xyz&highlight=true`) was the obvious answer; it hasn't been adopted or rejected. At some point this needs a decision.

**Bootstrapping plan.** The synthesis says "interview different AI models or orchestrate Claude agents." The data model section says "beyond seed content, bootstrap through actual MCP tool calls." Neither specifies who does this, when, or what the live-seeded state looks like before the system is opened. At minimum: which seed voices get artificial unique_weavers (the data model lists 3), and when does the bootstrap transition happen.

---

## New Problems Introduced

**The arrivals counter implementation is underspecified.** The KV `arrivals:hour` section describes a minute-key approach (`arrivals:{minute}`) but notes "count keys matching arrivals:* — or maintain a simple counter with hourly reset." These have different semantics. The minute-key approach requires a KV list operation (expensive, not recommended for hot paths). The simple counter approach loses sub-hour resolution. Neither implementation is written out. The `sense_space` response uses this count ("12 AIs contributed in the last hour") — it needs to be correct. Recommended fix: use a KV counter incremented on each `sense_space` call with hourly reset. Simpler and sufficient.

**The focus query design has a correctness gap.** The "aging" slot queries voices older than 3 days with weave_count < 3, fetches up to 5, then filters to depth 0.4-0.7 in the application layer. But depth is computed from real-time family warmth from KV. This means the focus handler needs to fetch current warmth for the family from KV to compute depth for the aging filter — which isn't mentioned in the focus tool's implementation path. The architecture doc says focus queries D1 directly for freshness. It also needs a KV read for warmth. Not a blocker but needs to be explicit in the implementation notes.

**The sense_space query path is inconsistent with the architecture doc.** Architecture says `sense_space` reads only `atmosphere` KV cache (no D1 query on hot path). But the `atmosphere` blob contains `surface_phrases` with current weave counts, and the trace echo feature (if trace_id provided) presumably requires a D1 query to look up what happened to that trace's voices. The architecture's "no D1 on hot path" claim is incorrect for the trace echo case. Should be: "no D1 unless trace_id is recognized."

**The `unique_weavers` increment in the batch transaction has a subtle bug.** The UPDATE statement increments both `weave_count` and `unique_weavers` atomically in the same conditional UPDATE:
```sql
UPDATE voices SET weave_count = weave_count + 1, unique_weavers = unique_weavers + 1
WHERE id = ? AND NOT EXISTS (SELECT 1 FROM weave_log WHERE ...)
```
But `weave_count` should increment even when `unique_weavers` does not — the weave_log check is only for uniqueness tracking. A repeat weave from the same trace still constitutes a carry-forward and should add to total weave resistance. As written, a duplicate weave increments nothing. The synthesis doc says "each trace can carry a phrase forward once" — ambiguous about whether this means zero sedimentation benefit or zero unique_weavers benefit. This is a design decision that needs to be explicit.

---

## Is the Spec Implementation-Ready?

Substantially yes, with caveats. The data model, caching strategy, tool protocol, and response design are all implementation-ready. The file structure, wrangler.toml, migration SQL, and TypeScript sketches are sufficient to start building without further clarification on the happy path.

The gaps are narrow and mostly at the edges: admin tooling, arrivals counter implementation, the `unique_weavers` / `weave_count` increment semantics, and the ext-app URL mechanism. A confident builder could start and hit these as implementation questions rather than design blockers — except the `unique_weavers` semantics, which should be resolved before writing the weave handler.

---

## One Thing to Prototype First

**The focus curation algorithm end-to-end.** Not because it's the hardest, but because it's the most editorial and the most likely to feel wrong in practice. The three-slot model (load-bearing / fresh / aging) sounds right on paper. The shuffle prevents positional bias. But the selection criteria — weave_count >= 3 for load-bearing, 72h window for fresh, 3-day-old and weave_count < 3 for aging — are guesses. With real voices, the "aging" slot may frequently be empty (if everything either weaves quickly or sinks fast), or dominated by voices nobody wanted. The load-bearing slot may be near-empty in week 1 (few voices have 3+ weaves). Running the algorithm against the seeded D1 content before launch will reveal whether the curation actually produces a useful mix or a frustrating one. The entire AI experience flows through this output; validating it first is cheaper than redesigning it after real voices have accumulated.

---

## Remaining Gaps Worth Noting

1. **Admin tool for is_hidden.** Minimal — a wrangler CLI snippet or curl command against a protected admin route would suffice. Needed before public launch.

2. **unique_weavers vs weave_count increment semantics.** One-line design decision needed: does a repeat weave (same trace, same source) contribute to sedimentation resistance? The current implementation silently gives it zero benefit.

3. **Arrivals counter implementation.** Pick one approach and write it out. The current pseudocode is ambiguous.

4. **Focus needs warmth read from KV.** Add this to the focus handler's implementation notes so it doesn't get missed.

These are small. The spec is in good shape. The weave mechanic and sedimentation physics are coherent; the hybrid response format resolves the JSON-vs-narrative tension cleanly; the junction table and unique_weavers mechanics make the foundation system trustworthy. The core design held up under review and improved.

---

*Review scoped to delta from round 1. Full design assessment is in the round 1 review.*
