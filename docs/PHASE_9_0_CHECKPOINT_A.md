# Phase 9.0 Checkpoint A

## Baseline

- Worktree repo root: `/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-90/vellum/vellum`
- `HEAD`: `e3261d9`
- `worker/tests/`: absent before Phase E

## Scope completed

- Added duplicate-family rejection to `ZOD_SCHEMAS.leave_imprint`
- Added duplicate-family rejection to `ZOD_SCHEMAS.weave`
- Deduped witness families before warmth writes
- Switched witness warmth-error analytics to deduped family lists
- Switched witness accepted analytics to deduped family lists

## Verification

### `bunx tsc --noEmit`

Status: clean

### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

### `cd app && bunx tsc --noEmit`

Status: clean

### `git diff --stat`

Status: expected scope

```text
 vellum/worker/src/index.ts | 17 ++++++++++++-----
 1 file changed, 12 insertions(+), 5 deletions(-)
```

## Files touched

- `worker/src/index.ts`

## LOC delta

- `worker/src/index.ts`: `+12 / -5`

## Judgment calls

- None. The Phase A changes match the spec directly: inline zod refines plus witness-side dedupe after family validation.

## Surprises

- None. The diff stayed confined to `worker/src/index.ts`, and the verification surface stayed green after the edit.

## Out-of-scope urges

- None acted on.

## Deviations

- None.

## Phase B

### Scope completed

- Added `STATE_DIRTY_KEY`, `ATMOSPHERE_DIRTY_KEY`, and `DIRTY_MARKER_TTL_S`
- Replaced the simple lock helper with a dirty-aware `rebuildWithLockAndDirty`
- Widened `rebuildStateProjectionIfNotLocked` to return `'locked' | 'rebuilt' | 'rebuilt-twice'`
- Widened `rebuildAtmosphereIfNotLocked` to return `'locked' | 'rebuilt' | 'rebuilt-twice'`
- Left `worker/src/tools/*.ts` unchanged, per spec

### Verification

#### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

#### `git diff --stat`

Status: expected cumulative scope

```text
 vellum/worker/src/cache.ts | 34 +++++++++++++++++++++++++++-------
 vellum/worker/src/index.ts | 17 ++++++++++++-----
 2 files changed, 39 insertions(+), 12 deletions(-)
```

#### `git diff --stat -- worker/src/tools`

Status: clean

```text
(no output)
```

### Files touched in Phase B

- `worker/src/cache.ts`

### LOC delta

- `worker/src/cache.ts`: `+27 / -7`

### Judgment calls

- Kept the dirty-aware helper local to `worker/src/cache.ts` and preserved the existing public wrapper names. That keeps the call-site diff at zero, which is exactly what the spec wanted for Phase B.

### Surprises

- None. The widened union type did not force any extra edits in callers.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase C

### Scope completed

- Imported `rebuildStateProjectionIfNotLocked` into `worker/src/index.ts`
- Extended `handleWitness` to accept `ctx: ExecutionContext`
- Routed `/api/witness` through the new `handleWitness(request, env, ctx)` signature
- Added the coalesced projection rebuild trigger via `ctx.waitUntil(...)` after successful warmth updates

### Verification

#### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

#### `cd worker && bun run deploy --dry-run`

Status: clean

Key output:

```text
Total Upload: 382.88 KiB / gzip: 93.65 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

#### `git grep -n "rebuildStateProjectionIfNotLocked" worker/src/`

Status: expected after Phase D consolidation

```text
worker/src/cache.ts:281:export async function rebuildStateProjectionIfNotLocked(db: D1Database, kv: KVNamespace): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
worker/src/index.ts:9:import { rebuildStateProjection, rebuildAll, rebuildStateProjectionIfNotLocked } from './cache'
worker/src/index.ts:428:      rebuildStatus = await rebuildStateProjectionIfNotLocked(env.DB, env.KV)
worker/src/index.ts:445:        rebuildStateProjectionIfNotLocked(env.DB, env.KV)
worker/src/index.ts:515:      rebuildStateProjectionIfNotLocked(env.DB, env.KV)
worker/src/tools/leave-imprint.ts:4:import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
worker/src/tools/leave-imprint.ts:51:  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
worker/src/tools/weave.ts:4:import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
worker/src/tools/weave.ts:88:    try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
worker/src/tools/weave.ts:137:  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
```

### Files touched in Phase C

- `worker/src/index.ts`

### LOC delta

- Captured in the cumulative Phase D diff below, since Phases C and D were implemented in one `index.ts` pass.

### Judgment calls

- Kept the witness rebuild trigger inside the existing warmth-write `try` block exactly as specified, so rebuilds only queue after successful warmth persistence.

### Surprises

- None in code. The only wrinkle is reporting: because this checkpoint file also records Phase D, the helper grep now includes the two `handleState` read-path call sites introduced in D, not just the four write-path uses from C.

### Out-of-scope urges

- None acted on.

### Deviations

- The Phase C grep was captured after the Phase D consolidation landed in the same worktree. The write-trigger surface is still the intended four call sites (`leave-imprint` x1, `weave` x2, `handleWitness` x1), but the raw grep now also includes the helper definition, imports, and the two `handleState` read-path uses added in D.

## Phase D

### Scope completed

- Deleted the duplicate `rebuildStateProjectionWithLock` wrapper from `worker/src/index.ts`
- Removed `STATE_CACHE_LOCK_KEY` and `STATE_CACHE_LOCK_TTL_S` from `worker/src/index.ts`
- Switched both `handleState` rebuild paths to `rebuildStateProjectionIfNotLocked(env.DB, env.KV)`
- Re-homed the `cache_rebuild` analytics around the consolidated helper in `handleState`
- Added `computed_at` guards to both `rebuildStateProjection` and `rebuildAtmosphere`

### Verification

#### `grep -rn "STATE_CACHE_LOCK_KEY\|STATE_CACHE_LOCK_TTL_S\|rebuildStateProjectionWithLock" worker/src/`

Status: clean

```text
(no output)
```

#### `git grep "state:rebuild:lock" worker/src/`

Status: clean

```text
worker/src/cache.ts:const STATE_REBUILD_LOCK_KEY = 'state:rebuild:lock'
```

#### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

#### `git diff --stat`

Status: expected cumulative scope at end of Phase D

```text
 vellum/worker/src/cache.ts | 48 ++++++++++++++++++++++++++-----
 vellum/worker/src/index.ts | 71 ++++++++++++++++++++++++----------------------
 2 files changed, 78 insertions(+), 41 deletions(-)
```

### Files touched in Phase D

- `worker/src/index.ts`
- `worker/src/cache.ts`

### Judgment calls

- Preserved the existing inline rebuild on a cold `/api/state` miss. The consolidation only replaced the two lock-wrapped paths, matching the spec and avoiding behavioral drift on cold start.

### Surprises

- None. The consolidated helper and the `computed_at` guards typechecked and dry-ran without needing extra call-site edits.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase E

### Scope completed

- Added worker test scripts to `worker/package.json`
- Added a hand-rolled mock layer in `worker/tests/mocks.ts`
- Added `worker/tests/dedupe.test.ts`
- Added `worker/tests/rebuild-lock.test.ts`
- Added `worker/tests/witness-rebuild.test.ts`
- Used a narrow export from `worker/src/index.ts` for `ZOD_SCHEMAS` and `handleWitness`

### Verification

#### `cd worker && bun test tests/`

Status: clean

```text
13 pass
0 fail
Ran 13 tests across 3 files.
```

#### Test file paths and case counts

- `worker/tests/dedupe.test.ts`: 5 cases
- `worker/tests/rebuild-lock.test.ts`: 4 cases
- `worker/tests/witness-rebuild.test.ts`: 4 cases

#### Mock LOC total

```text
246 worker/tests/mocks.ts
72 worker/tests/dedupe.test.ts
61 worker/tests/rebuild-lock.test.ts
86 worker/tests/witness-rebuild.test.ts
585 total
```

### Files touched in Phase E

- `worker/package.json`
- `worker/src/index.ts`
- `worker/tests/mocks.ts`
- `worker/tests/dedupe.test.ts`
- `worker/tests/rebuild-lock.test.ts`
- `worker/tests/witness-rebuild.test.ts`

### Judgment calls

- Chose the narrow-export path from `worker/src/index.ts` rather than introducing `worker/src/_testable.ts`. In this worktree, that kept the diff smaller and bun:test imported the module cleanly.

### Surprises

- `handleWitness` failure-path tests emit the existing `console.error('Warmth update failed:', e)` line during the intentional failure case. That is expected behavior from the production handler, not extra logging added for tests.

### Out-of-scope urges

- None acted on.

### Deviations

- The spec examples for T1/T3 used family names like `song`, but the actual worker enum is fixed to `attention`, `silence`, `space`, `ephemeral`, `memory`, and `light`. The tests substitute valid family names (`silence`, `light`) so they exercise duplicate-handling rather than enum rejection.
- No `_testable.ts` shim was needed, so none was added.
- No test had to be weakened from the spec.
