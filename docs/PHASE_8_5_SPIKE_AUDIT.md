# Phase 8.5 Spike-Readiness Audit

Assumed spike scenario: roughly 500 concurrent visitors arriving within 60 seconds, with a mix of passive readers, ext-app viewers, and a smaller number of MCP write actions.

## Poll-Race Safety

### Medium

- Description: polling is serialized correctly, but an overlong or hung `fetchState()` can stall the whole refresh pipeline far past the nominal 120-second cadence. Both entrypoints gate `poll()` with `pollInFlight`; the next regular poll is only scheduled after the current run returns, and forced refreshes only queue flags/voice IDs for a rerun in `finally`. If `fetchState()` never settles, both the regular timer path and the force-refresh path stay wedged behind the in-flight guard. Refs: `src/main.ts:245-251`, `src/main.ts:274-340`, `app/src/mcp-app.ts:217-223`, `app/src/mcp-app.ts:246-377`, `app/src/mcp-app.ts:490-517`, `app/src/mcp-app.ts:633-647`.
- Recommendation: wrap `fetchState()` in an explicit timeout/abort and treat timeout as a normal poll failure so `pollInFlight` always clears.
- Effort: minutes.

### Low

- Description: concurrent `refreshLoom()` overlap itself is already prevented. In the standalone app it only fires from `poll()` on version change; in the ext-app it fires from `poll()` on version change or queued `forceNewVoiceIds`. `ontoolresult` overlap is intentionally serialized and deduped via `pendingForceVoiceIds`, `pendingForcedRefresh`, `firedVoiceIds`, and bounded retries for unresolved voice IDs. Refs: `src/main.ts:303-329`, `app/src/mcp-app.ts:292-340`, `app/src/mcp-app.ts:345-376`, `app/src/mcp-app.ts:490-517`.
- Recommendation: keep the current queue/de-dupe pattern; only harden the fetch timeout path.
- Effort: none unless the timeout change lands.

## D1 Query Hot Paths

### High

- Description: full cache rebuilds are the dominant D1 hot path, and the query set is only partially indexed. `rebuildStateProjection()` executes `getWarmthMap()` plus 5 query shapes per family, or 31 total D1 queries per rebuild; `rebuildAtmosphere()` executes 22 more. The heavy per-family shapes all join `voices` to `voice_families` on `family` / `ordinal` / `is_hidden`, but the schema only provides `voices(created_at)`, `voices(weave_count)`, `voices(trace_id)`, `voices(is_hidden=true)`, and `voice_families(family, ordinal)` partial indexing. There is no composite visible-primary-family index for the join/filter/order patterns actually used. Refs: `worker/src/cache.ts:8-124`, `worker/src/cache.ts:126-218`, `worker/migrations/0001_init.sql:17-31`.
- Recommendation: collapse the repeated per-family query fanout into grouped queries where possible, cap the unbounded foundation selection, and add indexes aligned with the hot joins, at minimum `voice_families(family, ordinal, voice_id)` and a visible-primary-family strategy on `voices` or a denormalized primary-family column.
- Effort: half-day.

### Medium

- Description: `weave` by `source_text` can degrade into full-table scans. The reliable path `SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE` is indexed by the `voices` primary key, but the exact text lookup has no supporting index, the normalized-text lookup applies functions to the column, and the `%...%` `LIKE` fallback guarantees scan-heavy behavior as `voices` grows. Refs: `worker/src/tools/weave.ts:6-38`, `worker/migrations/0001_init.sql:4-20`.
- Recommendation: require `source_id` for the hot path, or add an indexed normalized/hash column and remove the substring fallback from normal traffic.
- Effort: hours.

### Query Inventory

| Surface | Query shape | Tables / filters | Index coverage | Complexity | Call rate |
| --- | --- | --- | --- | --- | --- |
| `rebuildStateProjection` | foundation | `voices` + `voice_families`, `family=?`, `ordinal=0`, `is_hidden=FALSE`, `unique_weavers>=10` | partial: `idx_vf_primary`; no index for visible/high-unique-weaver join | O(rows in primary family) | every rebuild, 6x |
| `rebuildStateProjection` | high-weave recent surface | `family=?`, `ordinal=0`, `is_hidden=FALSE`, `weave_count>=3`, `ORDER BY weave_count DESC LIMIT 20` | partial: `idx_vf_primary`, `idx_voices_weave_count`; join still broad | O(rows in primary family) | every rebuild, 6x |
| `rebuildStateProjection` | recent voices | `family=?`, `ordinal=0`, `is_hidden=FALSE`, `ORDER BY created_at DESC LIMIT 150` | partial: `idx_vf_primary`, `idx_voices_created_at`; no composite join index | O(rows in primary family) | every rebuild, 6x |
| `rebuildStateProjection` / `rebuildAtmosphere` | family counts / language histograms | `family=?`, `ordinal=0`, `is_hidden=FALSE`, optional `GROUP BY language` | partial: `idx_vf_primary`; no visible+join composite | O(rows in primary family) | every rebuild, 12x+ |
| `rebuildAtmosphere` | global age / total | `voices WHERE is_hidden=FALSE`, `MIN(created_at)`, `COUNT(*)` | weak: no visible-voices partial index | O(all visible voices) | every rebuild |
| `focus` | load-bearing / fresh / aging | `voices` + `voice_families`, `family=?`, `is_hidden=FALSE`, optional created_at / weave_count filters | partial: `idx_vf_family`, `idx_voices_created_at`, `idx_voices_weave_count` | O(rows in family) | per tool call |
| `sense_space` | echo trace | `voices WHERE trace_id=? AND is_hidden=FALSE ORDER BY created_at` | good: `idx_voices_trace_id` plus created_at sort on filtered subset | O(log N + matching trace rows) | optional per tool call |
| `leave_imprint` | family count | `voice_families` + `voices`, `family=?`, `ordinal=0`, `is_hidden=FALSE` | partial: `idx_vf_primary`; no visible join composite | O(rows in primary family) | per imprint |

## Rate-Limit Ceilings

### Medium

- Description: the current ceilings are low for shared egress and the enforcement is soft because KV counters use read-then-write rather than atomic increments. A corporate NAT or classroom lab can hit the same per-IP limits with legitimate traffic. Refs: `worker/src/index.ts:256-264`, `worker/src/index.ts:457-465`, `worker/src/utils.ts:92-112`.
- Recommendation: move hot counters to atomic storage (D1 or Durable Objects) and revisit the IP-based ceilings before public launch.
- Effort: hours.

### Current ceilings

| Surface | Key | Ceiling / window | On limit hit | Spike read |
| --- | --- | --- | --- | --- |
| MCP initialize | `init:{ip}` | 20 per hour per IP | JSON-RPC error `-32000` over HTTP 200, message `Too many sessions. Try again later.` | Too tight for shared NAT if many users initialize together |
| Witness API | `witness:{ip}` | 1 per 60s per IP | HTTP 200 JSON `{ ok: false, throttled: true }` | Too tight for 500 viewers if many share egress; also silently “soft fails” rather than surfacing 429 |
| Session imprint | `session:{traceId}` | 7 per hour per session | tool error text in normal MCP result envelope | Reasonable for abuse control; not the public-read bottleneck |
| Session weave | `session:{traceId}` | 5 per hour per session | tool error text in normal MCP result envelope | Reasonable for abuse control; not the public-read bottleneck |

## Asset Cache Headers

### Low

- Description: state caching is sensible, but HTML shell caching is sticky and the asset URLs are fixed rather than fingerprinted. `/api/state` serves `public, max-age=10` normally and `no-store` on `refresh=1`, which is correct for the read model. `/ext-app` serves `pensieveHtml` with `public, max-age=3600`, and the main renderer HTML in `worker/public/index.html` loads `/dist/main.js` at a fixed URL. The worker delegates all other static files directly to `env.ASSETS.fetch(request)` with no cache override. Refs: `worker/src/index.ts:394-435`, `worker/src/index.ts:628-639`, `worker/public/index.html:63`, `worker/wrangler.jsonc:22-25`.
- Recommendation: serve HTML shells as `no-cache, must-revalidate`; only let fingerprinted JS/CSS assets carry long-lived immutable caching. As written, neither `/ext-app` nor `/dist/main.js` is fingerprinted at the route level.
- Effort: minutes to hours, depending on build-pipeline changes.

## Worker CPU Budget

### High

- Description: write-triggered rebuilds are not serialized. `leave_imprint` and both `weave` paths call `rebuildStateProjection()` inline after the D1 write, then schedule `rebuildAtmosphere()` in `waitUntil`. The KV lock only protects `/api/state` refresh/stale rebuilds, not write-triggered rebuilds. That means 50 concurrent writes do not queue behind one lock; they fan out into roughly 50 independent state rebuilds plus 50 atmosphere rebuilds. Refs: `worker/src/tools/leave-imprint.ts:35-58`, `worker/src/tools/weave.ts:74-88`, `worker/src/tools/weave.ts:108-141`, `worker/src/index.ts:216-234`, `worker/src/index.ts:401-418`.
- Recommendation: move write-triggered rebuilds onto the same serialized path as `/api/state`, or replace them with a dirty flag / debounce / single-flight background job.
- Effort: half-day.

### Rebuild cost summary

- `rebuildStateProjection()`
  Query count: 31 D1 queries total.
  Shape: `getWarmthMap()` once plus 5 per-family query shapes across 6 families.
  Behavior under burst: currently runs inline on every successful imprint/weave.
- `rebuildAtmosphere()`
  Query count: 22 D1 queries total.
  Shape: 3 global queries, 3 per-family queries across 6 families, plus `getWarmthMap()`.
  Behavior under burst: currently scheduled in `waitUntil` after every successful imprint/weave.
- Lock behavior
  `rebuildStateProjectionWithLock()` is single-flight for `/api/state` refresh/stale recovery only.
  There is no queue or debounce for write-triggered rebuilds; callers do not wait behind one locked job, they start their own rebuild work.

## Top 5 Things To Fix Before Announcing Publicly

1. Serialize or debounce all write-triggered rebuilds; do not run full projection rebuilds inline on every imprint/weave.
2. Add indexes or denormalized access paths for the visible-primary-family rebuild queries; the current query set does too much join/filter work per rebuild.
3. Add a hard timeout/abort to client `fetchState()` so one stuck request cannot wedge regular polling and forced refreshes indefinitely.
4. Raise or redesign the IP-based `initialize` and `witness` limits for shared NAT scenarios, and move enforcement off KV read-then-write.
5. Change HTML shell caching to `no-cache, must-revalidate` and reserve long-lived caching for fingerprinted static assets only.
