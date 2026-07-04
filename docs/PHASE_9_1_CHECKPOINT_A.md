# Phase 9.1 Checkpoint A

## Baseline

- Worktree repo root: `/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-91/vellum/vellum`
- `main` / `HEAD`: `7f380ce`
- Semantic 9.0 anchor confirmed in history: `63ff6e8`
- Baseline after dependency install and one ext-app build artifact bootstrap:
  - `bun test tests/loom/` → `82 pass, 0 fail`
  - `cd worker && bun test tests/` → `13 pass, 0 fail`
  - `bunx tsc --noEmit` → clean
  - `bunx tsc -p worker/tsconfig.json --noEmit` → clean
  - `cd app && bunx tsc --noEmit` → clean
  - `bun run build` → `69884 dist/main.js`
  - `cd worker && bun run deploy --dry-run` → clean

## Phase A

### Scope completed

- Fixed `isLineRTL` to include the effective end segment
- Fixed same-segment wrapped RTL lines so they no longer default to LTR
- Added T4 coverage to `tests/loom/text.test.ts` for:
  - wrapped single-segment RTL lines
  - mid-segment line endings
  - null-level short-circuit behavior

### Verification

#### `bun test tests/loom/text.test.ts`

Status: clean

```text
10 pass
0 fail
Ran 10 tests across 1 files.
```

#### `bun test tests/loom/`

Status: clean

```text
85 pass
0 fail
Ran 85 tests across 19 files.
```

#### `cd worker && bun test tests/`

Status: clean

```text
13 pass
0 fail
Ran 13 tests across 3 files.
```

#### `bunx tsc --noEmit`

Status: clean

#### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

#### `cd app && bunx tsc --noEmit && cd ..`

Status: clean

#### `bun run build && wc -c dist/main.js`

Status: clean

```text
69915 dist/main.js
```

Bundle delta vs. baseline: `+31 bytes`

#### `cd worker && bun run deploy --dry-run`

Status: clean

Key output:

```text
Total Upload: 382.94 KiB / gzip: 93.66 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

#### `git diff --stat main`

Status: expected scope

```text
 vellum/src/loom/text.ts        |  3 ++-
 vellum/tests/loom/text.test.ts | 26 +++++++++++++++++++++++++-
 2 files changed, 27 insertions(+), 2 deletions(-)
```

### Files touched

- `src/loom/text.ts`
- `tests/loom/text.test.ts`

### LOC delta

- `src/loom/text.ts`: `+2 / -1`
- `tests/loom/text.test.ts`: `+25 / -1`

### Judgment calls

- Kept the fix minimal and local: `lastSeg` is derived inline inside `isLineRTL` rather than introducing shared helpers or extra clamping logic that the spec did not ask for.

### Surprises

- None in the code path. The bundle moved by only `31` bytes, which is comfortably inside the spec’s tolerance.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase B

### Scope completed

- Moved the resonance expiry check ahead of the family-match gate in `src/loom/resonance.ts`
- Added T5 coverage to `tests/loom/resonance.test.ts` for:
  - pruning expired non-matching resonances
  - preserving fresh non-matching resonances without applying them

### Verification

#### `bun test tests/loom/resonance.test.ts`

Status: clean

```text
4 pass
0 fail
Ran 4 tests across 1 files.
```

#### `bun test tests/loom/`

Status: clean

```text
87 pass
0 fail
Ran 87 tests across 19 files.
```

#### `cd worker && bun test tests/`

Status: clean

```text
13 pass
0 fail
Ran 13 tests across 3 files.
```

#### `bunx tsc --noEmit`

Status: clean

#### `bunx tsc -p worker/tsconfig.json --noEmit`

Status: clean

#### `cd app && bunx tsc --noEmit && cd ..`

Status: clean

#### `bun run build && wc -c dist/main.js`

Status: clean

```text
69911 dist/main.js
```

Bundle delta vs. baseline: `+27 bytes`

#### `cd worker && bun run deploy --dry-run`

Status: clean

Key output:

```text
Total Upload: 382.93 KiB / gzip: 93.67 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

#### `git diff --stat main`

Status: expected cumulative scope

```text
 vellum/src/loom/resonance.ts        |  2 +-
 vellum/src/loom/text.ts             |  3 ++-
 vellum/tests/loom/resonance.test.ts | 33 ++++++++++++++++++++++++++++++++-
 vellum/tests/loom/text.test.ts      | 26 +++++++++++++++++++++++++-
 4 files changed, 60 insertions(+), 4 deletions(-)
```

### Files touched

- `src/loom/resonance.ts`
- `tests/loom/resonance.test.ts`

### LOC delta

- `src/loom/resonance.ts`: `+1 / -1`
- `tests/loom/resonance.test.ts`: `+32 / -1`

### Judgment calls

- Used a minimal `Thread` stub cast in the new tests rather than reusing a larger fixture, because `updateResonances` only reads `familyNames`, `warmth`, and `arrivalGlow`.

### Surprises

- None. The bundle delta stayed small, and the worker baseline remained unaffected by the renderer-side fix.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase C

### Scope completed

- Replaced the root `deploy` script with worker delegation: `cd worker && bun run deploy`
- Added the root `verify` script covering loom tests, root typecheck, worker tests, worker typecheck, app typecheck, and renderer build

### Verification

#### `bun run verify`

Status: clean

Key output:

```text
87 pass
0 fail
Ran 87 tests across 19 files.
13 pass
0 fail
Ran 13 tests across 3 files.
```

#### `cd worker && bun run deploy --dry-run`

Status: clean

Key output:

```text
Total Upload: 382.93 KiB / gzip: 93.67 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

#### `git diff --stat main`

Status: expected cumulative scope

```text
 vellum/package.json                 |  3 ++-
 vellum/src/loom/resonance.ts        |  2 +-
 vellum/src/loom/text.ts             |  3 ++-
 vellum/tests/loom/resonance.test.ts | 33 ++++++++++++++++++++++++++++++++-
 vellum/tests/loom/text.test.ts      | 26 +++++++++++++++++++++++++-
 5 files changed, 62 insertions(+), 5 deletions(-)
```

### Files touched

- `package.json`

### LOC delta

- `package.json`: `+2 / -1`

### Judgment calls

- Kept `verify` exactly as a gate, not a diagnostic script. It intentionally stops on first failure and does not include `wrangler deploy --dry-run`, matching the spec’s separation between verification and deploy-adjacent checks.

### Surprises

- None. The delegated root deploy path still leaves `cd worker && bun run deploy --dry-run` as the correct human dry-run flow, exactly as the spec anticipated.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase D

### Scope completed

- Replaced the ext-app hardcoded base URL literal in `app/src/mcp-app.ts` with the sentinel string `__VELLUM_BASE_URL__`
- Rewrote the worker `resources/read` branch to derive `origin` from `request.url`, replace the sentinel in the bundled HTML, and emit `connectDomains: [origin]`
- Extended the 9.0 worker export line to `export { ZOD_SCHEMAS, handleWitness, handleMCP }`
- Added `worker/tests/resources.test.ts` for:
  - prod-origin sentinel rewrite
  - localhost-origin sentinel rewrite
  - unknown-resource error behavior

### Verification

#### `cd app && bunx vite build`

Status: clean

Key output:

```text
dist/mcp-app.html  190.20 kB │ gzip: 57.47 kB
✓ built in 46ms
```

#### `bun test tests/loom/`

Status: clean

```text
87 pass
0 fail
Ran 87 tests across 19 files.
```

#### `cd worker && bun test tests/ && cd ..`

Status: clean

```text
16 pass
0 fail
Ran 16 tests across 4 files.
```

#### `bun run verify`

Status: clean

Key output:

```text
87 pass
0 fail
Ran 87 tests across 19 files.
16 pass
0 fail
Ran 16 tests across 4 files.
main.js  69.91 KB  (entry point)
```

#### `bun run build && wc -c dist/main.js`

Status: clean

```text
69911 dist/main.js
```

Bundle delta vs. baseline: `+27 bytes`

#### `cd worker && bun run deploy --dry-run && cd ..`

Status: clean

Key output:

```text
Total Upload: 383.03 KiB / gzip: 93.71 KiB
Bindings: KV, DB, ANALYTICS, ASSETS, ENVIRONMENT
--dry-run: exiting now.
```

#### `git diff --stat main`

Status: expected tracked scope

```text
 vellum/app/src/mcp-app.ts           |  2 +-
 vellum/package.json                 |  3 ++-
 vellum/src/loom/resonance.ts        |  2 +-
 vellum/src/loom/text.ts             |  3 ++-
 vellum/tests/loom/resonance.test.ts | 33 ++++++++++++++++++++++++++++++++-
 vellum/tests/loom/text.test.ts      | 26 +++++++++++++++++++++++++-
 vellum/worker/src/index.ts          |  8 +++++---
 7 files changed, 68 insertions(+), 9 deletions(-)
```

Untracked files visible separately via `git status --short`:

```text
?? docs/PHASE_9_1_CHECKPOINT_A.md
?? worker/tests/resources.test.ts
```

#### Sentinel and hardcoded URL checks

Status: clean

```text
renderer_sentinel=0
extapp_sentinel=1
prod_url_hits=
```

### Files touched

- `app/src/mcp-app.ts`
- `worker/src/index.ts`
- `worker/tests/resources.test.ts`

### LOC delta

- `app/src/mcp-app.ts`: `+1 / -1`
- `worker/src/index.ts`: `+5 / -3`
- `worker/tests/resources.test.ts`: `+84 / -0`

### Judgment calls

- Kept the production diff inside the exact Phase D allowlist and solved the Bun test wiring issue in `worker/tests/resources.test.ts` with `mock.module(...)`, so the worker runtime did not pick up any Bun-specific compatibility branch.

### Surprises

- Under `bun test`, importing `../../app/dist/mcp-app.html` yields an `HTMLBundle` object rather than the raw string that Wrangler injects in the worker build. The test handles this by reading the built HTML file and mocking that module before importing `handleMCP`.

### Out-of-scope urges

- None acted on.

### Deviations

- None. The spec explicitly allowed judgment on T6 test wiring, and the chosen `mock.module(...)` path kept the diff smaller than a production-side compatibility shim.

## Phase E

### Scope completed

- Updated `docs/PHASE_9_1_CHECKPOINT_A.md` with the Phase D record and final verification state
- Added `docs/PHASE_9_1_HANDOFF.md`

### Verification

#### Full verification table

| Check | Command | Actual |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87 pass, 0 fail` |
| Worker tests | `cd worker && bun test tests/ && cd ..` | `16 pass, 0 fail` |
| Verify script | `bun run verify` | clean end-to-end |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `bunx tsc -p worker/tsconfig.json --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit && cd ..` | clean |
| Renderer bundle | `bun run build` | `dist/main.js = 69911 bytes` |
| Worker dry-run | `cd worker && bun run deploy --dry-run && cd ..` | clean; `Total Upload: 383.03 KiB / gzip: 93.71 KiB` |
| Diff scope | `git diff --stat main` | `7 tracked files changed`; new files are visible separately via `git status --short` as `docs/PHASE_9_1_CHECKPOINT_A.md`, `docs/PHASE_9_1_HANDOFF.md`, and `worker/tests/resources.test.ts` |
| Sentinel removed from bundle | `grep -c VELLUM_BASE_URL dist/main.js` | `0` |
| Sentinel IS in ext-app bundle | `grep -c __VELLUM_BASE_URL__ app/dist/mcp-app.html` | `1` |
| Old hardcoded URL gone from worker | `git grep "'https://vellum.linxule.com'" worker/src/` | `0 hits` |
| Old hardcoded URL gone from ext-app | `git grep "'https://vellum.linxule.com'" app/src/` | `0 hits` |

### Files touched

- `docs/PHASE_9_1_CHECKPOINT_A.md`
- `docs/PHASE_9_1_HANDOFF.md`

### LOC delta

- `docs/PHASE_9_1_CHECKPOINT_A.md`: rewritten into final A/B/C/D/E order with the Phase D and Phase E record
- `docs/PHASE_9_1_HANDOFF.md`: new file

### Judgment calls

- Recorded the diff-scope row exactly as observed rather than forcing the untracked docs/test files into `git diff --stat main`. The command only reports tracked edits, so the untracked file list is called out separately.

### Surprises

- None beyond the already-documented Bun HTML import behavior from Phase D.

### Out-of-scope urges

- None acted on.

### Deviations

- The spec’s diff-scope expectation mentions untracked files in the same row as `git diff --stat main`. In practice that command cannot show them, so the checkpoint records `git diff --stat main` and `git status --short` together for a truthful end-state.
