# Phase 9.5 Checkpoint A

## Execution start snapshot

- Phase: `9.5` Phase B only
- Worktree: `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-95/vellum/vellum`
- Branch: `feat/phase-9-5-support-layer`
- Start commit: `6d6f7b4`
- Current date context: `2026-04-09` (`Europe/London`)
- Bun version observed locally: `1.2.12`

## Verified baselines on entry

- Loom tests: `87` passing
- Worker tests: `17` passing
- `bun run verify`: clean
- Root / worker / app typecheck: clean
- Renderer bundle: `dist/main.js = 71110` bytes
- Worker dry-run upload: `384.16 KiB / gzip 94.74 KiB`
- `worker/src/utils.ts`: `213` lines
- `worker/src/utils.ts` live importer count: `8`

## Phase B execution order

1. Re-read Phase B spec and guardrails
2. Re-verify the worktree baseline
3. Execute `B1` and run `bun run verify`
4. Execute `B2` and run `bun run verify`
5. Execute `B3` and run `bun run verify`
6. Execute `B4` and run `bun run verify`
7. Run the full Phase B verification contract
8. Write checkpoint + handoff docs
9. Stop without any git write operations

## In-scope items

### B1 — `utils.ts` split

- Create:
  - `worker/src/ids.ts`
  - `worker/src/warmth.ts`
  - `worker/src/rate-limits.ts`
  - `worker/src/prose.ts`
  - `worker/src/helpers.ts`
- Update all `utils.ts` importers
- Delete `worker/src/utils.ts`
- Acceptance:
  - zero orphan `utils` imports
  - all tests and typechecks still pass

### B2 — runtime validation layer

- Add new schemas in `worker/src/schemas.ts`
- Validate:
  - MCP JSON-RPC envelope
  - admin hide body
  - witness body
  - cached projection / atmosphere KV payloads in `worker/src/cache.ts`
- Add malformed-body worker tests
- Acceptance:
  - malformed bodies return `400` / JSON-RPC parse error as specified
  - valid-path behavior unchanged

### B3 — shared write-tool helper

- Extract the shared “fresh voice insert + rebuild” path into `worker/src/tools/_shared.ts`
- Use it from:
  - `worker/src/tools/leave-imprint.ts`
  - source-not-found path in `worker/src/tools/weave.ts`
- Acceptance:
  - no behavior drift
  - worker tests stay green

### B4 — `scheduleNextFrame` handle rewrite

- Change `src/runtime/frame.ts` so `scheduleNextFrame` mutates a caller-owned handle
- Update only:
  - `src/main.ts`
  - `app/src/mcp-app.ts`
- Acceptance:
  - loom tests stay green
  - no other renderer/runtime files change

## Scope guardrails / do not list

- Do not edit `src/loom/**`
- Do not edit `src/content.ts`
- Do not touch `worker/src/index.ts` router order or bottom export line
- Do not add dependencies
- Do not perform git write operations
- Do not do speculative cleanup outside `B1`–`B4`
- Do not edit runtime files other than `src/runtime/frame.ts`
