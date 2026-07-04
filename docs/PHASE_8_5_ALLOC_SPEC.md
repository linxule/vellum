# Vellum Phase 8.5 — Allocator Pressure + Spike Readiness

**Status**: ready to execute
**Worktree**: the executor should cut a worktree from main. Recommended path `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-85/vellum/`. Cut from main @ `e62d8a2` (post-P1..P8).
**Executor**: Codex, with subagent support encouraged for Phase C + D audits.
**Stop-before-commit**: YES. Codex writes the code and a handoff report. The human reviews and commits. Do NOT run `git commit` from inside the Codex sandbox — `.git/index.lock` writes are blocked and Codex will loop trying to diagnose it.
**Main-branch policy**: do NOT push to origin. Do NOT deploy. The human owns those steps.

## Motivation

The P1..P8 hardening arc closed the cursor bug and locked in state-continuity correctness across viewport regrouping. With the foundation stable, two classes of work remain before feature work can proceed safely under a traffic spike:

1. **Per-frame allocator pressure** — `render/frame.ts#advanceLoom` currently allocates three fresh structures on every frame:
   - `const threadsByDist = loomState.threads.map((t, i) => ({i, dist: ...})).sort(...)` — allocates a new array of N wrapper objects + a sort closure per frame.
   - `const threadAnchorXs = new Float32Array(threadCount)` — fresh typed-array per frame.
   - `const repulsionDeltas = new Float32Array(threadCount)` — fresh typed-array per frame.

   At 60fps with 10 threads that is ~1800 allocations/second per visitor. The scratch-buffer pattern is already proven in the same file (`loomState.frameVisibilityAlpha` is reused when thread count is stable, reallocated on change). Applying the same pattern to the three allocations above removes the pressure without changing semantics.

   This matters for two concrete reasons:
   - **Traffic spike preparedness.** A viral moment with 100+ concurrent visitors on mid-range mobile devices starts exposing GC pauses that microstutter the canvas. Removing renderer allocations is the cheapest and highest-leverage preemptive fix.
   - **Audio-visual lockstep.** The next feature pass adds Strudel live-coded music tied to loom state. Audio worklets and the animation-frame loop run concurrently; GC pauses that stutter the canvas also cause audible clicks in audio callbacks. Removing the per-frame churn from the renderer is a precondition for clean realtime audio binding.

2. **Spike-readiness audit of the full request path.** The renderer is one of ~5 surfaces that can saturate under burst traffic. Cloudflare Workers handle burst fine at the edge, but the D1 query patterns, KV rate-limit keys, and asset cache headers all need a pass before we advertise the project publicly. This is diagnostic work, not code changes — the output is a written report with concrete findings and recommendations, which the human then triages.

This spec folds both into one coordinated pass. Phases A and B are mechanical code changes with an acceptance contract. Phase C and D are diagnostic audits that produce reports.

## Non-goals

- **No file splits.** `render/frame.ts`, `render/thread.ts`, `render/line.ts`, and `refresh.ts` all stay as single files. If you find yourself wanting to split one, STOP and document the urge in the handoff report — do not just do it. The P1..P7 spec already tried twice with Codex splitting `render/thread.ts` and both attempts broke production rendering. We are not repeating that.
- **No semantic changes to rendering.** Every test must pass with the same assertions. The golden-equivalence test in `tests/loom/frame.test.ts` ("renderLoom == advanceLoom + paintLoom") is the canary — if its `fillText` call comparison drifts, you have changed semantics.
- **No API surface changes.** Do not rename exports, do not add or remove items from `src/loom/index.ts`, do not touch the public barrel.
- **No changes to `src/loom/refresh.ts` beyond what Phase C surfaces.** The P8 commit (`e62d8a2`) just locked in group-identity continuity; do not destabilize it.
- **No changes to the MCP tool signatures in `worker/src/tools/`.** Phase D is read-only on the worker.
- **No `.git` writes.** Codex's sandbox blocks `.git/index.lock`; structure your work to stop at "code applied + reports written + verification green" and let the human commit.
- **No removal of `setDiagHook` or `loomState.diagHook`** — these are load-bearing for `tests/loom/regressions.test.ts` as the cursor-bug regression observation channel. They look like dead code but they are not.
- **No removal of `console.warn('[mcp] parse error', ...)` in `worker/src/index.ts`** — that is legitimate error visibility, not debug spam. The human already stripped the real debug code in commit `f705c1f`.

## Current baseline (what you are starting from)

As of commit `e62d8a2`:
- `bun test tests/loom/` → 76 pass, 0 fail, 438 expect() calls across 17 files.
- `bunx tsc --noEmit` (in `vellum/`) → clean. Run this from `vellum/`, not from root — the project tsconfig is scoped.
- `bun run build` (in `vellum/`) → `dist/main.js` = 67.99 KB minified.
- `cd worker && bunx tsc --noEmit` → clean.
- `cd app && bunx tsc --noEmit` → clean.
- `cd worker && bun run deploy` deploys the full stack (renderer + ext-app + worker) and the live site runs at `vellum.linxule.com` with version `c8be776f-4fce-4e70-8eb3-2a1de73595e2` at the time this spec was written.

If ANY of these baselines differ when you start, STOP and report it — something drifted that you need to understand before proceeding.

---

## Phase A — frame.ts scratch-buffer discipline (REQUIRED)

**Goal**: move the three per-frame allocations in `advanceLoom()` onto `loomState`, reusing buffers when `threadCount` is stable and reallocating only on thread-count change.

**Reference pattern**: `loomState.frameVisibilityAlpha` already exists in `src/loom/state.ts` and is resized in `advanceLoom()` at the appropriate point. Copy that pattern exactly — resize check, reuse, reallocate only on size change.

### A.1 — add scratch-buffer fields to loomState

File: `src/loom/state.ts`

Add alongside `frameVisibilityAlpha`:

```ts
// Per-frame scratch buffers used by advanceLoom() to avoid GC churn at 60fps.
// Reused when threadCount is stable, reallocated only on thread-count change
// (resize / refreshLoom). Do not read these from outside advanceLoom — they
// hold transient mid-frame state and have no meaning between frames.
frameThreadSortIndices: new Int32Array(0),   // indices sorted by distance from center
frameThreadSortDists: new Float32Array(0),   // parallel dist array, same order as indices pre-sort
frameThreadAnchorXs: new Float32Array(0),
frameThreadRepulsionDeltas: new Float32Array(0),
```

Also add to `resetLoomState()` in the same file — the reset completeness test at `tests/loom/state.test.ts` checks every field, so it will tell you if you miss one. Reset to zero-length typed arrays:

```ts
loomState.frameThreadSortIndices = new Int32Array(0)
loomState.frameThreadSortDists = new Float32Array(0)
loomState.frameThreadAnchorXs = new Float32Array(0)
loomState.frameThreadRepulsionDeltas = new Float32Array(0)
```

### A.2 — replace `threadsByDist` with a reusable sort

File: `src/loom/render/frame.ts`, inside `advanceLoom()`.

Current code (around line 87):

```ts
const centerX = vw / 2
const threadsByDist = loomState.threads.map((t, i) => ({ i, dist: Math.abs(t.xCenter - centerX) })).sort((a, b) => a.dist - b.dist)
if (loomState.frameVisibilityAlpha.length !== threadCount) {
  loomState.frameVisibilityAlpha = new Float32Array(threadCount)
}
const visAlpha = loomState.frameVisibilityAlpha
for (let k = 0; k < threadsByDist.length; k++) {
  const idx = threadsByDist[k]!.i
  visAlpha[idx] = k < ac.visibleThreads ? 1 : Math.max(0, 1 - (k - ac.visibleThreads) / 1.5)
}
```

Replace with:

```ts
const centerX = vw / 2
if (loomState.frameThreadSortIndices.length !== threadCount) {
  loomState.frameThreadSortIndices = new Int32Array(threadCount)
  loomState.frameThreadSortDists = new Float32Array(threadCount)
}
const sortIndices = loomState.frameThreadSortIndices
const sortDists = loomState.frameThreadSortDists
for (let i = 0; i < threadCount; i++) {
  sortIndices[i] = i
  sortDists[i] = Math.abs(loomState.threads[i]!.xCenter - centerX)
}
// Sort sortIndices by the parallel sortDists[] values, in place. Uses a
// simple insertion sort — threadCount is bounded at maxThreads=12, so the
// O(N^2) cost is ~78 comparisons worst case, cheaper than creating a
// closure + a new array. Do not replace with Array.sort() with a comparator
// closure — that is what we are removing.
for (let i = 1; i < threadCount; i++) {
  const cur = sortIndices[i]!
  const curDist = sortDists[cur]!
  let j = i - 1
  while (j >= 0 && sortDists[sortIndices[j]!]! > curDist) {
    sortIndices[j + 1] = sortIndices[j]!
    j--
  }
  sortIndices[j + 1] = cur
}

if (loomState.frameVisibilityAlpha.length !== threadCount) {
  loomState.frameVisibilityAlpha = new Float32Array(threadCount)
}
const visAlpha = loomState.frameVisibilityAlpha
for (let k = 0; k < threadCount; k++) {
  const idx = sortIndices[k]!
  visAlpha[idx] = k < ac.visibleThreads ? 1 : Math.max(0, 1 - (k - ac.visibleThreads) / 1.5)
}
```

### A.3 — reuse `threadAnchorXs` scratch

Current code (around line 146):

```ts
const threadSlotDenom = Math.max(1, threadCount - 1)
const threadAnchorXs = new Float32Array(threadCount)
for (let i = 0; i < threadCount; i++) {
  threadAnchorXs[i] = vw * (ac.spreadEdge + (i / threadSlotDenom) * (1 - 2 * ac.spreadEdge))
}
```

Replace with:

```ts
const threadSlotDenom = Math.max(1, threadCount - 1)
if (loomState.frameThreadAnchorXs.length !== threadCount) {
  loomState.frameThreadAnchorXs = new Float32Array(threadCount)
}
const threadAnchorXs = loomState.frameThreadAnchorXs
for (let i = 0; i < threadCount; i++) {
  threadAnchorXs[i] = vw * (ac.spreadEdge + (i / threadSlotDenom) * (1 - 2 * ac.spreadEdge))
}
```

### A.4 — reuse `repulsionDeltas` scratch

Current code (around line 151):

```ts
const repulsionDeltas = new Float32Array(threadCount)
for (let i = 0; i < threadCount; i++) {
  const xi = loomState.threads[i]!.xCenter
  for (let j = i + 1; j < threadCount; j++) {
    // ...
    repulsionDeltas[i]! += dir * 0.5 * frameRatio
    repulsionDeltas[j]! -= dir * 0.5 * frameRatio
  }
}
```

Replace with:

```ts
if (loomState.frameThreadRepulsionDeltas.length !== threadCount) {
  loomState.frameThreadRepulsionDeltas = new Float32Array(threadCount)
}
const repulsionDeltas = loomState.frameThreadRepulsionDeltas
// Clear the reused buffer — it accumulates per-frame, so stale values from
// the previous frame would compound into the current xCenter updates.
for (let i = 0; i < threadCount; i++) repulsionDeltas[i] = 0
for (let i = 0; i < threadCount; i++) {
  // ... (unchanged)
}
```

**IMPORTANT**: the clear loop is load-bearing. When `new Float32Array(n)` was called per frame, it was zero-initialized by the JS engine. Reusing a buffer means you must clear it yourself or last frame's repulsion deltas get added to this frame's. Missing the clear will show up as threads drifting toward the edges over time — easy to miss in a short test but catastrophic in a long session.

### A.5 — add a scratch-buffer reuse test

File: `tests/loom/alloc.test.ts` (new).

This test guards against future regressions where someone adds a `new Float32Array(...)` or `.map(...)` inside advanceLoom. It asserts that after a warm-up frame, subsequent frames reuse the same scratch buffer object identity — so any future "fresh allocation" regression fails loudly.

```ts
import { expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

test('advanceLoom reuses scratch buffers across frames at stable threadCount', async () => {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory',    voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
  ], 101))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()

  // Warm-up frame: buffers get allocated for the first time.
  runFrames(renderLoom, ctx, mouse, 1)

  const frameVisAlphaRef       = loomState.frameVisibilityAlpha
  const frameSortIndicesRef    = loomState.frameThreadSortIndices
  const frameSortDistsRef      = loomState.frameThreadSortDists
  const frameAnchorsRef        = loomState.frameThreadAnchorXs
  const frameRepulsionsRef     = loomState.frameThreadRepulsionDeltas

  // Run several more frames. Object identity must be stable — same buffer,
  // same length, reused in place. If any of these assertions fail, someone
  // has reintroduced a per-frame allocation.
  runFrames(renderLoom, ctx, mouse, 10)

  expect(loomState.frameVisibilityAlpha).toBe(frameVisAlphaRef)
  expect(loomState.frameThreadSortIndices).toBe(frameSortIndicesRef)
  expect(loomState.frameThreadSortDists).toBe(frameSortDistsRef)
  expect(loomState.frameThreadAnchorXs).toBe(frameAnchorsRef)
  expect(loomState.frameThreadRepulsionDeltas).toBe(frameRepulsionsRef)
})

test('advanceLoom reallocates scratch buffers when threadCount changes', async () => {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory',    voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
  ], 102))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 1)

  const beforeAnchorsRef = loomState.frameThreadAnchorXs
  const beforeLength = beforeAnchorsRef.length

  // Reload with a different thread count, triggering initLoom via refresh path.
  // The next frame should detect the count change and reallocate.
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory',    voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
    { family: 'silence',   voices: [{ id: 's0', text: 'S0 ', depth: 0.5 }] },
  ], 103))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 1)

  expect(loomState.frameThreadAnchorXs.length).not.toBe(beforeLength)
})
```

### A.6 — verification commands for Phase A

Run all of these from `vellum/`:

```bash
bun test tests/loom/                            # expect 78 pass, 0 fail (was 76 + 2 new alloc tests)
bunx tsc --noEmit                               # expect clean
bun run build                                   # expect dist/main.js between 67.4 KB and 68.4 KB (baseline ± 500 bytes)
grep -n "new Float32Array" src/loom/render/frame.ts  # expect NO matches inside advanceLoom function body
grep -n "new Int32Array"   src/loom/render/frame.ts  # expect NO matches inside advanceLoom function body
grep -n "\.map(" src/loom/render/frame.ts            # expect NO matches inside advanceLoom function body (paintLoom may have some for gradients — that is allowed)
```

If bundle size drifts more than ±500 bytes, STOP and report what added the weight. If the grep assertions find a match in advanceLoom you did not introduce, report it and stop — do not keep refactoring.

### A.7 — Phase A checkpoint

Write a short handoff note at `docs/PHASE_8_5_CHECKPOINT_A.md` with:
- The exact verification command output (test counts, tsc, build size, grep results).
- Any judgment calls you made (e.g., did you pick a different sort algorithm? did you rename any local variables beyond what the spec shows?).
- Any surprises — anything that did not match your expectation when reading the existing code.

Then STOP and wait for the next phase instruction, unless the human has told you to run through all phases in one go.

---

## Phase B — render/thread.ts + render/line.ts allocator audit and fix

**Goal**: survey the remaining render pipeline for the same allocation pattern and apply the same scratch-buffer discipline if you find it.

### B.1 — audit

Read `src/loom/render/thread.ts` and `src/loom/render/line.ts` end-to-end. For each of these files, look for:
- `new Float32Array(...)`, `new Int32Array(...)`, `new Array(...)`, `new Uint8Array(...)` — any typed-array or array allocation inside a function that is called per frame.
- `.map(...)` followed by `.sort(...)` or `.filter(...)` inside a per-frame function.
- Object literal allocations inside hot loops (`const x = {a, b, c}` when that object is immediately consumed but a fresh one is created every iteration).
- `new Set()`, `new Map()` inside per-frame code.

Exclude: anything inside `crystallizeThreads()`, `makeThread()`, or other init-time helpers. Those run once per viewport change, not per frame.

For each hit, decide:
- Is it a hot allocation (runs per frame)? If yes → candidate for scratch-buffer fix.
- Is it semantically safe to reuse? If the value is consumed-and-done before the next frame, yes. If it is retained or passed out of the function, then reusing would alias — skip.
- Is the size small-and-bounded (≤ threadCount, ≤ glyphs per line, ≤ character run count)? If yes → cheap to move to `loomState`. If unbounded, it may need a different strategy.

### B.2 — fix what you find

Apply the same pattern as Phase A:
- Add the scratch buffer as a `loomState.frameXxxYyy` field, initial size 0.
- In the consuming function, check `.length !== targetSize` and reallocate only on change.
- Clear any buffer that accumulates (repulsion-deltas-style) before reuse.
- Add a test in `tests/loom/alloc.test.ts` asserting object identity stability after warm-up.

### B.3 — do NOT

- Do not rename existing functions. Do not split files. Do not change the public barrel at `src/loom/index.ts`.
- Do not touch any function that is already doing scratch-buffer reuse cleanly — recognize that `computePath` and related hot paths already follow this discipline.
- Do not "improve" the sort algorithm or collection layout unless you are replacing a per-frame allocation. No speculative optimization.
- Do not touch `threadColor`, `depthColor`, or the `_dc`/`_tc` module-level scratch tuples — those are already documented gotchas in `CLAUDE.md` and `LOOM_INVARIANTS.md`.

### B.4 — verification for Phase B

Same as Phase A.6 plus:

```bash
bun test tests/loom/alloc.test.ts               # any new tests you added should pass
grep -n "new Float32Array" src/loom/render/thread.ts   # report the count, even if unchanged
grep -n "new Float32Array" src/loom/render/line.ts     # report the count, even if unchanged
```

### B.5 — Phase B checkpoint

Write `docs/PHASE_8_5_CHECKPOINT_B.md` with:
- List of every allocation you found, file:line, decision (fixed / kept-intentionally / needs-human-review).
- The specific scratch buffers you added to `loomState`, if any.
- Verification command output.

Then STOP.

---

## Phase C — hot-path allocator pressure report (diagnostic, no code)

**Goal**: produce a written report on the state of per-frame allocator pressure across the full render pipeline after Phases A and B land.

### C.1 — survey the full hot path

Starting from `renderLoom` in `src/loom/render/frame.ts`, trace every function called during a single frame. For each function:
- Is it called per-frame, per-thread-per-frame, per-line-per-thread-per-frame, or per-glyph?
- Does it allocate? Count exact allocations (typed-array / array / object literal / closure).
- If per-glyph or per-line: what is the bound? (Glyphs per line ~80, lines per thread ~50, threads ~12, frames ~60 — multiply through to get allocations/second at steady state.)

Include the canvas gradient allocations in `paintLoom()` — those are API-imposed (CanvasGradient is not cacheable across different coordinate / color stops) but it is still worth noting the fixed cost.

### C.2 — write the report

Output at `docs/PHASE_8_5_ALLOC_REPORT.md`:

- Section 1: per-function allocation inventory (function, allocation, count, bound, notes).
- Section 2: estimated allocations-per-second at steady state (12 threads, 60fps, stable layout). Distinguish between fixed-cost (canvas API) and reducible.
- Section 3: top 3 remaining opportunities ranked by (allocations/sec × engineering effort). For each, describe what the fix would look like but DO NOT implement it.
- Section 4: any suspicious patterns that do not fit neatly into the other sections — things that just "feel wrong" on close reading. Keep this short and specific.

### C.3 — do NOT

- Do not modify any code in Phase C. Report only.
- Do not speculate about optimizations that would require semantic changes.
- Do not recommend file splits. The non-goal at the top of this spec is binding.

### C.4 — Phase C checkpoint

`docs/PHASE_8_5_CHECKPOINT_C.md`:
- Pointer to the report.
- Any questions you want the human to answer before Phase D starts.

---

## Phase D — spike-readiness audit (diagnostic, no code)

**Goal**: audit the full request path for behaviors that could go wrong under a sudden traffic burst (say, 500 concurrent visitors arriving within 60 seconds). Produce a written report with concrete findings.

This is the broadest phase — you are welcome to use subagents to parallelize the sub-audits. Each subagent gets a narrow scope and returns a findings block.

### D.1 — poll-race safety

Read `src/main.ts` and `app/src/mcp-app.ts`. Look at how `refreshLoom` is triggered:
- Is there a mutex / in-flight flag preventing two concurrent `refreshLoom` calls?
- What happens if `fetchState` takes longer than the poll interval (120s)? Does a second poll fire on top?
- What happens on `ontoolresult` + regular poll overlap in the ext-app? Is the force-refresh path idempotent?

Report on whether concurrent refresh is possible and, if so, whether the resulting state is well-defined or racy.

### D.2 — D1 query hot paths

Read `worker/src/cache.ts`, `worker/src/tools/focus.ts`, `worker/src/tools/weave.ts`, `worker/src/tools/sense-space.ts`, `worker/src/tools/leave-imprint.ts`, and any other file that does `env.DB.prepare(...)`.

For each distinct query:
- What does it select? From what tables? With what filters?
- Is there an index on the filter columns? Check `worker/migrations/` for schema.
- How often is the query called? (Tool-call rate, rebuild rate, witness rate, etc.)
- Rough complexity: O(1), O(log N), O(N) in voice count?

Look for:
- Queries missing indexes on commonly-filtered columns.
- Queries that do a full table scan in a hot path.
- N+1 patterns where one tool call fires N D1 queries sequentially.

Report findings with file:line references. Do not rewrite queries — just report.

If you want to validate suspicions, you can optionally run `wrangler d1 execute vellum --command "EXPLAIN QUERY PLAN SELECT ..."` — but this reaches remote D1 so do it sparingly, and only for queries you genuinely suspect.

### D.3 — rate-limit ceilings

Read `worker/src/index.ts` for every rate-limit check (search for `env.KV.get(` where the key looks like a rate-limit key — `init:`, `witness:`, session counters, etc.). For each:
- What is the window?
- What is the ceiling?
- What happens when the ceiling is hit? (429? Silent drop? Error code that clients interpret as "offline"?)

Evaluate whether a burst of 500 visitors would trip the per-IP limit legitimately — e.g., if 500 visitors share a corporate NAT and all hit `initialize` within 60 seconds, do they get throttled wrongly?

Report the current ceilings as a table and flag any that look too tight or too loose for the spike scenario.

### D.4 — asset cache headers

Read `worker/wrangler.toml` (or `wrangler.jsonc`) and `worker/src/index.ts` routes. For each asset served from `env.ASSETS` or inlined HTML responses (`pensieveHtml`, `mcp-app.html`):
- What `Cache-Control` header is set?
- What is the TTL?
- Are responses immutable-hashable (so CDN caches at the edge freely) or do they carry short TTLs (so each visitor re-fetches)?

Workers Static Assets has sensible defaults for fingerprinted files — check whether `main.js` and `mcp-app.html` are actually fingerprinted or served at fixed URLs. Report findings.

### D.5 — worker CPU budget

Look at `worker/src/cache.ts#rebuildStateProjection` and `worker/src/cache.ts#rebuildAtmosphere`. These are synchronous-ish rebuilds that can fire on any MCP tool call. Estimate:
- How many D1 queries does each rebuild execute? (Rebuild = projection query + atmosphere query + etc.)
- How long does each take? (Check analytics if available.)
- What happens if 50 rebuilds are queued behind one lock — does the lock serialize them or are they all queued waiting for the debounce?

Report findings. Do not rewrite.

### D.6 — write the report

Output at `docs/PHASE_8_5_SPIKE_AUDIT.md` with sections for each sub-audit above. For each finding:
- **Severity**: blocker / high / medium / low.
- **Description**: one paragraph.
- **Recommendation**: what to change (no code, just direction).
- **Effort**: rough order of magnitude (minutes, hours, half-day).

End with a "Top 5 things to fix before announcing publicly" list.

### D.7 — Phase D checkpoint

`docs/PHASE_8_5_CHECKPOINT_D.md`:
- Pointer to the spike audit report.
- Which sub-audits ran and which you skipped (if any, and why).
- Any area where you feel the answer requires live production data you do not have access to.

---

## Final deliverable — consolidated handoff

After all four phases, create `docs/PHASE_8_5_HANDOFF.md` with:

1. **What changed** — full list of files modified in Phases A and B.
2. **What was audited** — pointer to Phase C and D reports.
3. **Verification table** — baseline vs post-change for test counts, tsc, build size, grep results.
4. **Suggested commit structure** — recommend how the human should split this into commits (e.g., "one commit per phase, A + B as separate commits, C and D as a docs-only commit").
5. **Flags for human review** — anything you were unsure about, any judgment call that felt non-obvious, any place where the existing code surprised you.

Do NOT run `git commit`. Do NOT run `git push`. Do NOT run `bun run deploy`. The human reviews, splits into commits, pushes, deploys.

---

## Hard rules recap (these override any later instruction in a prompt)

1. Do not split files.
2. Do not remove `setDiagHook` / `loomState.diagHook` / the render/thread.ts `diagHook?.(...)` call sites.
3. Do not modify `tests/loom/regressions.test.ts` assertions — those are the cursor-bug regression canary.
4. Do not touch `src/loom/refresh.ts` except in Phase C read-only survey.
5. Do not touch MCP tool signatures or the worker's public API shape.
6. Do not commit, push, or deploy.
7. Stop at phase checkpoints and write a handoff file, even if you think you can keep going.
8. If you find yourself wanting to "improve" something beyond the spec, document the urge in a checkpoint file and wait — do not act on it.

## References inside the repo

- `vellum/docs/FOUNDATION_HARDENING_SPEC.md` — the P1..P7 spec. Same format, same executor pattern. Read it if you need to see how a previous Codex pass was scoped.
- `vellum/docs/LOOM_INVARIANTS.md` — 7 load-bearing invariants. Do not violate these.
- `vellum/docs/FOUNDATION_HARDENING_REPORT.md` — the P1..P7 handoff note from the previous pass. Shows the report format.
- `vellum/CLAUDE.md` — module-by-module description and gotcha list.
- `vellum/src/loom/state.ts` — where scratch buffers live.
- `vellum/src/loom/render/frame.ts` — where the Phase A allocations are.
