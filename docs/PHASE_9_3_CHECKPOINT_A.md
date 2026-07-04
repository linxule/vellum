# Phase 9.3 Checkpoint A

Baseline captured at Phase A start from the already-green starting state provided for this worktree.

## Baseline snapshot

- `bun run verify` -> clean: 87 loom pass, 16 worker pass, tsc clean root/worker/app, bundle 69911
- `wc -c dist/main.js` -> `69911`
- `wc -l src/main.ts app/src/mcp-app.ts src/content.ts` -> `449 672 184`
- `git rev-parse HEAD` -> `6e5508c` (spec commit, anchored at main)

## Local anchor

- Full HEAD observed in this worktree before edits: `6e5508cdcda34ca44ae035740136b35c8ce42668`
- Branch: `feat/phase-9-3-runtime-extraction`
