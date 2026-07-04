# Phase 8.6 Checkpoint B

## Status

Phase B is complete.

## B1 — Serialize write-triggered rebuilds

### Approach

- Chose Option 1 from the spec.
- Added KV-backed single-flight wrappers in `worker/src/cache.ts`:
  - `rebuildStateProjectionIfNotLocked()`
  - `rebuildAtmosphereIfNotLocked()`
- Updated all write-triggered rebuild call sites in:
  - `worker/src/tools/leave-imprint.ts`
  - `worker/src/tools/weave.ts`

### Verification

- `cd worker && bunx tsc --noEmit` -> clean
- Code inspection confirms all three write paths now route through the lock-aware wrappers instead of calling `rebuildStateProjection()` / `rebuildAtmosphere()` directly.

### Files

- `worker/src/cache.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/weave.ts`

## B2 — D1 composite indexes

### Approach

- Added `worker/migrations/0002_identity_and_indexes.sql` with:
  - `idx_vf_primary_voice`
  - `idx_voices_visible_weave_count`
  - `idx_voices_visible_unique_weavers`
  - `rate_limits` table + `idx_rate_limits_expires` (also used by B4)
- Captured pre/post `EXPLAIN QUERY PLAN` locally with `sqlite3` against:
  - baseline schema: `0001_init.sql` + existing `0002_warmth_state.sql`
  - post-change schema: baseline + new `0002_identity_and_indexes.sql`

### EXPLAIN QUERY PLAN

#### Foundation

Before:

```text
QUERY PLAN
|--SEARCH vf USING INDEX idx_vf_primary (family=? AND ordinal=?)
`--SEARCH v USING INDEX sqlite_autoindex_voices_1 (id=?)
```

After:

```text
QUERY PLAN
|--SEARCH v USING INDEX idx_voices_visible_unique_weavers (is_hidden=? AND unique_weavers>?)
`--SEARCH vf USING COVERING INDEX idx_vf_primary_voice (family=? AND ordinal=? AND voice_id=?)
```

#### High-weave recent surface

Before:

```text
QUERY PLAN
|--SEARCH vf USING INDEX idx_vf_primary (family=? AND ordinal=?)
|--SEARCH v USING INDEX sqlite_autoindex_voices_1 (id=?)
`--USE TEMP B-TREE FOR ORDER BY
```

After:

```text
QUERY PLAN
|--SEARCH v USING INDEX idx_voices_visible_weave_count (is_hidden=? AND weave_count>?)
`--SEARCH vf USING COVERING INDEX idx_vf_primary_voice (family=? AND ordinal=? AND voice_id=?)
```

#### Recent voices

Before:

```text
QUERY PLAN
|--SEARCH vf USING INDEX idx_vf_primary (family=? AND ordinal=?)
|--SEARCH v USING INDEX sqlite_autoindex_voices_1 (id=?)
`--USE TEMP B-TREE FOR ORDER BY
```

After:

```text
QUERY PLAN
|--SEARCH vf USING COVERING INDEX idx_vf_primary_voice (family=? AND ordinal=?)
|--SEARCH v USING INDEX sqlite_autoindex_voices_1 (id=?)
`--USE TEMP B-TREE FOR ORDER BY
```

### Verification

- `cd worker && bunx wrangler d1 migrations apply vellum --local` -> clean
- The new indexes are picked up by the foundation / high-weave query shapes exactly where the audit said the join/filter pressure lived.

### Files

- `worker/migrations/0002_identity_and_indexes.sql`

## B3 — fetchState timeout + abort

### Approach

- Added optional `signal` support to `src/content.ts:fetchState()`.
- Wrapped fetches in both entrypoints with a 20s `AbortController` helper:
  - `src/main.ts`
  - `app/src/mcp-app.ts`
- Added a new test that passes an already-aborted signal and verifies `fetchState()` returns `null` immediately.

### Verification

- `bun test tests/loom/content.test.ts tests/loom/`
  - `82 pass, 0 fail`
- `bunx tsc --noEmit` (root) -> clean
- `cd app && bunx tsc --noEmit` -> clean

### Files

- `src/content.ts`
- `src/main.ts`
- `app/src/mcp-app.ts`
- `tests/loom/content.test.ts`

## B4 — Rate limit ceiling redesign

### Approach

- Took the D1 route, not the KV fallback.
- Added generic atomic-ish counter helper in `worker/src/utils.ts`:
  - `checkAndIncrementRateLimit()`
- Updated public ceilings to:
  - `initialize`: `100 / hour / IP`
  - `witness`: `5 / 60s / IP`
- Added `Retry-After` headers on both throttled surfaces:
  - MCP `initialize` JSON-RPC error
  - `/api/witness` throttled JSON response

### Verification

- `cd worker && bunx tsc --noEmit` -> clean
- Local migration applied successfully with the `rate_limits` table present.

### Files

- `worker/src/utils.ts`
- `worker/src/index.ts`
- `worker/migrations/0002_identity_and_indexes.sql`

## B5 — HTML cache headers

### Approach

- Changed `/ext-app` to `Cache-Control: no-cache, must-revalidate`.
- Wrapped static asset HTML-shell responses so `/` and `.html` responses are also returned with `no-cache, must-revalidate`.
- Left non-HTML assets alone.

### Verification

- `cd worker && bun run deploy --dry-run` -> clean after fixing the pre-existing `worker/public/dist` packaging hole.

### Files

- `worker/src/index.ts`
- `worker/package.json`

## Additional Verification

- `bunx tsc --noEmit` (root) -> clean
- `cd app && bunx tsc --noEmit` -> clean
- `cd worker && bunx tsc --noEmit` -> clean
- `bun test tests/loom/` -> `82 pass, 0 fail`
- `cd worker && bun run deploy --dry-run` -> clean

## Surprises / Human Review Flags

- The repo already contained `worker/migrations/0002_warmth_state.sql`, so Phase B now adds a second `0002_*` migration. Wrangler applies them cleanly, but the numbering is worth normalizing if the human wants a tidier migration history.
- `worker/package.json` had a pre-existing `predeploy` failure because `worker/public/dist` was never created before `cp dist/main.js worker/public/dist/main.js`. I fixed that with `mkdir -p` so the required dry-run verification could actually run.
- The recent-voices query still uses a temp B-tree for `ORDER BY created_at DESC LIMIT 150`. The new composite indexes materially improve the hot join path, but this query shape is not fully covered without a deeper schema change or denormalized access path, which the audit already hinted at.

## Incomplete Items

- None.
