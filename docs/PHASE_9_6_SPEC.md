# Phase 9.6 — Post-deploy observability foundation

## Why this phase exists

The hardening arc P1..9.5 closed cleanly, but every post-deploy sanity check was ad-hoc: manual curl sweeps by a human, different commands each time, no persistent record of what "healthy" looked like. The post-9.3 audit flagged this explicitly — we were flying blind on production observability. Before starting feature work (F1 Strudel, F2 lineage), we want the minimum viable observability floor: a repeatable script that answers "did the deploy work?" and a reference doc that enumerates the observability surfaces.

**Scope guardrail**: this is a pure ops/scripts/docs phase. Zero changes to `worker/src/**` or `src/**`. No new runtime code paths. No new dependencies. The worker bundle must stay flat.

## Baselines

- Branch base: `48d18ca` (main, post-9.5 + doc sweep)
- Live version: `a6727c65-8150-4255-b7ea-7db47f996a42`
- Loom tests: 87 pass
- Worker tests: 20 pass
- Renderer bundle: `dist/main.js` = 71048 bytes
- Worker upload: 387.75 KiB / gzip 95.15 KiB
- Current voice count: ~283 steady (natural growth)
- `bun run verify`: clean

## Scope — 3 items

### 9.6-1 — Post-deploy smoke script

Create `scripts/smoke.ts` (at repo-root `vellum/scripts/`, create the directory if it does not exist). The script is a standalone bun-runnable TypeScript file that takes one optional positional argument: the base URL to smoke-test (default `https://vellum.linxule.com`).

The script runs this checklist and prints one line per check with a `[PASS]` or `[FAIL]` prefix, then a final summary line. Exit code is 0 if all checks pass, 1 otherwise.

Checks in order:

1. **`/api/state` returns 200 + parses as JSON + has `threads` array with 6 entries + `total_voices` > 0** (sum across threads)
2. **`/ext-app` returns 200** and the body contains zero `__VELLUM_BASE_URL__` sentinel occurrences and at least one reference to the target origin's hostname (confirming A4 sentinel rewrite)
3. **`/mcp` `ping` request returns 200** with a valid JSON-RPC response (`result` field present, no `error`). Use a proper JSON-RPC envelope: `{jsonrpc: '2.0', id: 1, method: 'ping'}`. Set `content-type: application/json` + `accept: application/json`.
4. **`/mcp` malformed body returns 400** with `error.code === -32700` (confirms Phase 9.5 B2 validation is live)
5. **`/api/witness` malformed body returns 400** with `error === 'Invalid witness event'` (confirms Phase 9.5 B2 validation is live)
6. **`dist/main.js` bundle size is within bounds** (≤ 72000 bytes; current baseline is 71048). Read the file locally from `dist/main.js` — this check runs against the repo, not the network. Skip gracefully (log a warning, don't fail) if the file doesn't exist.

Each check:
- Times out independently at 10 seconds
- Catches network errors and marks the check as FAIL with a one-line reason
- Never throws — always reports and continues to the next check

Output format example:
```
Vellum smoke — https://vellum.linxule.com
[PASS] /api/state returns 200 with 6 threads, 283 voices
[PASS] /ext-app sentinel rewritten (0 sentinels, 1 origin ref)
[PASS] /mcp ping returns 200 with valid JSON-RPC result
[PASS] /mcp malformed body returns 400 + -32700
[PASS] /api/witness malformed body returns 400
[PASS] dist/main.js bundle size 71048 bytes ≤ 72000
Result: 6/6 passed — HEALTHY
```

On any FAIL, the final line reads `Result: N/6 passed — DEGRADED` and exit code is 1.

Keep the script under 200 lines. Use `fetch` from bun's global, no external HTTP library. Use `Bun.file('dist/main.js').size` for the bundle size read (cwd-relative). If using from a non-repo-root cwd, resolve via `import.meta.dir` or similar.

### 9.6-2 — `package.json` script alias

Add one new npm script to `vellum/package.json` (the root, NOT `worker/package.json`):

```json
"smoke": "bun run scripts/smoke.ts"
```

Place it alphabetically in the scripts object (so it sits between `preview` or `predeploy` and `test` or `verify`, wherever alphabetical order lands it).

**Do NOT** wire it into `verify` or `deploy` automatically. Smoke runs against production — bundling it into verify would create a dependency on network + prod state that breaks local dev. Users invoke smoke explicitly post-deploy via `bun run smoke` or `bun run smoke https://vellum.linxule.workers.dev`.

### 9.6-3 — Observability reference doc

Create `docs/OBSERVABILITY.md` with the following sections (and nothing more — keep it tight):

1. **Quick commands** — one-line invocations:
   - `bun run smoke` — post-deploy health check against prod custom domain
   - `bun run smoke https://vellum.linxule.workers.dev` — same against workers.dev origin
   - `cd worker && bun run tail` — live log tail via `wrangler tail`
   - `cd worker && bunx wrangler deployments list` — recent deploys
2. **Healthy baselines as of 2026-04-09** — voice count range, bundle size upper bound, expected smoke output, worker upload size range, worker startup time range. Mark these as "snapshot as of version `a6727c65`" so future updates are obvious.
3. **Observability surfaces** — enumerate what exists and how to reach it:
   - `wrangler tail` — real-time log stream, best for active debugging
   - Analytics Engine dataset `vellum_usage` — structured event writes from the worker (see `worker/src/analytics.ts` `trackAnalytics`). Events: `['route', '<path>', '<status>']`, optionally with a blob for families and a double for dwell_s. Document query pattern (even if not currently queried).
   - Cloudflare Workers Observability dashboard — if the Cloudflare observability MCP is configured for this account, it can query `vellum` worker logs via `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability`. Note this as available, don't require it.
4. **Smoke script reference** — what `scripts/smoke.ts` checks, expected pass lines, how to interpret FAIL output, how to pass a custom base URL.
5. **What counts as red** — short list of signals that mean "stop and investigate":
   - Smoke script exits non-zero
   - Voice count drops vs last smoke
   - Bundle size exceeds 72000 bytes (regression guard)
   - 500 rate in Analytics Engine exceeds historical baseline
   - `/api/state` `computed_at` age exceeds `STATE_CACHE_STALE_MS` (10 min) consistently
6. **Alerting** — explicit note: no automated alerting wired. Smoke is manual post-deploy. Adding cron-triggered smoke via GitHub Actions is a possible Phase 9.7, not in 9.6 scope.

Keep this file under 200 lines. Link to it from `CLAUDE.md` (add one line to the "Where to look" section: `- docs/OBSERVABILITY.md — post-deploy smoke, healthy baselines, observability surfaces.`).

## Hard invariants — DO NOT VIOLATE

1. **Zero changes to `worker/src/**` or `src/**` or `app/src/**`.** This phase is scripts + docs only.
2. **No new runtime dependencies.** Don't add anything to `package.json` or `worker/package.json` `dependencies` or `devDependencies`. Use bun built-ins + node stdlib only.
3. **All existing tests pass**: 87 loom + 20 worker.
4. **`bun run verify` clean.** Smoke is NOT part of verify — verify stays renderer + tsc + tests + build. Smoke is post-deploy only.
5. **Renderer bundle flat**: `dist/main.js` must still be 71048 bytes (or exactly whatever the baseline is at time of execution — no renderer changes expected so no delta).
6. **Worker upload flat**: within ±1 KiB of 387.75 KiB.
7. **No changes to wrangler configs, D1 migrations, KV bindings, or any production-touching config.**
8. **No changes to existing docs except one-line `CLAUDE.md` pointer.** Don't rewrite `PATTERNS_AND_GOTCHAS`, don't touch phase-arc memory, don't touch existing phase docs.

## Execution order

1. Read this spec top-to-bottom.
2. Read `CLAUDE.md` (for context on worker structure and existing commands).
3. Create `scripts/smoke.ts`. Test it locally: `bun run scripts/smoke.ts` should run cleanly against prod. Verify it returns exit 0 when prod is healthy.
4. Run it with a bad URL (e.g. `bun run scripts/smoke.ts https://does-not-exist.vellum.test`) to confirm graceful FAIL behavior.
5. Add the `smoke` script to `vellum/package.json`.
6. Write `docs/OBSERVABILITY.md` with all 6 sections.
7. Add the one-line pointer to `CLAUDE.md` under "Where to look".
8. Run `bun run verify` to confirm nothing regressed.
9. Run `bun run smoke` as final sanity check — should print 6/6 passed.
10. **STOP.** Do NOT commit. Do NOT run any git write operations. Report back with what you changed, the smoke script's output, and any deviations from spec.

## Verification contract

| Check | Command | Expected |
|---|---|---|
| Loom tests | `bun test tests/loom/` | 87 pass |
| Worker tests | `cd worker && bun test tests/` | 20 pass |
| Verify script | `bun run verify` | clean |
| Root typecheck | `bunx tsc --noEmit` | clean |
| Smoke against prod | `bun run smoke` | 6/6 passed, exit 0 |
| Smoke against bad URL | `bun run smoke https://invalid.test` | 0/6 passed (gracefully), exit 1 |
| `scripts/smoke.ts` exists | `ls scripts/smoke.ts` | present |
| `docs/OBSERVABILITY.md` exists | `ls docs/OBSERVABILITY.md` | present |
| `package.json` has smoke script | `grep '"smoke"' package.json` | one match |
| `CLAUDE.md` has pointer | `grep 'OBSERVABILITY.md' CLAUDE.md` | one match |
| No worker/src edits | `git diff --stat main -- worker/src/` | empty |
| No src/ edits | `git diff --stat main -- src/` | empty |
| No app/src edits | `git diff --stat main -- app/src/` | empty |
| No new deps | `git diff main -- package.json worker/package.json` | only scripts field changes, no dependencies changes |
| Renderer bundle flat | `wc -c dist/main.js` | 71048 bytes |

## Output — one new doc

### `docs/PHASE_9_6_HANDOFF.md`

Item-by-item report for 9.6-1, 9.6-2, 9.6-3. Include:
- Exact files created / modified
- Smoke script output (paste the 6/6 passed output)
- Deviations from spec, if any, with rationale
- Full verification matrix with actual values

## Suggested commit structure (for Claude after)

Claude will probably land 9.6 as 2 commits:
1. `chore(vellum): phase 9.6 — post-deploy smoke script + observability doc`
2. `docs(vellum): phase 9.6 — handoff`

But Claude's call. Smaller phase than 9.5 so one-commit landing is also reasonable.

## Reminder on the current toolchain

- Package manager: `bun`. Use `bunx` for one-off tool runs.
- Test runner: `bun:test` via `bun test`.
- Type check: `bunx tsc --noEmit`.
- Smoke script runtime: plain bun (`bun run scripts/smoke.ts`) — uses `fetch` global + `Bun.file()`.

Surgical scope. No flourish. Three items, all docs/ops.
