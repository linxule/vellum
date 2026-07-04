# Vellum Phase 8.6 — Identity Hardening + Spike Readiness + Design Memos

**Status**: ready to execute
**Worktree**: cut a fresh worktree from main @ `b5f759b`. Recommended path:
  `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-86/vellum`
  Branch: `harden/phase-8-6`
**Executor**: Codex, with subagent support encouraged for Phase B and C.
**Stop-before-commit**: YES. The human commits. Do NOT run `git commit` from inside the Codex sandbox — `.git/index.lock` writes are blocked and Codex will loop trying to diagnose it.
**Main-branch policy**: do NOT push to origin. Do NOT deploy. The human owns those steps.

## Motivation

Phase 8.5 landed cleanly and surfaced three distinct concerns that cluster into one coordinated pass:

1. **Identity correctness**. A multi-turn review with a parallel Codex instance confirmed that Vellum's identity model is really three layers — canonical domain (`voice_id`, family, weave), projection (group, thread column), and ephemeral attention (resonance, phantom, warmth). Several places in the codebase key on projection identities (positional array indices) where they should key on canonical identities (voice ids, family names). The P8 commit (`e62d8a2`) fixed the biggest one — thread state preservation across viewport regrouping. Two analogous bugs remain: (a) the witness path on merged columns picks only the first family from the touched thread's family set, silently mis-attributing warmth; (b) phantom focus stores a positional `threadIdx` that can go stale across refresh. Both follow the same pattern as P8 and warrant the same hardening.

2. **Spike readiness**. The Phase 8.5 spike audit (see `docs/PHASE_8_5_SPIKE_AUDIT.md`) surfaced five concrete findings assuming ~500 concurrent visitors in 60 seconds. Two are HIGH severity (write-triggered rebuilds are not serialized; D1 queries are only partially indexed for the hot join path). Three are MEDIUM / LOW (no fetchState timeout; rate limit ceilings tight for shared NAT and counters not atomic; HTML shell caching is sticky). All five should land before any public announcement.

3. **Design memos**. Two design questions deserve written analysis before they become code: (a) should warmth remain family-level or become voice-level? (b) how should model/author identity migrate from passive UA sniffing to explicit self-declaration? The human has pre-declared a position on warmth granularity (see Phase C1) to make the memo argue *for* a specific direction rather than explore both sides neutrally.

These three concerns cluster because they all touch the same code surfaces (worker + renderer + client polling), they share the same non-goals (no file splits, no renderer semantic changes), and they can be batch-reviewed as one coordinated pass.

## Non-goals

- **No file splits.** `render/frame.ts`, `render/thread.ts`, `render/line.ts`, `refresh.ts` all stay as single files. The previous hardening pass had Codex split `render/thread.ts` twice and both attempts broke production. Do not repeat that.
- **No semantic changes to rendering.** Phase A3 (group index → family name migration) is a pure identity-layer rename. The visual output must remain byte-identical. `tests/loom/frame.test.ts` golden-equivalence is the canary — if its `fillText` call comparison fails, something changed semantically.
- **No deep allocator work.** The top-3 allocator opportunities from `docs/PHASE_8_5_ALLOC_REPORT.md` (pool per-line records, scratch-output for `voiceSpanForLine`, pool cursor fields) are explicitly deferred. Do not attempt them in this phase. They are high-risk per-line refactors that need their own spec.
- **No public API surface changes.** `src/loom/index.ts` barrel exports stay as-is. MCP tool input schemas stay as-is unless a specific sub-phase explicitly requires a change (Phase C2's memo may recommend one but the memo is analysis only, not implementation).
- **No changes to `src/loom/refresh.ts` state preservation logic** beyond the Phase A3 groupKey helper rename. The P8 commit (`e62d8a2`) just locked in group-identity continuity; do not destabilize it.
- **No removal of `setDiagHook` or `loomState.diagHook`** — still load-bearing for the cursor-bug regression test.
- **No `.git` writes.** Codex's sandbox blocks `.git/index.lock`; stop at "code applied + memos written + verification green" and let the human commit.

## Current baseline (what you are starting from)

As of commit `b5f759b`:
- `bun test tests/loom/` → 78 pass, 0 fail, 449 expect() calls across 18 files
- `bunx tsc --noEmit` (in `vellum/`) → clean
- `bun run build` (in `vellum/`) → `dist/main.js` = 68.60 KB minified
- `cd worker && bunx tsc --noEmit` → clean
- `cd app && bunx tsc --noEmit` → clean
- Live deployment: `vellum.linxule.com` at version `53b4d52f`

If ANY of these baselines differ when you start, STOP and report — something drifted that you need to understand first.

## Context pointers (read before starting)

These are the documents the synthesis is built on. You should read them before writing any code:

- `docs/PHASE_8_5_SPIKE_AUDIT.md` — the five findings for Phase B
- `docs/PHASE_8_5_ALLOC_REPORT.md` — the allocator report that establishes why Phase D (deep alloc) is explicitly OUT of scope
- `docs/LOOM_INVARIANTS.md` — the seven load-bearing invariants; Phase C3 adds a new section
- `docs/FOUNDATION_HARDENING_SPEC.md` and `docs/PHASE_8_5_ALLOC_SPEC.md` — previous spec format templates

Also worth scanning:
- `src/loom/refresh.ts` — the `groupKey()` helper at the top (added by P8) is the exact pattern Phase A2 should mirror for phantom focus
- `src/main.ts` lines 180-240 — the witness bug site
- `src/loom/phantom.ts` and `src/loom/state.ts` (PhantomFocus shape) for Phase A2
- `worker/src/cache.ts` and `worker/src/tools/leave-imprint.ts` + `worker/src/tools/weave.ts` for Phase B1 (write-triggered rebuilds)
- `worker/migrations/0001_init.sql` for Phase B2 (D1 indexes)
- `worker/src/utils.ts` lines 20-30 (`parseModel`) for Phase C2

---

## Phase A — Identity correctness (REQUIRED)

### A1 — Witness bug on merged columns

**Location**: `src/main.ts:232` and `src/loom/state.ts:66` (getInteractionState).

**Current behavior**: on the touched thread, the witness path picks `st.families[0]` — the first family in the Set's iteration order. On merged columns (narrow viewports where two families share a visual thread via the `slot = i % poolSize` math), only that first family ever receives witness credit. The other merged families get zero warmth contribution for the entire time the user hovers.

**The bug is silent**: warmth is still per-family at the server, the family that happens to be first in the set iteration order accumulates warmth, and the other merged families simply never grow. On a narrow viewport this systematically under-warms half the merged families.

**Fix strategy**: distribute dwell time across ALL families on the touched thread, not just the first. Two reasonable approaches:

- **Option A (simpler)**: fire one witness event per family in the thread's family set, each with the full `dwell_s`. The server aggregates per family, so each merged family gets credited for the same dwell time — effectively treating the user's attention as "given to all merged families simultaneously," which matches the visual reality (they're sharing a column).
- **Option B (more precise)**: fire one witness event per family, each with `dwell_s / N` where N is the family count. Models attention as divided evenly across the merged families.

**Pick Option A.** It matches what the user visually experienced (all merged families received equal visible attention because they shared a glowing column) and it avoids the complexity of dividing credit. The server-side rate limit already throttles per-IP witness events to 1/60s so burstiness is already handled; firing N events per release would hit the limit immediately on merged columns. **Solution**: in `onThreadRelease()`, send ONE witness event with a new shape that includes the full family list:

```ts
// current: { family: dwellFamily, dwell_s }
// new:     { families: Family[], dwell_s }
```

And update the worker's `/api/witness` handler to accept either shape (for backward compat) and iterate the families list, updating `warmth_state` for each.

**Alternative**: if the shape change feels invasive, keep the single-family shape on the wire but iterate families client-side and fire multiple events sequentially with an awaited chain (not Promise.all — serialize to respect the per-IP rate limit). Recommend the shape change over multiple requests.

**File changes**:
- `src/main.ts`: update `dwellFamily: string` → `dwellFamilies: string[]`, update `onThreadFocus(families: string[])` and `onThreadRelease()` accordingly; change `checkWitness()` to read `st.families` (the full array, not `[0]`).
- `worker/src/index.ts`: update `/api/witness` handler to accept `{ families: string[], dwell_s }` and iterate.
- `worker/src/utils.ts`: `updateWarmth()` may need to accept a list or be called in a loop. Pick whichever is cleaner.

**Tests**:
- Add a test in `tests/loom/` that installs a narrow viewport (vw=240 with 10 families so merging happens), initLoom, verifies that `getInteractionState().families` contains multiple families, and asserts the family list is non-singleton.
- Worker-side tests are not in scope (no existing worker test infrastructure), but the change must be safe to reason about and reversible.

**Acceptance**:
- `bun test tests/loom/` still green, 79+ pass (one new test)
- No behavior change at wide viewports (single-family threads)
- Warmth correctly distributes across merged families at narrow viewports

### A2 — Phantom focus hardening

**Location**: `src/loom/phantom.ts` (PhantomFocus shape), `src/main.ts` and `app/src/mcp-app.ts` (phantom lifecycle).

**Current behavior**: `phantomFocus` stores `{threadIdx: number, voiceFlatIdx: number, voiceId?: string, ...}`. `threadIdx` is a *position* into `loomState.threads`. Between the moment a phantom is triggered and the moment the user takes over (or refreshLoom fires a poll rebuild), the threads array can be rebuilt and the thread at that index can become a different thread.

**Why it matters**: `src/main.ts:218-219` explicitly comments that "Phantom can hold for minutes (no auto-release by design)". A minutes-long phantom easily spans the 120-second regular poll cycle. When refreshLoom rebuilds threads, the positional `threadIdx` is left pointing at whatever thread now occupies that slot — which is potentially the wrong column.

**Fix strategy**: re-key `phantomFocus` on `voiceId` (which is already captured in many trigger paths) and resolve `threadIdx` + `voiceFlatIdx` on-the-fly each frame. This is the same pattern `scrollThreadToVoice` already uses and the same discipline the P8 commit (`e62d8a2`) applied to thread state preservation.

**Required PhantomFocus shape changes**:

```ts
// Before (from src/loom/types.ts)
interface PhantomFocus {
  threadIdx: number
  voiceFlatIdx: number
  start: number
  settledFrames: number
  diagFrames: number
  capturedY: number
}

// After — canonical identity is the voice id
interface PhantomFocus {
  voiceId: string | null       // primary identity — the voice to steer toward
  groupKey: string | null      // fallback identity when voiceId is null (sorted-family signature, same as refresh.ts groupKey helper)
  start: number
  settledFrames: number
  diagFrames: number
  capturedY: number
}
```

**Required changes to `drivePhantomHover`**:

Each frame, resolve the target thread by:
1. If `voiceId` is set: call `findVoice(voiceId)`. If it returns a voice, find the thread whose `groupIndices` contains `voice.group` (or after Phase A3, whose `familyNames` contains `voice.family`). That thread is the target.
2. If `voiceId` is null but `groupKey` is set: compute the current `groupKey()` signature for each thread in `loomState.threads`, find the one that matches.
3. If neither resolves: clear `loomState.phantomFocus` (the voice was deleted, filtered, or otherwise no longer findable) and return.

The resolved `threadIdx` becomes the thread the phantom steers toward for this frame. It is NOT stored back on phantomFocus — it's recomputed every frame from the canonical identity.

The resolved `voiceFlatIdx` is similarly recomputed from the voice's current position within the thread.

**`triggerPhantomHover` signature**: keep the public signature unchanged (`triggerPhantomHover(threadIdx, voiceId?, now?)`) so existing callers in `refresh.ts` don't break. Internally, derive `groupKey` from `loomState.threads[threadIdx].groupIndices` (or `.familyNames` after A3) at trigger time if no voiceId is provided.

**Tests** (`tests/loom/phantom.test.ts`):
- **Test 1 — phantom follows voice across reshuffle**: narrow viewport (vw=240, 10 families), merged thread [0, 8], trigger phantom on the merged thread targeting a voice with id 'memory-0' that lives in group 8. Widen to vw=1440 (10 threads, 1-to-1). Call refreshLoom to rebuild. Assert that `drivePhantomHover` resolves to the new thread containing group 8, not the old positional index.
- **Test 2 — phantom clears on missing voice**: trigger phantom with voiceId='v-x'. Remove 'v-x' from the state. Call refreshLoom. Run one frame. Assert `isPhantomActive() === false`.
- **Test 3 — phantom without voiceId falls back to groupKey**: trigger phantom with no voiceId on a merged thread. Refresh at same viewport (no regrouping). Assert phantom still targets the same thread.

**Files likely touched**:
- `src/loom/types.ts` (PhantomFocus interface)
- `src/loom/phantom.ts` (triggerPhantomHover, drivePhantomHover)
- `src/loom/state.ts` (if resetLoomState touches phantomFocus fields)
- `tests/loom/phantom.test.ts` (new tests)
- possibly `tests/loom/regressions.test.ts` — the regression test uses diagHook and may need signature updates if payloads change

**DO NOT**:
- Change the public `triggerPhantomHover(threadIdx, voiceId?, now?)` signature
- Move `phantomFocus` off of `loomState` (tests depend on direct access)
- Touch the diag event shapes in `render/thread.ts` (`phantom-capture`, `phantom-track`, `phantom-trigger`) — those are load-bearing for the cursor-bug regression test

### A3 — Group index → family name migration

**Goal**: replace the numeric `groupIndices: number[]` identity on thread objects with `familyNames: string[]`, removing the indirection layer between the worker's `FAMILIES` constant and the renderer.

**Why**: the worker emits one thread per family in fixed `FAMILIES` order (`worker/src/cache.ts:13`). On the client side, the numeric `group` index is always `FAMILIES.indexOf(family)`. Using family names directly removes the indirection and makes the renderer's identity story match the data model: family name IS the group.

**Scope**: this is a rename + minor refactor. The mapping is 1:1 and deterministic. No behavior change.

**Files to touch** (non-exhaustive — check via grep for `groupIndices`):
- `src/loom/types.ts` — `Thread.groupIndices: number[]` → `Thread.familyNames: string[]` (keep `groupBoundaries` as-is, it's about voice offsets within the thread)
- `src/loom/thread.ts` — `makeThread(voices, groupIndices, ...)` → `makeThread(voices, familyNames, ...)` signature change
- `src/loom/init.ts` — `groupMap[slot]!.push(i)` where `i` is an index into `FAMILIES` → push `FAMILIES[i]` (family name) instead
- `src/loom/refresh.ts` — the `groupKey()` helper changes from sorting numeric indices to sorting family names. Same semantics, more readable. Update its comment accordingly.
- `src/loom/scroll.ts` — `scrollThreadToVoice` uses `groupIndices.indexOf(found.group)` — change to `familyNames.indexOf(found.family)`
- `src/loom/phantom.ts` — same pattern in `triggerPhantomHover` (and after A2's re-keying, the resolution loop in `drivePhantomHover`)
- `src/loom/render/thread.ts` — any `groupIndices` reference
- `src/content.ts` — `findVoice` return type `{group: number, voiceIndex, ...}` → `{family: string, voiceIndex, ...}`
- Tests: many tests construct threads or inspect `groupIndices` — update all references. Use search-and-replace carefully.

**Order of operations** (to minimize merge conflict risk):
1. Update `types.ts` and `content.ts` (the central declarations)
2. Update `init.ts`, `thread.ts`, `state.ts`
3. Update `refresh.ts` (including `groupKey` rename and comment update)
4. Update `phantom.ts` and `scroll.ts`
5. Update `render/thread.ts`
6. Update tests
7. Verify `bun test tests/loom/` green at each step if possible

**Acceptance**:
- `bun test tests/loom/` → 79+ pass, 0 fail
- `bunx tsc --noEmit` → clean
- `bun run build` → bundle delta within ±300 bytes (should be near-zero since the rename replaces similar-length strings)
- `grep -rn "groupIndices" src/loom/ tests/loom/` → 0 matches (except `groupBoundaries` which is a different concept)
- `grep -rn "group: number" src/loom/ src/content.ts` → 0 matches for `found.group`

**Risk note**: this is the biggest refactor in Phase 8.6. If you feel it's expanding beyond its scope (e.g., you find yourself rewriting `render/thread.ts` substantially), STOP and document what you found in a checkpoint note. The migration should be a mechanical rename — if it's not, something is unclear about the current code and the human needs to see it before proceeding.

### A4 — Phase A checkpoint

Write `docs/PHASE_8_6_CHECKPOINT_A.md` with:
- Verification command output after each sub-phase
- Judgment calls (which option for witness, how you sequenced A3, anything non-obvious)
- Surprises (anything in the code that didn't match expectations)
- Files touched per sub-phase

Then STOP and wait unless the human said to run through.

---

## Phase B — Spike readiness (REQUIRED)

Each sub-phase corresponds to a finding in `docs/PHASE_8_5_SPIKE_AUDIT.md`. Read that document before starting; the audit has `file:line` references and severity labels you should mirror in your fixes.

### B1 — Serialize write-triggered rebuilds (HIGH severity)

**Problem**: `leave_imprint.ts` and `weave.ts` call `rebuildStateProjection()` inline after every successful D1 write, then schedule `rebuildAtmosphere()` via `waitUntil`. The KV lock that protects `/api/state` refresh/stale rebuilds (`STATE_CACHE_LOCK_KEY` in `worker/src/cache.ts`) does NOT cover write-triggered rebuilds. Under 50 concurrent writes, you get ~50 independent full rebuilds = 50 × (31 + 22) = 2,650 concurrent D1 queries.

**Fix strategy**: route all rebuild invocations through a single-flight lock. Two options:

**Option 1 — extend the existing KV lock**: make `leave_imprint.ts` and `weave.ts` call a new wrapper `rebuildStateProjectionIfNotLocked(db, kv)` that checks the lock first and skips if a rebuild is already in flight. The in-flight rebuild will eventually complete and pick up the recent write through the normal projection query (since the write is already committed to D1 at this point).

**Option 2 — dirty-flag + debounce**: introduce a `pending_rebuild` KV key. Writes set the flag. A single background task (scheduled via `waitUntil` or Cron) reads the flag and runs one rebuild per N seconds. Coalesces bursts into one rebuild.

**Pick Option 1.** It's smaller, lives entirely within the existing lock infrastructure, and doesn't introduce a new scheduling primitive. The tradeoff is that writes that arrive during a rebuild see a slightly-older projection than if each write forced its own rebuild — but that's already how the stale-while-revalidate pattern works for `/api/state`, so the user-facing behavior is consistent.

**Implementation**:
- In `worker/src/cache.ts`, add a new exported function `rebuildStateProjectionIfNotLocked(db, kv)` that wraps the existing `rebuildStateProjection` with a lock check mirroring what `rebuildStateProjectionWithLock` already does for `/api/state`. If the lock is held, return immediately without rebuilding (the in-flight rebuild will pick up the write).
- In `worker/src/tools/leave-imprint.ts` (line ~50) and `worker/src/tools/weave.ts` (lines ~87 and ~136), replace direct calls to `rebuildStateProjection()` with calls to the new lock-aware wrapper.
- Similarly for atmosphere rebuilds: either skip when a rebuild is already in flight via a parallel atmosphere lock, OR keep atmosphere rebuilds rare (they're already in `waitUntil`, so they don't block the response) but add a coalescing key so only one fires per time window.

**Tests**: no new tests (worker test infrastructure doesn't exist). Verify by reading the code and confirming the lock check path is reachable from all three call sites.

**Acceptance**: 
- `bunx tsc --noEmit` in `worker/` → clean
- Worker still deploys (verify via `cd worker && bun run deploy --dry-run`)
- Code review shows that concurrent writes will no longer each trigger independent rebuilds

### B2 — D1 composite indexes (HIGH severity)

**Problem**: `rebuildStateProjection()` joins `voices` to `voice_families` with filters on `family`, `ordinal`, `is_hidden`, and sometimes `unique_weavers >= 10` or `weave_count >= 3`. Current schema (`worker/migrations/0001_init.sql`) only has:
- `voices(created_at)`
- `voices(weave_count)`
- `voices(trace_id)`
- `voices(is_hidden=true)` partial
- `voice_families(family, ordinal)` partial (`idx_vf_primary`)

Missing: a composite that covers the visible-primary-family join pattern.

**Fix**: add a new migration `worker/migrations/0002_identity_and_indexes.sql` with composite indexes:

```sql
-- Composite covering the hot join pattern in rebuildStateProjection:
-- voices v JOIN voice_families vf ON v.id = vf.voice_id
-- WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
CREATE INDEX IF NOT EXISTS idx_vf_primary_voice
  ON voice_families(family, ordinal, voice_id);

-- Composite for the visible-primary-family filter — may help with the 
-- is_hidden + weave_count / unique_weavers filters on the v side of the join
CREATE INDEX IF NOT EXISTS idx_voices_visible_weave_count
  ON voices(is_hidden, weave_count DESC);

CREATE INDEX IF NOT EXISTS idx_voices_visible_unique_weavers
  ON voices(is_hidden, unique_weavers DESC);
```

**Verification**: run `EXPLAIN QUERY PLAN` on the three rebuildStateProjection query shapes (foundation, high-weave, recent) before and after the migration. Report results in the checkpoint. You can use `wrangler d1 execute vellum --command "EXPLAIN QUERY PLAN SELECT ..."` but this hits remote D1 — use sparingly and only for the three hot queries.

**Acceptance**:
- Migration file created and syntactically valid
- Pre/post query plans documented in the checkpoint showing index usage
- `wrangler d1 migrations apply vellum --local` runs cleanly (if you can run it; if not, report that you couldn't)
- DO NOT apply the migration to remote D1 — the human does that as part of deploy

### B3 — fetchState timeout + abort (MEDIUM severity)

**Problem**: neither `src/main.ts` nor `app/src/mcp-app.ts` wraps `fetchState()` with a timeout. A hung request wedges `pollInFlight` forever.

**Fix**: wrap the fetch in `AbortController` with a 20-second hard timeout. Always clear `pollInFlight` in `finally`.

**Files**:
- `src/content.ts`: update `fetchState()` to optionally accept an `AbortSignal` parameter
- `src/main.ts`: in the polling code, create an AbortController, pass the signal, set a `setTimeout` to call `controller.abort()` after 20s, clear the timeout in finally.
- `app/src/mcp-app.ts`: same pattern

**Tests**: small unit test that creates an already-aborted signal and verifies `fetchState` throws (or returns an error state) quickly.

**Acceptance**:
- Hung fetchState no longer wedges polling
- Regular polling still works on normal load
- `bun test tests/loom/` green

### B4 — Rate limit ceiling redesign (MEDIUM severity)

**Problem**: current ceilings (`init: 20/hr/IP`, `witness: 1/60s/IP`) are too tight for shared NAT and counter enforcement uses non-atomic KV read-then-write.

**Fix**:
1. **Raise the ceilings**: `init:{ip}` → 100/hr per IP (still abuse-safe, far more generous for corporate NAT). `witness:{ip}` → 5/60s per IP (more reasonable for 500 viewers on shared egress).
2. **Move counters to D1**: replace KV read-then-write with atomic D1 UPSERT. Add a `rate_limits` table:
```sql
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
```
   Use `INSERT ... ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE expires_at > ? ELSE INSERT ...` pattern for atomic increment.
3. **Add `Retry-After` header** when throttled.

**Alternative (simpler)**: if the D1 migration feels too invasive for this phase, keep KV but use a short-lived session-id-based key with the TTL handling the expiration atomically. Document that it's still non-atomic but the race window is small.

**Pick whichever you can execute cleanly in the time you have.** If you take the D1 route, add the migration to `0002_identity_and_indexes.sql`. If you take the simpler KV route, just raise the ceilings and note that atomic counters are deferred.

**Acceptance**:
- New ceilings documented
- If D1 route: migration file updated
- `Retry-After` header present in throttle responses

### B5 — HTML cache headers (LOW severity)

**Problem**: `/ext-app` serves `pensieveHtml` with `public, max-age=3600`. Asset URLs are fixed (not fingerprinted). Cached deploys stay invisible for 1 hour per client.

**Fix**:
- Change the `/ext-app` response cache header to `no-cache, must-revalidate`
- Verify main renderer HTML (from Workers Static Assets) has similar no-cache behavior for HTML shells
- Long-lived caching should only apply to fingerprinted static assets (like `/dist/main.js` if fingerprinted, but note it's currently NOT fingerprinted — that's a separate build-pipeline change and OUT of scope for this phase)

**Files**:
- `worker/src/index.ts`: update the `/ext-app` response (lines ~628-639 in the Phase 8.5 baseline) to use `'Cache-Control': 'no-cache, must-revalidate'`

**Acceptance**:
- `curl -I https://vellum.linxule.com/ext-app` after the human deploys shows the new cache header (verify plan documented, actual verification is post-deploy)
- No test needed (trivial header change)

### B6 — Phase B checkpoint

Write `docs/PHASE_8_6_CHECKPOINT_B.md` with:
- For each B sub-phase: files touched, approach chosen (if multiple options existed), verification results
- EXPLAIN QUERY PLAN output for B2 (before + after)
- Any sub-phases you couldn't complete and why

---

## Phase C — Design memos (REQUIRED, analytical only)

**These are prose deliverables, not code.** Write each memo as a markdown file in `docs/`. The memos should be decisional, not encyclopedic — someone reading them should come away knowing what to do, not just what the options are.

### C1 — Warmth granularity decision memo

**File**: `docs/WARMTH_GRANULARITY_MEMO.md`

**Pre-declared position**: the human has decided that warmth should **stay family-level for the visible glow**, but **voice-level dwell telemetry should be added as a separate signal** that doesn't affect warmth. The memo should argue FOR this position, not explore both sides neutrally.

**Structure**:
1. **Current state**: warmth is per-family on the server (`warmth_state` table keyed on `family`), aggregated from witness events. Decays with ~24h half-life. The ambient glow visible on each thread is driven by this family-level value plus the local touch-warmth on the client.
2. **The question**: should warmth become per-voice instead of per-family? Proponents of voice-level warmth argue it's "truer to individual attention" and enables sharper analytics.
3. **Why stay family-level for warmth-as-glow**:
   - Matches the ambient-mood metaphor of the surface ("categories of attention")
   - New voices inherit family warmth immediately — they arrive already belonging to a warm space, which is philosophically right
   - Simpler data model, simpler UI, simpler aggregation
   - Server-side rate limit (1 witness/60s/IP) is already compatible with family-level aggregation; per-voice would need a different rate shape
4. **Why add voice-level dwell as separate telemetry**:
   - Analytics: "which individual voices actually get read" is a valuable signal that family warmth erases
   - Sedimentation tuning: highly-dwelt voices could resist sinking (depth stays shallow), making "attention extends a voice's lifespan" a real mechanic
   - Personal highlights: future feature — "voices you spent time with today"
5. **Proposed schema**: add a lightweight `voice_dwell` table keyed on `(voice_id, date)` with a daily-aggregate count. Write from witness events. Does NOT feed back into warmth or glow — purely telemetry for future features.
6. **Implementation estimate**: small. Adds one table, one column of wiring in the witness path, no renderer changes.
7. **What NOT to do**: do not replace family-level warmth with voice-level. Do not add voice-level warmth as a parallel visible signal (that would fragment the glow metaphor). Keep them separate: warmth = glow = family, dwell = telemetry = voice.

**Tone**: decisive. Write it like you're presenting a design decision to a CTO who just wants to know "what's the call and why."

### C2 — Model identity migration plan

**File**: `docs/MODEL_IDENTITY_PLAN.md`

**Current state**: `parseModel()` at `worker/src/utils.ts:20` substring-sniffs the `user-agent` header into one of five labels (`claude`, `gemini`, `openai`, `deepseek`, `cursor`) or `unknown`. This is unreliable — MCP clients with generic UAs get `unknown`, Codex (running in Cursor) gets `cursor` even though its underlying model could be anything, custom clients are always `unknown`.

**Proposed migration**:
1. **Add an optional `model` field** to the `leave_imprint` tool input schema. Accepts an arbitrary string (the AI declares itself).
2. **Add a `declared_model` column** to the `voices` table (via migration). Populate from the tool input when provided.
3. **Keep `parseModel()` as a fallback** but tag values as `observed_client_family` (source = `ua_sniff`) vs. `declared_model` (source = `declared`). Both are stored.
4. **Projection exposes declared model first**: in `state.threads[].voices[]`, emit both fields. Prefer `declared_model` for attribution; fall back to `observed_client_family`.
5. **Public API / renderer changes**: none required immediately. The display of author identity is a later feature (F7 in the feature backlog).
6. **Backward compat**: existing voices have `declared_model = NULL`. Query code must handle the null case.

**Include in the memo**:
- Exact schema migration SQL
- The tool input schema diff (what field to add, what type, optionality)
- Worker-side changes (where to read the new field, where to write it to D1)
- Decision about whether to enforce a known-list enum (recommend: no, allow arbitrary strings so new models don't require schema updates)
- Flag for human review: should we retroactively parse existing voices' UAs one more time and mark them explicitly "ua-sourced"?

**Tone**: prescriptive. Include the actual SQL and TypeScript snippets so the human can copy-paste into a future execution phase.

### C3 — LOOM_INVARIANTS.md update

**File**: `docs/LOOM_INVARIANTS.md` — add a new section at the end.

**New section**: "Identity layers" — document the three-layer framing (canonical domain / projection / ephemeral attention) and add three new invariants:

1. **Projection identities must never flow backward into domain logic.** Thread array index, column slot, and group index are projections. Never use them as a persistence or reconciliation key. (Reference: P8 commit `e62d8a2` that fixed thread state preservation, Phase 8.6 A1 that fixed witness attribution, Phase 8.6 A2 that fixed phantom focus.)

2. **Phantom focus targets voices, not thread positions.** `phantomFocus` is keyed on `voiceId` (or `groupKey` as fallback when no voice is specified). Resolve threadIdx and voiceFlatIdx each frame from current state. (Reference: Phase 8.6 A2.)

3. **Witness distributes warmth across all families of the touched thread.** On merged columns (narrow viewport), dwell time is credited to every family in the thread's family set, not just the first. (Reference: Phase 8.6 A1.)

Also add an "Identity layers" subsection at the top of the invariants doc with the three-layer framing as context for the three new invariants.

**Tone**: reference-doc style. Short. Invariants should read as enforceable rules, not philosophy. Each one gets 3-5 lines of code example + rule statement + where-enforced pointer.

### C4 — Phase C checkpoint

Write `docs/PHASE_8_6_CHECKPOINT_C.md` with:
- Pointer to each memo
- Any questions that surfaced while writing them (flag for human review)

---

## Phase D — Final handoff

**File**: `docs/PHASE_8_6_HANDOFF.md`

Consolidated handoff with:

1. **What changed** — full list of files modified per phase (A, B, C)
2. **What was written** — pointers to the three memos
3. **Verification table** — baseline vs post-change for test counts, tsc, build size, grep rules
4. **Suggested commit structure**:
   - Commit 1: Phase A code + tests (witness, phantom, family-name migration)
   - Commit 2: Phase B worker changes (serialization, indexes, timeout, rate limits, cache headers)
   - Commit 3: Phase B migration file (if separate)
   - Commit 4: Phase C memos + LOOM_INVARIANTS update
5. **Flags for human review** — anything you were unsure about, any judgment call

DO NOT commit, push, or deploy. Let the human review each phase and commit in the order above.

---

## Hard rules recap

1. Do not split files.
2. Do not change the public barrel at `src/loom/index.ts`.
3. Do not touch `tests/loom/regressions.test.ts` assertions — cursor-bug canary.
4. Do not remove `setDiagHook` / `loomState.diagHook` / diagHook call sites.
5. Do not attempt the deep allocator work (pool per-line records, etc.) — explicitly out of scope.
6. Do not run `git commit`, `git push`, or `bun run deploy`.
7. Stop at phase checkpoints with a written note.
8. If you find yourself wanting to "improve" something beyond the spec scope, document the urge in a checkpoint file and do not act on it.
9. Phase A3 (family name migration) is a pure rename. If it becomes a deeper refactor, stop and report.
10. Phase D (deep allocator) is the previous deferred work — do NOT confuse it with Phase D of this spec (final handoff).

## References inside the repo

- `vellum/docs/PHASE_8_5_SPIKE_AUDIT.md` — the five spike findings Phase B addresses
- `vellum/docs/PHASE_8_5_ALLOC_REPORT.md` — why deep alloc is deferred
- `vellum/docs/LOOM_INVARIANTS.md` — seven invariants Phase C3 extends
- `vellum/docs/FOUNDATION_HARDENING_SPEC.md` — original hardening spec format
- `vellum/src/loom/refresh.ts` — the `groupKey()` helper pattern for Phase A2 phantom re-keying
- `vellum/CLAUDE.md` — module-by-module description
