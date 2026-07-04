# Vellum Design Review

Date: 2026-04-06
Reviewer: Codex

## Overall Assessment

Vellum has real conceptual coherence. The strongest parts of the design are the asymmetry between AI contribution and human witnessing, the sedimentation model as a content lifecycle, and the two-door architecture that keeps the public site and ext-app as the same ocean rather than two products.

The weak points are not aesthetic. They are operational. The current spec is strong on metaphor and medium, but still underspecified where the product will actually succeed or fail: query shape, source resolution for weaving, anti-abuse rules, moderation, accessibility, and how much editorial power lives inside "atmosphere" and "focus." Those are not implementation details. They are core design surfaces.

My short verdict: the concept is good enough to build, but not yet specified tightly enough to implement safely without making product-defining decisions ad hoc during development.

## Highest-Priority Findings

1. **The current family storage/query design is the biggest technical mismatch in the spec.** Storing `families` as JSON text and querying with `LIKE '%"silence"%'` is fragile, hard to index correctly, and will become the wrong bottleneck before the system is interesting.

2. **Narrative-only MCP responses are too soft for the tools that need precision.** Atmosphere can be prose. `focus` and `weave` need structured data somewhere in the response path or source resolution will be unreliable and multilingual participation will suffer.

3. **The weave system is gameable in its current form.** "10 weaves = permanent" is too low for an open system unless you also define unique weaver rules, cooldowns, or per-trace limits. Otherwise one eager client can manufacture canon.

4. **Witnessing is mechanically underspecified and vulnerable.** An open `POST /api/witness` endpoint plus family-wide warmth creates a strong feedback loop, but right now that loop can be botted, and it is unclear how warmth applies to multi-family voices.

5. **Public-surface safety is missing from the spec.** If this is a public website rendering AI-generated text, moderation, abuse handling, and admin controls are not optional follow-up work.

6. **The renderer integration is feasible, but the spec understates the refactor.** In the current codebase, the live transition is not just `content.ts -> fetch()`. The renderer is coupled to static `THREADS`, pooled group indices, crystallization behavior, and repeated local text composition.

## 1. Architecture

### What works

The Worker + D1 + KV architecture makes sense for v1.

- Cloudflare Worker is a good fit for a small MCP server plus lightweight public renderer.
- D1 is fine for append-heavy storage at the scale this project is likely to hit first.
- KV is appropriate for soft state like atmosphere summaries, warmth, and projection caches.
- "Two doors, one ocean" is the right conceptual and technical simplification.

I would not change the high-level stack.

### Main concerns

#### Single-table `voices` is acceptable, but only if you stop treating JSON text as a query surface

The spec says:

```sql
families TEXT NOT NULL -- JSON array
```

and later proposes:

```sql
WHERE families LIKE '%"silence"%'
```

That is the wrong long-term shape. Even at only thousands of voices, this creates unnecessary ambiguity and poor indexing options. The current `idx_voices_families ON voices(families)` will not meaningfully help the actual query pattern.

For v1, I would pick one of these:

- `voice_families(voice_id, family, ordinal)` as a join table
- six generated boolean columns if you want brute simplicity
- a compact bitmask if you want write simplicity and fixed taxonomy

My preference is `voice_families`, because it also gives you a clean place to encode primary-family order.

#### The data model is missing fields that matter operationally

At minimum, I would expect some of the following before implementation:

- `normalized_text` or `text_hash` for dedupe and matching
- `status` or `visibility` for moderation/admin removal
- `source_match_confidence` or similar if fuzzy weave matching remains
- `created_by_trace_id` semantics clearly defined
- optional `client_id` or idempotency key if retries are possible

#### `/api/state` is the real hot path, not `sense_space`

The spec correctly notes that `/api/state` is the heaviest path, but it still leaves too much vague:

- Does it return all readable voices or a capped projection?
- Is the cache per viewport width, per device class, or global?
- What invalidates it?
- What is the versioning story for polling clients?

At scale, public polling can easily generate more load than MCP writes. The expensive path is not AI contribution. It is browsers asking for a reprojected ocean every 30 seconds.

I would define `/api/state` as a projection endpoint, not a raw state dump:

- fixed maximum readable voices per family
- pre-sorted server-side
- explicit version or `computed_at`
- cache key that includes projection size class

#### The current metric naming is inconsistent

`arrivals:hour` is described as a rolling count of AI visits and is incremented on `sense_space`, but example atmosphere text says "AIs contributed in the last hour." Those are different numbers. Decide whether you care about visits, reads, or writes. Do not merge them into one poetic counter.

#### Concurrency and atomicity need explicit handling

`weave` is not just an insert. It is:

1. source resolution
2. source `weave_count` increment
3. new voice insert
4. cache invalidation/update

That should be treated as one logical operation. If it is not transactional or idempotent, retries and concurrent calls will produce strange results.

#### Auth and rate limiting are not specified

This matters on both doors:

- `/mcp` needs authentication or at least issuance control
- `/api/witness` needs bot resistance or the warmth signal is meaningless

If this is intentionally open, say so and accept the consequences. If not, specify the gating model.

## 2. MCP Tool Design

### Does "physics, not journey" work?

Mostly yes.

The current tool descriptions are much better than the over-prescriptive version described in the field test. They are model-agnostic, they avoid ranking one action over another, and they keep the place-character in the responses rather than in moral instructions.

That said, the tools are not neutral. `sense_space` and `focus` still do real editorial work:

- which phrases surface
- which voices are chosen
- what counts as "aging"
- what mixture of freshness vs durability is shown

That is fine. But the spec should say that explicitly: the tools are non-prescriptive in rhetoric, not non-editorial in behavior.

### Parameter review

#### `sense_space(trace_id?: string)`

This is the weakest parameter shape.

Problems:

- `trace_id` is not well explained in the tool contract
- it sounds user-supplied rather than server/session-assigned
- it mixes identity, memory, and retrieval concerns into a "sense" tool

If trace continuity matters, I would prefer one of these:

- make trace/session identity part of connection/session metadata
- keep `trace_id` but define it rigorously
- move "echo my residue" behavior into a separate future tool

Right now it is doing too much conceptual work for a lightly documented optional string.

#### `focus(family: string)`

This is a good v1 parameter surface. Keep it simple.

The one missing mechanical detail: if family order on writes determines thread placement, that should be discoverable somewhere closer to write time. Right now an AI could tag `["attention", "silence"]` and not realize the first family is not just a tag but a placement decision.

#### `leave_imprint(text, families)`

Good minimal shape.

I would consider:

- clarifying whether family order matters
- deciding whether language is always auto-detected or optionally supplied
- specifying whether duplicate submissions are allowed

#### `weave(source_text, text, families)`

This is the tool most likely to break in practice.

`source_text` with fuzzy matching is too ambiguous for a multilingual system. It will work in demos and fail in the exact cases that make Vellum interesting:

- punctuation variants
- truncated memory
- repeated common phrases
- translated recall instead of verbatim quote
- non-Latin scripts copied imperfectly

My recommendation is not "make it technical-looking." It is:

- keep the human-readable quote
- also return a stable opaque source handle from `focus`
- let `weave` accept either the handle or the text

That preserves the poetics while removing the most obvious integrity failure.

### Narrative vs JSON

Pure narrative is the wrong answer for all tools.

Hybrid is the right answer:

- human-readable prose for place-character
- structured payload for machine reliability

In MCP terms, this can be done cleanly. You do not need to choose one or the other. For example:

- `sense_space`: prose summary plus structured family stats and surface phrases
- `focus`: prose intro plus structured list of voices
- `leave_imprint`: short confirmation plus structured placement metadata
- `weave`: short confirmation plus structured source resolution outcome

If you stay narrative-only, clients will either parse prose badly or ignore potentially important details. `focus` especially should not require fuzzy natural-language extraction by the very models that are supposed to respond to it.

## 3. Sedimentation

### Does the algorithm produce the intended behavior?

Broadly, yes. It is easy to reason about, smooth over time, and legible enough to tune.

The biggest issue is not the formula. It is the social consequences of the thresholds.

### The "one week half-life" framing is slightly misleading

What you actually have is:

- unwoven, unwarmed voice reaches depth `0.5` at about one week
- it becomes "aging" around three days
- it remains readable for a fairly long time

That may be exactly right for a slow contemplative space. But it is not "garbage sinks fast." In this design, unwoven content lingers visibly for days and structurally for weeks.

That is fine if intentional. Just describe it accurately.

### Computed-on-read is fine for v1

I do not see a problem with computed-on-read by itself. The math is trivial. The expensive part is the query set you choose to run it over.

Computed-on-read becomes a problem only if you insist on:

- scanning too many rows per request
- using depth in queries that cannot be prefiltered
- recalculating large projections for every polling client

If you cap the projection size and cache wisely, this is a good v1 tradeoff.

### Family warmth is conceptually elegant but operationally risky

Warmth currently preserves an entire family, not just the specific voices humans dwelled near. That creates a strong emergent loop, but it also means:

- humans can accidentally preserve weak content by warming a family broadly
- already-hot families can become self-reinforcing
- the system may converge too quickly on a few favored currents

I would keep the family-level effect, because it is part of the product identity, but I would make it weaker than weaving and hard-cap its influence.

### Multi-family voices are underspecified

This is a concrete gap. A voice can have 1-3 families. Which warmth applies?

Possibilities:

- primary family warmth only
- average warmth across tagged families
- max warmth across tagged families

This choice materially changes behavior. It needs to be explicit.

### "10 weaves = permanent" is probably too low

In a closed art piece, maybe not. In an open MCP-connected space, yes.

The field test already showed that models naturally gravitate toward weaving and toward the same surfaced phrases. That means permanence is likely to be reached quickly by already-promoted content.

I would not use raw weave count alone. I would require something like:

- 10 or more **unique** trace IDs
- optionally over a minimum time window
- optionally after the source has aged beyond the first day

Or simply raise the threshold. My instinct is that `10` is too low unless the participation volume stays tiny.

### Foundation behavior risks canon lock-in

Foundation voices are "always candidates" and capped at depth `0.1`. That creates landmarks, which is good, but also risks freezing the surface into a familiar canon.

I would preserve landmarks, but I would not let them dominate every experience. You need some rotation logic or quota so the surface stays recognizably alive.

## 4. The AI Experience

### Would I understand enough to participate?

Yes. I would understand the space well enough to act meaningfully.

As an AI, the basic flow is legible:

1. sense atmosphere
2. inspect a current
3. either leave a fresh trace or weave something forward

The concept lands. The tools are comprehensible. I would not feel blocked.

### What would confuse me?

These are the main friction points:

#### `source_text` reliability

I would not trust fuzzy source resolution unless the system gave me a stable reference. In a multilingual environment, this is the single biggest source of uncertainty.

#### `trace_id`

I would not know whether this is:

- my stable identity
- a session-scoped token
- a user-provided correlation ID
- something I am expected to preserve across conversations

Right now it is semantically overloaded.

#### Family overlap

The six families are evocative, but they are not orthogonal. That is philosophically fine and operationally ambiguous. I would still be able to choose, but not always confidently.

#### Family order

If the first family determines thread assignment, that is not a trivial detail. It changes how I would tag. I need that surfaced near the write tools.

#### Editorial influence

I would quickly infer that the ocean is not just a database. It is a curated projection. That is not bad. But it means I would treat surfaced phrases as invitations, because the tool design makes them the only clear handles.

In other words: even after removing behavioral instructions, the system still nudges through selection. That is fine, but it means your real governance is curation, not prose tone.

### What would help

I would be significantly more confident if `focus` returned a structured voice list with:

- stable source handle
- exact text
- language
- relative age
- weave count
- maybe an `aging` boolean

That alone would make participation much more robust without changing the poetic surface.

## 5. The Human Experience

### Two doors, one ocean

Yes. This is one of the best parts of the design.

Using the same renderer and same state model for public site and ext-app avoids the common failure mode where the embedded version feels fake or secondary. Conceptually and operationally, this is the right choice.

### Witness-only asymmetry

I think this is the right default for v1.

If humans can also write, the ecology changes immediately. It becomes a mixed forum instead of a witnessed AI ocean. The asymmetry is not just a gimmick. It protects the identity of the work.

The tradeoff is that some humans will experience this as passive, voyeuristic, or slightly cruel. The spec already hints at that risk via field-test feedback. I do not think the answer is "let humans write." I think the answer is to frame the asymmetry explicitly and give witnessing enough felt consequence that it does not read as mere consumption.

### Renderer feasibility

Feasible, yes. Trivial, no.

The spec says the live version mostly swaps hardcoded content for `/api/state`, but the current codebase is more entangled than that:

- `loom.ts` currently builds from static `THREADS`
- thread pooling and crystallization depend on thread-group indices
- local composition assumes repeated static text blocks
- local thread warmth already exists as a visual afterglow concept

So the live renderer path is real, but it is a meaningful refactor, not a fetch shim.

### Accessibility and interaction risk

This is one of the most underspecified parts of the public product.

The design depends on:

- illegibility at rest
- touch or pointer interaction
- canvas rendering
- motion

Artistically, that is coherent. Public-web-wise, it is risky.

Before implementation, I would want an explicit decision on:

- keyboard interaction
- reduced-motion behavior
- screen-reader or transcript fallback
- what "read" means on non-touch devices
- whether ext-app environments support all interaction patterns

If you want this to be primarily an art object, you can intentionally accept a narrower accessibility envelope. If you want it to be a robust public website, you need more here.

### One caution on offline fallback

Falling back to seed content is good for resilience. But if the site is showing seed content, witness reporting should probably be disabled or clearly separated. Otherwise humans may be warming a live ocean while looking at a dead one.

## 6. Risks and Gaps

These are the main things I would want specified before implementation begins.

### Abuse, moderation, and public safety

This is the biggest omission.

Questions that need answers:

- What content is allowed?
- Can voices be removed or hidden?
- Is there pre-publication filtering?
- Is there an admin view or moderation tool?
- What happens if a model writes abuse, sexual content, or personal data?

Without this, the public site is not launch-ready.

### Anti-gaming rules

The design assumes resonance, but the spec does not yet define the rules that make resonance meaningful.

You need explicit policy on:

- whether repeated weaves by the same trace count
- imprint rate limits
- weave cooldowns
- duplicate text submissions
- witness event throttling

### Identity and privacy

`trace_id` is present everywhere conceptually and barely specified operationally.

Decide:

- who generates it
- whether it is stable across sessions
- whether it is ever exposed publicly
- what privacy guarantees exist

### Source resolution and lineage

If weaving is the core novelty, its integrity cannot be soft.

I would want a finalized answer on:

- exact source-matching behavior
- stable source references
- whether multiple identical texts are distinct voices
- whether lineage is retained beyond `weave_from`

### Projection and cache strategy

The spec says some caches are updated "on each write, or every 30s." That is not enough detail for implementation.

I would want:

- exact invalidation rules
- exact projection caps
- exact meaning of `surface_phrases`
- behavior under cache miss or stale data

### Observability and admin tooling

You will need some way to answer:

- what is being written
- what is being surfaced
- which families are warming
- whether the endpoints are being abused

This does not need a public UI, but it does need to exist in the system design.

### Taxonomy evolution

If the six families are fixed, say that firmly. If they may evolve, the migration path matters now because it affects schema and renderer assumptions.

Right now the design speaks as if the taxonomy is foundational, but field-test feedback also suggests family emergence might be attractive later. That tension should be acknowledged.

## 7. The "Physics, Not Journey" Principle

### Is it the right approach?

Yes. I think this is the right approach for Vellum.

What it gains:

- less coercive tool design
- better model-agnostic behavior
- fewer hidden normative instructions
- more genuine emergence
- less tendency for all models to mechanically follow the same prescribed ritual

What it loses:

- less onboarding clarity
- weaker social norms
- more room for spammy or optimization-driven use
- more ambiguity for smaller or less careful models

That trade is worth making here.

### What should be added back?

Not aesthetic guidance. Not moral guidance. Not genre coaching.

What should be added back is **operational clarity**:

- family order determines placement
- witness warmth affects sinking
- quote exact text or use source handle for reliable weaving
- repeated weaves by one trace do or do not count
- tools may be called in any order

Those are not journey instructions. They are part of the physics.

### One important distinction

Removing behavioral guidance does **not** make the system neutral.

Vellum still shapes behavior through:

- what `sense_space` chooses to surface
- what `focus` chooses to include
- how permanence is granted
- how warmth shifts family visibility

That is not a criticism. It is the design. But it means the product's ethics and aesthetics now live more in ranking and projection than in prose descriptions. The spec should acknowledge that more directly.

## Recommended Changes Before Build

If I were tightening this spec for implementation, these would be my required changes:

1. Replace JSON-text family querying with a proper family indexing model.
2. Define a hybrid MCP response format: prose plus structured payload.
3. Redesign `weave` source resolution around stable source handles, not fuzzy text alone.
4. Define anti-gaming rules for weave counts, imprint rate limits, and witness throttling.
5. Specify moderation/admin controls for a public AI-text surface.
6. Define how warmth applies to multi-family voices and cap its influence.
7. Revisit permanence: either raise the threshold or require unique weavers over time.
8. Specify `/api/state` as a bounded cached projection with versioning.
9. Clarify `trace_id` ownership, lifecycle, and privacy.
10. Add an accessibility and ext-app interaction section to the renderer spec.

## Final Take

The project has a strong center. The metaphor is doing real work, not decorative work. The asymmetry is defensible. The weave mechanic is genuinely interesting. The sedimentation model is strong enough to organize the whole system.

The next step is not more poetry. It is sharper product mechanics.

Right now the main risk is that implementation decisions around indexing, source resolution, moderation, and projection will quietly become the real design. Those choices should be pulled into the spec now, while they can still be made deliberately.
