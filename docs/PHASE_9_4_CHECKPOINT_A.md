# Phase 9.4 Checkpoint A

## Execution start snapshot

- Phase: `9.4` Phase A only
- Worktree: `/Users/xulelin/Documents/Apps/mcp/.claude/worktrees/vellum-phase-94/vellum/vellum`
- Branch: `feat/phase-9-4-post-audit-cleanup`
- Start commit: `4bc889a`
- Current date context: `2026-04-09` (`Europe/London`)
- Bun version observed locally: `1.2.12`

## Baseline from execution brief

- Baseline anchor / verified green commit: `4bc889a`
- Renderer tests: `87` loom tests passing
- Worker tests: `16` tests passing
- TypeScript: root + worker + app clean
- Renderer bundle baseline: `71.13 KB` (`~71130` bytes)
- Worker dry-run upload baseline: `384.53 KiB`
- Dependencies: already installed in root, `worker/`, and `app/`

## Scope guardrails for this execution

- Execute A1 through A9 in order
- Do not touch `src/loom/**`
- Do not touch `src/content.ts`
- Do not touch `worker/src/index.ts` beyond the `/ext-app` rewrite in A4
- Do not apply D1 migrations during execution
- Do not start any Phase B work

## Baseline intent carried into execution

- Phase A is surgical cleanup only
- Highest-priority functional fix is A1 (`focus.ts` primary-family ordinal rule)
- Cache contention semantics are documentation-only in A2
- `warmth.pending` removal includes writing, but not applying, migration `0005`
