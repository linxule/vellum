# Phase 9.2 Spec — M1 worker/src/index.ts split

**Type**: mechanical refactor (M1 only)
**Scope**: `worker/src/index.ts` → 9 files under `worker/src/` and `worker/src/handlers/`
**Deferred to 9.3**: M2 renderer runtime extraction from `src/main.ts` + `app/src/mcp-app.ts`
**Expected duration**: one Codex session, six small phases

## Motivation

`worker/src/index.ts` is 697 lines covering MCP JSON-RPC handling, HMAC session crypto,
JSON-RPC response helpers, analytics, four route handlers, CORS, the main fetch router,
and the narrow-export line for tests. Single file is cohesive (the router needs all of
it) but the internal groups are cleanly function-level separated by `// ---` banners.
Reading the file at a glance now requires remembering where each concern lives, and
touching one handler during a future feature pass means loading the whole file into
context. Splitting into a schemas file, HMAC helpers, JSON-RPC helpers, analytics,
four handler files, and a reduced index (router + CORS + narrow exports) makes each
concern locally comprehensible and leaves the next feature pass with a smaller blast
radius per edit.

This is a **mechanical refactor**. No runtime behavior changes. No bug fixes. No new
features. The acceptance test is simple: every existing test passes unchanged, the
worker dry-run is clean, and the live worker deploys identically.

## Non-goals

- **NO M2 renderer runtime extraction.** `src/main.ts` and `app/src/mcp-app.ts` are
  UNTOUCHED in 9.2. M2 is deferred to Phase 9.3 because it has genuine design decisions
  (how to parameterize the force-voice-queue divergence between main.ts's simple poll
  and mcp-app.ts's force-retry path) that deserve their own spec.
- **NO runtime behavior changes.** This refactor is invisible to clients. If the wire
  protocol, response shapes, or router behavior changes in any observable way, the
  refactor has failed.
- **NO test changes.** Tests import from `../src/index` and rely on the narrow export
  line. Tests MUST pass unchanged. Do not edit any `worker/tests/*.ts` file.
- **NO changes to already-modular files.** `worker/src/cache.ts`, `worker/src/utils.ts`,
  `worker/src/tools/**`, `worker/src/types.ts`, `worker/src/sedimentation.ts`,
  `worker/src/language.ts` — all untouched.
- **NO migration files.** Schema is stable since 0004.
- **NO `package.json` changes.** The verify script, deploy script, and dependencies
  stay as-is. If the split reveals a missing devDependency, stop and flag it in the
  handoff rather than adding it silently.

## Baseline

- Worktree repo root: `/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-92/vellum/vellum`
- Anchor commit: `5a78808` (CLAUDE.md refresh post-9.1 — the tip of main at spec-writing time).
  Any post-9.1 commit at or after this hash is acceptable; trailing docs-only commits do
  not count as drift. Semantic anchor: "after 9.1 has fully landed in production".
- Pre-execution `bun run verify` MUST be green from the baseline before any code
  changes. Record the result in Checkpoint A.
- Pre-execution tallies to capture in Checkpoint A baseline:
  - `bun test tests/loom/` → `87 pass, 0 fail`
  - `cd worker && bun test tests/` → `16 pass, 0 fail`
  - `bunx tsc --noEmit` (root, worker, app) → all clean
  - `bun run build && wc -c dist/main.js` → `69911 bytes` (or the current steady-state
    post-9.1 size; any value is acceptable as long as Phase E verification shows a
    bundle delta of exactly ZERO — this is a worker-only refactor)
  - `cd worker && bun run deploy --dry-run` → `Total Upload: ~383 KiB / gzip: ~93 KiB`
    (record exact value; Phase E verification must be within ±2 KiB of baseline,
    accounting for bundler packing noise only)

## Allowlist

Phase 9.2 may touch ONLY these paths:

**Modified:**
- `worker/src/index.ts` (reduced from 697 lines to ~80: imports + handleCors + export
  default { fetch } + narrow export line re-exporting from new modules)

**New:**
- `worker/src/schemas.ts` — TOOL_DEFINITIONS, ZOD_SCHEMAS, familyEnum, RESOURCE_URI,
  EXT_APPS_MIME, JsonRpcRequest interface, STATE_CACHE_STALE_MS
- `worker/src/hmac.ts` — SESSION_ID_RE, SESSION_MAX_AGE_S, bytesToHex, hexToBytes,
  importHmacKey, signSessionId, verifySessionId
- `worker/src/jsonrpc.ts` — mcpHeaders, jsonrpcResponse, jsonrpcError
- `worker/src/analytics.ts` — analyticsDayIndex, trackAnalytics, withHtmlNoCache
- `worker/src/handlers/mcp.ts` — handleMCP
- `worker/src/handlers/state.ts` — handleState
- `worker/src/handlers/witness.ts` — handleWitness
- `worker/src/handlers/admin.ts` — handleAdmin
- `docs/PHASE_9_2_CHECKPOINT_A.md`
- `docs/PHASE_9_2_HANDOFF.md`

**Anything NOT on this list is denied.** If you find you need to touch something else to
make the refactor work, STOP and write the blocker into the checkpoint instead of
silently expanding scope.

## Denylist (explicit, NOT exhaustive)

- `src/**` (except `docs/`) — all renderer code, including `src/main.ts`, is M2 territory
- `app/**` — all ext-app code is M2 territory
- `worker/src/cache.ts`, `worker/src/utils.ts`, `worker/src/types.ts`,
  `worker/src/sedimentation.ts`, `worker/src/language.ts`, `worker/src/html.d.ts`,
  `worker/src/tools/**` — already modular, don't touch
- `worker/tests/**` — tests must pass unchanged
- `worker/migrations/**` — no schema work
- `worker/wrangler.toml`, `worker/package.json`, `worker/tsconfig.json` — config untouched
- `package.json`, `tsconfig.json`, `app/package.json`, `app/tsconfig.json` — config untouched
- `CLAUDE.md` — updated AFTER 9.2 lands, not during execution
- Any `.gitignore` — untouched

## Context pointers (read these first)

- `worker/src/index.ts` — the full file you're splitting
- `worker/tests/mocks.ts` — understand what the test mocks provide (KV, D1, Env, ExecutionContext)
- `worker/tests/dedupe.test.ts`, `rebuild-lock.test.ts`, `witness-rebuild.test.ts`,
  `resources.test.ts` — all four tests import from `../src/index`. The narrow export
  line at the bottom of the new `worker/src/index.ts` MUST re-export:
  `export { ZOD_SCHEMAS, handleWitness, handleMCP }`
- `vellum/docs/PHASE_9_0_SPEC.md`, `vellum/docs/PHASE_9_1_SPEC.md` — spec template format
- `vellum/docs/PHASE_9_0_CHECKPOINT_A.md`, `vellum/docs/PHASE_9_1_CHECKPOINT_A.md` —
  checkpoint template format (baseline → scope → verification → judgment calls →
  surprises → deviations, per phase)

## Hard rules

1. **Narrow export line is LOAD-BEARING.** The file `worker/src/index.ts` MUST end
   with a line re-exporting `ZOD_SCHEMAS`, `handleWitness`, `handleMCP` so that
   `import { ... } from '../src/index'` in the test files keeps working unchanged.
   Example pattern: `export { ZOD_SCHEMAS } from './schemas'` and
   `export { handleWitness } from './handlers/witness'` and
   `export { handleMCP } from './handlers/mcp'`. Any shape that makes those three
   symbols importable from `../src/index` is acceptable.

2. **Function signatures are FROZEN for the four handlers.** Do not change the
   parameter list, return type, or thrown-error shape of `handleMCP`, `handleState`,
   `handleWitness`, or `handleAdmin`. The router in the reduced `index.ts` must call
   each with the exact same arguments as the original file.

3. **Router behavior is FROZEN.** The `export default { fetch }` in the reduced
   `index.ts` must produce byte-identical responses for every request the original
   router handled. Same path matches, same method filtering, same response bodies,
   same headers, same status codes. This is the load-bearing invariant for smoke-test
   parity with 9.1.

4. **Zero runtime behavior changes.** This is a mechanical refactor. Do not "improve"
   logic. Do not remove dead code that the split exposes. Do not combine similar
   error paths. Do not rename public functions. If you notice something that feels
   like a bug, record it in the checkpoint's "surprises" section and move on.

5. **Shared constants go where they're most used.** `STATE_CACHE_STALE_MS` is used
   by both `handleState` and `handleAdmin`. Put it in `schemas.ts` (or a new
   `constants.ts` if `schemas.ts` starts feeling overloaded, but prefer NOT to add
   a 9th file if you can avoid it). Import it into both handlers. Do NOT duplicate it.

6. **`pensieveHtml` import is a single-source.** The HTML text import via wrangler's
   `rules` config — `import pensieveHtml from '../../app/dist/mcp-app.html'` — must
   stay in exactly ONE file. Import it in `handlers/mcp.ts` (which needs it for
   `resources/read`), and import it separately in the reduced `index.ts` (which
   needs it for the `/ext-app` standalone fallback route). Two imports are fine;
   the bundler inlines the string once and the narrow-export pattern doesn't apply
   here (pensieveHtml isn't a function — it's a module-level string literal).

7. **JsonRpcRequest interface moves to `schemas.ts`.** It's conceptually part of
   the MCP wire protocol, which is what `schemas.ts` covers. Import it into
   `handlers/mcp.ts`.

8. **No test file edits.** The acceptance contract for this refactor is "existing
   tests pass unchanged." If a test fails, the refactor introduced a regression —
   fix the code, not the test.

9. **Checkpoint A discipline.** Write the checkpoint as you go, phase by phase.
   Each phase section must include: scope completed, verification commands + results,
   files touched, LOC delta, judgment calls, surprises, out-of-scope urges (and
   whether you acted on them — answer should always be "no"), deviations. See
   `PHASE_9_0_CHECKPOINT_A.md` for the template.

## Phase A — Extract `schemas.ts`

**Scope:** Move TOOL_DEFINITIONS, ZOD_SCHEMAS, familyEnum, RESOURCE_URI, EXT_APPS_MIME,
JsonRpcRequest, STATE_CACHE_STALE_MS from `worker/src/index.ts` into a new file
`worker/src/schemas.ts`. Update imports in `worker/src/index.ts` to consume from the
new file. The original index.ts still works as-is at this phase — you're just moving
declarations, not splitting handlers yet.

**Files touched:**
- NEW: `worker/src/schemas.ts` (~120 lines)
- MODIFIED: `worker/src/index.ts` (imports added, declarations removed)

**Verification for Phase A (run in order, all must be green):**

```bash
bun run verify
cd worker && bun test tests/ && cd ..
bunx tsc --noEmit
bunx tsc -p worker/tsconfig.json --noEmit
cd worker && bun run deploy --dry-run && cd ..
git diff --stat main
```

**Acceptance:** `bun run verify` green, all tests pass, `git diff --stat main` shows
exactly 2 files changed: `worker/src/index.ts` (shrinking) and `worker/src/schemas.ts`
(new). No other files touched.

**Checkpoint A section for Phase A:** record scope, verification output, exact LOC delta
on both files, the fact that `JsonRpcRequest` moved with the schemas (explain why:
MCP wire protocol cohesion), any surprises about which declarations had implicit
dependencies on other parts of the file.

## Phase B — Extract `hmac.ts`

**Scope:** Move SESSION_ID_RE, SESSION_MAX_AGE_S, bytesToHex, hexToBytes, importHmacKey,
signSessionId, verifySessionId from `worker/src/index.ts` into a new file
`worker/src/hmac.ts`. Update imports in `worker/src/index.ts` to consume signSessionId
and verifySessionId (the two functions the MCP handler actually calls).

**Files touched:**
- NEW: `worker/src/hmac.ts` (~50 lines)
- MODIFIED: `worker/src/index.ts` (imports added, declarations removed)

**Verification for Phase B:** same command sequence as Phase A. Acceptance: same shape
as Phase A.

**Judgment call allowed:** If `bytesToHex` / `hexToBytes` are used only by the HMAC
functions (which they are), do NOT export them from `hmac.ts` — keep them as file-local
helpers. Export only `signSessionId`, `verifySessionId`, and the two constants.

## Phase C — Extract `jsonrpc.ts` and `analytics.ts`

**Scope:** Move `mcpHeaders`, `jsonrpcResponse`, `jsonrpcError` into
`worker/src/jsonrpc.ts`. Move `analyticsDayIndex`, `trackAnalytics`, `withHtmlNoCache`
into `worker/src/analytics.ts`. Both are small unrelated groups so they land in one
phase together.

**Files touched:**
- NEW: `worker/src/jsonrpc.ts` (~35 lines)
- NEW: `worker/src/analytics.ts` (~30 lines)
- MODIFIED: `worker/src/index.ts` (imports added, declarations removed)

**Verification for Phase C:** same command sequence.

**Judgment call allowed:** `withHtmlNoCache` is technically a generic response helper
rather than an analytics function, but it lives near the analytics code in the original
file and has a 1-line implementation. If putting it in `analytics.ts` feels wrong,
create a `worker/src/http-helpers.ts` instead — but that would make the file count 10,
which we're trying to avoid. Prefer `analytics.ts` unless it materially hurts readability.
Record the decision in the checkpoint.

## Phase D — Extract the four handlers into `handlers/`

**Scope:** Move `handleMCP`, `handleState`, `handleWitness`, `handleAdmin` into separate
files under `worker/src/handlers/`. Each handler file imports what it needs from
`../schemas`, `../hmac`, `../jsonrpc`, `../analytics`, `../cache`, `../utils`, `../types`,
`../tools/*`, and in one case `../../app/dist/mcp-app.html`.

**Files touched:**
- NEW: `worker/src/handlers/mcp.ts` (~170 lines — the biggest of the four)
- NEW: `worker/src/handlers/state.ts` (~60 lines)
- NEW: `worker/src/handlers/witness.ts` (~65 lines)
- NEW: `worker/src/handlers/admin.ts` (~90 lines)
- MODIFIED: `worker/src/index.ts` (imports added, four large function definitions removed)

**Verification for Phase D:**

```bash
bun run verify
cd worker && bun test tests/ && cd ..
bunx tsc --noEmit
bunx tsc -p worker/tsconfig.json --noEmit
cd app && bunx tsc --noEmit && cd ..
cd worker && bun run deploy --dry-run && cd ..
git diff --stat main
# Narrow export surface check: handleMCP and handleWitness must STILL be importable
# from '../src/index' — this is tested implicitly by `cd worker && bun test tests/`
# but check by inspection of worker/src/index.ts as well
grep -n "export.*handleMCP\|export.*handleWitness\|export.*ZOD_SCHEMAS" worker/src/index.ts
```

**Acceptance:** all tests pass, narrow export line still exports the three symbols
(either as named re-exports from the new modules, or as a single re-export line),
router calls in `export default { fetch }` use the imported handler functions.

**Judgment call allowed:** The directory structure — `worker/src/handlers/mcp.ts` vs
`worker/src/mcp-handler.ts` (flat) — is a readability call. Prefer `handlers/`
subdirectory because four handler files deserve their own namespace and the rest of
`worker/src/` stays cleanly top-level (tools is already a subdirectory, so handlers
is consistent).

**Known tricky imports for handlers/mcp.ts:**

- `schemas.ts` → TOOL_DEFINITIONS, ZOD_SCHEMAS, RESOURCE_URI, EXT_APPS_MIME, JsonRpcRequest
- `hmac.ts` → signSessionId, verifySessionId
- `jsonrpc.ts` → jsonrpcResponse, jsonrpcError
- `analytics.ts` → trackAnalytics
- `cache.ts` → (nothing directly — tools call through cache)
- `utils.ts` → checkAndIncrementRateLimit, generateTraceId, parseModel
- `tools/sense-space.ts`, `tools/focus.ts`, `tools/leave-imprint.ts`, `tools/weave.ts` → handle* tool fns
- `../../app/dist/mcp-app.html` → pensieveHtml (for the resources/read branch)
- `types.ts` → Env (type only)

**Known tricky imports for handlers/state.ts:**

- `schemas.ts` → STATE_CACHE_STALE_MS
- `analytics.ts` → trackAnalytics
- `cache.ts` → rebuildStateProjection, rebuildStateProjectionIfNotLocked
- `types.ts` → Env, StateResponse

**Known tricky imports for handlers/witness.ts:**

- `analytics.ts` → trackAnalytics
- `cache.ts` → rebuildStateProjectionIfNotLocked
- `utils.ts` → checkAndIncrementRateLimit, updateWarmth
- `types.ts` → Env, FAMILIES

**Known tricky imports for handlers/admin.ts:**

- `schemas.ts` → STATE_CACHE_STALE_MS
- `cache.ts` → rebuildAll
- `utils.ts` → getWarmthMap
- `types.ts` → Env, StateResponse

If you hit a circular import, STOP and figure out the cycle before resolving it.
Don't just add barrel re-exports to paper over it.

## Phase E — Reduce `worker/src/index.ts`

**Scope:** The `worker/src/index.ts` file at this point should already be significantly
smaller after Phases A-D moved things out. Phase E is the cleanup pass: confirm the
file is reduced to imports + `handleCors()` + `export default { fetch }` + narrow
export line. Move `handleCors` to its own file only if doing so reduces `index.ts` by
a meaningful amount; otherwise keep it as a file-local helper.

**Files touched:**
- MODIFIED: `worker/src/index.ts` (final shape, ~80 lines)

**Verification for Phase E:**

```bash
bun run verify
cd worker && bun test tests/ && cd ..
bunx tsc --noEmit
bunx tsc -p worker/tsconfig.json --noEmit
cd app && bunx tsc --noEmit && cd ..
cd worker && bun run deploy --dry-run && cd ..
git diff --stat main
wc -l worker/src/index.ts
# Bundle should be identical — this is a worker refactor, renderer untouched
bun run build && wc -c dist/main.js
```

**Acceptance:** `wc -l worker/src/index.ts` reports ~80 lines (within ±15 is fine),
`wc -c dist/main.js` is EXACTLY equal to the baseline (worker split has zero renderer
impact), worker dry-run upload size is within ±2 KiB of baseline.

## Phase F — Checkpoint + Handoff

**Scope:** Finalize `docs/PHASE_9_2_CHECKPOINT_A.md` with all five phases recorded.
Write `docs/PHASE_9_2_HANDOFF.md` following the 9.0 / 9.1 format: "What changed",
"Verification table", "Suggested commit structure", "Flags for human review",
"Open items".

**Files touched:**
- NEW: `docs/PHASE_9_2_CHECKPOINT_A.md`
- NEW: `docs/PHASE_9_2_HANDOFF.md`

**Verification for Phase F:** full verification table same shape as 9.1 handoff.

**Suggested commit structure (Codex should put this in the handoff):**

1. Phase A: `worker/src/schemas.ts` + `worker/src/index.ts` shrink
2. Phase B: `worker/src/hmac.ts` + `worker/src/index.ts` shrink
3. Phase C: `worker/src/jsonrpc.ts` + `worker/src/analytics.ts` + `worker/src/index.ts` shrink
4. Phase D: `worker/src/handlers/*.ts` (all four at once) + `worker/src/index.ts` shrink
5. Phase E: `worker/src/index.ts` final shape (if any additional trim after Phase D)
6. Phase F docs: `docs/PHASE_9_2_CHECKPOINT_A.md` + `docs/PHASE_9_2_HANDOFF.md`

Phase E may be empty (no commit) if Phase D already produced the final shape.
That's fine — record in the checkpoint that Phase E was a no-op verification pass.

## Verification acceptance contract

The refactor is accepted iff ALL of these hold:

| Check | Expected |
|---|---|
| `bun test tests/loom/` | `87 pass, 0 fail` (unchanged from baseline) |
| `cd worker && bun test tests/` | `16 pass, 0 fail` (unchanged from baseline) |
| `bun run verify` | clean end-to-end |
| `bunx tsc --noEmit` | clean |
| `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| `cd app && bunx tsc --noEmit` | clean |
| `bun run build && wc -c dist/main.js` | EXACTLY equal to baseline (worker-only refactor) |
| `cd worker && bun run deploy --dry-run` | clean; upload within ±2 KiB of baseline |
| `grep "export.*ZOD_SCHEMAS\|export.*handleWitness\|export.*handleMCP" worker/src/index.ts` | exactly 3 symbols exported (may be 1 line or 3 lines) |
| `wc -l worker/src/index.ts` | ~80 lines (±15 acceptable) |
| `git diff --stat main` | exactly the allowlist files, no surprises |
| `ls worker/src/ worker/src/handlers/` | matches the allowlist (schemas.ts, hmac.ts, jsonrpc.ts, analytics.ts, handlers/{mcp,state,witness,admin}.ts, plus the untouched existing files) |

## Post-handoff (NOT part of 9.2 execution)

After Codex delivers the 9.2 handoff, I (Claude) will:

1. Review each phase commit for scope creep + hard rule compliance
2. Fast-forward merge to main, push
3. Deploy worker (`cd worker && bun run deploy`)
4. Smoke test against production: hit `/mcp` initialize, `/mcp` tools/call leave_imprint,
   `/api/state`, `/api/witness`, and `/mcp` resources/read on both origins. All should
   return byte-identical responses (modulo timestamps) compared to 9.1 production
   behavior.
5. Update `CLAUDE.md` to reflect the new file layout (Architecture section's worker
   bullet list needs to enumerate the new handlers/* paths). Drift-resistant pass.
6. Update `project_vellum-phase-arc.md` memory with 9.2 chronology.
7. Write Phase 9.3 spec for M2 renderer runtime extraction (the harder split).

## Phase 9.3 preview (NOT part of 9.2)

Phase 9.3 will tackle M2: extract shared runtime modules from `src/main.ts` and
`app/src/mcp-app.ts`. The two files have ~80% line-identical sections (input handlers,
canvas setup, witness reporting, timeout helpers, scheduleFrame, fetchStateWithTimeout)
and ~20% genuinely different sections (poll's force-voice-queue path in mcp-app.ts,
sound modulation in main.ts, boot-race buffering in mcp-app.ts, ext-apps SDK in
mcp-app.ts). The shared parts go into `src/runtime/{input,canvas,witness,poll-core}.ts`,
the unique parts stay in the caller files. 9.3 is a bigger design decision than 9.2
because the "shared" helpers need to be parameterized for the genuine differences
(e.g., `poll()` takes an optional `computeExtraVoiceIds` callback). Not in scope for 9.2.

## References

- `vellum/docs/PHASE_9_0_SPEC.md` — spec format (worker correctness hardening)
- `vellum/docs/PHASE_9_1_SPEC.md` — spec format (small-fixes sweep)
- `vellum/docs/PHASE_9_0_CHECKPOINT_A.md` — checkpoint template
- `vellum/docs/PHASE_9_1_CHECKPOINT_A.md` — checkpoint template with tighter phase discipline
- `vellum/docs/PHASE_9_1_HANDOFF.md` — handoff template
- `vellum/CLAUDE.md` — architecture pointers for the worker + ext-app layers
- `worker/tests/mocks.ts` — hand-rolled test mocks (MockKV, MockD1, MockExecutionContext,
  makeTestEnv). Tests import from `../src/index`, so the narrow export surface is
  THE acceptance contract for the refactor.
