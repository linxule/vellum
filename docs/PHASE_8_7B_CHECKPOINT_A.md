# Phase 8.7b Checkpoint A

## Scope completed

- Added optional free-form `model` to the `weave` JSON schema in `worker/src/index.ts`
- Added optional free-form `model` to the `weave` zod schema in `worker/src/index.ts`
- Renamed the `handleWeave` fourth parameter to `observedClientFamily`
- Added `model?: string` to `handleWeave` args
- Derived `declaredModel` in `handleWeave`
- Updated both weave INSERT paths to persist both `model` and `declared_model`

## Verification

### `cd worker && bunx wrangler d1 migrations apply vellum --local`

Status: clean

Key output:

```text
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
Total Upload: 382.14 KiB / gzip: 93.52 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

### `bunx tsc --noEmit`

Status: clean

### `cd app && bunx tsc --noEmit`

Status: clean

### `bun test tests/loom/`

Status: clean

```text
82 pass
0 fail
Ran 82 tests across 19 files.
```

### `bun run build && wc -c dist/main.js`

Status: clean

```text
main.js  69.88 KB
69884 dist/main.js
```

## Files touched

- `worker/src/index.ts`
- `worker/src/tools/weave.ts`

## Judgment calls

- None. This was a direct mechanical analog of Phase 8.7's `leave_imprint` wiring.

## Surprises

- None. The diff stayed at the expected two code files, and all verification checks passed on the first run.

## Out-of-scope urges

- None acted on.
