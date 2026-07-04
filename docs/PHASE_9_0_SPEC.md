# Vellum Phase 9.0 — Worker correctness hardening

**Status**: ready to execute
**Worktree**: cut a fresh worktree from main at the commit that adds this spec. Recommended path:
  `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-90/vellum`
  Branch: `feat/phase-9-0-worker-correctness`
**Executor**: the Codex instance that produced the 2026-04-09 audit is the preferred executor — context is already warm on the exact files this phase touches. A fresh instance also works; the spec is self-contained.
**Stop-before-commit**: YES. The human commits. Do NOT run `git commit` from inside the Codex sandbox.
**Main-branch policy**: do NOT push. Do NOT deploy. The human owns those steps.

## Motivation

The Phase 8.7b landing closed the model-identity write-surface asymmetry and wrapped up the P1..P7 → 8.5 → 8.6 → 8.7 → 8.7b hardening arc. A full post-arc audit (2026-04-09) then surfaced seven correctness findings, four of which are in the worker write pipeline and are load-bearing for the "write commits → readers see it" contract that everything downstream (ext-app emergence, resonance, witness→warmth feedback) depends on.

Phase 9.0 closes the four worker-side correctness gaps and adds a small, durable test suite under `worker/tests/` so regressions in these areas are caught mechanically instead of by future audits. Renderer, ext-app, build-infra, and modularization findings are deferred to Phase 9.1 — that phase is bigger and cross-cutting, and it benefits from 9.0 being landed and stable first.

## Audit findings addressed in this phase

| # | Severity | Summary | Task |
|---|---|---|---|
| F7 | High | Duplicate family input in `leave_imprint`/`weave` causes D1 batch UNIQUE violation → whole write rolled back. Witness separately double-counts warmth. Schema PK is `(voice_id, family)` — not `(voice_id, ordinal)`. | A |
| F2 | High | `rebuildStateProjectionIfNotLocked` returns `'locked'` when a rebuild is in flight; write tools discard the return. A committed voice can miss the projection until the next write or 10-min stale window. | B |
| F1 | High | `handleWitness` updates D1 warmth but never rebuilds the projection. Warmth updates are invisible to readers for up to 10 minutes, breaking the dwell→warmth feedback loop. | C |
| F3 | Medium | Two duplicate lock wrappers share KV key `'state:rebuild:lock'`: `rebuildStateProjectionWithLock` in `worker/src/index.ts` and `rebuildStateProjectionIfNotLocked` in `worker/src/cache.ts`. TOCTOU race allows a slow rebuild from an older snapshot to clobber a newer projection. | D |

Findings F4 (ext-app hardcoded prod URL), F5 (`isLineRTL` same-segment wrap), F6 (resonance leak), M1/M2/M3 (modularization, deploy collapse, verify script) are out of scope for 9.0 and will be picked up in 9.1.

## Non-goals

- **No migration.** The schema is frozen. If you think you need a new migration, stop — you are lost.
- **No renderer changes.** `src/**` and `app/**` are untouched by this phase. Renderer fixes are deferred to 9.1.
- **No worker modularization.** `worker/src/index.ts` stays monolithic for this phase. The split is deferred to 9.1.
- **No new npm/bun dependencies.** Not even a mocking framework. Use bun:test + hand-rolled mocks.
- **No wire-format changes.** MCP tool schemas gain a zod refine but no new fields, no new response shapes. `/api/witness` response unchanged.
- **No `parseModel()` changes.** Unchanged.
- **No cache-envelope changes.** The `StateResponse` shape is frozen; only the conditions under which it is rebuilt change.
- **No KV-TTL changes.** The 60s minimum still applies; nothing in this phase asks KV to do sub-60s work.

## Current baseline (what you are starting from)

At main @ `b86edab` (or whatever the commit is that adds this spec):
- `bun test tests/loom/` → `82 pass, 0 fail`, 19 files
- `bunx tsc --noEmit` (root) → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd app && bunx tsc --noEmit` → clean
- `bun run build` → `dist/main.js` = `69884` bytes
- Remote D1 migrations applied: `0001_init`, `0002_warmth_state`, `0003_identity_and_indexes`, `0004_declared_model`
- Live version: `vellum.linxule.com` at `d3860594-0b58-4803-bf9c-04458adc03fd`
- `worker/tests/` does not exist yet — this phase creates it.

If any of these baselines differ when you start, STOP and report — something drifted.

## Files Codex is allowed to touch

- `worker/src/index.ts`
- `worker/src/cache.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/weave.ts`
- `worker/src/utils.ts` (only if a new helper is genuinely required; prefer adding helpers to `cache.ts` instead)
- `worker/tests/**` (new directory + new test files + mocks)
- `worker/package.json` (add `test` and `test:watch` scripts)
- `worker/tsconfig.json` (only if tests otherwise fail to type-check)
- `docs/PHASE_9_0_CHECKPOINT_A.md`, `docs/PHASE_9_0_CHECKPOINT_B.md`, `docs/PHASE_9_0_HANDOFF.md`

## Files Codex must NOT touch

- Anything under `src/loom/**`, `src/main.ts`, `src/content.ts`, `src/loom.ts`
- Anything under `app/**`
- Any migration under `worker/migrations/**`
- `worker/src/types.ts` (type shapes are stable; if you think a new type is needed, add it locally inside the file that uses it)
- `worker/wrangler.toml`
- Root `package.json`
- Root `tsconfig.json`
- `CLAUDE.md`
- Anything under `docs/` other than the three 9.0 files listed above

## Context pointers (read before writing code)

- `worker/src/index.ts:241-260` — existing `rebuildStateProjectionWithLock`. Delete this in Task D.
- `worker/src/index.ts:277` — `const observedClientFamily = parseModel(...)`. Do not touch.
- `worker/src/index.ts:106-117` — `ZOD_SCHEMAS.leave_imprint` and `ZOD_SCHEMAS.weave`. Task A edits both.
- `worker/src/index.ts:473-526` — `handleWitness`. Tasks A and C both edit this.
- `worker/src/index.ts:661-663` — the `/api/witness` router entry. Task C updates the call signature.
- `worker/src/cache.ts:230-253` — `rebuildWithLock`, `rebuildStateProjectionIfNotLocked`, `rebuildAtmosphereIfNotLocked`. Task B refactors the inner helper; Task D adds the `computed_at` guard inside `rebuildStateProjection`/`rebuildAtmosphere`.
- `worker/src/cache.ts:13-134` — `rebuildStateProjection`. Task D adds the `computed_at` guard just before the final `kv.put`.
- `worker/src/cache.ts:136-228` — `rebuildAtmosphere`. Symmetric guard.
- `worker/src/tools/leave-imprint.ts:51` — `await rebuildStateProjectionIfNotLocked(...)`. Unchanged — Task B changes the helper's internal behavior so this call auto-queues a follow-up rebuild.
- `worker/src/tools/weave.ts:88, 137` — same pattern, both INSERT paths. Unchanged for the same reason.
- `worker/migrations/0001_init.sql:22-28` — `voice_families (voice_id, family, ordinal)` with `PRIMARY KEY (voice_id, family)`. This is the schema fact that makes Task A a High rather than a Medium.
- `worker/src/utils.ts:97-128` — `checkAndIncrementRateLimit`. Relevant to Task E's witness test rigging, not edited.
- `vellum/docs/PHASE_8_7B_SPEC.md` — format and tone reference for this spec and for your CHECKPOINT + HANDOFF files.
- `vellum/CLAUDE.md` — "Write-then-rebuild isolation" gotcha describes the current contract this phase tightens.

## Execution phases

### Phase A — Duplicate family input (finding F7)

**Problem.** `voice_families` PK is `(voice_id, family)`. If a client sends `families=['song','song']`, the second INSERT in the D1 batch throws a UNIQUE violation, and because D1 batches are atomic, the entire write rolls back. The user sees "The space is busy, try again", and any AI client retrying with the same payload loops forever. Witness separately double-counts warmth if duplicates reach the endpoint. Zod currently does not dedupe.

#### A1 — Zod refine on both write schemas

**File**: `worker/src/index.ts`

**Locate**: `ZOD_SCHEMAS.leave_imprint` (around line 106) and `ZOD_SCHEMAS.weave` (around line 111).

**Change**: replace the `families` line in BOTH schemas from:

```ts
families: z.array(familyEnum).min(1).max(3),
```

to:

```ts
families: z.array(familyEnum).min(1).max(3)
  .refine(arr => new Set(arr).size === arr.length, {
    message: 'families must be unique',
  }),
```

Both schemas get the same refine. Do not hoist the refine into a shared constant unless it is trivially reusable — the two inline definitions are fine and match the existing style.

Do NOT touch the `familyEnum` definition. Do NOT add the refine to `witness` validation in the router — that branch is handled separately in A2 because the witness endpoint uses ad-hoc JSON parsing, not zod.

#### A2 — Witness endpoint dedupe

**File**: `worker/src/index.ts`

**Locate**: `handleWitness` at around line 473. Find the block that builds the `families` array from the request body (around line 483-487):

```ts
const families = Array.isArray(body?.families)
  ? body.families
  : typeof body?.family === 'string'
    ? [body.family]
    : []
```

**Add**, immediately after the existing family-validity check at around line 492-494 (the one that returns `invalid_family`), a dedupe step:

```ts
const uniqueFamilies = Array.from(new Set(families))
```

**Update** the `updateWarmth` loop at around line 512-514 to iterate `uniqueFamilies` instead of `families`:

```ts
for (const family of uniqueFamilies) {
  await updateWarmth(env.DB, family, clampedDwell)
}
```

**Update** the two analytics blobs at lines 517 and 522 to use `uniqueFamilies.join(',')` instead of `families.join(',')`, so the analytics stream reflects the actual warmth writes.

Do NOT change the rate-limit branch — the rate limit is per-IP, not per-family, so duplicates don't inflate quota.

#### A3 — Phase A checkpoint

Write `docs/PHASE_9_0_CHECKPOINT_A.md` with:
- Files touched (expected: `worker/src/index.ts` only for Phase A)
- LOC delta
- Any judgment calls
- Any surprises

STOP and wait unless the human said to run through.

### Phase B — Dirty-marker rebuild queueing (finding F2)

**Problem.** `rebuildStateProjectionIfNotLocked` returns `'locked'` if another rebuild is in flight; the call sites in `leave-imprint.ts` and `weave.ts` discard the return. A voice committed while another rebuild is in progress can sit unprojected until the next write or the 10-min stale window.

#### B1 — Dirty marker constants

**File**: `worker/src/cache.ts`

**Add** near the existing lock constants (line 7-9):

```ts
const STATE_DIRTY_KEY = 'state:rebuild:dirty'
const ATMOSPHERE_DIRTY_KEY = 'atmosphere:rebuild:dirty'
const DIRTY_MARKER_TTL_S = 300
```

#### B2 — Refactor `rebuildWithLock` into a dirty-aware loop

**File**: `worker/src/cache.ts`

**Locate**: `rebuildWithLock` at lines 230-245.

**Replace** with:

```ts
async function rebuildWithLockAndDirty(
  kv: KVNamespace,
  lockKey: string,
  dirtyKey: string,
  rebuild: () => Promise<void>,
): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  const lock = await kv.get(lockKey)
  if (lock) {
    // Signal to the lock-holder that state is dirty after its current snapshot.
    // Idempotent: multiple concurrent 'locked' callers all write the same marker.
    await kv.put(dirtyKey, '1', { expirationTtl: DIRTY_MARKER_TTL_S })
    return 'locked'
  }

  await kv.put(lockKey, '1', { expirationTtl: REBUILD_LOCK_TTL_S })
  try {
    // Clear any marker that was written before we grabbed the lock. Any
    // marker that lands AFTER this delete but BEFORE we finish rebuild is
    // the interesting case: our snapshot may predate the write that set it,
    // so we re-run.
    await kv.delete(dirtyKey)
    await rebuild()
    const dirtyAfter = await kv.get(dirtyKey)
    if (dirtyAfter) {
      await kv.delete(dirtyKey)
      await rebuild()
      return 'rebuilt-twice'
    }
    return 'rebuilt'
  } finally {
    await kv.delete(lockKey)
  }
}
```

Rename is intentional — the old `rebuildWithLock` function name goes away, and all callers move to the new signature.

#### B3 — Update the two public wrappers

**File**: `worker/src/cache.ts`

**Locate**: `rebuildStateProjectionIfNotLocked` and `rebuildAtmosphereIfNotLocked` at lines 247-253.

**Replace** with:

```ts
export async function rebuildStateProjectionIfNotLocked(db: D1Database, kv: KVNamespace): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  return rebuildWithLockAndDirty(kv, STATE_REBUILD_LOCK_KEY, STATE_DIRTY_KEY, () => rebuildStateProjection(db, kv))
}

export async function rebuildAtmosphereIfNotLocked(db: D1Database, kv: KVNamespace): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  return rebuildWithLockAndDirty(kv, ATMOSPHERE_REBUILD_LOCK_KEY, ATMOSPHERE_DIRTY_KEY, () => rebuildAtmosphere(db, kv))
}
```

The return type widens from `'locked' | 'rebuilt'` to `'locked' | 'rebuilt' | 'rebuilt-twice'`. Any caller that pattern-matches on the return value must still work — check the Task D hits.

#### B4 — Call sites

The call sites in `worker/src/tools/leave-imprint.ts:51` and `worker/src/tools/weave.ts:88, 137` are UNCHANGED. The wider union type is subsumed by the existing `try { await ... }` blocks because they discard the return value.

Do NOT change these files in Phase B. Verify them with `git diff --stat` — any change to tools/*.ts in this phase is a scope violation unless justified in the checkpoint.

#### B5 — Phase B checkpoint

Write an update to `docs/PHASE_9_0_CHECKPOINT_A.md` OR a new `docs/PHASE_9_0_CHECKPOINT_B.md` (your call — prefer appending if the deltas are small). Include the same verification surface as A.

### Phase C — Witness triggers projection rebuild (finding F1)

**Problem.** `handleWitness` updates D1 warmth but never rebuilds the projection. The cached projection emits `warmth` into `ThreadData` (cache.ts:121), so warmth updates stay invisible for up to 10 minutes.

#### C1 — Import `rebuildStateProjectionIfNotLocked` in index.ts

**File**: `worker/src/index.ts`

**Locate**: the existing import (around line 9):

```ts
import { rebuildStateProjection, rebuildAll } from './cache'
```

**Change** to:

```ts
import { rebuildStateProjection, rebuildAll, rebuildStateProjectionIfNotLocked } from './cache'
```

#### C2 — Extend `handleWitness` signature

**File**: `worker/src/index.ts`

**Locate**: `handleWitness` declaration at line 473 and its router entry at line 662.

**Change declaration** from:

```ts
async function handleWitness(request: Request, env: Env): Promise<Response> {
```

to:

```ts
async function handleWitness(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

**Change router entry** at line 662 from:

```ts
return handleWitness(request, env)
```

to:

```ts
return handleWitness(request, env, ctx)
```

The `ctx` parameter is already available in the outer `fetch` handler (line 631).

#### C3 — Coalesced rebuild trigger

**File**: `worker/src/index.ts`

**Locate**: inside `handleWitness`, immediately AFTER the `updateWarmth` loop (line 512-514 in the baseline) and BEFORE the `trackAnalytics(... 'accepted' ...)` call at line 522.

**Insert**:

```ts
// Warmth is emitted into the cached projection (cache.ts). Without this
// trigger, witness updates are invisible for up to STATE_CACHE_STALE_MS.
// Coalesced by the lock + dirty marker — contention just sets the marker.
// Not awaited: witness must stay a fast path (sub-50ms).
ctx.waitUntil(
  rebuildStateProjectionIfNotLocked(env.DB, env.KV)
    .catch(e => console.error('Witness rebuild failed:', e))
)
```

The rebuild trigger lives INSIDE the try/catch block that wraps the warmth write loop, AFTER the loop succeeds. If warmth fails, the early return at line 517-521 fires and the rebuild is NOT triggered — this is intentional, we don't want to rebuild on nothing.

#### C4 — Phase C checkpoint

Add a Phase C section to the checkpoint file. Verify:
- `cd worker && bunx tsc --noEmit` clean
- `cd worker && bun run deploy --dry-run` clean
- `git grep "rebuildStateProjectionIfNotLocked" worker/src/` shows four call sites: leave-imprint.ts (1), weave.ts (2), index.ts (1 new in handleWitness).

### Phase D — Lock consolidation + `computed_at` guard (finding F3)

**Problem.** Two lock implementations share KV key `'state:rebuild:lock'`: one in `worker/src/index.ts` (`rebuildStateProjectionWithLock`) used by `handleState`, and one in `worker/src/cache.ts` (`rebuildStateProjectionIfNotLocked`) used by the write tools (and Phase C's witness trigger). They do not coordinate — they just happen to use the same string. Also, a slow rebuild from an older D1 snapshot can clobber a newer projection.

#### D1 — Delete `rebuildStateProjectionWithLock` from index.ts

**File**: `worker/src/index.ts`

**Delete**:
- The three lock constants at lines 15-17: `STATE_CACHE_STALE_MS`, `STATE_CACHE_LOCK_KEY`, `STATE_CACHE_LOCK_TTL_S`. **Exception**: `STATE_CACHE_STALE_MS` is used by `handleState` and `handleAdmin` and must STAY. Only delete `STATE_CACHE_LOCK_KEY` and `STATE_CACHE_LOCK_TTL_S`.
- The `rebuildStateProjectionWithLock` function at lines 241-260.

#### D2 — Update `handleState` to use the consolidated helper

**File**: `worker/src/index.ts`

**Locate**: `handleState` at lines 429-471, specifically the two call sites for `rebuildStateProjectionWithLock`:
- Line 442 inside the `forceRefresh` branch
- Line 453 inside the stale-served `ctx.waitUntil` branch

**Change both** call sites from `rebuildStateProjectionWithLock(env)` to `rebuildStateProjectionIfNotLocked(env.DB, env.KV)`.

**Preserve the analytics emissions** that the old function inlined. Emit them inline around the call site now:

For the forceRefresh branch (currently line 442-448):

```ts
} else if (forceRefresh) {
  analyticsState = 'force-refresh'
  const startedAt = Date.now()
  let rebuildStatus: 'locked' | 'rebuilt' | 'rebuilt-twice'
  try {
    rebuildStatus = await rebuildStateProjectionIfNotLocked(env.DB, env.KV)
    trackAnalytics(env, ['cache_rebuild', 'state', rebuildStatus], [Date.now() - startedAt])
  } catch (error) {
    trackAnalytics(env, ['cache_rebuild', 'state', 'error'], [Date.now() - startedAt])
    throw error
  }
  if (rebuildStatus === 'rebuilt' || rebuildStatus === 'rebuilt-twice') {
    projection = await env.KV.get<StateResponse>('state:projection', 'json')
    analyticsState = 'force-refreshed'
  } else {
    analyticsState = 'force-locked'
  }
}
```

For the stale-served branch (currently line 451-456):

```ts
if (ageMs > STATE_CACHE_STALE_MS) {
  analyticsState = 'stale-served'
  ctx.waitUntil(
    rebuildStateProjectionIfNotLocked(env.DB, env.KV)
      .catch(e => console.error('Background state rebuild failed:', e))
  )
}
```

The analytics dimension now reports `'locked'`, `'rebuilt'`, `'rebuilt-twice'`, or `'error'` — this is a useful observability win and is acceptable as a widening.

#### D3 — `computed_at` guard in `rebuildStateProjection`

**File**: `worker/src/cache.ts`

**Locate**: the `rebuildStateProjection` function, specifically the `kv.put('state:projection', ...)` call at lines 129-133.

**Insert**, immediately before the `kv.put`:

```ts
// Guard against clobbering a newer projection. A slow rebuild with an
// older D1 snapshot should not overwrite a newer one committed while we
// were computing. Self-heals on the next rebuild trigger.
const existing = await kv.get<StateResponse>('state:projection', 'json')
if (existing && existing.computed_at > now) {
  return
}
```

The `now` variable is already captured at the top of the function (line 14) and represents the start of this rebuild's snapshot. It is the correct comparison point.

#### D4 — `computed_at` guard in `rebuildAtmosphere`

**File**: `worker/src/cache.ts`

**Locate**: the `rebuildAtmosphere` function, specifically the `kv.put('atmosphere', ...)` call at lines 227-228.

**Insert**, immediately before the `kv.put`:

```ts
// Symmetric guard with rebuildStateProjection — see comment above.
const existing = await kv.get<{ computed_at: number }>('atmosphere', 'json')
if (existing && existing.computed_at > now) {
  return
}
```

The `now` variable is captured at line 137 of `rebuildAtmosphere`.

#### D5 — Phase D checkpoint

Add a Phase D section to the checkpoint. Verify:
- `grep -rn "STATE_CACHE_LOCK_KEY\|STATE_CACHE_LOCK_TTL_S\|rebuildStateProjectionWithLock" worker/src/` returns zero results.
- The KV lock key string `'state:rebuild:lock'` now appears exactly once in `worker/src/` — inside `STATE_REBUILD_LOCK_KEY` in cache.ts.
- Type-check is green.
- `git diff --stat` shows `worker/src/index.ts` and `worker/src/cache.ts` for Phase D.

### Phase E — Worker test suite (T1, T2, T3)

**Scope.** Create `worker/tests/` with three test files and a shared mocks file. No new dependencies. Use bun:test (already available via the bun toolchain). No miniflare, no vitest, no cloudflare emulators.

#### E0 — Tsconfig / package wiring

**File**: `worker/package.json`

**Add** to the scripts block:

```json
"test": "bun test tests/",
"test:watch": "bun test tests/ --watch"
```

**File**: `worker/tsconfig.json`

Only edit if the test files don't type-check out of the box. The most likely friction is `types` / `lib` / `include`. If you add anything, document it in the checkpoint. Prefer leaving this file alone.

#### E1 — Mocks

**File**: `worker/tests/mocks.ts` (new)

Build hand-rolled mocks. Keep them tight — minimum needed to exercise the tests.

**`MockKV`** — class implementing the subset of `KVNamespace` we touch:
- `get<T>(key, type?: 'json'): Promise<T | null>`
- `put(key, value, opts?: { expirationTtl?: number }): Promise<void>`
- `delete(key): Promise<void>`
- Internal `Map<string, {value: string, expiresAt: number | null}>`
- Expose `_getRaw(key)` and `_getAll()` for test assertions
- Optional `injectDelay(key, ms)` hook so tests can simulate a slow `get` on a specific key (used to rig contention in T2)

**`MockD1`** — class implementing the subset we touch:
- `prepare(sql): MockStatement`
- `batch(statements): Promise<...>`
- Internal tables: `voices`, `voice_families`, `weave_log`, `warmth_state`, `rate_limits` — each as a row array
- `MockStatement.bind(...args).run()` / `.first<T>()` / `.all()`
- Handle only the SQL shapes the tests actually execute. When a test hits an unexpected SQL, throw a loud "Mock D1 does not handle: <sql>" error.

**`MockExecutionContext`** — captures `waitUntil` promises:
- `waitUntil(p: Promise<unknown>)` — push into internal array
- `async drain()` — await all captured promises, including any added during drain (loop until empty)
- Expose `waitUntilCalls` for test assertions

**`MockAnalytics`** — implements `writeDataPoint`, captures into array. Wire into Env via test helper.

**`makeTestEnv()`** — returns a full `Env` shape: `{ DB: MockD1, KV: MockKV, ANALYTICS: MockAnalytics, ADMIN_KEY: 'test-secret', ... }`. Everything else stubbed to an object that throws on access.

Keep mocks under ~300 lines. If they start growing past that, stop and flag in the checkpoint — we may need a scope discussion.

#### E2 — T1: duplicate family rejection

**File**: `worker/tests/dedupe.test.ts` (new)

Cases:

1. **leave_imprint zod rejects duplicate families**
   - Import `ZOD_SCHEMAS` — note this may require exporting it from index.ts. If so, add a narrow export of just `ZOD_SCHEMAS` near the existing TOOL_DEFINITIONS export. Alternative: re-declare a minimal test schema — prefer the export.
   - Call `ZOD_SCHEMAS.leave_imprint.safeParse({ text: 'x', families: ['song', 'song'] })` → `success === false`, error message contains `'families must be unique'`.

2. **weave zod rejects duplicate families**
   - Same pattern with `families: ['light', 'light', 'light']`.

3. **valid unique families still parse**
   - `families: ['song', 'light']` → `success === true`.

4. **handleWitness dedupes duplicate families** (functional test)
   - Build MockD1 with rate_limits and warmth_state tables. Build MockKV empty.
   - Craft a `Request` with JSON body `{ families: ['song', 'song'], dwell_s: 5 }`.
   - Call `handleWitness(req, env, ctx)`.
   - Assert warmth_state has exactly ONE update for `'song'` (not two).
   - Assert the analytics blob contains `'song'` not `'song,song'`.

5. **handleWitness dedupes mixed duplicates**
   - `{ families: ['song', 'light', 'song'], dwell_s: 5 }` → warmth_state has one update each for `song` and `light`, not two for `song`.

handleWitness is not exported — add a narrow `export { handleWitness }` in index.ts if needed, or import via a test-specific re-export module. Prefer the narrow export.

#### E3 — T2: dirty-marker rebuild queueing

**File**: `worker/tests/rebuild-lock.test.ts` (new)

Cases:

1. **Single rebuild returns 'rebuilt'**
   - Fresh MockKV, MockD1 stubbed to return empty results for all projection queries.
   - Call `rebuildStateProjectionIfNotLocked(db, kv)` → `'rebuilt'`.
   - Lock key absent, dirty key absent, projection key present.

2. **Concurrent rebuilds with a dirty signal**
   - Rig: inject a 20ms delay into MockKV's `put('state:projection', ...)` to make the rebuild take at least 20ms.
   - Start rebuild A (don't await).
   - Wait 5ms. Start rebuild B (don't await). Assert B returned `'locked'` (by awaiting B's promise).
   - Await A's promise. Assert A returned `'rebuilt-twice'`.
   - Rebuild function was invoked exactly 2 times (A's first pass + A's second pass), NOT 3. Measure via a counter passed through the mock DB.
   - Dirty key is absent at the end.
   - Lock key is absent at the end.

3. **Multiple queued dirty signals collapse to one follow-up**
   - Rig: same 20ms delay.
   - Start rebuild A (don't await).
   - Start rebuilds B, C, D sequentially. All return `'locked'`.
   - Await A. It returns `'rebuilt-twice'`.
   - Rebuild count is 2 (not 4).
   - This proves the dirty marker collapses the queue — critical for cost control under a write flood.

4. **Rebuild before lock is taken clears pre-existing stale dirty marker**
   - Rig: set dirty marker manually, then call `rebuildStateProjectionIfNotLocked`.
   - After the call: rebuild ran once, final marker is absent, returned `'rebuilt'` (not `'rebuilt-twice'` — the marker was stale, not a signal of concurrent work).

If you can't get case 4 to match the spec without contorting the mock, document the deviation in the checkpoint and we'll decide whether to weaken the test or tighten the helper.

#### E4 — T3: witness triggers rebuild

**File**: `worker/tests/witness-rebuild.test.ts` (new)

Cases:

1. **Happy path: witness → rebuild waitUntil**
   - MockD1 with `warmth_state` row for `song`, `rate_limits` empty, `voices`/`voice_families` present but minimal.
   - MockKV empty.
   - Craft `POST /api/witness` request with `{ family: 'song', dwell_s: 10 }`.
   - Call `handleWitness(req, env, ctx)` → 200.
   - `ctx.waitUntilCalls` length is 1.
   - Await `ctx.drain()` → projection key is now present in MockKV.
   - warmth_state shows the 10s update applied to `song`.

2. **Rate-limited witness does NOT trigger rebuild**
   - Pre-populate `rate_limits` table with a `witness:unknown` row whose `count >= 5` and `expires_at > now`.
   - Call handleWitness → 200 with throttled body.
   - `ctx.waitUntilCalls` length is 0.
   - warmth_state UNCHANGED.

3. **Failed warmth update does NOT trigger rebuild**
   - Stub `updateWarmth` to throw via MockD1 arranging for the warmth_state UPDATE to fail.
   - Call handleWitness → 500.
   - `ctx.waitUntilCalls` length is 0.
   - (If stubbing at the function level is cleaner than via MockD1, that is acceptable — document in the checkpoint.)

4. **Dedupe crossed with rebuild**
   - `{ families: ['song', 'song'], dwell_s: 10 }` → warmth_state updated once for `song`, rebuild triggered once (`ctx.waitUntilCalls` length is 1).

#### E5 — Test runner verification

Run `cd worker && bun test tests/` and verify all three files pass, no skipped tests.

If bun:test has trouble with the TS imports from index.ts (e.g., the `pensieveHtml` text import), rig a minimal module boundary: put only the bare functions you need under test into a new `worker/src/_testable.ts` that re-exports them — or mock the HTML import. Document whichever approach you picked.

Do NOT add miniflare, vitest, or any other test framework. Do NOT add a mocking library. Hand-rolled mocks only.

#### E6 — Phase E checkpoint

Add a Phase E section to the checkpoint with:
- Test file paths and their case counts
- Mock LOC total
- Any `_testable.ts` shim you had to introduce
- Any test that had to be weakened from the spec and why

### Phase F — Handoff

Write `docs/PHASE_9_0_HANDOFF.md` with:

1. **What changed** — brief narrative: Phase A (dedupe), B (dirty marker), C (witness rebuild), D (lock consolidation + computed_at guard), E (worker tests). No migration. No renderer. No app. No build infra.

2. **Verification table** — baseline vs post-change for:
   - `bun test tests/loom/` (should still be 82 pass, 0 fail)
   - `cd worker && bun test tests/` (new — should be green)
   - `bunx tsc --noEmit` (root)
   - `bunx tsc -p worker/tsconfig.json --noEmit`
   - `cd app && bunx tsc --noEmit`
   - `bun run build` → `dist/main.js` = `69884` bytes (unchanged — worker-only phase)
   - `cd worker && bun run deploy --dry-run` clean

3. **Suggested commit structure**:
   - Commit 1: **Phase A** (dedupe) — `worker/src/index.ts` only. Small.
   - Commit 2: **Phase B** (dirty marker) — `worker/src/cache.ts` only.
   - Commit 3: **Phase C** (witness rebuild) — `worker/src/index.ts`.
   - Commit 4: **Phase D** (lock consolidation + computed_at guard) — `worker/src/index.ts` + `worker/src/cache.ts`.
   - Commit 5: **Phase E** (tests) — `worker/tests/**` + `worker/package.json`.
   - Commit 6: **docs** — `docs/PHASE_9_0_CHECKPOINT_A.md` (or B/C if split) + `docs/PHASE_9_0_HANDOFF.md`.

   Alternative collapsed form if the deltas are tiny: commits 1-4 as one "fix" commit, commit 5 as "tests", commit 6 as "docs". Use your judgment in the handoff — the human will pick.

4. **Flags for human review**:
   - Any place where the zod refine wording or error surface might affect client-facing error messages.
   - Any deviation from the exact constant names in the spec (acceptable if documented).
   - Any test case that had to be weakened.
   - The widened return type `'locked' | 'rebuilt' | 'rebuilt-twice'` — call out that existing call sites discard the value, so the widening is safe, and note the new analytics dimension in `handleState`.

5. **Open items / next phase**:
   - F4 (ext-app base URL injection)
   - F5 (isLineRTL same-segment wrap)
   - F6 (resonance expiry sweep)
   - M1 (worker/src/index.ts split)
   - M2 (shared renderer runtime between src/main.ts and app/src/mcp-app.ts)
   - M3 (deploy script collapse + verify script)

   These are intentionally deferred to Phase 9.1 and must NOT be touched in 9.0.

## Hard rules recap

1. Do not touch `src/loom/**`, `src/main.ts`, `src/content.ts`, `src/loom.ts`, or anything under `app/**`.
2. Do not create or modify migrations.
3. Do not touch `worker/src/types.ts` — add local types inside the file that uses them if needed.
4. Do not change `parseModel()`.
5. Do not modify any wire format (zod schemas can gain refines; no new fields, no removed fields).
6. Do not add new runtime dependencies. Do not add test frameworks. Hand-rolled mocks only.
7. Do not run `git commit`, `git push`, or `bun run deploy`.
8. Do not start Phase 9.1 work (M1/M2/M3, F4/F5/F6) inside this phase. If you find yourself wanting to, document the urge in the checkpoint and do not act on it.
9. Stop at each phase checkpoint with a written note. The human runs the commits, push, and deploy.

## Verification table (final, before handoff)

| Check | Command | Expected |
|---|---|---|
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit` | clean (unchanged) |
| Loom tests (baseline) | `bun test tests/loom/` | 82 pass, 0 fail |
| Worker tests (new) | `cd worker && bun test tests/` | all green |
| Renderer build | `bun run build` | `dist/main.js` = 69884 bytes |
| Worker dry-run deploy | `cd worker && bun run deploy --dry-run` | clean |
| Diff scope | `git diff --stat main` | only files listed in "allowed to touch" |
| Lock key grep | `git grep "state:rebuild:lock" worker/src/` | exactly 1 hit (cache.ts STATE_REBUILD_LOCK_KEY) |
| Old lock wrapper grep | `git grep "rebuildStateProjectionWithLock" worker/src/` | 0 hits |

## References inside the repo

- `vellum/docs/PHASE_8_7B_SPEC.md` — format and tone reference.
- `vellum/docs/PHASE_8_7_SPEC.md` — earlier format reference.
- `vellum/docs/LOOM_INVARIANTS.md` — invariants section on projection/identity layers. Not edited by this phase.
- `vellum/CLAUDE.md` — "Write-then-rebuild isolation" gotcha and "KV expirationTtl minimum is 60s" gotcha both relate to this phase.
- `vellum/worker/migrations/0001_init.sql` — the voice_families PK fact behind Task A.
