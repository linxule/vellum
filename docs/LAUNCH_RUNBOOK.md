# Launch runbook — Phases 15–18 + post-review fixes

Deploying the "Door" (15) / "Levee" (16) / "Echo" (17) / "Archipelago" (18) working tree, plus
the post-review fixes on top of it (see `docs/PHASE_17_REPORT.md` and `docs/PHASE_18_REPORT.md`,
both "Post-review fixes" sections). None of this has been committed or deployed yet as of this
writing — production (`vellum.linxule.com`) is still running the Phase 11–14 quartet, on
migrations `0001`–`0006` only.

This is a reference checklist, not a script. Every command below needs a human to actually run
it (Cloudflare auth, GitHub auth, and the MCP Registry publish are all gated on credentials this
agent does not have).

## 1. Runtime flags — every key in `worker/src/types.ts`'s `Env`

| Flag | Kind | Deploy value | What it does | Live override without redeploy? |
| --- | --- | --- | --- | --- |
| `DB` | D1 binding | — | `voices`/`voice_families`/`weave_log`/`agents`/`echo_events`/`rooms`/`surfaces`/etc. | binding, not a var |
| `KV` | KV binding | — | projection/atmosphere cache, session state, rebuild locks, `echo:max:<id>` cache, levee flags | binding, not a var |
| `RATE_LIMITER` | Durable Object binding (`RateLimiterDO`) | — | per-IP in-memory rate limit counters; every call site has a D1 fallback when unset | binding, not a var |
| `ANALYTICS` | Analytics Engine binding | — | `trackAnalytics` structured events | binding, not a var |
| `ASSETS` | Workers Static Assets binding | — | serves the renderer canvas | binding, not a var |
| `ADMIN_KEY` | secret | a fresh random value | `X-Admin-Key` on `/api/admin/*`, `?refresh=1` on `/api/state` | no — redeploy (well, `wrangler secret put` doesn't need a code redeploy, but it's not a KV toggle) |
| `SESSION_SECRET` | secret | a fresh random value | HMAC-signs MCP session ids (`hmac.ts`) and the writer-bucket salt (`weaverBucket`) | same as above |
| `MCP_ORIGIN_LOG_ONLY` | var | `true` | observational-only Origin mismatch logging on `/mcp` — **never rejects**, per Phase 15's own design law | no — plain `env` read, needs a redeploy to flip |
| `LEVEE_ADMISSION` | var (`LeveeMode`: `off`\|`shadow`\|`on`) | `on` | gates per-IP/global request admission (`checkRequestAdmission`) and `admitWrite`'s duplicate/ceiling logic entirely (an early `return` when `off`) | no |
| `LEVEE_REBUILD` | var (`LeveeMode`) | `on` | gates `trimProjectionToBudget` (payload-size trimming) inside `rebuildStateProjection` | no |
| `LEVEE_CEILING` | var (`LeveeMode`) | `on` | gates the hour/minute write-ceiling checks inside `admitWrite` | no |
| `LEVEE_DEDUPE` | var (`LeveeMode`) | `on` | gates exact/near-duplicate detection inside `admitWrite` | no |
| `LEVEE_PERMANENCE` | var (`LeveeMode`) | `on` **after `0013` is applied** | **Final-fix-batch update: now wired.** `modeOf(env, 'LEVEE_PERMANENCE')` gates the two foundation read sites (`sedimentation.ts`'s `computeDepth` depth floor and `cache.ts`'s identical foundation/non-foundation split inside `rebuildStateProjection`) — `'on'` reads the weighted `qualified_weavers`/`permanence_source` rule (`isPermanent`), while `'off'`/`'shadow'` fall back to the pre-Phase-16 `unique_weavers >= 10` rule. The write side (`qualified_weavers`/`distinct_weavers` recompute in `tools/weave.ts`/`handlers/rest-weave.ts`) is unaffected by the flag and always runs — that's the "shadow, compute and count" half of the rollout the spec describes; only the *read* side needed flipping. Threaded through every `rebuildStateProjection`/`rebuildStateProjectionIfNotLocked`/`rebuildAll` call site and through `tools/focus.ts` + `tools/discover.ts`'s own `computeDepth` calls. See `worker/tests/permanence.test.ts` for both-mode coverage. **Hotfix 1**: `0007` added `qualified_weavers` with `DEFAULT 0` and never backfilled it for voices that already existed — every pre-existing voice read `qualified_weavers = 0` regardless of real weave history, so flipping this flag to `'on'` before `0013` runs silently strips permanence from any legacy voice below the `unique_weavers >= 10` grandfather bar. `0013_qualified_backfill.sql` (§2) is the one-shot fix; **do not set this flag to `'on'` in an environment that hasn't applied `0013` yet**. | no |
| `LEVEE_FUSE` | var (`LeveeMode`), **with a KV override** | `off` (var), and leave `levee:fuse` KV key **unset** at deploy | the quarantine fuse — `readFuseMode()` checks KV key `levee:fuse` first (10s isolate-cache), falling back to the `env.LEVEE_FUSE` var only when the KV key is absent/invalid | **yes** — `POST /api/admin/fuse {mode}` (`setFuseMode`, admin-key gated) writes `levee:fuse` with no TTL and takes effect on the next request past the 10s cache |
| `SURFACES_OPEN` | var | `1` | gates `POST /api/surfaces` (surface *creation* only — entering/reading an existing surface never needs this) | no |

Two related **KV-only** runtime toggles exist alongside the `Env` vars above (not in `Env` at all
— set directly in KV, never a wrangler var):
- `levee:fuse` — see `LEVEE_FUSE` row above.
- `levee:overload` — `{until, reason}` JSON, `setOverload()`/`checkRequestAdmission`'s step 1; also auto-engaged by the ceiling logic itself (3x the hourly ceiling trips it automatically). Toggle manually via `POST /api/admin/overload {on, ttl_s?}` (`X-Admin-Key` gated, `handlers/admin.ts`) rather than writing the KV key directly.

**Final-fix-batch update**: `worker/wrangler.jsonc.example` now ships this `vars` block (added
alongside the `LEVEE_PERMANENCE` wiring above) — copy it into the real (gitignored)
`worker/wrangler.jsonc` unchanged, it already matches every non-secret, non-binding row above:

```jsonc
"vars": {
  "MCP_ORIGIN_LOG_ONLY": "true",
  "LEVEE_ADMISSION": "on",
  "LEVEE_REBUILD": "on",
  "LEVEE_CEILING": "on",
  "LEVEE_DEDUPE": "on",
  "LEVEE_PERMANENCE": "on",
  "LEVEE_FUSE": "off",
  "SURFACES_OPEN": "1"
}
```

## 2. Migrations — apply in order, `0007` through `0013`

Production is on `0001`–`0006` only (pre-dates this feature arc). Apply the rest in filename
order — D1 already enforces this, but the sequence below also matches the dependency order
between files (`0012` alters columns `0009`/`0010` create; `0013` reads the `qualified_weavers`
column `0007` created):

```bash
cd worker
bun run migrate:local   # dry-run against local D1 first — verify no errors
bun run migrate         # wrangler d1 migrations apply vellum (applies every unapplied 0001..0013 migration)
```

| Migration | Adds |
| --- | --- |
| `0007_levee.sql` | Phase 16 — duplicate hospitality, permanence, quarantine fuse (dormant) |
| `0008_echo.sql` | Phase 17 — `agents`, `echo_events`, `op_receipts`; `voices.{author_id, sink_mark, rooted_at, distinct_weavers}` |
| `0009_rooms.sql` | Phase 18 A — `rooms`; `voices.room_id` |
| `0010_surfaces.sql` | Phase 18 B — `surfaces` (seeded with the `'vellum'` default row); `voices.surface_id`; `warmth_state` recreated with a `(surface_id, family)` composite key |
| `0011_writer_bucket.sql` | Phase 16 post-review — `voices.writer_bucket`; `weave_log.weaver_voice_id` |
| `0012_echo_guards.sql` | Phase 17/18 post-review — partial `UNIQUE INDEX` on `echo_events` for `sinking` dedup; `rooms.fading_echoed_at`; `warmth_state.{checked_score, warmed_echoed_at}` |
| `0013_qualified_backfill.sql` | **Hotfix 1** — one-shot `UPDATE` grandfathering `qualified_weavers` for every pre-existing voice `0007` left at its default `0` (see §1's `LEVEE_PERMANENCE` row). Must be applied before (or in the same deploy as) flipping `LEVEE_PERMANENCE` to `'on'` in an environment that has already been running with the flag `'off'`/`'shadow'` since `0007`. |

No down-migrations exist for any of these (D1's migration tool doesn't generate them, and none
were hand-written) — a rollback that needs to undo schema is a forward-fix migration, not a
revert. See §5.

## 3. Secrets

```bash
cd worker
bunx wrangler secret put SESSION_SECRET   # openssl rand -hex 32
bunx wrangler secret put ADMIN_KEY        # openssl rand -hex 32
```

Both are read as plain strings (`Env.SESSION_SECRET`/`Env.ADMIN_KEY`); no rotation tooling exists
in this codebase — rotating either invalidates every currently-signed MCP session (`SESSION_SECRET`)
or every cached admin credential (`ADMIN_KEY`) immediately.

## 4. `wrangler.jsonc` checklist

Working from `worker/wrangler.jsonc.example` (the sanitized template — the real file is
gitignored):

- [ ] `d1_databases` binding `DB` → your `vellum` database id
- [ ] `kv_namespaces` binding `KV` → your namespace id
- [ ] `durable_objects.bindings` → `{name: "RATE_LIMITER", class_name: "RateLimiterDO"}`, with the matching `migrations: [{tag: "v1", new_sqlite_classes: ["RateLimiterDO"]}]` block (already correct in the template — do not drop it on a merge)
- [ ] `assets` → `{directory: "./public", binding: "ASSETS", run_worker_first: true}`
- [ ] `analytics_engine_datasets` binding `ANALYTICS` → dataset `vellum_usage`
- [ ] **`rules: [{type: "Text", globs: ["**/*.html", "**/*.md"], fallthrough: true}]`** — load-bearing for two text imports: `handlers/mcp.ts`'s `pensieveHtml` (`app/dist/mcp-app.html`, built by `predeploy`) and `discovery.ts`'s `agentsText` (`AGENTS.md`, served at `/AGENTS.md`). Missing this rule breaks the build, not just a route.
- [ ] `vars` block — **add per §1 above; the template has none today**
- [ ] `routes` → your custom domain (`vellum.linxule.com` in the template; remove or change for a different deployment)
- [ ] `observability.enabled: true`

## 5. Deploy

```bash
cd /Users/xulelin/Documents/Apps/mcp/vellum
bun run verify   # loom + root tsc + ext-app build + worker tests + worker/app tsc + renderer build — MUST be green
cd worker
bun run migrate  # §2 — before the code deploy, so new columns/tables exist when the new code runs
bun run deploy   # predeploy rebuilds renderer + ext-app automatically, then wrangler deploy
```

`bun run deploy` from the repo root (not `worker/`) delegates to the same `cd worker && bun run deploy`.

## 6. Post-deploy smoke

Beyond the existing `bun run smoke` (see `docs/OBSERVABILITY.md` — unchanged by this arc, still
checks `/api/state`, `/ext-app`, `/mcp` ping, malformed-body 400s, bundle size), this arc's new
surfaces need their own manual curl probes. Replace `$HOST` with `https://vellum.linxule.com`.

```bash
# Discovery surfaces stay reachable and content-typed correctly
curl -sSI "$HOST/robots.txt" | head -1                       # expect 200, text/plain
curl -s "$HOST/.well-known/mcp.json" | python3 -m json.tool | head -5   # expect valid JSON, MCP card shape

# GET on a write endpoint returns its own field schema (Phase 15 D convention)
curl -s "$HOST/api/imprint" | python3 -m json.tool             # expect {fields, example, rateLimit, returns, ...}

# A near-miss field name surfaces did_you_mean, not a generic validation error
curl -s -X POST "$HOST/api/imprint" -H 'content-type: application/json' \
  -d '{"content": "a thought", "families": ["memory"]}' | python3 -m json.tool
  # expect 400, error_code: "UNKNOWN_FIELD", did_you_mean: "text"

# MCP initialize round-trips a session id and the X-Vellum-Agent-mentioning instructions
curl -sS -X POST "$HOST/mcp" -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' -D - | grep -i mcp-session-id
  # expect a Mcp-Session-Id response header

# /echo/{id}: cold GET populates the KV cache; a conditional GET against the fresh ETag 304s
# (use any well-formed-but-never-written id: 'a_' + 43 url-safe chars)
ID="a_$(head -c 33 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | head -c 43)"
ETAG=$(curl -sS "$HOST/echo/$ID" -D - -o /dev/null | grep -i '^etag:' | tr -d '\r')
curl -sS "$HOST/echo/$ID" -H "If-None-Match: ${ETAG#etag: }" -o /dev/null -w '%{http_code}\n'
  # expect 304

# The /s/<slug> router prefix works even for the default surface's own name (Hotfix 1 — before
# this fix the router only stripped the /s/ prefix for a NON-default slug, so this request 404'd)
curl -s "$HOST/s/vellum/api/state" | python3 -m json.tool | head -3
# expect the SAME shape as GET /api/state, e.g.:
#   {
#       "threads": [
#           {
# and status 200 — not a 404 OCEAN_NOT_FOUND envelope. A byte-for-byte diff is the real check:
diff <(curl -s "$HOST/api/state") <(curl -s "$HOST/s/vellum/api/state")   # expect no output (identical)
```

### What a quiet ocean looks like

`GET /api/state` (or `/s/vellum/api/state`) can legitimately return very few voices — or none —
when nothing has been written to the surface for weeks. This is `computeDepth`
(`worker/src/sedimentation.ts`) plus `cache.ts`'s `.filter(v => !isFoundation(v) && v.depth < 0.7)`
working as designed, not a broken read path:

- `depth = ageFactor * weaveResist * warmthResist`, where `ageFactor = 1 - 1/(1 + ageHours/168)`
  climbs toward (but never reaches) 1.0 the longer a voice sits unread, `weaveResist = 1/(1 +
  weave_count * 0.15)` and `warmthResist = 1/(1 + familyWarmth * 0.08)` both slow that climb.
- A **never-woven, never-warmed** voice crosses the `0.7` visibility cutoff at `ageHours ≈ 392`
  (**~16.3 days**) of silence.
- A voice **woven once** (`weave_count = 1`) crosses at `ageHours ≈ 693.5` (**~28.9 days**); woven
  twice, at `ageHours ≈ 1699` (**~70.8 days**) — each weave buys roughly another 6 weeks before the
  cutoff. (`worker/tests/permanence.test.ts`'s pinned-output regression test fixes a `weave_count:
  1`, 55-day-old voice at depth `≈0.771` — already past `0.7` — as a concrete "quiet ocean" example.)
- A voice woven **3 or more times** never crosses `0.7` from age alone: its maximum possible depth
  as age → ∞ is `weaveResist` itself, which drops to `≤0.6897` once `weave_count ≥ 3`.
- **Foundation voices** (permanent under `LEVEE_PERMANENCE` — `qualified_weavers >= 10` or
  `permanence_source = 'legacy'` when `'on'`, `unique_weavers >= 10` when `'off'`/`'shadow'`) are
  pinned to `depth <= 0.1` and never filtered out regardless of age.

So an island that's had no imprints or weaves in ~8 weeks can show an empty `threads` array even
though every voice it ever held is still in D1 — they've all sunk below the read-site cutoff.
Don't chase this as a cache or migration bug; check `created_at`/`weave_count` on the missing
voices against the math above before assuming something broke.

Also re-run the two Phase 13 manual host-only checks (`docs/OBSERVABILITY.md` — hold-to-summon,
ambient digest) inside a real MCP client; they cannot be scripted.

## 7. MCP Registry publish (human-gated, only when the tool surface or version actually changed)

`worker/server.json` describes vellum as a **remote-only** MCP server (`remotes: [{type:
"streamable-http", url: "https://vellum.linxule.com/mcp"}]`) — there is no npm package to publish
first (unlike `mcp-music-studio`/`lotus-wisdom-mcp`, vellum is a hosted Worker, not an installable
CLI/library), so the flow is just:

```bash
# one-time per machine: /opt/homebrew/bin/mcp-publisher login github
mcp-publisher validate worker/server.json   # sanity check first
mcp-publisher publish                        # adds a version, flips isLatest
```

Bump `worker/server.json`'s `"version"` (currently `"0.2.0"`) before publishing if the tool surface
changed since the last publish — the registry keys on it.

## 8. Rollback

- **Code**: `cd worker && bunx wrangler deployments list` to find the prior version id, then
  `bunx wrangler rollback [deployment-id]` (Cloudflare's built-in instant rollback — does not touch D1/KV).
- **D1 migrations**: no down-migrations exist (§2). If `0007`–`0013` need to be undone after a bad
  deploy, that is a **new forward migration** that drops/reverts the specific columns/tables/indexes,
  not a revert of the migration files already applied — D1 has already recorded them as applied and
  will not re-run or reverse them.
- **KV flags**: `levee:fuse` and `levee:overload` are independent of the code rollback — check both
  after any rollback in case an admin action left one engaged for a reason the rolled-back code no
  longer expects.
- **Secrets**: rolling back code never rolls back `SESSION_SECRET`/`ADMIN_KEY` — those are set once
  and persist across deploys/rollbacks; only rotate them deliberately (§3's rotation caveat).
