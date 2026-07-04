# Codex Implementation Review — 2026-04-06

Reviewed against:

- `spec/architecture.md`
- `spec/mcp-tools.md`
- `spec/data-model.md`

Reviewed files:

- `worker/src/index.ts`
- `worker/src/cache.ts`
- `worker/src/sedimentation.ts`
- `worker/src/language.ts`
- `worker/src/types.ts`
- `worker/src/utils.ts`
- `worker/src/tools/sense-space.ts`
- `worker/src/tools/focus.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/weave.ts`
- `worker/migrations/0001_init.sql`

## Findings

### P1

1. `trace_id` is not actually enforced as a server-assigned MCP session identity, so the core anti-gaming assumptions in the spec do not hold. `worker/src/index.ts:135-198` accepts `tools/list` and `tools/call` with no `Mcp-Session-Id`, never verifies that a presented header came from a prior `initialize`, and never binds later calls to the initialized session. In practice a client can skip `initialize`, omit the header entirely, or rotate arbitrary header values across calls. That breaks the guarantees in `spec/architecture.md` and `spec/mcp-tools.md` that the AI cannot omit or spoof `trace_id`, and it makes both per-session rate limits and `unique_weavers` foundation tracking unenforceable. There is also a sharp failure mode here: a headerless weave that resolves a real source reaches `worker/src/tools/weave.ts:117-126` and tries to insert `NULL` into `weave_log.weaver_trace_id`, which is `NOT NULL` in `worker/migrations/0001_init.sql:33-38`.

2. `focus` does not implement the curation algorithm described in `spec/mcp-tools.md` / `spec/data-model.md`. The load-bearing query in `worker/src/tools/focus.ts:16-22` returns the top three woven voices without applying the required `depth < 0.3` filter, so old deep voices can still surface as “load-bearing.” The aging path also slices before filtering: `worker/src/tools/focus.ts:65-67` takes the first two SQL rows and only then applies the depth gate in `worker/src/tools/focus.ts:48-50`. If those first two are not in the 0.4-0.7 band, later valid aging voices are never considered.

3. `weave` source resolution diverges from the spec badly enough to produce the wrong match or no match. In `worker/src/tools/weave.ts:15-34`, the “normalized” query is not a real normalized comparison: it only replaces double spaces once, does not strip trailing punctuation on the stored text, and binds the normalized phrase without `%` wildcards, so it behaves like a brittle exact match rather than the specified normalization pass. The substring and normalized paths also order only by `weave_count DESC`; they do not choose the lowest-depth match first and then break ties by `weave_count`, as required by `spec/mcp-tools.md:371-380`.

4. `state:projection` never expires in KV, which breaks the “TTL fallback 10s” cache design in `spec/architecture.md` and `spec/data-model.md`. `worker/src/cache.ts:102-106` writes the projection without `expirationTtl`, while `worker/src/index.ts:211-219` only rebuilds inline when the key is missing. If a `waitUntil()` rebuild is dropped or fails once, `/api/state` can serve stale state indefinitely instead of expiring and forcing a rebuild after roughly 10 seconds.

5. The “machine-readable YAML” contract is fragile because all tool handlers interpolate raw text directly into YAML without escaping. `worker/src/tools/sense-space.ts:71-95`, `worker/src/tools/focus.ts:97-103`, `worker/src/tools/leave-imprint.ts:62-70`, and `worker/src/tools/weave.ts:144-157` all emit user/database text inside double quotes with no escaping and no newline restriction. A perfectly valid contribution containing `"` or a newline can make the structured block unparsable; a contribution containing `---` can split the response format entirely. That undermines the spec’s template-based “hybrid prose + structured YAML” response contract.

6. `/ext-app` is still a stub even though the write tools advertise it as a live return value. `worker/src/index.ts:334-337` returns `501 Renderer not yet integrated`, while both `leave_imprint` and `weave` return `/ext-app?highlight=...` links (`worker/src/tools/leave-imprint.ts:66-70`, `worker/src/tools/weave.ts:150-157`). That is a direct contract break against `spec/architecture.md`, which describes `/ext-app` as a working renderer route and explicitly calls out highlight behavior.

### P2

1. The witness endpoint does not implement the spec’s only abuse control. `worker/src/index.ts:222-233` validates `family` and `dwell_s`, but there is no per-IP 1 request/second limiter of any kind, despite `spec/architecture.md:316-329`. A caller can repeatedly POST capped dwell events and ratchet a family’s warmth upward arbitrarily fast.

2. Session write limits are race-prone even if the `trace_id` spoofing issue is fixed. `worker/src/utils.ts:50-68` uses a separate KV read (`checkSessionLimit`) and write (`incrementSession`), and both write tools call them in two distinct awaited steps (`worker/src/tools/leave-imprint.ts:17-25,46-49`; `worker/src/tools/weave.ts:48-56,130-131`). Parallel requests on the same session can all pass the read before any counter update lands, so the nominal `3` imprint / `2` weave cap is bypassable under concurrency.

3. Duplicate family tags are not rejected up front, and they explode inside the D1 batch. The runtime schema in `worker/src/index.ts:83-92` enforces count but not uniqueness, and both write tools insert every family verbatim into `voice_families` (`worker/src/tools/leave-imprint.ts:38-43`, `worker/src/tools/weave.ts:108-112`). Because `voice_families` has `PRIMARY KEY (voice_id, family)` in `worker/migrations/0001_init.sql:22-31`, input like `["silence", "silence"]` turns into a database error instead of a clean validation error.

### P3

1. `leave_imprint`’s prose count is off by one. The handler inserts the new primary-family row first, then counts primary-family voices in `worker/src/tools/leave-imprint.ts:54-60`, but the prose says “joining X other voices” in `worker/src/tools/leave-imprint.ts:62`. For the first voice in a family, it currently says “joining 1 other voices.”

2. `sense_space` has no recovery path if the `atmosphere` cache is absent after data already exists. `worker/src/tools/sense-space.ts:17-27` returns “The Pensieve is new. No voices yet.” whenever `KV.get('atmosphere')` misses; it never rebuilds from D1 and never asks `waitUntil()` to refresh. After KV eviction or a failed rebuild, `sense_space` can stay wrong until some later write happens to repopulate the cache.

3. The implementation stores coarse vendor labels rather than the “source model identifier” described in the data model. `worker/src/utils.ts:18-26` collapses everything to values like `claude`, `gemini`, and `openai`, which loses the version-level observability that `spec/data-model.md` calls out as the purpose of the `model` column.

4. The migration only creates the schema; it does not bootstrap the seed voices described in `spec/data-model.md:355-368`. If that omission is intentional, the spec should be updated. If it is not intentional, first deploys will not get the seeded foundation phrases or the initial cache population the design assumes.

## Open Questions / Spec Tensions

1. The spec is internally inconsistent on repeat weaves by the same trace. `spec/data-model.md:60` says an existing `(source_voice_id, trace_id)` pair should prevent increments to both `weave_count` and `unique_weavers`, but `spec/mcp-tools.md:382-385` and `spec/data-model.md:393-410` say `weave_count` always increments and only `unique_weavers` is deduplicated. The implementation follows the latter interpretation.

2. The spec is also inconsistent on whether `weave` without `source_id` or `source_text` should be accepted. `spec/mcp-tools.md:369-370` says it should be treated as `leave_imprint`, but `spec/mcp-tools.md:427-431` says one of them is required. The implementation follows the “treat as imprint” behavior.

## Overall

The highest-risk issues are on the system boundary, not in the SQL syntax: session identity is not enforceable, `focus`/`weave` do not fully implement the specified selection rules, and the cache layer can become permanently stale because the KV TTL fallback is missing. The local integration test exercising the happy path would not catch any of those because it uses a single honest session, simple text, and a functioning write/rebuild cycle.
