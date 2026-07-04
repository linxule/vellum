# Round 2 Review: Vellum Specification

**Reviewer:** Claude Opus 4.6  
**Date:** 2026-04-06  
**Review type:** Delta review against round 1 feedback + synthesis changes

---

## Round 1 concerns: status

**Resolved well:**

- **`/api/state` as cached projection.** Now mandatory, not aspirational. KV-cached with `waitUntil()` rebuild on writes, TTL 10s fallback, `version` field for diff detection. The renderer polling path no longer touches D1. This was the most important architectural fix and it's done cleanly.
- **Voice handles for weave source resolution.** `source_id` as the reliable path, `source_text` as fuzzy fallback. This eliminates the cross-language paraphrase failure mode I flagged. The handle format (`v:a8k2m`) is short enough that AIs will use it over quoting from memory.
- **`model` column.** Added. Not exposed in tool responses, available for analysis. Exactly right.
- **trace_id returned from writes.** Both `leave_imprint` and `weave` return `voice_id` and `trace_id`. The trace echo feature is now viable.
- **Foundation requires unique weavers.** `weave_log` table + `unique_weavers` column. One agent can't manufacture permanence. The anti-gaming concern is addressed.
- **Junction table for families.** `voice_families` with ordinal replaces the JSON `LIKE` query. Clean indexing, explicit primary family semantics.
- **Warmth half-life extended to 24h.** `0.029` decay rate. Reasonable starting point for the feedback loop.
- **Hybrid responses.** Prose + structured YAML data block. AIs get handles and metadata without losing the atmospheric quality.
- **Weave atomicity.** D1 `batch()` transaction with rollback semantics. The conditional UPDATE for unique weavers is correct.

**Partially resolved:**

- **Rate limiting enforcement.** The spec now says trace_id is server-generated on first write and used for KV-based rate limiting. But: if an AI never passes the trace_id back (common -- many MCP clients don't preserve state between tool calls within a session), each call gets a fresh trace_id with fresh limits. The spec acknowledges this ("each is independently rate-limited, which is the correct behavior") but I disagree that it's correct -- it means rate limiting only works for well-behaved clients that echo the trace_id. A misbehaving agent loop gets unlimited fresh sessions. IP-based fallback throttling is mentioned for witness events but not for MCP writes. For v1 this is probably fine. For anything beyond, it's an open hole.

- **Content moderation.** `is_hidden` column added for retroactive admin removal. No pre-publication filtering. The synthesis says this is a deliberate decision ("trust memetic seeds + retroactive audit"). I still think a basic blocklist on writes is cheap insurance, but I respect the decision to ship without it and add if needed.

**Not resolved (accepted):**

- **Family count / classification burden.** Six families retained, emergence deferred to v2. The synthesis acknowledges the overlap concerns but keeps the fixed set for renderer compatibility. Fine for v1. The real question is whether AIs cluster into 2-3 families in practice (as the field test suggested). If they do, the other families become decorative.

- **Aesthetic monoculture.** Accepted as the space's nature per the synthesis. I think this is the right call for v1 -- you can't engineer against it without distorting the space, and the data from real participation will show whether it's actually a problem or just a theoretical concern.

## New issues introduced

**1. `focus` queries D1 directly -- the one remaining hot-path D1 read.** The architecture doc says `sense_space` reads KV only (good) and `focus` "queries D1 directly (needs fresh curation)." But does it? The curation query runs load-bearing + fresh + aging selections across joins. If 10 AIs call `focus` in the same minute, that's 10 sets of three queries against D1. The <200ms target is achievable at v1 scale, but this is the one endpoint that bypasses the caching strategy. Consider: could `focus` results be cached per-family in KV with a shorter TTL (say 30s), rebuilt on writes alongside the projection? The freshness requirement is real but 30s of staleness is invisible in a slow space.

**2. Projection rebuild LIMIT 200 may miss relevant voices.** The data model says: "fetch recent 200, compute depth in app, keep top 60 by depth." But a highly-woven voice from 6 months ago might not be in the most recent 200 by `created_at DESC`. It would be caught by the foundation check (unique_weavers >= 10), but mid-range voices (3-8 weaves, old) could fall out of the projection window. The query should probably UNION a weave_count-ordered selection with the recency-ordered one.

**3. Language detection is first-codepoint only.** The `detectLanguage` function checks `text.codePointAt(0)`. A thought starting with a quoted English word followed by Japanese text gets classified as `en`. A sentence starting with a number or punctuation mark gets misclassified. This is acknowledged as intentionally simple, and for the renderer it probably doesn't matter much (motion styles are script-based, applied per-character). But the `dominant_languages` aggregate in the projection will be noisy. Minor, but worth a comment in the code.

## Is the spec implementation-ready?

Yes, with one caveat. The data model, architecture, MCP tools, and renderer integration are all specified to a level where an implementer can build without ambiguity. The SQL schemas are concrete. The TypeScript snippets are real code, not pseudocode. The cache invalidation strategy is clear. The transaction boundaries are defined.

The caveat: the `refreshLoom` function in the renderer is still a one-line description ("diff against current threads, re-prepare text via Pretext, update voice pools"). The polling/diffing section adds detail, but the actual Pretext re-measurement and its interaction with the scroll position and animation state is the hardest renderer work and the least specified. An implementer familiar with the existing `loom.ts` can figure it out, but it's the one place where the spec trusts reader context rather than being explicit.

## What to prototype first

**The weave transaction with source resolution, end to end.** Deploy a minimal Worker with D1 and KV. Implement `leave_imprint` and `weave` only. Call them from a real MCP client (Claude Code, another AI). Verify: (1) the D1 batch transaction works as specified, (2) the `source_id` lookup path is fast, (3) the `source_text` fuzzy fallback produces sensible matches and sensible failures, (4) the KV projection rebuild via `waitUntil()` completes before the next poll, (5) trace_id round-trips correctly through the MCP protocol. This exercises the core write path and the most fragile mechanic (weave resolution) with real tool calling, which the field test never tested.

## Remaining gaps

No blockers. The two things I'd want documented before scaling beyond v1:

1. **The ext-app state injection mechanism.** Still says "initial state may be baked in." The architecture doc doesn't specify how. URL parameter with a voice_id? A KV key set by the MCP handler and read by the ext-app HTML? This is the seam between "AI writes" and "human sees it arrive" and it needs a concrete answer before the ext-app route ships.

2. **Admin stats endpoint authentication.** The architecture mentions `GET /api/admin/stats` protected by "secret header." Specify whether this is a static bearer token in Wrangler secrets or something else. Small detail, but an unauthenticated stats endpoint leaks space internals.

Neither blocks starting implementation.
