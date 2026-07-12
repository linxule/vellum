# Observability

## Quick commands

```bash
bun run smoke
bun run smoke https://vellum.linxule.workers.dev
cd worker && bun run tail
cd worker && bunx wrangler deployments list
```

## Healthy baselines as of 2026-04-09

Snapshot refreshed during Phase 9.6 against live version `e2ccf9eb-80e0-471b-92ba-377f0e296ae6`.

- Voice count: expect `> 0` and roughly `280-300` voices on prod; the first 9.6 smoke saw `283`.
- Renderer bundle: `dist/main.js` is `82631` bytes after sound redesign (was `80198` post-Phase 10). Limit: `84000` bytes.
- Worker upload: keep dry-run total upload within `395-405 KiB`; current baseline is `399.72 KiB` total and about `98.8 KiB` gzip.
- Worker startup time: no repo-local metric is wired yet; use the Workers dashboard and treat the normal band as low double-digit milliseconds. Sustained movement into `100ms+` territory is a red flag.
- Expected smoke output:
  `6/6 passed`, `/api/state` shows `6 threads`, `/ext-app` shows `0 sentinels`, `/mcp` ping succeeds, malformed `/mcp` returns `400 + -32700`, malformed `/api/witness` returns `400`, and the bundle check reports `80198 bytes ≤ 82000`.

## Observability surfaces

- `wrangler tail`: real-time worker logs for active debugging. Use this first when a deploy looks wrong in the moment.
- Analytics Engine dataset `vellum_usage`: the worker writes structured blobs and doubles through `trackAnalytics` in `worker/src/analytics.ts`.
- Common event shape: route-style writes use blob arrays like `['route', '<path>', '<status>']`, with optional extra blob values such as joined families and optional doubles such as `dwell_s` or cache age.
- Query pattern: filter recent points by the first blob (`route`, `mcp`, `cache_rebuild`), then narrow by path/status/tool. Use Cloudflare's Analytics Engine SQL docs for the exact query syntax: [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
- Cloudflare Workers Observability dashboard: use it for request/error/startup trends when dashboard access is available.
- Optional MCP path: if the Cloudflare observability MCP is configured for this account, it can query `vellum` worker logs through `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability`.

## Smoke script reference

- `scripts/smoke.ts` is a manual post-deploy check. It does not run inside `bun run verify` or `bun run deploy`.
- Default target: `https://vellum.linxule.com`. Override with a positional base URL: `bun run smoke https://vellum.linxule.workers.dev`.
- Checks, in order:
  `/api/state` returns `200`, parses, exposes `6` threads, and contains at least one voice across those threads.
  `/ext-app` returns `200`, contains zero `__VELLUM_BASE_URL__` sentinels, and includes the target hostname at least once.
  `/mcp` ping returns `200` with a valid JSON-RPC `result`.
  `/mcp` malformed body returns `400` with `error.code === -32700`.
  `/api/witness` malformed body returns `400` with `error === 'Invalid witness event'`.
  `dist/main.js` stays at or below `84000` bytes locally.
- Output format is plain text with `[PASS]` / `[FAIL]` per line and a final `HEALTHY` or `DEGRADED` summary.
- Interpret FAIL lines literally: the text in parentheses is the first thing to inspect.

## Manual host-only checks (Phase 13 — cannot be scripted)

The two ext-apps host channels only exist inside a real MCP client (standalone `/ext-app` has no host, so `scripts/smoke.ts` cannot cover them):

- **F13 hold-to-summon**: open the Vellum ext-app in an MCP client, dive into any voice (woven or not), mouse-hold ≥800ms without moving. Expected: the voice's glow deepens during the hold, then `A witness held a voice on the surface: "…" (v:xxxx)` appears as a user message in the conversation. A second hold within 5s must NOT fire (cooldown). Releasing a fired hold must NOT also enter loom view (click suppression).
- **F12 ambient digest**: after the ext-app connects, the host model's context should receive one `[vellum surface] The ocean holds N voices…` block (REPLACE semantics; re-pushed only on loom enter/exit). Verify by asking the host model what it knows about the surface before any tool call.

## What counts as red

- `bun run smoke` exits non-zero.
- Voice count drops materially versus the last healthy smoke on the same day.
- `dist/main.js` exceeds `84000` bytes.
- Analytics Engine shows a 500 rate above the recent healthy baseline.
- `/api/state` `computed_at` age stays above `STATE_CACHE_STALE_MS` (`10 min`) across repeated checks.

## Alerting

- No automated alerting is wired in 9.6.
- Smoke remains a manual post-deploy step.
- If automated post-deploy or recurring smoke is added later, treat it as follow-on work (possible Phase 9.7), not part of the 9.6 foundation.
