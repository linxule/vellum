# Phase 9.4 + 9.5 Spec — Post-Audit Cleanup + Support Layer Restructure

**Single spec covering two sequential Codex-executed phases.** Phase A (9.4) ships first, is reviewed and deployed, then Phase B (9.5) executes against the post-A baseline.

## Baseline anchor

- Current main: commit `7160b22` — "docs(vellum): CLAUDE.md + PATTERNS_AND_GOTCHAS — post-9.3 runtime layout"
- Live version: `b07fcced-f744-499e-93f0-8065f51c76ff` (9.3 production)
- Hardening arc state: P1..9.3 closed, but a post-9.3 three-track audit (Codex worker audit + code-reviewer agent on 9.3 DI + Cloudflare observability sweep) surfaced one real semantic bug + a set of dead-code vestiges + structural debt in the support layer.
- Audit output: `/tmp/vellum-worker-audit.md` (Codex), code-reviewer chat report in phase-arc memory (next session should re-read from prior-session context if needed).

## Why this spec exists

The audit found:

1. **Real semantic bug**: `worker/src/tools/focus.ts` ignores the `vf.ordinal = 0` primary-family rule that 11 other worker sites enforce. The `focus` MCP tool can surface voices whose primary family is different from the queried family. This is a data consistency inconsistency, not a crash.

2. **Structural debt in the older support layer**: 9.2 split the router/handler layer cleanly, but `worker/src/utils.ts` is still a 213-line junk drawer imported by 8 modules (IDs + UA sniffing + warmth + 2 rate-limit systems + mood prose + retry + YAML escape). `cache.ts` lock semantics are implicit. Write tools duplicate skeleton. `warmth.pending` field is vestigial across schema + types + admin + tests but never set to anything but 0.

3. **Trust-boundary validation gaps**: No explicit `any` in worker code, but JSON-RPC envelope is cast rather than parsed, admin body is cast without parse error handling, KV reads trust their stored shape.

4. **Dead code residue from the monolith era + the 9.2 split**: unused exports (`analyticsDayIndex`, `mcpHeaders`, `familyEnum`, `SESSION_ID_RE`, `SESSION_MAX_AGE_S`), unused `reason?` admin field, unused `ENVIRONMENT` binding, redundant zod text-length guards in write tools, dead `default` branch in MCP tool switch.

5. **Latent `/ext-app` sentinel rewrite**: the standalone fallback route in `worker/src/index.ts` serves `pensieveHtml` raw without the `__VELLUM_BASE_URL__` rewrite. Pre-existing since before 9.2. Only bites if someone hits the URL directly in a browser (not via the ext-apps SDK iframe).

6. **Renderer DI design-note**: `src/runtime/frame.ts` `scheduleNextFrame` returns a new handle each call, then the caller `Object.assign`s into a persistent `frameHandle`. Works in production because stale-ID cancels are browser no-ops, but `frameHandle.frameId` is never actually nulled — load-bearing on spec behavior and would break under strict fake-timer tests.

7. **Renderer DI micro-asymmetry**: `src/runtime/input.ts` has `lastTouchY` correctly scoped inside `attachInputHandlers` but `touchEndTimeout` at module scope. Latent test fragility.

8. **Production observability insight**: 340 historical 500s were from a pre-9.0 KV rate-limit bug already fixed in Phase 8.6. Zero exceptions on current versions. We've been blind to observability data for the whole arc. Worth adding a post-deploy sanity check.

## Scope split

### Phase A (9.4) — "post-audit cleanup: semantic consistency + dead code trim"

Surgical, mostly mechanical. Landing these first gives Phase B a cleaner foundation.

| # | Item | Severity | Files | Effort |
|---|---|---|---|---|
| A1 | `focus.ts` ordinal=0 fix + new test | HIGH | 1 src + 1 new test | Small |
| A2 | Cache contention semantics — **document, do not tighten** (Option A) | HIGH | 1 doc + 5 comment sites | Small |
| A3 | `input.ts` `touchEndTimeout` scope fix | MEDIUM | 1 file | Trivial |
| A4 | `/ext-app` sentinel rewrite | LOW | 1 file | Trivial |
| A5 | `warmth.pending` vestigial field removal (including D1 migration) | LOW | 1 migration + 5 files | Small |
| A6 | Dead exports cleanup | LOW | 5 files | Trivial |
| A7 | Unused `reason?` admin field + unused `ENVIRONMENT` binding | LOW | 3 files | Trivial |
| A8 | Redundant zod text-length guards in write tools | LOW | 2 files | Trivial |
| A9 | Dead `default` branch in `handleMCP` tool switch | LOW | 1 file | Trivial |

**Explicit non-goals for Phase A:** no utils.ts split, no runtime validation layer, no write tools consolidation, no frame.ts handle pattern rewrite. Those are Phase B.

### Phase B (9.5) — "support layer restructure"

Bigger refactors. Execute only after Phase A has landed cleanly in production.

| # | Item | Severity | Files | Effort |
|---|---|---|---|---|
| B1 | `utils.ts` split into focused modules | MEDIUM | ~8 files | Medium |
| B2 | Runtime validation layer: zod at JSON-RPC envelope + admin body + KV reads | MEDIUM | ~5 files | Medium |
| B3 | Write tools shared helper: extract `leave-imprint` + `weave` source-not-found skeleton | MEDIUM | 2-3 files | Small-Medium |
| B4 | `frame.ts` `scheduleNextFrame` handle pattern rewrite | MEDIUM | 2 files | Small |

**Explicit non-goals for Phase B:** no feature additions, no new MCP tools, no renderer loom changes, no test rewrites beyond what the restructure requires.

## Hard baseline invariants (both phases)

1. **All existing tests pass.** 87 loom + 16 worker tests = 103 minimum, Phase A adds at least 1 new focus.ts test (17+ worker minimum post-A). No test edits to `tests/loom/**` or existing `worker/tests/**` files unless a legitimate behavior change requires it — in which case flag it in the handoff.
2. **`bunx tsc --noEmit` clean** at root, worker, app.
3. **`bun run verify` clean** end-to-end.
4. **No new dependencies.** No new packages in package.json or worker/package.json.
5. **No ext-app bundle behavior changes** unless explicit (frame.ts change in B4 is the only renderer-touching item in either phase).
6. **No worker/src/index.ts router-order changes.** The narrow export surface `export { ZOD_SCHEMAS, handleWitness, handleMCP }` at the bottom is load-bearing for 4 worker test files. Do not touch.
7. **No changes to `src/loom/**`** in either phase.
8. **No changes to `src/content.ts`** in either phase.
9. **Renderer bundle tolerance**: Phase A should be net-neutral or slightly negative (dead code removal). Phase B should be within ±1% of the post-A baseline (the frame.ts change is the only renderer item and is small). Explicit tolerance: **`dist/main.js` must stay ≤ post-A baseline + 500 bytes** for Phase B.
10. **Worker bundle tolerance**: Phase A should be net-negative (dead code). Phase B is a wash (splitting doesn't change total code). Explicit: **`Total Upload` must stay within ±5 KiB of the pre-phase baseline** for each phase.

## Phase A — detailed execution plan

### A1: `focus.ts` ordinal=0 fix + new test

**The bug**: `worker/src/tools/focus.ts` lines 17-37 have three D1 queries that join `voice_families vf ON v.id = vf.voice_id WHERE vf.family = ?` with NO `vf.ordinal = 0` filter. All 11 other worker sites consistently use `AND vf.ordinal = 0`:

```
worker/src/handlers/admin.ts:20
worker/src/cache.ts:28, 35, 43, 49, 54, 161, 172, 177, 183
worker/src/tools/leave-imprint.ts:58
```

**The fix**: Add `AND vf.ordinal = 0` to all three `focus.ts` queries. That's it — no other logic changes.

**The test** (new file: `worker/tests/focus.test.ts`):
- Follow the existing worker test pattern in `worker/tests/dedupe.test.ts` for mocks and harness.
- Import `handleFocus` from `../src/tools/focus` (may require adding `handleFocus` to a narrow export in `worker/src/index.ts` OR importing directly from `tools/focus` — prefer direct import to avoid touching the index.ts narrow export, which is load-bearing for other tests).
- Seed D1 with: voice X whose primary family is `attention` (ordinal=0) and secondary family is `silence` (ordinal=1); voice Y whose primary family is `silence` (ordinal=0).
- Assert: `handleFocus({ family: 'silence' })` returns voice Y but NOT voice X.
- The assertion is "voice X is not in the returned `voices` array of the text block".

**Acceptance**: The new test passes. All 16 existing worker tests still pass.

### A2: Cache contention semantics — document

**The finding**: `cache.ts` `rebuildWithLockAndDirty` is advisory locking (KV `get` then `put`, not atomic). Callers (`handleState` force-refresh, `leave-imprint`, `weave`) treat `'locked'` as acceptable without distinguishing from `'rebuilt'`. This is actually the **correct design intent**: concurrent writers should coalesce through the dirty-marker system rather than serialize. But the acceptance is invisible in the code.

**Option A decision (confirmed)**: Document as known-acceptable. No behavior change.

**The doc**: Add a new section to `docs/PATTERNS_AND_GOTCHAS.md` titled "Cache contention semantics (Phase 9.0 + 9.4 clarification)" that explains:
- `rebuildWithLockAndDirty` lock is advisory, not atomic
- `'locked'` return value is acceptable on BOTH refresh and write paths because the dirty-marker system guarantees eventual consistency — a later concurrent caller will see the marker and re-run the rebuild once
- Post-write visibility is best-effort under contention (writer-to-reader immediate visibility is not guaranteed)
- This is the design intent from Phase 9.0, not a bug
- If a future feature needs strict post-write visibility, the fix is NOT to tighten the lock; the fix is to add a read-your-writes barrier at that specific call site

**The comments**: Add a single-line `// KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention` comment at each of these 5 call sites:
- `worker/src/handlers/state.ts` — the force-refresh branch that serves existing projection on `'locked'`
- `worker/src/tools/leave-imprint.ts` — the `rebuildStateProjectionIfNotLocked` await after the D1 insert
- `worker/src/tools/weave.ts` — the two separate `rebuildStateProjectionIfNotLocked` awaits (source-found path and source-not-found path)
- `worker/src/cache.ts` — the `rebuildWithLockAndDirty` function itself, at the `return 'locked'` branch

**Acceptance**: `bun run verify` clean. No behavior change.

### A3: `input.ts` `touchEndTimeout` scope fix

**The asymmetry**: In `src/runtime/input.ts`:
- Line 3: `let touchEndTimeout: ReturnType<typeof setTimeout> | null = null` at module scope
- Line 34: `let lastTouchY = 0` correctly inside `attachInputHandlers`
- Lines 5-10: `clearTouchEndTimeout` function at module scope, closes over module-level `touchEndTimeout`

**The fix**: Move both `touchEndTimeout` and `clearTouchEndTimeout` inside `attachInputHandlers` so they're per-call. Update the 3 handler references (`handleTouchStart`, `handleTouchMove`, `handleTouchEnd`) accordingly.

**Why**: Removes the latent test fragility. If anyone ever imports `input.ts` twice in the same JS context (e.g., testing two independent canvas instances), they won't share timeout state.

**Acceptance**: tsc clean, loom tests pass, `src/runtime/input.ts` still compiles to roughly the same bundle contribution (±20 bytes tolerance).

### A4: `/ext-app` sentinel rewrite

**The gap**: `worker/src/index.ts:68-76` serves `pensieveHtml` raw for the `/ext-app` standalone route. The `__VELLUM_BASE_URL__` sentinel is NOT rewritten. Only the MCP `resources/read` path (in `worker/src/handlers/mcp.ts`) does the rewrite.

**The fix**: In `worker/src/index.ts` the `/ext-app` branch, derive `const origin = new URL(request.url).origin` and `const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)` before returning. 3-line addition.

**Acceptance**: Manual smoke test after deploy: `curl -s https://vellum.linxule.com/ext-app | grep -c '__VELLUM_BASE_URL__'` should return 0 instead of 1. Codex cannot do this check in sandbox — Claude handles it post-deploy.

### A5: `warmth.pending` vestigial field removal

**The residue trail**: `pending` is set in migration `0002_warmth_state.sql`, declared in `worker/src/types.ts` (`WarmthState` interface), read in admin stats output at `worker/src/handlers/admin.ts:31-49`, updated in `worker/src/utils.ts` warmth functions, and referenced in `worker/tests/rebuild-lock.test.ts` mock data. The runtime **never sets it to anything other than 0**.

**The fix** (order matters):
1. Create new migration: `worker/migrations/0005_drop_warmth_pending.sql` that runs `ALTER TABLE warmth_state DROP COLUMN pending;`
2. Remove `pending` from `WarmthState` interface in `worker/src/types.ts`
3. Remove `pending` from all `SELECT` / `INSERT` / `UPDATE` queries in `worker/src/utils.ts` (the `getWarmth`, `getWarmthMap`, `updateWarmth` functions)
4. Remove `pending` from admin stats output in `worker/src/handlers/admin.ts`
5. Remove `pending` from mock data in `worker/tests/rebuild-lock.test.ts` (this is the one allowed test edit in Phase A — update the mock, do not rewrite the test logic)
6. Grep-verify no other `pending` references remain in worker code

**Acceptance**: All 16 worker tests still pass after the mock update. tsc clean. Migration applied remotely during deploy. Grep for `\bpending\b` in `worker/src/` returns zero matches.

**Migration application**: Codex writes the migration file but does NOT apply it. Claude applies it after review via `cd worker && bunx wrangler d1 migrations apply vellum --remote`.

### A6: Dead exports cleanup

**The dead exports** (flagged by Codex audit):
- `worker/src/analytics.ts` — `analyticsDayIndex` is exported but only used inside the file. Remove `export`.
- `worker/src/jsonrpc.ts` — `mcpHeaders` is exported but only used inside the file. Remove `export`.
- `worker/src/schemas.ts` — `familyEnum` is exported but not used outside the file. Remove `export`.
- `worker/src/hmac.ts` — `SESSION_ID_RE` and `SESSION_MAX_AGE_S` are exported but not used outside the file. Remove `export`.

**The fix**: Remove the `export` keyword from each. Verify no external references via grep before removing each.

**Acceptance**: tsc clean. 16 worker tests still pass.

### A7: Unused `reason?` admin field + unused `ENVIRONMENT` binding

**The unused `reason`**: `worker/src/handlers/admin.ts:71` declares `reason?: string` in the destructured admin hide request body type, but the value is never used. Remove from the type annotation.

**The unused `ENVIRONMENT`**: `worker/src/types.ts:7` (approximately) declares `ENVIRONMENT: string` on the `Env` interface, and `worker/wrangler.jsonc:49` (approximately) sets `ENVIRONMENT = "production"`, but no worker code reads `env.ENVIRONMENT`. Remove from both `types.ts` and `wrangler.jsonc`.

**Acceptance**: tsc clean. 16 worker tests still pass. No grep hits for `env.ENVIRONMENT` anywhere in worker code.

### A8: Redundant zod text-length guards

**The redundancy**: `worker/src/tools/leave-imprint.ts:10-16` and `worker/src/tools/weave.ts:45-51` have manual text-length checks that throw before the D1 insert. But `handleMCP()` already validates all tool args via `ZOD_SCHEMAS` (which include `.max(280)` or similar) BEFORE dispatching to the tool handler. So these guards are unreachable on the only public path (MCP).

**The fix**: Remove the manual length-check branches. Keep the zod validation in `ZOD_SCHEMAS` as the single source of truth.

**Acceptance**: 16 worker tests still pass. If any test directly calls `handleLeaveImprint` or `handleWeave` bypassing `handleMCP`, the test must still pass (the zod check still runs at the MCP boundary — the removed check was the one AFTER the boundary).

### A9: Dead `default` branch in `handleMCP` tool switch

**The dead code**: `worker/src/handlers/mcp.ts:123-124` (approximately) has a `default:` case in the tool switch that returns an "unknown tool" error. But the tool switch is reached only AFTER `handleMCP` has already looked up the tool in `ZOD_SCHEMAS` and rejected unknown names (`worker/src/handlers/mcp.ts:85-91` approximately). The `default` branch is structurally unreachable.

**The fix**: Remove the `default` branch. The switch becomes exhaustive over the 4 known tool names.

**Acceptance**: tsc clean (exhaustive switch should satisfy the compiler). 16 worker tests still pass.

## Phase B — detailed execution plan

Phase B executes against the post-A baseline. **Do not start Phase B until Phase A has landed on main and deployed to production.**

### B1: `utils.ts` split into focused modules

**The problem**: `worker/src/utils.ts` is 213 lines with 6 unrelated concern groups and 8 importers. It's a textbook junk drawer.

**The target structure** (new files under `worker/src/`):
- `ids.ts` — `randomString`, `voiceId`, `generateTraceId`, and the `parseModel` UA sniffer (related to identity/request context)
- `warmth.ts` — `computeWarmthValue`, `getWarmth`, `getWarmthMap`, `updateWarmth` (the D1 warmth state CAS logic, post-A7 removal of the `pending` field — assumes Phase A landed first)
- `rate-limits.ts` — `checkAndIncrementRateLimit` (D1-backed public) + `checkAndIncrementSession` (KV-backed per-session)
- `prose.ts` — `computeMood`, `warmthDesc` (atmosphere text generation)
- `helpers.ts` — `withRetry`, `yamlEscape` (generic infrastructure)

Delete `worker/src/utils.ts`. Update all 8 importers to import from the new modules.

**The 8 importers** (as of audit):
1. `worker/src/cache.ts`
2. `worker/src/handlers/state.ts`
3. `worker/src/handlers/witness.ts`
4. `worker/src/handlers/admin.ts`
5. `worker/src/handlers/mcp.ts`
6. `worker/src/tools/sense-space.ts`
7. `worker/src/tools/focus.ts`
8. `worker/src/tools/leave-imprint.ts`
9. `worker/src/tools/weave.ts`

(Recount live — the audit said 8, enumerate from a fresh `grep -l "from '../utils'" worker/src/**/*.ts` before starting B1.)

**Hard rules**:
- Pure refactor. Zero behavior changes.
- Function signatures stay identical.
- Module-level state (if any) moves with its functions.
- Test file imports update accordingly. `worker/tests/*.ts` may need import updates — this is allowed mechanical edit.

**Acceptance**: `bun run verify` clean. 16 (or post-A count) worker tests still pass. tsc clean. Grep for `from ['\"]\\.\\./utils['\"]\\|from ['\"]\\./utils['\"]` in `worker/src/` returns zero matches.

### B2: Runtime validation layer at trust boundaries

**The gaps** (from audit):
- `worker/src/handlers/mcp.ts:15-18` — `await request.json() as JsonRpcRequest` with no runtime validation. Adds a `JSON_RPC_ENVELOPE_SCHEMA` zod schema and validates before dispatching.
- `worker/src/handlers/admin.ts:70-72` — `await request.json<{voice_id, reason?}>()` cast. Adds zod validation for the admin hide body (post-A7, `reason` is already gone).
- `worker/src/handlers/witness.ts` — already better than the others (uses ad hoc narrowing) but not schema-driven. Convert to a `WITNESS_BODY_SCHEMA`.
- `worker/src/handlers/state.ts:10-16` — request parsing is already minimal (query params) but flag for any unchecked casts.
- `worker/src/tools/sense-space.ts:18-22` — any D1 cast worth narrowing.
- `worker/src/cache.ts:135-144` and `:238-244` — KV read casts (`kv.get<T>(..., 'json')`). Wrap each with a lightweight zod `.safeParse` + graceful fallback (return null cache on parse error, logs the error, triggers rebuild).

**Hard rules**:
- All new schemas live in `worker/src/schemas.ts` (the existing schema module).
- Parse errors return 400 for request bodies, null for KV reads (which triggers rebuild).
- No user-visible behavior change on valid inputs.

**Acceptance**: `bun run verify` clean. All worker tests still pass. Malformed JSON on any endpoint returns a well-formed 400 (add at least one new test case per new boundary).

### B3: Write tools shared helper

**The duplication**: `worker/src/tools/leave-imprint.ts` and the source-not-found branch of `worker/src/tools/weave.ts` share almost the same skeleton:
1. Session limit check
2. Detect language
3. Insert voices row
4. Insert voice_families row
5. Synchronous state rebuild (lock-aware)
6. Async atmosphere rebuild (lock-aware)
7. Return text payload + `_meta`

**The fix**: Extract to a shared helper, likely `worker/src/tools/_shared.ts` (underscore prefix marks it as internal to the tools directory):

```
export async function insertVoiceAndRebuild(
  env: Env, ctx: ExecutionContext,
  voice: { id, text, language, family, ...},
  sourceId?: string  // for weave path
): Promise<{ content, _meta }>
```

The exact signature is for Codex to design — just match the actual shared logic. Do not extract anything that's genuinely different between the two call sites (the session limit key differs between `imprint` and `weave`, for example).

**Hard rules**:
- Only the duplicated parts move. Unique parts stay.
- No behavior change.

**Acceptance**: All worker tests pass. The duplication grep (diff against post-A baseline) shows ~30 lines removed.

### B4: `frame.ts` `scheduleNextFrame` handle pattern rewrite

**The finding (from code-reviewer agent)**: `src/runtime/frame.ts:16-41` `scheduleNextFrame` returns a new handle object each call. The callbacks (`handle.frameId = null`, `handle.frameTimeout = null`) close over the LOCAL `handle`, not the caller's persistent `frameHandle`. Callers then `Object.assign(frameHandle, scheduleNextFrame(render))` to copy field values into `frameHandle`. Result: `frameHandle.frameId` is almost never actually nulled because the callbacks zero the wrong object. Works in production because `cancelAnimationFrame`/`clearTimeout` with stale IDs are browser no-ops.

**The fix**: Change `scheduleNextFrame` to accept the handle by reference as an output parameter instead of returning a new one. The callbacks then close over the caller's handle and null it correctly.

New signature:
```ts
export function scheduleNextFrame(
  handle: { frameId: number | null, frameTimeout: ReturnType<typeof setTimeout> | null },
  renderFn: (now: number) => void,
): void {
  if (document.hidden) {
    handle.frameTimeout = setTimeout(() => {
      handle.frameTimeout = null
      renderFn(performance.now())
    }, 100)
    return
  }
  handle.frameId = requestAnimationFrame(now => {
    handle.frameId = null
    renderFn(now)
  })
}
```

Update both entry points (`src/main.ts` and `app/src/mcp-app.ts`) to call it as `scheduleNextFrame(frameHandle, render)` instead of `Object.assign(frameHandle, scheduleNextFrame(render))`.

**Hard rules**:
- No bundle delta explosion. Expected: slight reduction because the `Object.assign` wrapper is gone.
- `clearScheduledFrame` does NOT need to change — it already mutates the handle by reference.
- Do not change any other behavior in `src/runtime/frame.ts`.

**Acceptance**: 87 loom tests pass. tsc clean. Manual smoke test (frame animation still runs, visibilitychange transitions still work) after deploy.

## Verification contracts

### Phase A verification (Codex reports in handoff)

| Check | Command | Expected |
|---|---|---|
| Loom tests | `bun test tests/loom/` | 87 pass |
| Worker tests | `cd worker && bun test tests/ && cd ..` | 17+ pass (includes new focus.test.ts) |
| Verify script | `bun run verify` | clean |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle | `bun run build && wc -c dist/main.js` | ≤ 71130 (baseline) + 50 |
| Worker dry-run | `cd worker && bun run deploy --dry-run` | Total Upload ≤ 385 KiB |
| `pending` grep | `grep -rn "\\bpending\\b" worker/src/` | zero |
| `utils.ts` unchanged check | `git diff --stat main -- worker/src/utils.ts` | no changes |
| No test deletes | `git diff --stat main -- tests/ worker/tests/` | only `rebuild-lock.test.ts` mock update + new `focus.test.ts` |
| No loom edits | `git diff --stat main -- src/loom/` | empty |
| No runtime edits (except input.ts) | `git diff --stat main -- src/runtime/` | only `input.ts` |
| Sentinel intact in ext-app | `grep -c '__VELLUM_BASE_URL__' app/dist/mcp-app.html` | 1 |

### Phase B verification (Codex reports in handoff)

| Check | Command | Expected |
|---|---|---|
| Loom tests | `bun test tests/loom/` | 87 pass |
| Worker tests | `cd worker && bun test tests/ && cd ..` | ≥17 pass (plus any new boundary tests from B2) |
| Verify script | `bun run verify` | clean |
| All typechecks | root + worker + app | clean |
| `utils.ts` deleted | `ls worker/src/utils.ts 2>&1` | file not found |
| New modules exist | `ls worker/src/{ids,warmth,rate-limits,prose,helpers}.ts` | all present |
| No orphan imports | `grep -rn "from ['\"].*utils['\"]" worker/src/` | zero |
| Renderer bundle | `wc -c dist/main.js` | ≤ post-A + 500 |
| Worker dry-run | Total Upload | within ±5 KiB of post-A baseline |
| Test files untouched (except B2 new tests) | `git diff --stat main -- worker/tests/` | only new test files for B2 |

## Execution flow

### Phase A execution (Codex in worktree)

1. Read the full spec (this doc), especially the Phase A section.
2. Read CLAUDE.md and PATTERNS_AND_GOTCHAS.md for orientation.
3. Execute A1 through A9 **in order**. A1 is highest-value; do it first.
4. After each item, run the local checks (`bunx tsc --noEmit`, targeted bun test) to confirm nothing broke.
5. Stop before commit. Write checkpoint + handoff:
   - `docs/PHASE_9_4_CHECKPOINT_A.md` — baseline snapshot at start
   - `docs/PHASE_9_4_HANDOFF.md` — what changed per item, verification matrix, flags for human review
6. Return a summary.

**Do NOT**:
- Execute Phase B items
- Modify anything under `src/loom/**`, `src/content.ts`, `worker/src/utils.ts` (Phase B territory)
- Apply D1 migrations (Claude handles this)
- Commit, push, or deploy
- Touch `worker/src/index.ts` except for the `/ext-app` handler in A4

### Phase B execution (Codex in NEW worktree, after Phase A deployed)

1. Verify the post-A baseline is committed to main (check commit hash in the execution prompt).
2. Read the spec's Phase B section.
3. Execute B1 → B2 → B3 → B4 **in order**. B1 is the foundation; it must land first because B2 and B3 may touch the new modules.
4. After B1 (utils split), run `bun run verify` to confirm the refactor is clean before starting B2.
5. Stop before commit. Write checkpoint + handoff.
6. Return a summary.

**Do NOT** (Phase B):
- Revert any Phase A changes
- Modify anything Phase A left alone (e.g., focus.ts logic — only imports may change if utils.ts functions move)
- Apply D1 migrations (none expected in Phase B)
- Commit, push, or deploy

## Open questions for future-me

- **Post-deploy observability sanity script**: the audit revealed we've been blind. Nice-to-have follow-up: add a small `scripts/check-observability.sh` that queries the Cloudflare observability API for errors in the last N minutes and exits nonzero if any match current deployed version. NOT in scope for 9.4/9.5 but worth remembering. **→ Promoted to Phase 9.6 spec after 9.5 landed. See `docs/PHASE_9_6_SPEC.md`.**
- **Pre-existing `.then()` on short-circuited poll** (`app/src/mcp-app.ts` lines 369, 397, 507) — code-reviewer flagged this as LOW. Not introduced by 9.3. Defer unless we see highlight reliability issues in production.
- **Worker test coverage gaps beyond focus.ts**: `leave-imprint`, `weave`, `admin`, and the `'force-locked'` state path are still untested. Phase B restructures some of these; consider adding tests as part of B1/B2/B3 handoff if time allows. **→ B2 added `validation.test.ts` (3 tests at the malformed-body boundaries). Leave-imprint / weave / admin happy-path coverage + force-locked state path remain untested. Defer to future phase if they surface as pain points.**

---

## LANDED — archival footer

**This spec is ARCHIVED as of 2026-04-09. Do not execute; both phases are live in production.**

### Phase 9.4 (Phase A)

- **Landed**: 2026-04-09
- **Commits on main**: `0061097` A1 focus.ts ordinal fix → `1fa3b70` A3+A4 input scope + `/ext-app` sentinel → `3b43c6a` A2+A8 cache contention docs + redundant zod guards → `2511893` A5+A7 warmth.pending removal + admin reason/ENVIRONMENT cleanup → `3a4197e` A6+A9 dead exports + dead default branch → `68e32db` checkpoint + handoff → `6d6f7b4` CLAUDE.md refresh → `37724d0` PATTERNS_AND_GOTCHAS drift fix
- **D1 migration**: `0005_drop_warmth_pending.sql` applied to remote
- **Deploy**: version `2f0f72c7-99a2-4a84-9d97-13c55fb743db`
- **Smoke result**: `/ext-app` sentinel=0 on both origins, `/api/state` serving ~289 voices, `/mcp` ping 200
- **Handoff doc**: `docs/PHASE_9_4_HANDOFF.md`

### Phase 9.5 (Phase B)

- **Landed**: 2026-04-09
- **Commits on main**: `c139a29` B1+B2 utils.ts split + runtime validation layer → `80d1d4c` B3 extract shared write helper → `7a879ff` B4 scheduleNextFrame handle-by-reference → `2915ee7` checkpoint + handoff → `48d18ca` CLAUDE.md + PATTERNS_AND_GOTCHAS post-9.5 sweep
- **D1 migration**: none (Phase B is schema-stable by design)
- **Deploy**: version `a6727c65-8150-4255-b7ea-7db47f996a42`
- **Smoke result**: `/ext-app` sentinel=0 both origins, `/mcp` malformed body → 400 + `-32700` (B2 validation live), `/api/witness` malformed body → 400 (B2 validation live), bundle 71048 bytes (−62 from B4 Object.assign removal)
- **Handoff doc**: `docs/PHASE_9_5_HANDOFF.md`
- **Commit-split note**: B1 and B2 landed as a single commit (`c139a29`) because they shared 4 handler files (cache.ts, admin.ts, mcp.ts, witness.ts) with interleaved hunks. B3 was committed separately by temporarily reverting leave-imprint.ts/weave.ts to a "B1-only" state and restoring the B3 versions post-commit. See `feedback_commit-splitting-interleaved-hunks` memory for the mechanics.
- **Post-land B2 follow-up**: independent code review after land flagged that `handlers/state.ts`, `handlers/admin.ts`, and `tools/sense-space.ts` still had raw `env.KV.get<T>(…, 'json')` casts for `state:projection` and `atmosphere` reads, bypassing the new safe-parse wrappers in `cache.ts`. Follow-up fix exported `readProjectionCache` + `readAtmosphereCache` and routed all 7 hot-read call sites through them. Landed as part of the post-9.5 wrap-up commit (same day). Not a regression vs pre-9.5 baseline, but a spec-literal miss — the Phase B spec targeted "KV read casts" broadly, not only the rebuild path.

### Arc status

Phases 9.4 + 9.5 close the hardening arc P1..9.5. Feature work is unblocked (F1/F2 + optional 9.6 observability warm-up). Hardening-arc chronology lives in memory `project_vellum-phase-arc`.
