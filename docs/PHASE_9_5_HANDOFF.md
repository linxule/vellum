# Phase 9.5 Handoff

## Overall status

Phase B (`B1` through `B4`) is complete and verification is green.

## B1 — `utils.ts` split into focused modules

### Created

- `worker/src/ids.ts`
- `worker/src/warmth.ts`
- `worker/src/rate-limits.ts`
- `worker/src/prose.ts`
- `worker/src/helpers.ts`

### Modified

- `worker/src/cache.ts`
- `worker/src/handlers/admin.ts`
- `worker/src/handlers/mcp.ts`
- `worker/src/handlers/witness.ts`
- `worker/src/tools/focus.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/sense-space.ts`
- `worker/src/tools/weave.ts`

### Deleted

- `worker/src/utils.ts`

### Function re-homing

- `ids.ts`:
  - `randomString`
  - `voiceId`
  - `generateTraceId`
  - `parseModel`
- `warmth.ts`:
  - `computeWarmthValue`
  - `getWarmth`
  - `getWarmthMap`
  - `updateWarmth`
- `rate-limits.ts`:
  - `checkAndIncrementRateLimit`
  - `checkAndIncrementSession`
- `prose.ts`:
  - `computeMood`
  - `warmthDesc`
- `helpers.ts`:
  - `withRetry`
  - `yamlEscape`

### Notes

- Zero behavior changes intended; signatures stayed the same.
- No worker tests needed import rewrites.

## B2 — runtime validation layer

### Created

- `worker/tests/validation.test.ts`

### Modified

- `worker/src/schemas.ts`
- `worker/src/cache.ts`
- `worker/src/handlers/admin.ts`
- `worker/src/handlers/mcp.ts`
- `worker/src/handlers/witness.ts`

### New schemas

- `STATE_RESPONSE_SCHEMA`
- `ATMOSPHERE_DATA_SCHEMA`
- `JSON_RPC_ENVELOPE_SCHEMA`
- `ADMIN_HIDE_BODY_SCHEMA`
- `WITNESS_BODY_SCHEMA`

### Boundary changes

- `handleMCP` now parses the incoming JSON body through `JSON_RPC_ENVELOPE_SCHEMA` and returns JSON-RPC parse error `-32700` on malformed envelopes.
- `handleAdmin` now parses the hide body through `ADMIN_HIDE_BODY_SCHEMA` and returns `400` on malformed body / invalid JSON.
- `handleWitness` now parses the body through `WITNESS_BODY_SCHEMA`, preserving the existing post-parse dedupe behavior.
- `worker/src/cache.ts` now safe-parses cached projection / atmosphere payloads. Invalid cached JSON is logged and treated as `null`, which falls back to rebuild behavior.

### Tests added

- malformed `/mcp` envelope → parse error
- malformed admin hide body → `400`
- malformed witness body → `400`

## B3 — write tools shared helper

### Created

- `worker/src/tools/_shared.ts`

### Modified

- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/weave.ts`

### Helper signature

```ts
export async function insertVoiceAndRebuild(
  env: Env,
  ctx: ExecutionContext,
  input: {
    text: string
    families: string[]
    traceId: string | null
    observedClientFamily: string
    declaredModel: string | null
  },
): Promise<{ id: string; primaryFamily: string }>
```

### Notes

- Only the duplicated “fresh voice insert + rebuild” path moved.
- The source-found weave branch stayed separate.
- The duplication was a bit larger than the spec’s “~30 lines” estimate. Caller diffstat removed `49` lines across `leave-imprint.ts` and `weave.ts` before accounting for the new helper file, because the shared extraction also absorbed the repeated `id`/`language`/`now`/`declaredModel` setup.

## B4 — `scheduleNextFrame` handle pattern rewrite

### Modified

- `src/runtime/frame.ts`
- `src/main.ts`
- `app/src/mcp-app.ts`

### Signature change

From:

```ts
scheduleNextFrame(renderFn) => { frameId, frameTimeout }
```

To:

```ts
scheduleNextFrame(handle, renderFn): void
```

### Notes

- `clearScheduledFrame` was left unchanged.
- No other runtime modules changed.

## Deviations from spec

- None on scope.
- The B2 malformed `/mcp` boundary test uses a schema-invalid JSON-RPC envelope (`{"method":42}`) rather than syntactically invalid JSON. This still exercises the new runtime envelope validation and the required JSON-RPC parse-error path.

## Final verification matrix

| Check | Command | Result |
|---|---|---|
| Loom tests | `bun test tests/loom/` | `87` pass |
| Worker tests | `cd worker && bun test tests/` | `20` pass |
| Verify script | `bun run verify` | clean |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Worker typecheck | `cd worker && bunx tsc --noEmit` | clean |
| App typecheck | `cd app && bunx tsc --noEmit` | clean |
| Renderer bundle | `wc -c dist/main.js` | `71048` bytes |
| Worker dry-run | `cd worker && bun run deploy --dry-run` | `387.74 KiB / gzip 95.14 KiB` |
| `utils.ts` deleted | `ls worker/src/utils.ts 2>&1` | `No such file or directory` |
| New modules exist | `ls worker/src/{ids,warmth,rate-limits,prose,helpers}.ts` | all present |
| No orphan utils imports | `grep -rn "from ['\"].*utils['\"]" worker/src/` | zero matches |
| Shared tool helper exists | `ls worker/src/tools/_shared.ts` | present |
| No loom edits | `git diff --stat main -- src/loom/` | empty |
| Only frame.ts in runtime | `git diff --stat main -- src/runtime/` | only `src/runtime/frame.ts` |
| No content.ts edits | `git diff --stat main -- src/content.ts` | empty |
| Narrow export intact | `tail -3 worker/src/index.ts` | `export { ZOD_SCHEMAS, handleWitness, handleMCP }` |

## Worktree-local file list

### Modified

- `app/src/mcp-app.ts`
- `src/main.ts`
- `src/runtime/frame.ts`
- `worker/src/cache.ts`
- `worker/src/handlers/admin.ts`
- `worker/src/handlers/mcp.ts`
- `worker/src/handlers/witness.ts`
- `worker/src/schemas.ts`
- `worker/src/tools/focus.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/sense-space.ts`
- `worker/src/tools/weave.ts`

### Created

- `worker/src/helpers.ts`
- `worker/src/ids.ts`
- `worker/src/prose.ts`
- `worker/src/rate-limits.ts`
- `worker/src/tools/_shared.ts`
- `worker/src/warmth.ts`
- `worker/tests/validation.test.ts`

### Deleted

- `worker/src/utils.ts`

## Flags for human review

- `worker/src/cache.ts` now logs schema parse failures for corrupted KV payloads. Behavior is intentionally graceful (`null` → rebuild), but the exact log wording is worth a quick sanity pass before commit.
- `worker/tests/validation.test.ts` emits the expected `[mcp] parse error` warning while asserting the malformed-envelope path. That is intentional and not a test failure.
- Existing worker tests still emit the expected `Warmth update failed` console error from the negative test path in `witness-rebuild.test.ts`.

## Suggested commit grouping

1. `B1` — worker utility split
2. `B2` — runtime validation layer + new validation test
3. `B3` — shared write helper
4. `B4` — frame handle rewrite
5. docs
