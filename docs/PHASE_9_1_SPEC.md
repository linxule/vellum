# Vellum Phase 9.1 — Small-fixes sweep (renderer bugs + build infra + ext-app base URL)

**Status**: ready to execute after Phase 9.0 lands on main
**Worktree**: cut a fresh worktree from main at the commit that adds this spec (the post-9.0 docs commit). Recommended path:
  `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-91/vellum`
  Branch: `feat/phase-9-1-small-fixes`
**Executor**: the Codex instance that did 9.0 is preferred — context is already warm on the build/test surface and the post-9.0 handoff pattern. A fresh instance also works; the spec is self-contained.
**Stop-before-commit**: YES. The human commits. Do NOT run `git commit` from inside the Codex sandbox.
**Main-branch policy**: do NOT push. Do NOT deploy. The human owns those steps.

## Motivation

Phase 9.0 closed the four worker-side correctness findings from the 2026-04-09 audit. That leaves three small renderer/ext-app/build-infra findings and the full modularization pass still open. Phase 9.1 is the **small-fixes sweep** — it closes the three tiny-but-real correctness bugs (F5, F6) and the build-infra findings (M3, F4) as a single coherent pass. Modularization (M1 worker split, M2 shared renderer runtime) is deferred to a separate Phase 9.2 because it's a much larger cross-cutting refactor that deserves its own fresh Codex context.

The four targets in 9.1 are all independent of each other, all independent of 9.0's final shape, and all touch files that the worker test suite added in 9.0 does not exercise. The phase should land as 4-5 small atomic commits, each of which is individually reviewable and revertable.

## Audit findings addressed in this phase

| # | Severity | Summary | Task |
|---|---|---|---|
| F5 | Medium | `isLineRTL` loop uses `i < end.segmentIndex`, so lines that share a single wrapped segment (all common in CJK + long Arabic runs) get 0 width counted in either direction and return LTR by default. Also silently drops the end segment when `end.graphemeIndex > 0`, under-counting every multi-segment line. | A |
| F6 | Medium | `updateResonances` runs `continue` when the current thread's `familyNames` does not include the resonance's family. The `continue` skips the expiry check, so if no iterated thread matches (hidden voice, viewport regrouping, etc.) the resonance is never pruned and leaks in `loomState.resonances` until `clearResonance()` is called. | B |
| M3 | Low | Root `bun run deploy` builds the renderer + ext-app, then calls `cd worker && bun run deploy` whose `predeploy` rebuilds the renderer + ext-app AGAIN. No repo-wide `verify` script — each deployment relies on ad-hoc recollection of which tests to run. | C |
| F4 | Medium | `app/src/mcp-app.ts` hardcodes `BASE_URL = 'https://vellum.linxule.com'` and `worker/src/index.ts` hardcodes `connectDomains: ['https://vellum.linxule.com']`. Local-dev iframe mode always hits prod; a `workers.dev` deploy would fail CSP. | D |

M1 (split `worker/src/index.ts`) and M2 (extract shared renderer runtime between `src/main.ts` and `app/src/mcp-app.ts`) are deferred to Phase 9.2. Do **not** do any modularization in this phase.

## Non-goals

- **No modularization.** `worker/src/index.ts` stays monolithic. `src/main.ts` and `app/src/mcp-app.ts` stay as parallel files (the M2 extraction target). If you think you need to create a new `src/runtime/` directory or a new `worker/src/handlers/` directory, stop — you are in Phase 9.2.
- **No new renderer features.** F5 and F6 are strictly bug fixes. Do not add new visual effects, new state, new tests beyond T4 and T5.
- **No worker correctness changes.** 9.0 closed the worker write pipeline. Do not touch `worker/src/cache.ts`, `worker/src/tools/**`, `worker/src/utils.ts`, `worker/src/sedimentation.ts`, or the zod schemas in `worker/src/index.ts`. The ONLY worker edit in 9.1 is inside the `resources/read` handler for F4.
- **No migration.** The schema is frozen. If you think you need a new migration, stop — you are lost.
- **No new npm/bun dependencies.** Not even for tests.
- **No rename of existing constants or functions.** Touch only what the tasks call out.
- **No `parseModel()` changes.** Still untouched from 8.7.
- **No wire-format changes.** MCP tool schemas untouched. `/api/witness` response untouched.
- **No CSP widening beyond request origin.** The F4 fix derives `connectDomains` from the request URL; do not hardcode a multi-domain list "just in case".
- **No CLAUDE.md edits.** The human updates CLAUDE.md post-landing.

## Current baseline (what you are starting from)

At main HEAD (any post-9.0 commit at or after the 9.0 landing at `63ff6e8` — run `git log --oneline -1 main` to confirm. The semantic baseline is the worker state that 9.0 landed; trailing docs-only commits do not count as drift):

- `bun test tests/loom/` → `82 pass, 0 fail`, 19 files
- `cd worker && bun test tests/` → `13 pass, 0 fail`, 3 files (Phase 9.0's new worker test suite — do NOT regress these)
- `bunx tsc --noEmit` (root) → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd app && bunx tsc --noEmit` → clean
- `bun run build` → `dist/main.js` = `69884` bytes
- `cd worker && bun run deploy --dry-run` → clean
- Live version: `vellum.linxule.com` at `f3412b5b-324f-40fd-8eb0-4b67e4d5267f`
- Remote D1 migrations applied: `0001_init`, `0002_warmth_state`, `0003_identity_and_indexes`, `0004_declared_model` — no new migration in 9.1

If any of these baselines differ when you start, STOP and report — something drifted.

## Files Codex is allowed to touch

**Phase A (F5):**
- `src/loom/text.ts`
- `tests/loom/text.test.ts` (new file OR add T4 to an existing text-related test file — check first)

**Phase B (F6):**
- `src/loom/resonance.ts`
- `tests/loom/resonance.test.ts` (new file OR add T5 to existing — check first)

**Phase C (M3):**
- `package.json` (root) — `deploy`, add `verify`
- `worker/package.json` — no changes, the `predeploy` script is already correct; 9.1 removes the DUPLICATION from the root side

**Phase D (F4):**
- `app/src/mcp-app.ts` — replace hardcoded `BASE_URL` with sentinel
- `worker/src/index.ts` — only the `resources/read` branch of `handleMCP` (lines 397-417 in the 9.0 baseline). Replace sentinel with dynamic origin, derive `connectDomains` from request.
- `worker/tests/resources.test.ts` (new file)

**Phase E (docs):**
- `docs/PHASE_9_1_CHECKPOINT_A.md`
- `docs/PHASE_9_1_HANDOFF.md`

## Files Codex must NOT touch

- Anything under `worker/src/**` **other than** the `resources/read` branch of `handleMCP` in `worker/src/index.ts`
- Anything under `worker/tests/**` **other than** the new `resources.test.ts`
- Anything under `src/loom/**` **other than** `text.ts` and `resonance.ts`
- `src/main.ts` (Phase 9.2 target)
- `src/content.ts` (stable API shape)
- `app/mcp-app.html` — the HTML shell. The sentinel lives inside the JS bundle, not the shell.
- `app/src/mcp-app.ts` **other than** the `BASE_URL` constant and any immediate references that need to be kept in sync
- Any migration under `worker/migrations/**`
- `worker/wrangler.jsonc`
- `app/package.json`
- `tsconfig.json` (root, worker, or app)
- `CLAUDE.md`
- Anything under `docs/` other than the two 9.1 files listed above
- Anything under `spec/` or `archive/`

## Context pointers (read before writing code)

- `src/loom/text.ts:26-36` — the `isLineRTL` loop. The bug is `i < end.segmentIndex` excluding the end segment. Note the neighboring function `voiceSpanForLine` at line 63 already uses the correct `end.graphemeIndex === 0 ? -1 : 0` idiom (`let lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)`) — mirror that idiom in the fix.
- `src/loom/resonance.ts:20-34` — `updateResonances`. The `continue` at line 24 sits BEFORE the expiry check at lines 25-29. Move the expiry check above the family-match gate.
- `package.json` — root scripts. Current `deploy` double-builds: the root line runs `bun run build && cp && cd app && vite build && cd ../worker && bun run deploy`, but the worker's `predeploy` then runs the same sequence again. One of the two needs to stop doing the build.
- `worker/package.json` — the worker's `predeploy` is the right place for the build chain (it's a single `cd ..` sequence). Root `deploy` should delegate entirely.
- `worker/src/index.ts:4` — `import pensieveHtml from '../../app/dist/mcp-app.html'`. The bundled HTML is imported as a string at build time via wrangler's `[[rules]]` `text` handler. Dynamic replacement at `resources/read` time is a pure string operation.
- `worker/src/index.ts:397-417` — the `resources/read` branch. `pensieveHtml` is passed as-is. The fix rewrites the string before returning it.
- `worker/src/index.ts:408` — hardcoded `connectDomains: ['https://vellum.linxule.com']`. Replace with `[new URL(request.url).origin]`.
- `app/src/mcp-app.ts:9` — `const BASE_URL = 'https://vellum.linxule.com'`. Replace the literal with the sentinel `'__VELLUM_BASE_URL__'`. The sentinel must be a plain string literal (not a template, not a computed value) so that vite/esbuild preserves it verbatim in the output bundle.
- `app/src/mcp-app.ts:174` — `fetch(BASE_URL + '/api/witness', ...)`. This path uses BASE_URL. After the fix, `BASE_URL` holds the sentinel string at build time, then the worker replaces the sentinel at `resources/read` time, so by the time the bundle runs in the browser it's the real origin. No runtime logic change.
- `src/content.ts:5` — `setBaseUrl` is already called with BASE_URL from mcp-app.ts (line 10). This continues to work: after the sentinel is rewritten, `setBaseUrl('https://vellum.linxule.com')` or `setBaseUrl('http://localhost:8787')` depending on origin.

## Hard rules recap

1. Do not touch `worker/src/cache.ts`, `worker/src/tools/**`, `worker/src/utils.ts`, `worker/src/sedimentation.ts`, or the zod schemas in `worker/src/index.ts`.
2. Do not touch `src/main.ts`, `src/content.ts`, or any `src/loom/**` file other than `text.ts` and `resonance.ts`.
3. Do not modify CLAUDE.md.
4. Do not squash phases. Each of the four code tasks should be a single atomic commit in the suggested sequence.
5. Do not add new dependencies.
6. Do not rename existing identifiers unless the task explicitly says so.
7. Do not add comments describing what was changed ("// Phase 9.1 fix"). The commit message IS the record.
8. Run the full verification table after EACH phase, not just at the end. If any check regresses, stop and report.

## Phase A — F5: `isLineRTL` same-segment wrap fix + T4 test

### Problem

In `src/loom/text.ts:26-36`:

```ts
export function isLineRTL(prepared: PreparedTextWithSegments, start: LayoutCursor, end: LayoutCursor): boolean {
  const levels = (prepared as any).segLevels as Int8Array | null
  if (!levels) return false
  const widths = (prepared as any).widths as number[]
  let rtl = 0
  let ltr = 0
  for (let i = start.segmentIndex; i < end.segmentIndex; i++) {
    const w = widths[i] || 1
    if (levels[i]! & 1) rtl += w
    else ltr += w
  }
  return rtl > ltr
}
```

Two defects in the same loop:

1. **Same-segment wrap**: when `start.segmentIndex === end.segmentIndex` (a single long Arabic/Hebrew/CJK run that wrapped into multiple lines), the loop body never runs. `rtl = ltr = 0`. `return 0 > 0` → `false` → the line is mis-labeled LTR and the glyph ordering flips wrong.
2. **End-segment drop**: when the line ends mid-segment (`end.graphemeIndex > 0`), the end segment's level is silently dropped. Multi-segment lines ending inside an RTL run get under-counted.

### Fix

Mirror the idiom already used by `voiceSpanForLine` at `src/loom/text.ts:63-65`:

```ts
const startSeg = Math.min(Math.max(0, start.segmentIndex), segmentCount - 1)
let lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)
lastSeg = Math.min(Math.max(startSeg, lastSeg), segmentCount - 1)
```

Apply the same `lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)` derivation inside `isLineRTL` and loop `for (let i = start.segmentIndex; i <= lastSeg; i++)`. No segmentCount clamping is needed inside `isLineRTL` because it does not index `segments[i]` — only `widths[i]` and `levels[i]`, which are the same length and safe under the derived bound when `widths` is the authoritative length source.

### Exact diff

```ts
export function isLineRTL(prepared: PreparedTextWithSegments, start: LayoutCursor, end: LayoutCursor): boolean {
  const levels = (prepared as any).segLevels as Int8Array | null
  if (!levels) return false
  const widths = (prepared as any).widths as number[]
  const lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)
  let rtl = 0
  let ltr = 0
  for (let i = start.segmentIndex; i <= lastSeg; i++) {
    const w = widths[i] || 1
    if (levels[i]! & 1) rtl += w
    else ltr += w
  }
  return rtl > ltr
}
```

Net change: `-1 / +2` LOC inside the function body. Loop header changes from `i < end.segmentIndex` to `i <= lastSeg`; one new line declares `lastSeg`.

### T4 test — `tests/loom/text.test.ts`

Check first whether `tests/loom/text.test.ts` already exists. If it does, add T4 as a new `test(...)` inside the existing `describe(...)`. If not, create the file with minimal setup.

T4 must assert three things:

- **T4a**: a single RTL segment that wraps across multiple lines — each line's `isLineRTL` returns `true`. Build a `PreparedTextWithSegments`-shaped object (fields accessed: `segLevels`, `widths`) with `segLevels = new Int8Array([1])` (RTL) and one wide `widths` entry, then call `isLineRTL` with `start = { segmentIndex: 0, graphemeIndex: 0 }` and `end = { segmentIndex: 0, graphemeIndex: 5 }`. Expect `true`.
- **T4b**: a multi-segment line ending mid-RTL segment — previously the end segment was dropped. Build `segLevels = new Int8Array([0, 1])` (LTR, RTL) with `widths = [1, 10]` and `start = { segmentIndex: 0, graphemeIndex: 0 }`, `end = { segmentIndex: 1, graphemeIndex: 3 }`. Expect `true` (10 > 1).
- **T4c**: the null-levels guard still short-circuits. Build a prepared object with `segLevels = null`. Expect `false` for any cursor pair.

Use the `as any` cast when constructing the fake prepared object since the real `PreparedTextWithSegments` type has more fields that are irrelevant to this test.

### Verification after Phase A

```bash
bun test tests/loom/text.test.ts   # the new T4 cases must pass
bun test tests/loom/               # 82+3=85 or 82+N where N is the number of T4 assertions — report actual count
bunx tsc --noEmit                  # root must stay clean
bunx tsc -p worker/tsconfig.json --noEmit
cd app && bunx tsc --noEmit && cd ..
bun run build                       # expect dist/main.js = 69884 ± small delta (F5 is small diff, bundle drift < 100 bytes)
git diff --stat main                # expect 2 files: src/loom/text.ts, tests/loom/text.test.ts
```

Report the actual test count delta. If bundle size changes by more than 200 bytes, investigate before continuing — a 1-line loop change should not meaningfully shift the bundle.

## Phase B — F6: resonance expiry sweep fix + T5 test

### Problem

In `src/loom/resonance.ts:20-34`:

```ts
export function updateResonances(thread: Thread, now: number) {
  for (let ri = loomState.resonances.length - 1; ri >= 0; ri--) {
    const res = loomState.resonances[ri]!
    if (!thread.familyNames.includes(res.family)) continue
    const resElapsed = (now - res.start) / 1000
    if (resElapsed > 6) {
      loomState.resonances.splice(ri, 1)
      continue
    }
    const resFade = Math.max(0, 1 - resElapsed / 6)
    thread.warmth = Math.max(thread.warmth, 0.6 * resFade)
    thread.arrivalGlow = Math.max(thread.arrivalGlow, 0.5 * resFade)
  }
}
```

`updateResonances` is called per-thread per-frame. The family-match gate sits BEFORE the expiry check. If no iterated thread matches the resonance's family (e.g., the sourced voice was hidden, the viewport regrouped, or the family's thread has merged away), the expiry check never runs and the resonance lives forever in `loomState.resonances` until `clearResonance()` is called on bulk reload.

The behavioral impact is small (resonance entries are a handful of bytes) but it's a real memory leak under edge conditions, and the fix is trivial.

### Fix

Move the expiry check above the family-match `continue`. The expiry decision is independent of the iterating thread — it depends only on `now - res.start`.

### Exact diff

```ts
export function updateResonances(thread: Thread, now: number) {
  for (let ri = loomState.resonances.length - 1; ri >= 0; ri--) {
    const res = loomState.resonances[ri]!
    const resElapsed = (now - res.start) / 1000
    if (resElapsed > 6) {
      loomState.resonances.splice(ri, 1)
      continue
    }
    if (!thread.familyNames.includes(res.family)) continue
    const resFade = Math.max(0, 1 - resElapsed / 6)
    thread.warmth = Math.max(thread.warmth, 0.6 * resFade)
    thread.arrivalGlow = Math.max(thread.arrivalGlow, 0.5 * resFade)
  }
}
```

Net change: `-1 / +2` LOC. The expiry block (3 lines) moves up, the family-match `continue` moves down. Same total logic, different ordering. No behavioral change for the happy path where a matching thread exists.

### Incidental behavior note

After the fix, the expiry check runs once per thread per frame instead of once per matching thread per frame. For 10 threads and a list of 3 resonances, that's 30 `splice` candidates per frame vs. the old ~3. However, `splice` only actually runs when a resonance IS expired, so the amortized cost is identical; only the array-read + subtraction + comparison runs unconditionally per thread. This is a non-issue for the expected resonance list length (< 10) but is worth knowing if you see a frame-time spike.

### T5 test — `tests/loom/resonance.test.ts`

Check first whether `tests/loom/resonance.test.ts` already exists. If yes, add T5 cases to the existing describe. If no, create the file.

T5 must assert two things:

- **T5a**: a resonance older than 6s whose family is NOT in any iterated thread is pruned anyway. Setup: `loomState.resonances = [{ family: 'silence', start: performance.now() - 7000 }]`. Build a thread with `familyNames = ['light']` (no match). Call `updateResonances(thread, performance.now())`. Assert `loomState.resonances.length === 0`. Assert `thread.warmth` unchanged (no application happened).
- **T5b**: a fresh resonance whose family is NOT in the iterated thread is NOT pruned (it has time left) AND is NOT applied to the non-matching thread. Setup: `loomState.resonances = [{ family: 'silence', start: performance.now() - 1000 }]`. Thread with `familyNames = ['light']`. Call `updateResonances`. Assert `loomState.resonances.length === 1` (still alive). Assert `thread.warmth` unchanged.

You will need to import `loomState` and the types. Follow the pattern of any existing loomState-touching test in `tests/loom/`. Reset `loomState.resonances = []` in a `beforeEach` or at the top of each test to avoid cross-test bleed.

Building a minimal `Thread` object for the test: look at existing test fixtures in `tests/loom/` for the shape. You can construct a stub with only the fields `updateResonances` touches: `familyNames: string[]`, `warmth: number`, `arrivalGlow: number`. Cast to `Thread` via `as unknown as Thread` if needed.

### Verification after Phase B

```bash
bun test tests/loom/resonance.test.ts
bun test tests/loom/               # expect (Phase A total + T5 case count)
bunx tsc --noEmit
bunx tsc -p worker/tsconfig.json --noEmit
cd app && bunx tsc --noEmit && cd ..
bun run build                       # expect bundle size unchanged or within 100 bytes
git diff --stat main                # expect 2 new files (A + B combined): 4 files total
```

## Phase C — M3: deploy script consolidation + verify script

### Problem

Currently two places build the renderer + ext-app:

- Root `package.json`:
  ```json
  "deploy": "bun run build && cp dist/main.js worker/public/dist/main.js && cd app && bunx vite build && cd ../worker && bun run deploy"
  ```
- Worker `package.json`:
  ```json
  "predeploy": "cd .. && bun run build && mkdir -p worker/public/dist && cp dist/main.js worker/public/dist/main.js && cd app && bunx vite build",
  "deploy": "bun run predeploy && wrangler deploy"
  ```

Running `bun run deploy` at repo root builds the renderer and ext-app, then invokes `cd worker && bun run deploy`, whose `predeploy` builds the renderer and ext-app AGAIN. Double work, and any flakiness in the first pass (e.g., a stale `dist/`) is silently covered by the second pass, hiding real bugs.

There is also no repo-wide `verify` command, so "can I land this safely" depends on ad-hoc recollection of every check: renderer tests, worker tests (new in 9.0), three `tsc --noEmit` passes, renderer bundle build, worker dry-run.

### Fix

Two changes, both in `package.json` (root).

**C1: Delegate deploy to worker.**

The worker's `predeploy` is the canonical build chain (it's the most complete sequence: cd, build renderer, copy, build ext-app). Root's `deploy` should simply invoke the worker's `deploy`. Change root `deploy` to:

```json
"deploy": "cd worker && bun run deploy"
```

Worker's `package.json` is untouched. The flow becomes: root deploy → worker deploy → worker predeploy (which does the full build chain from the worker directory via `cd ..`) → wrangler deploy.

**C2: Add a `verify` script at root.**

Single command that runs everything a human would run before landing a change:

```json
"verify": "bun test tests/loom/ && bunx tsc --noEmit && cd worker && bun test tests/ && bunx tsc --noEmit && cd ../app && bunx tsc --noEmit && cd .. && bun run build"
```

Order chosen so the fastest-to-fail checks run first:

1. Renderer tests (fastest, most churned surface)
2. Root typecheck
3. Worker tests (Phase 9.0's new suite — 13 tests, < 1s)
4. Worker typecheck
5. App typecheck
6. Renderer bundle build (slowest, validates the whole pipeline minifies)

Do NOT add `cd worker && bun run deploy --dry-run` to `verify`. That requires wrangler auth state and is deploy-adjacent — it belongs in a separate `predeploy` or the human's manual sequence, not in a test gate.

### Exact edit

Current root `package.json` `scripts` block — note this is from the pre-9.1 baseline, confirm against the actual file before editing:

```json
{
  "scripts": {
    "dev": "...",
    "build": "...",
    "serve": "...",
    "artifact": "...",
    "deploy": "bun run build && cp dist/main.js worker/public/dist/main.js && cd app && bunx vite build && cd ../worker && bun run deploy",
    "test": "..."
  }
}
```

After the edit:

```json
{
  "scripts": {
    "dev": "...",
    "build": "...",
    "serve": "...",
    "artifact": "...",
    "deploy": "cd worker && bun run deploy",
    "verify": "bun test tests/loom/ && bunx tsc --noEmit && cd worker && bun test tests/ && bunx tsc --noEmit && cd ../app && bunx tsc --noEmit && cd .. && bun run build",
    "test": "..."
  }
}
```

Do not reorder other scripts. Do not touch the other scripts' contents. Do not add a `predeploy` script at root — let the worker's own `predeploy` handle the build chain.

### Verification after Phase C

```bash
bun run verify                     # must pass end-to-end, no skips
cd worker && bun run deploy --dry-run && cd ..   # must still be clean
git diff --stat main               # expect 5 files: phase A (2) + phase B (2) + phase C (1)
```

**Critical**: after the edit, running `bun run deploy --dry-run` from root will NOT work directly because `cd worker && bun run deploy --dry-run` does not chain (the `--dry-run` flag needs to reach `wrangler deploy`, and the new root deploy only calls `bun run deploy` not `bun run deploy --dry-run`). This is an acceptable trade-off — humans running dry-runs go `cd worker && bun run deploy --dry-run` directly, which is the intended flow and matches the worker-deploy pattern in CLAUDE.md. Do not add a separate root-level `deploy:dry` script — it's not worth the surface.

Also critical: the `verify` script uses `&&` chaining, which means the first failure stops the rest. If renderer tests fail you won't see worker test results. That's intentional — verify is a gate, not a diagnostic. Diagnostics are run step-by-step by the human.

## Phase D — F4: ext-app base URL injection via sentinel rewrite

### Problem

`app/src/mcp-app.ts:9`:

```ts
const BASE_URL = 'https://vellum.linxule.com'
```

This is hardcoded in the ext-app bundle at vite build time. Consequences:

1. When the ext-app iframe is loaded inside an MCP host against a local wrangler dev worker, it still hits `vellum.linxule.com` for `/api/state` and `/api/witness`. You can't develop the ext-app against local data.
2. If the worker ever gets deployed under a different hostname (e.g., `vellum.linxule.workers.dev` as the primary, or a preview subdomain), the bundled ext-app ignores the hostname it was served from and hits the hardcoded one.
3. `worker/src/index.ts:408` independently hardcodes `connectDomains: ['https://vellum.linxule.com']` in the `resources/read` CSP `_meta`, which would block cross-origin fetches if the iframe ever ran under a different origin.

### Fix

The fix has three coordinated parts:

**D1: Sentinel in the ext-app bundle.**

Replace the hardcoded URL in `app/src/mcp-app.ts:9` with the sentinel string `'__VELLUM_BASE_URL__'`:

```ts
const BASE_URL = '__VELLUM_BASE_URL__'
```

This must be a plain string literal — not a template, not a computed expression, not wrapped in a function call. Vite/esbuild preserves string literals verbatim in the output bundle, so the sentinel will survive bundling and minification as a literal substring of the emitted JS.

Do NOT change any downstream usage of `BASE_URL` in `mcp-app.ts` (lines 10, 174, etc.). They continue to work: at browser runtime, after the worker has rewritten the sentinel to the real origin, `BASE_URL` holds a valid URL string and `setBaseUrl(BASE_URL)` + `fetch(BASE_URL + '/api/witness', ...)` work normally.

**D2: Worker rewrites sentinel at `resources/read` time.**

In `worker/src/index.ts`, in the `case 'resources/read':` branch of `handleMCP` (currently lines 397-417), derive the request origin and replace the sentinel in `pensieveHtml` before returning:

```ts
case 'resources/read': {
  const uri = (body.params as Record<string, unknown>)?.uri as string
  if (uri === RESOURCE_URI) {
    const origin = new URL(request.url).origin
    const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)
    return jsonrpcResponse(body.id, {
      contents: [{
        uri: RESOURCE_URI,
        mimeType: EXT_APPS_MIME,
        text: html,
        _meta: {
          ui: {
            csp: {
              connectDomains: [origin],
              resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
            },
          },
        },
      }],
    }, sessionId ?? undefined)
  }
  return jsonrpcError(body.id, -32002, `Resource not found: ${uri}`)
}
```

Three changes:

- Compute `const origin = new URL(request.url).origin` at the top of the branch.
- Compute `const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)` and pass `html` to `text:` instead of `pensieveHtml`.
- Replace `connectDomains: ['https://vellum.linxule.com']` with `connectDomains: [origin]`.

The global regex `/__VELLUM_BASE_URL__/g` handles the case where the sentinel appears multiple times in the bundle (if vite inlines the const at multiple usage sites during minification, each call site becomes its own literal).

**D3: Worker test — `worker/tests/resources.test.ts`.**

New test file. Three cases:

- **T6a**: `resources/read` with a prod-origin request rewrites the sentinel to the prod origin. Build a `Request` with URL `https://vellum.linxule.com/mcp`, call `handleMCP` (import narrowly like the existing test files do), assert the response JSON's `result.contents[0].text` contains `'https://vellum.linxule.com'` and does NOT contain `'__VELLUM_BASE_URL__'`. Also assert `result.contents[0]._meta.ui.csp.connectDomains === ['https://vellum.linxule.com']`.
- **T6b**: `resources/read` with a local-dev origin rewrites to localhost. Request URL `http://localhost:8787/mcp`. Assert response text contains `'http://localhost:8787'` and `connectDomains === ['http://localhost:8787']`.
- **T6c**: `resources/read` with an unknown URI still returns the method-not-found error. Request URL doesn't matter; body params `uri` is `'ui://something/else'`. Assert the response is a jsonrpc error with code -32002.

Use `handleMCP` as the test target. If it's not currently exported, add it to the `export { ZOD_SCHEMAS, handleWitness, handleMCP }` line that Phase 9.0 added at the bottom of `worker/src/index.ts`. That's the only allowed edit outside the `resources/read` branch.

Reuse `MockExecutionContext` and (if relevant) `makeTestEnv` from `worker/tests/mocks.ts` — do NOT add new mock machinery. If the existing mocks don't cover what's needed (e.g., `handleMCP` expects something the 9.0 mocks don't provide), add the minimal extension to `mocks.ts` rather than inlining it in the test.

For the test, `pensieveHtml` is imported from `../../app/dist/mcp-app.html` which is a build artifact. The test environment needs `app/dist/mcp-app.html` to exist — if it doesn't, run `cd app && bunx vite build` first (this is what `bun run verify` does in Phase C). Note this dependency in the Phase E handoff.

### Verification after Phase D

```bash
bun test tests/loom/
cd worker && bun test tests/       # expect 13 + 3 = 16 (or the actual T6 case count)
cd ..
bun run verify                     # the full gate should still pass
bun run build                      # renderer bundle size should be unchanged from pre-9.1 baseline
cd worker && bun run deploy --dry-run && cd ..
git diff --stat main               # expect 8 files total: A(2) + B(2) + C(1) + D(3)
```

**Smoke test** (post-deploy, not part of Codex's Phase D):

1. Deploy the worker. Note the new version.
2. `curl https://vellum.linxule.com/mcp -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` — grab session.
3. `curl https://vellum.linxule.com/mcp -X POST -H 'Content-Type: application/json' -H 'mcp-session-id: ...' -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://vellum/pensieve.html"}}'` — assert response text contains `https://vellum.linxule.com` and does NOT contain `__VELLUM_BASE_URL__`, and `_meta.ui.csp.connectDomains` is `['https://vellum.linxule.com']`.
4. Repeat against `https://vellum.linxule.workers.dev/mcp` if you want to verify cross-origin rewriting.

Smoke is a human task post-deploy, not part of Codex's verification.

## Phase E — checkpoint + handoff

Two new files under `docs/`:

- `docs/PHASE_9_1_CHECKPOINT_A.md` — one section per phase (A/B/C/D) in the same structure as `PHASE_9_0_CHECKPOINT_A.md`. Each section: Baseline, Scope completed, Verification (with actual commands + outputs), Files touched, LOC delta, Judgment calls, Surprises, Out-of-scope urges, Deviations. Be honest about anything that deviates from this spec.
- `docs/PHASE_9_1_HANDOFF.md` — in the same style as `PHASE_9_0_HANDOFF.md`: What changed, Verification table, Suggested commit structure, Flags for human review, Open items.

The **suggested commit structure** in the handoff should be 5 atomic commits:

1. **Phase A**: `src/loom/text.ts` + `tests/loom/text.test.ts` (or the existing text test file) — F5 fix + T4 test
2. **Phase B**: `src/loom/resonance.ts` + `tests/loom/resonance.test.ts` (or the existing) — F6 fix + T5 test
3. **Phase C**: `package.json` (root) — deploy delegation + verify script
4. **Phase D**: `app/src/mcp-app.ts` + `worker/src/index.ts` + `worker/tests/resources.test.ts` (+ optional `worker/tests/mocks.ts` if extended) — F4 sentinel rewrite
5. **Phase E docs**: `docs/PHASE_9_1_CHECKPOINT_A.md` + `docs/PHASE_9_1_HANDOFF.md`

Do NOT collapse Phase C into Phase D. Build infra changes are independently revertable and deserve their own commit. Do NOT collapse Phases A and B — the two renderer bug fixes are independent and deserve separate test coverage in history.

**Flags section** of the handoff should include (minimum):

- Bundle size delta post-9.1 vs. baseline (expected: within ~200 bytes)
- Actual test count delta (baseline: 82 loom + 13 worker = 95, expected post-9.1: 82 + N_T4 + N_T5 loom + 13 + N_T6 worker)
- Whether `worker/tests/mocks.ts` was extended for Phase D, and what was added
- Whether any phase required an export change to `worker/src/index.ts` beyond the 9.0-added `export { ZOD_SCHEMAS, handleWitness }` line (adding `handleMCP` to it is expected)
- Any divergence from the suggested commit structure

**Open items section** should list M1 (worker split) and M2 (shared renderer runtime) as "deferred to Phase 9.2", and note that F1/F2/F7 renderer display is still a separate feature pass (not hardening).

## Full verification table (run after Phase E, before reporting done)

| Check | Command | Expected |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `82 + N_T4 + N_T5 pass, 0 fail` |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `13 + N_T6 pass, 0 fail` |
| Verify script | `bun run verify` | clean end-to-end |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle | `bun run build` | `dist/main.js` within 200 bytes of 69884 |
| Worker dry-run | `cd worker && bun run deploy --dry-run && cd ..` | clean |
| Diff scope | `git diff --stat main` | 8 tracked files + `worker/tests/resources.test.ts` as untracked (or 9 if the Phase D worker test file is the only new untracked) |
| Sentinel removed from bundle | `grep -c VELLUM_BASE_URL dist/main.js` | `0` (sentinel is in the ext-app bundle, not the renderer bundle — this assertion catches accidental sentinel leakage into the renderer) |
| Sentinel IS in ext-app bundle | `grep -c __VELLUM_BASE_URL__ worker/public/dist/main.js` or `grep -c __VELLUM_BASE_URL__ app/dist/mcp-app.html` | `>= 1` |
| Old hardcoded URL gone from worker | `git grep "'https://vellum.linxule.com'" worker/src/` | `0 hits` in `worker/src/` (excluding tests) |
| Old hardcoded URL gone from ext-app | `git grep "'https://vellum.linxule.com'" app/src/` | `0 hits` |

If any row fails, stop and report. Do NOT paper over failures.

## References (in-repo)

- `docs/PHASE_9_0_SPEC.md` — the spec Codex just executed. Use its style and tone as the template for the checkpoint and handoff.
- `docs/PHASE_9_0_CHECKPOINT_A.md` — Phase A/B/C/D/E format template.
- `docs/PHASE_9_0_HANDOFF.md` — handoff format template.
- `docs/PHASE_8_7B_SPEC.md` — small-scope spec template (good reference for "one-pass, atomic, per-phase-commit" style).
- `CLAUDE.md` — do NOT edit. But read the "Architecture", "Key Dependency", "Gotchas" sections for grounding.
- `src/loom/text.ts` — F5 target (~95 lines)
- `src/loom/resonance.ts` — F6 target (~34 lines)
- `worker/src/index.ts` — F4 target (line range 397-417 only; the `resources/read` branch)
- `app/src/mcp-app.ts:9` — F4 target (the BASE_URL const line)
- `package.json` (root) — M3 target
- `worker/tests/mocks.ts` — 9.0-built mock layer; reuse or extend minimally for T6

## Closing reminders

1. Do not touch files outside the allowlist.
2. Do not squash phases.
3. Run the full verification table after each phase, not just at the end.
4. Report deviations honestly — the 9.0 checkpoint was clean because Codex flagged valid-family-name substitution and the "no \_testable.ts shim needed" decision. Do the same here.
5. Stop before commit. The human commits.
6. Do not push, do not deploy, do not edit CLAUDE.md.
