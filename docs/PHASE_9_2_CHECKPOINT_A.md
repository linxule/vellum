# Phase 9.2 Checkpoint A

## Baseline

- Worktree repo root: `/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-92/vellum/vellum`
- Git toplevel: `/Users/xulelin/Documents/Apps/.claude/worktrees/vellum-phase-92/vellum`
- `main` / `HEAD`: `cd664b9`
- Semantic 9.1 anchor from spec: `5a78808`
- Pre-edit baseline was green:
  - `bun run verify` → clean end-to-end
  - `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
  - `bunx tsc --noEmit` → clean
  - `bunx tsc -p worker/tsconfig.json --noEmit` → clean
  - `cd app && bunx tsc --noEmit && cd ..` → clean
  - `cd worker && bun run deploy --dry-run && cd ..` → `Total Upload: 383.03 KiB / gzip: 93.71 KiB`
  - `bun run build && wc -c dist/main.js` → `69911 dist/main.js`
  - `bun run build && wc -c dist/main.js` → `69911 dist/main.js`

## Phase A

### Scope completed

- Extracted `TOOL_DEFINITIONS`, `ZOD_SCHEMAS`, `familyEnum`, `RESOURCE_URI`, `EXT_APPS_MIME`, `JsonRpcRequest`, and `STATE_CACHE_STALE_MS` into `worker/src/schemas.ts`.
- Rewired `worker/src/index.ts` to import the moved schema/protocol declarations without changing handler logic.

### Verification

- `bun run verify` → clean end-to-end
- `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
- `bunx tsc --noEmit` → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd worker && bun run deploy --dry-run && cd ..` → `Total Upload: 383.05 KiB / gzip: 94.21 KiB`
- `git diff --stat main` → tracked diff only:

```text
 vellum/worker/src/index.ts | 122 +--------------------------------------------
 1 file changed, 1 insertion(+), 121 deletions(-)
```

- `git status --short` also showed the new allowlist file:

```text
 M worker/src/index.ts
?? worker/src/schemas.ts
```

### Files touched

- `worker/src/index.ts`
- `worker/src/schemas.ts`

### LOC delta

- `worker/src/index.ts`: `+1 / -121`
- `worker/src/schemas.ts`: `+117 / -0`

### Judgment calls

- Moved `JsonRpcRequest` with the schemas rather than leaving it near the handler, because it is part of the MCP wire-protocol surface and the spec explicitly called that out as the cohesive home.

### Surprises

- `git diff --stat main` does not report new untracked allowlist files, so `git status --short` was needed to confirm the phase stayed within the two intended paths.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase B

### Scope completed

- Extracted the HMAC/session helpers into `worker/src/hmac.ts`.
- Rewired `worker/src/index.ts` to import `signSessionId` and `verifySessionId`.

### Verification

- `bun run verify` → clean end-to-end
- `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
- `bunx tsc --noEmit` → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd worker && bun run deploy --dry-run && cd ..` → `Total Upload: 383.07 KiB / gzip: 94.17 KiB`
- `git diff --stat main` + `git status --short`:

```text
 vellum/worker/src/index.ts | 170 +--------------------------------------------
 1 file changed, 2 insertions(+), 168 deletions(-)
 M worker/src/index.ts
?? worker/src/hmac.ts
?? worker/src/schemas.ts
```

### Files touched

- `worker/src/index.ts`
- `worker/src/hmac.ts`

### LOC delta

- `worker/src/index.ts`: `+1 / -47`
- `worker/src/hmac.ts`: `+46 / -0`

### Judgment calls

- Kept `bytesToHex`, `hexToBytes`, and `importHmacKey` file-local inside `worker/src/hmac.ts`; exported only the session helpers and constants, per spec.

### Surprises

- None in code shape or behavior. Worker tests and dry-run stayed green after the session helper move.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase C

### Scope completed

- Extracted JSON-RPC response helpers into `worker/src/jsonrpc.ts`.
- Extracted analytics/no-cache helpers into `worker/src/analytics.ts`.
- Rewired `worker/src/index.ts` to import both helper groups.

### Verification

- `bun run verify` → clean end-to-end
- `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
- `bunx tsc --noEmit` → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd worker && bun run deploy --dry-run && cd ..` → `Total Upload: 383.11 KiB / gzip: 94.23 KiB`
- `git diff --stat main` + `git status --short`:

```text
 vellum/worker/src/index.ts | 237 +--------------------------------------------
 1 file changed, 4 insertions(+), 233 deletions(-)
 M worker/src/index.ts
?? worker/src/analytics.ts
?? worker/src/hmac.ts
?? worker/src/jsonrpc.ts
?? worker/src/schemas.ts
```

### Files touched

- `worker/src/index.ts`
- `worker/src/jsonrpc.ts`
- `worker/src/analytics.ts`

### LOC delta

- `worker/src/index.ts`: `+2 / -65`
- `worker/src/jsonrpc.ts`: `+33 / -0`
- `worker/src/analytics.ts`: `+32 / -0`

### Judgment calls

- Kept `withHtmlNoCache` in `worker/src/analytics.ts` instead of creating a tenth helper file. That matches the spec’s preference to stay at nine focused files total.

### Surprises

- None. The helper extraction stayed mechanically isolated and did not perturb the renderer bundle size.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase D

### Scope completed

- Extracted the four handlers into `worker/src/handlers/mcp.ts`, `state.ts`, `witness.ts`, and `admin.ts`.
- Preserved handler signatures exactly:
  - `handleMCP(request, env, ctx)`
  - `handleState(request, env, ctx)`
  - `handleWitness(request, env, ctx)`
  - `handleAdmin(request, env, url)`
- Kept `pensieveHtml` imported in exactly two places:
  - `worker/src/handlers/mcp.ts` for `resources/read`
  - `worker/src/index.ts` for `/ext-app`
- Preserved the load-bearing export surface from `worker/src/index.ts`:
  - `export { ZOD_SCHEMAS, handleWitness, handleMCP }`

### Verification

- `bun run verify` → clean end-to-end
- `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
- `bunx tsc --noEmit` → clean
- `bunx tsc -p worker/tsconfig.json --noEmit` → clean
- `cd app && bunx tsc --noEmit && cd ..` → clean
- `cd worker && bun run deploy --dry-run && cd ..` → `Total Upload: 383.31 KiB / gzip: 94.42 KiB`
- `grep -n "export.*handleMCP\\|export.*handleWitness\\|export.*ZOD_SCHEMAS" worker/src/index.ts`:

```text
86:export { ZOD_SCHEMAS, handleWitness, handleMCP }
```

- `wc -l worker/src/index.ts`:

```text
86 worker/src/index.ts
```

- `bun run build && wc -c dist/main.js`:

```text
69911 dist/main.js
```

- `git diff --stat main` + `git status --short`:

```text
 vellum/worker/src/index.ts | 625 +--------------------------------------------
 1 file changed, 7 insertions(+), 618 deletions(-)
 M worker/src/index.ts
?? worker/src/analytics.ts
?? worker/src/handlers/
?? worker/src/hmac.ts
?? worker/src/jsonrpc.ts
?? worker/src/schemas.ts
```

### Files touched

- `worker/src/index.ts`
- `worker/src/handlers/mcp.ts`
- `worker/src/handlers/state.ts`
- `worker/src/handlers/witness.ts`
- `worker/src/handlers/admin.ts`

### LOC delta

- `worker/src/index.ts`: `+3 / -385`
- `worker/src/handlers/mcp.ts`: `+179 / -0`
- `worker/src/handlers/state.ts`: `+59 / -0`
- `worker/src/handlers/witness.ts`: `+69 / -0`
- `worker/src/handlers/admin.ts`: `+92 / -0`

### Judgment calls

- Used the `worker/src/handlers/` namespace rather than flat `*-handler.ts` files, matching the spec preference and keeping top-level `worker/src/` clean.

### Surprises

- `git diff --stat main` still only reports the tracked `index.ts` shrink; confirming the full allowlist-required file set still requires reading `git status --short`.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase E

### Scope completed

- No additional code move was needed after Phase D.
- Confirmed `worker/src/index.ts` was already in final shape: imports, `handleCors`, router, and narrow export line only.

### Verification

- Reused the Phase D final verification pass:
  - `bun run verify` → clean
  - `cd worker && bun test tests/ && cd ..` → `16 pass, 0 fail`
  - `bunx tsc --noEmit` → clean
  - `bunx tsc -p worker/tsconfig.json --noEmit` → clean
  - `cd app && bunx tsc --noEmit && cd ..` → clean
  - `cd worker && bun run deploy --dry-run && cd ..` → `383.31 KiB / gzip: 94.42 KiB`
  - `wc -l worker/src/index.ts` → `86`
  - `bun run build && wc -c dist/main.js` → `69911`

### Files touched

- None. Phase E was a no-op cleanup/verification pass.

### LOC delta

- None.

### Judgment calls

- Left `handleCors` file-local because `index.ts` was already within the spec target range at `86` lines.

### Surprises

- None.

### Out-of-scope urges

- None acted on.

### Deviations

- None.

## Phase F

### Scope completed

- Wrote `docs/PHASE_9_2_CHECKPOINT_A.md`.
- Wrote `docs/PHASE_9_2_HANDOFF.md`.

### Verification

- Documentation only. Final code verification remains the Phase D/E pass above.

### Files touched

- `docs/PHASE_9_2_CHECKPOINT_A.md`
- `docs/PHASE_9_2_HANDOFF.md`

### LOC delta

- `docs/PHASE_9_2_CHECKPOINT_A.md`: `+343 / -0`
- `docs/PHASE_9_2_HANDOFF.md`: `+46 / -0`

### Judgment calls

- Kept the handoff aligned to the 9.1 structure: change summary, verification table, suggested commit structure, review flags, open items.

### Surprises

- None.

### Out-of-scope urges

- None acted on.

### Deviations

- None.
