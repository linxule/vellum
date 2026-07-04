# Phase 8.7 Checkpoint A

## Scope completed

- Added `worker/migrations/0004_declared_model.sql`
- Added `declared_model` to `worker/src/types.ts` `VoiceRow`
- Added `declared_model` and `observed_client_family` to worker `VoiceData`
- Added optional free-form `model` to `leave_imprint` JSON schema and zod schema
- Routed `leave_imprint` writes as `model` (UA-observed fallback) + `declared_model` (self-declared)
- Updated state projection queries and `VoiceData` emission to expose both identity fields

## Verification

### `cd worker && bunx wrangler d1 migrations apply vellum --local`

Status: clean

Key output:

```text
Migrations to be applied:
0001_init.sql
0002_warmth_state.sql
0003_identity_and_indexes.sql
0004_declared_model.sql

... final status:
0001_init.sql ✅
0002_warmth_state.sql ✅
0003_identity_and_indexes.sql ✅
0004_declared_model.sql ✅
```

### `cd worker && bunx tsc --noEmit`

Status: clean

### `cd worker && bun run deploy --dry-run`

Status: clean

Key output:

```text
✨ Read 4 files from the assets directory ...
Total Upload: 381.64 KiB / gzip: 93.53 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

### `bunx tsc --noEmit`

Status: clean

Note: the spec parenthetical said root `tsc` "should fail until Phase B lands"; in this worktree it remained clean after Phase A.

## Files touched

- `worker/migrations/0004_declared_model.sql`
- `worker/src/types.ts`
- `worker/src/index.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/cache.ts`

## Judgment calls

- In `worker/src/cache.ts`, I kept the SQL alias `v.model AS observed_client_family` from the spec and added a local `ProjectionVoiceRow` type so the projection stays explicit without changing the domain `VoiceRow` meaning.

## Surprises

- The only issue during verification was a worker TypeScript complaint about the aliased projection field; the local projection-row type resolved it cleanly.
- Root `tsc` did not fail after Phase A.

## Out-of-scope urges

- None acted on.
