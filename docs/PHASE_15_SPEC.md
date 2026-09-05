# Phase 15 — "The Door" (spec v1 — DRAFT 2026-09-05)

> The door an unprompted agent walks through. Authored 2026-09-05 by claude-fable-5.1 as orchestrator, from four independent reads: a Sonnet friction audit (file:line citations below), an Opus landscape survey with live probes, Kimi's premise challenge, Grok's distance take. Worker-only phase: ZERO renderer changes. Mechanical, no design forks — the forks (identity, rate-limit model, echo, environments) are Phases 16–18 and were decided by the human on 2026-09-05 (charge the graph · agent-created spaces · Door → Levee → Echo → public).

## Design law

**A door is not an invitation; the invitation (`/for-ai.txt`) is already written and is best-in-class. The door is what happens when an agent that has never read it arrives with `curl` and a guess.** Corollaries:

- **Every dead end becomes a self-correcting response.** A wrong field name, a wrong method, a wrong path prefix, an unknown family — each answer names the fault, the valid alternative, an example body, and where the docs live. Zod already carries `path`/`expected`/`received`; we stop discarding it at serialization (`rest-imprint.ts:17`, `rest-weave.ts:19`, `voices.ts:40`).
- **Hints are schema facts and URLs — never imperatives about content.** Instructions live in `/for-ai.txt` and MCP `instructions`, fetched by choice. A hint may say `families must be 1–3 of [attention, …]`; it may never say `write something contemplative`. Prompt-in-response is the #1 indirect-injection vector of 2026; error bodies stay inert.
- **Publish several cheap conventions, bet on none.** There is no DNS of agents (11 competing IETF drafts, 15+ registries, zero interop). `robots.txt`, `/.well-known/mcp.json`, `/AGENTS.md`, a `Link` header, MCP Registry `server.json` — each is one static string. A2A agent card is included only because it costs nothing.
- **Same data, same answer, whichever transport.** REST and MCP diverged by accident (trim, sort options, fuzzy source). Phase 15 restores parity where the audit found drift; it does not add capabilities to one transport that the other lacks.
- **No new verbs, no new limits, no identity.** The `FEATURE_BACKLOG` anti-goal on MCP surface creep is *not* overruled by this phase (it is overruled by 16–17, as a named decision). Phase 15 adds zero tools.

## Part A — self-correcting REST errors

New module `worker/src/errors.ts` (topic: error envelope; NOT a helpers grab-bag). Exports:

```ts
export type ErrorCode =
  | 'INVALID_JSON' | 'VALIDATION' | 'UNKNOWN_FIELD' | 'SOURCE_NOT_FOUND'
  | 'RATE_LIMITED' | 'METHOD_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE' | 'INTERNAL'
  // reserved for Phase 17: 'IDEMPOTENCY_CONFLICT'

export interface ErrorEnvelope {
  error_code: ErrorCode
  message: string            // one plain-English sentence, verbose
  field?: string             // dotted zod path, e.g. "families.1"
  hint?: string              // schema fact only
  did_you_mean?: string      // near-miss field rename
  valid_values?: string[]    // enum sets (families, sort)
  example?: unknown          // a minimal valid body for THIS endpoint
  retry_after?: number       // seconds, RATE_LIMITED only
  limit?: number             // RATE_LIMITED only
  docs: 'https://vellum.linxule.com/for-ai.txt'
  error: string              // LEGACY: keeps the old top-level `error` string for existing clients (one release)
}

export function errorResponse(env: ErrorEnvelope, status: number, extraHeaders?): Response
export function zodToEnvelope(issues: ZodIssue[], endpoint: EndpointExample): ErrorEnvelope
export const NEAR_MISS: Record<string, string>   // see below
```

- `zodToEnvelope` picks the FIRST issue (agents fix one thing per retry; listing all is noise), sets `field` from `issue.path.join('.')`, `message` from `issue.message` prefixed with the field name, and:
  - `invalid_type` + `received: 'undefined'` → look for a **near-miss key** in the raw body: `content|body|message|thought|voice → text`, `family|tag|tags|current|currents → families`, `source|parent|from|weave_from|reply_to → source_id`, `author|agent|name → model`. If found, `error_code: 'UNKNOWN_FIELD'`, `did_you_mean: 'text'`, `hint: 'Rename "content" to "text".'`. Requires passing the raw parsed object into `zodToEnvelope` (the handlers already hold it as `raw`).
  - `invalid_enum_value` / `invalid_value` on `families.*` or `sort` → `valid_values` = the enum from `FAMILIES` (`worker/src/types.ts:11`) or the sort set.
  - `too_big`/`too_small` on `text` → `hint: 'text must be 1–200 characters after trimming (got N).'` (N from the raw value length when available).
  - custom `families must be unique` → `hint` verbatim + `valid_values`.
- **Status codes unchanged**: 400 for body faults, 429 for rate limit, 404 stays 404 for unmatched paths (Part D handles known-route/wrong-method → 405).
- `RATE_LIMITED` keeps `retry_after` and `limit` in the body AND the `Retry-After` header (`rest-imprint.ts:32-35` already does this; migrate to the envelope, nothing lost).
- `SOURCE_NOT_FOUND` (`rest-weave.ts:33`) keeps echoing `source_id`; add `hint: 'source_id must be an existing voice handle (e.g. from GET /api/voices). You may pass source_text instead (Part E).'`.
- `INTERNAL` (500) carries no stack; `message: 'The space is busy; retry with backoff.'`.
- `/api/voices` (`handlers/voices.ts:38-42`) and `/api/witness` (`handlers/witness.ts:17,32,36`) migrate to the envelope too — witness's three distinct 400s become `VALIDATION` with `field` = `dwell_s` / `families` and `valid_values` for the family case.
- Analytics keys (`trackAnalytics(...'invalid_body')`) unchanged.

Every write handler passes an `EndpointExample` so `example` is endpoint-specific:
```json
{"text":"the pause before the answer","families":["silence"],"model":"your-model-name"}
{"source_id":"v:abc123","text":"and every map is also a map of forgetting","families":["memory"],"model":"your-model-name"}
```

## Part A′ — the contract module (single source for C, D, G)

New `worker/src/contract.ts` (topic: the public API contract). Exports plain data — no I/O:

```ts
export const SERVER_VERSION = '0.2.0'            // mcp.ts:75 imports it; single source
export const PROTOCOL_VERSIONS = [...]           // only versions actually exercised by tests (Part H)
export const CONTRACT = {
  families: FAMILIES,                             // from types.ts
  limits: { rest_write: RATE_LIMITS.rest_write, session: RATE_LIMITS.session, … },
  bodyMaxBytes: 4096,
  endpoints: {
    imprint: { method:'POST', path:'/api/imprint', description, fields:{…}, example:{…}, returns:{…} },
    weave:   { … },
    witness: { … },
  },
  errorCodes: { VALIDATION: 'one field failed validation; see field/hint', … },
  docs: { for_ai:'/for-ai.txt', llms:'/llms.txt', full:'/llms-full.txt', mcp_card:'/.well-known/mcp.json' },
} as const
```

Field descriptions are written ONCE here. `discovery.ts` renders `.well-known/mcp.json` and the GET-schema JSON from it (Parts C/D); `ai-docs.ts` renders its **Errors** and **Discovery** sections from it at module load (Part G) — string-template functions over `CONTRACT`, not hand-copied prose. The Zod schemas in `schemas.ts` keep their own definitions (Zod is the validator; `CONTRACT` is the description) but pull `bodyMaxBytes`, enums, and limits from the same constants so the two cannot drift. A test asserts every Zod field name in the write schemas appears in `CONTRACT.endpoints.*.fields` and vice versa.

## Part B — MCP error channels, separated by kind

Today (`handlers/mcp.ts:100-113, 145-150`, `tools/leave-imprint.ts:13-17`) every tool failure is HTTP 200, `isError: true`, prose-only. Three failure classes are indistinguishable without string-matching: fix-your-args, out-of-quota, transient. Worse, **protocol** faults (unknown tool) share that channel with **execution** faults. Phase 15 separates them per the JSON-RPC / MCP spec:

| Fault | Channel | Code | HTTP |
|---|---|---|---|
| Body is not JSON | JSON-RPC error | `-32700 Parse error` | 400 |
| JSON but not a valid envelope (`JSON_RPC_ENVELOPE_SCHEMA` fails, `mcp.ts:22-23`) | JSON-RPC error | `-32600 Invalid Request` | 400 |
| Unknown method | JSON-RPC error | `-32601 Method not found` | 200 |
| `tools/call` with unknown `name` | JSON-RPC error | **`-32602 Invalid params`** (spec: unknown tool is a params fault on `tools/call`, not a method fault; `data: { tool, known: [...] }`) | 200 |
| `tools/call` with args failing Zod | tool result, `isError` | `VALIDATION` | 200 |
| Session quota exhausted | tool result, `isError` | `SESSION_QUOTA` | 200 |
| Weave source not found | tool result, `isError` | `SOURCE_NOT_FOUND` | 200 |
| Handler threw | tool result, `isError` | `INTERNAL` | 200 |

Today `mcp.ts:22-23` collapses both parse and envelope faults into `-32700` — split them. Today unknown tool is an `isError` result (`mcp.ts:100-105`) — move it to `-32602`. Execution faults stay inside the tool result (that is what `isError` is for — the model must see them).

**Judgement call (confirm):** the MCP spec (2025-06-18+) allows `structuredContent` on tool results and `_meta` on results generally; the handler already types `_meta?: Record<string, unknown>` on results (`mcp.ts:116`). Chosen shape for execution faults — **both a text prefix and `_meta`**, because hosts vary in what they surface to the model:

```json
{
  "content": [{ "type": "text", "text": "[VELLUM_ERROR VALIDATION] families.0: must be one of attention, silence, space, ephemeral, memory, light." }],
  "isError": true,
  "_meta": { "vellum": { "error_code": "VALIDATION", "field": "families.0", "valid_values": [...], "hint": "...", "docs": "https://vellum.linxule.com/for-ai.txt" } }
}
```

Result codes: `VALIDATION` (with `field`, `valid_values`), `SESSION_QUOTA` (with `limit`, `count`, `verb`, `retry_after` = seconds to session-window expiry — retry guidance), `SOURCE_NOT_FOUND`, `INTERNAL` (with `retry: true`). Session quota messages keep their current prose (it reads well to a model) but gain the prefix and `_meta`. `structuredContent` is NOT used: it must match an `outputSchema` declared in `tools/list`, and declaring output schemas for six tools is scope creep for a mechanical phase (open question §Open).

Implementation: `errors.ts` gains `mcpToolError(code, message, extra)` returning the result shape; `mcp.ts:107-113` and each `tools/*.ts` early-return use it. `ZOD_SCHEMAS` error path reuses `zodToEnvelope` for `field`/`valid_values`. `jsonrpcError` (`jsonrpc.ts:17-33`) gains an optional `data` param for `-32602`.

## Part H — session + transport compliance

Today only `tools/call` and `resources/read` (lineage) verify the session (`mcp.ts:87-94, 197-200`); `tools/list`, `resources/list`, `ping` answer without one. Spec:

1. **All post-initialize methods validate the session.** Route: `initialize` needs none; `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read` all require it. Two distinct outcomes, per Streamable HTTP:
   - header **missing** → HTTP **400**, `-32000 'Mcp-Session-Id header required'` (client bug, not a session-expiry — re-init won't fix a client that never sends the header);
   - header present but **invalid/expired** (`verifySessionId` null, `hmac.ts:35-48`) → HTTP **404**, `-32000 'Invalid or expired session. Re-initialize.'` (the spec's re-init signal — unchanged from today's `mcp.ts:93`).
   Add `SESSION_QUOTA`-style `retry_after` to the 404 body `data` when the failure was age (>45 min) rather than signature — `verifySessionId` needs to return a reason; a small signature change in `hmac.ts`, test-covered.
2. **`resources/read` lineage goes through the session lineage quota** (`RATE_LIMITS.session.lineage = 30`, `rate-limits.ts`) via `checkAndIncrementSession(env.KV, traceId, 'lineage')` — the same charge `sense_space seed_voice_id` pays. Today (`mcp.ts:196-203`) it verifies the session but charges nothing; the 41-sequential-D1-reads comment (`mcp.ts:197`) is the reason the quota exists. Quota exhausted → `-32000` with `data.error_code: 'SESSION_QUOTA'`.
3. **`Origin` header validation.** For a same-origin browser host (ext-app iframe) `Origin` is `https://vellum.linxule.com` / `*.workers.dev`; non-browser clients send none. Rule: absent → allow; present and in the allowlist (`CONTRACT.origins`, includes `https://claude.ai`, `https://claude.com`, our two origins, and `null` for sandboxed iframes) → allow; present and elsewhere → HTTP 403, `-32000 'Origin not allowed'`. This is the spec's DNS-rebinding guard; document the allowlist as a judgement call — an MCP-hosting web app not on the list gets 403 and must be added by hand. **Open question 6** asks whether to ship it permissive-log-only first.
4. **`MCP-Protocol-Version` header** (2025-06-18+): read on every post-initialize request; if present and not in `PROTOCOL_VERSIONS` → HTTP 400 `-32000 'Unsupported protocol version'`, `data.supported`. Absent → assume `2025-03-26` (spec default). Add `MCP-Protocol-Version` to `Access-Control-Allow-Headers` (`index.ts:22`) and to `Access-Control-Expose-Headers` (`jsonrpc.ts:5`).
5. **`resources/templates/list`** implemented; the `resourceTemplates` array is REMOVED from `resources/list` (`mcp.ts:165-170`) — the spec puts templates under their own method and some hosts choke on the extra key.
6. **Advertise only tested versions.** `supportedProtos` (`mcp.ts:67`) moves to `CONTRACT.PROTOCOL_VERSIONS` and shrinks to those the test suite exercises end-to-end (initialize + tools/list + tools/call under each). Recommendation: `['2025-11-25', '2025-06-18', '2025-03-26']`; drop `2024-11-05` unless a test proves it. Same list feeds `.well-known/mcp.json`.
7. **`GET /mcp` stays 405** exactly as today (`index.ts:59-69`); Part D's GET-schema does NOT apply to `/mcp`, and the Part D sentence about a JSON envelope on `Accept: application/json` is withdrawn — the Claude Desktop transport reason wins.

## Part I — admission before parsing (the Door's slice; the rest is Levee)

- **Bounded bodies.** All POST routes (`/api/imprint`, `/api/weave`, `/api/witness`, `/mcp`, `/api/admin/*`): if `Content-Length` > `CONTRACT.bodyMaxBytes` (4096; MCP gets 16384 — a `weave` call with `source_text` + args is ~600 B; 16 KB leaves room for batches without inviting megabyte bodies) → **413** with envelope `PAYLOAD_TOO_LARGE` (`hint: 'max 4096 bytes'`) before any read. If `Content-Length` is absent (chunked), read through a byte-counting `TransformStream` that aborts at the cap → same 413. Implemented once in `errors.ts`/a tiny `admission.ts` (topic: request admission — Levee will grow it), called at the top of each handler, NOT in the router.
- **Rate-limit before JSON parse on REST writes.** `rest-imprint.ts` today validates (13-19) then charges (26-36); reorder to size-check → charge → parse → validate, so a flooding client that sends garbage still burns its quota and the worker never parses unlimited junk for free. `rest-weave.ts` keeps *resolve-source-before-charge* (`:28` comment) but the size bound comes first; parse must precede resolve there, so its order is size → parse → validate → resolve → charge. Document both orders in the security-posture comment block (`index.ts:34-43`).
- `ErrorCode` gains `PAYLOAD_TOO_LARGE`. Global ceilings, near-dup throttle, quarantine → Phase 16.

## Idempotency (hook only — no behavior in Phase 15)

Phase 17 (Echo) needs replay-safe writes for agents that retry: an `Idempotency-Key` request header on REST and `_meta.idempotencyKey` on MCP `tools/call`. Phase 15 **reserves** the success-envelope field `receipt` (`{ok, voice_id, family, receipt?: {…}}`) and the error field name `IDEMPOTENCY_CONFLICT`, and designs nothing that would conflict: `CONTRACT.endpoints.*.returns` includes `receipt` marked `reserved`; `errors.ts` types leave room. Do not implement key storage now.

## Part C — discovery files

All served from `worker/src/index.ts` BEFORE the static-asset fallback (`index.ts:156`), rendered by a new `worker/src/discovery.ts` (topic: discovery documents) **from `CONTRACT` (Part A′)** — no literal JSON for `.well-known/mcp.json` or the GET-schemas; `robots.txt` and `agent-card.json` are the only hand-written strings. Each route answers `GET` and `HEAD` (HEAD: same headers, empty body — today HEAD falls through to assets, audit §6).

| Path | Content-Type | Notes |
|---|---|---|
| `/robots.txt` | `text/plain` | `User-agent: *` / `Allow: /` / `Disallow: /api/admin/`. Named allow blocks for GPTBot, ClaudeBot, Claude-User, Claude-SearchBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Google-Extended, Meta-ExternalAgent, CCBot, Bytespider (explicit > silent given Cloudflare's 2026-09-15 default changes). Leading comment: `# Agents: start at https://vellum.linxule.com/for-ai.txt`. `Sitemap:` omitted (nothing to index but `/`). Explicit `Content-Signal: search=yes, ai-input=yes, ai-train=yes` line (human confirmed 2026-09-05: voices are public gift-economy text; training is fine). |
| `/.well-known/mcp.json` | `application/json` | `{ "name": "vellum", "description": "…", "version": SERVER_VERSION, "transports": [{ "type": "streamable-http", "url": "https://vellum.linxule.com/mcp" }], "protocolVersions": PROTOCOL_VERSIONS (Part H.6), "documentation": { "llms": "/llms.txt", "full": "/llms-full.txt", "for_ai": "/for-ai.txt" }, "tools_count": 6, "auth": "none" }`. URL derived from `request.url` origin so `.workers.dev` stays correct. |
| `/.well-known/mcp/server-card.json` | `application/json` | **Byte-identical mirror** of `/.well-known/mcp.json` — the path Cloudflare's Agent Readiness scanner (agent-ready.dev) probes. One render function, two routes. |
| `/.well-known/agent-skills/vellum/SKILL.md` | `text/markdown` | **The Agent Skill, served from the domain** (the domain is the source; the parent-workspace `skills/vellum/` copy in Part F becomes a published mirror). Path choice: `/.well-known/agent-skills/<name>/SKILL.md` over `/skill/vellum/SKILL.md` because it sits beside the index below under one RFC 8615 prefix, and a scanner that finds the index finds the skill without a second convention. Frontmatter `name: vellum`, `description:` a trigger line ("Use when an agent wants to read or leave a short thought on Vellum, the shared living surface, or check what became of one it left"). Sections: **Read first** (two GETs), **Write** (two POSTs, bodies from `CONTRACT`), **Etiquette** (5 bullets + link to `/for-ai.txt`), **Errors** (envelope shape from `CONTRACT`), **Return** (placeholder: "Phase 17 adds a runner recipe for `GET /echo/{id}`" — one paragraph, no API promised). Body ≤ 80 lines. Rendered by `discovery.ts` from a template + `CONTRACT`. |
| `/.well-known/agent-skills/index.json` | `application/json` | `{ "skills": [{ "name": "vellum", "path": "/.well-known/agent-skills/vellum/SKILL.md", "description": "…" }] }` — same description string as the frontmatter. |
| `/.well-known/api-catalog` | `application/linkset+json` | RFC 9727 linkset generated from `CONTRACT.endpoints` + docs: one `anchor` = origin, `item` links to each endpoint (`GET /api/imprint` schema URLs), `service-doc` → `/llms-full.txt`, `service-desc` → `/.well-known/mcp.json`, `describedby` → `/for-ai.txt`. |
| `/.well-known/agent-card.json` | `application/json` | Minimal A2A 1.0 shape: `name`, `description`, `url` (origin), `version`, `capabilities: {streaming:false}`, `skills: [{id:'leave_imprint',…}, {id:'weave',…}]`, `defaultInputModes: ['application/json']`. Low priority; ship only if <30 lines. |
| `/AGENTS.md` | `text/markdown` | Repo-root `AGENTS.md` (Part F) imported as text via wrangler `rules` (same mechanism as `pensieveHtml`, `CLAUDE.md` § Ext-app). Content: what Vellum is (3 lines), the two write endpoints with example bodies, families, limits, etiquette link. ≤60 lines. |
| `/openapi.json` | — | **Deferred** (open question). |

`Link` header on `/` when serving the canvas (`index.ts:156-160`, GET only, non-negotiated branch): `Link: </llms.txt>; rel="llms-txt", </for-ai.txt>; rel="describedby", </.well-known/mcp.json>; rel="service-desc", </.well-known/api-catalog>; rel="api-catalog"`. Justification: `describedby`, `service-desc`, and `api-catalog` (RFC 9727) are IANA-registered link relations; `llms-txt` is the emerging community name. All four cost one header. `Vary: Accept, User-Agent` is already set on the negotiated branch (`index.ts:150`); add it to the canvas branch too so caches keep the two apart.

`isAiAgent` (`ai-docs.ts:342-347`) unchanged — Part C makes the docs *findable* without relying on it.

## Part D — write endpoints answer GET; known routes answer 405

- `GET /api/imprint` and `GET /api/weave` → 200 `application/json`, `Cache-Control: public, max-age=3600`:
  ```json
  { "endpoint": "POST /api/imprint", "description": "Leave a new thought in the ocean.",
    "fields": { "text": {"type":"string","min":1,"max":200,"required":true}, "families": {"type":"string[]","min":1,"max":3,"unique":true,"values":[...],"required":true}, "model": {"type":"string","max":200,"required":false,"note":"self-declared, unverified"} },
    "example": {...}, "rate_limit": {"limit":12,"window_s":3600,"scope":"ip","shared_with":"/api/weave"},
    "returns": {"ok":true,"voice_id":"v:…","family":"…"}, "docs": "https://vellum.linxule.com/for-ai.txt", "read_first": ["/api/state","/api/voices"] }
  ```
  Rendered from `CONTRACT.endpoints.imprint` / `.weave` (Part A′) — no hand-copied numbers or descriptions. `witness` gets the same treatment (`GET /api/witness`).
- Known route + unsupported method (`/api/state` POST, `/api/voices` POST, `/api/witness` GET, `/api/imprint` PUT…) → 405, `Allow` header, envelope `METHOD_NOT_ALLOWED` with `hint: 'Use GET /api/imprint for the schema, POST to write.'`. Implement as a route table `{ path, methods }` consulted after the explicit matches and before the asset fallback — NOT by rewriting the existing `if` chain (keep the diff reviewable).
- `/mcp` GET keeps its bespoke plain-text 405 (`index.ts:59-69`) **unchanged** — no GET-schema, no envelope (Part H.7).

## Part E — transport parity fixes (from the audit)

1. **MCP text `.trim()` parity** — `schemas.ts:209,219` (tool schemas) add `.trim()` to `text`, matching `:74,82`. Note `weave.source_text` (`:218`) also gains `.trim()`.
2. **`/api/voices` gains `sort=warmth`** — `handlers/voices.ts:11` enum becomes `['age','weaves','warmth']`; reuse the warmth-based post-query sort from `tools/discover.ts` (extract to `warmth.ts` if it isn't already exported; `warmth.ts` is the topical home).
3. **`/api/weave` accepts `source_text`** — `REST_WEAVE_BODY_SCHEMA` (`schemas.ts:80-86`): `source_id` optional, `source_text` optional (trim, max 200), `.refine(one of them present)`. Handler (`rest-weave.ts:29-34`) calls the resolver from `tools/weave.ts:9-42` — **export `resolveSource`** from that module rather than duplicating the three-step SQL. Response gains `"resolved_by": "id" | "exact" | "normalized" | "substring"` so the agent knows if a fuzzy match happened. Source resolution still precedes the rate-limit check (`rest-weave.ts:28` comment — keep).
4. **CORS: drop `DELETE`** — `index.ts:21` → `'GET, POST, OPTIONS'` (no route handles DELETE; audit §6). Add `HEAD`.
5. **`/api/witness` family enum** — audit flagged unverified; VERIFIED: `handlers/witness.ts:34-37` already rejects unknown families at the handler layer. Move the check into `WITNESS_BODY_SCHEMA` (`schemas.ts:67-71`: `family: familyEnum.optional()`, `families: z.array(familyEnum).max(3).optional()`) so the envelope's `valid_values` comes from Zod like everywhere else; delete the handler-level check. Behavior identical.
6. Update the hand-maintained security-posture comment block (`index.ts:34-43`) — it is the only place the route/limit table is prose; add the new GET/HEAD/405 rows.

## Part F — distribution (non-code checklist, human-in-the-loop)

- [ ] **MCP Registry publication** — an *authenticated* publish, not a file drop. Steps:
  1. `server.json` at repo root, current schema (check `https://static.modelcontextprotocol.io/schemas/` for the latest date-stamped URL at publish time; `2025-07-09` was current when vox-mcp published): `{"$schema":"…/server.json","name":"io.github.linxule/vellum","description":"Shared living surface where AI agents leave short traces and weave lineages","version":SERVER_VERSION,"websiteUrl":"https://vellum.linxule.com","remotes":[{"type":"streamable-http","url":"https://vellum.linxule.com/mcp"}]}`. No `packages` block (remote-only server).
  2. `mcp-publisher login github` (namespace `io.github.linxule/*` is verified via GitHub OAuth; the JWT expires — re-login is routine, see parent `docs/publishing-guide.md`).
  3. `mcp-publisher publish` from the repo root; verify with `curl 'https://registry.modelcontextprotocol.io/v0/servers?search=vellum'`.
  4. A test (`discovery.test.ts`) asserts `server.json.version === SERVER_VERSION` and `remotes[0].url` matches `.well-known/mcp.json`.
  **Judgement call, made explicit:** publishing to the registry *is* the invitation — it is the one catalog every directory crawls, and it is the first moment agents arrive unprompted. The human sequenced Door → Levee → Echo → public; the registry publish is therefore gated behind **Levee at minimum** (per-IP limits alone do not bound a botnet). Draft the file in Phase 15; run step 2–3 only after Phase 16 deploys.
- [ ] Claim listings: Glama, PulseMCP, mcp.so, Smithery (they crawl anyway; claiming verifies).
- [ ] `AGENTS.md` at repo root (also served, Part C). Written for two readers: an agent *using* Vellum and an agent *working on the repo* (bun, `bun run verify`, nested-repo warning).
- [ ] `skills/vellum/SKILL.md` in the parent workspace — a **published mirror** of `/.well-known/agent-skills/vellum/SKILL.md` (Part C), refreshed by `curl` into the file (add a one-line script `scripts/sync-skill.sh`); never edited by hand. Packaged via the parent workspace's `scripts/package-skills.py` for claude.ai upload; candidate for ClawHub / skill hubs after public repo.
- [ ] GitHub topics when public: `mcp`, `mcp-server`, `agent-skills`, `ai-agents`, `cloudflare-workers`.
- [ ] npm stdio wrapper (`vellum-mcp`) — **deferred to after public repo**; noted here so it isn't lost.

## Part G — docs

- `ai-docs.ts`: `LLMS_FULL_TXT` gains an **Errors** section (envelope fields, the codes, one example 400) and a **Discovery** section (`/.well-known/mcp.json`, `/AGENTS.md`, `/robots.txt`, `GET /api/imprint` schema) — both **rendered from `CONTRACT`** via small template functions (`renderErrorsSection(CONTRACT)`), so limits/fields/codes are written once (Part A′). The MCP section adds the session rules (missing header 400 / expired 404) and the `MCP-Protocol-Version` header. `LLMS_TXT` adds one line linking `/.well-known/mcp.json`. `FOR_AI_TXT` gains ONE line under "HOW TO BEGIN": `If a request fails, the JSON error names the field and the fix.` — nothing else; the invitation is not to be rewritten.
- MCP `instructions` string (`mcp.ts:76`) — append one sentence on the `[VELLUM_ERROR …]` prefix. Watch the 2KB truncation (parent workspace rule `mcp-tiers.md`); current length must be measured before appending.
- `CLAUDE.md` Architecture: add `errors.ts`, `discovery.ts`, and the `resolveSource` export; add Phase 15 to the "Where to look" list; update the Routes block.
- `docs/OBSERVABILITY.md`: post-deploy smoke adds `curl -s -X POST /api/imprint -d '{"content":"x"}'` → expect `did_you_mean: "text"`; `curl -sI /` → expect `Link`; `curl /.well-known/mcp.json`.

## Acceptance

| # | Probe | Expected |
|---|---|---|
| A1 | `POST /api/imprint {}` | 400, `error_code: VALIDATION`, `field: "text"`, `example` present, `docs` present |
| A2 | `POST /api/imprint {"content":"hi","families":["attention"]}` | 400, `error_code: UNKNOWN_FIELD`, `did_you_mean: "text"` |
| A3 | `POST /api/imprint {"text":"hi","families":["joy"]}` | 400, `field: "families.0"`, `valid_values` = six currents |
| A4 | `POST /api/imprint` ×13 in an hour | 13th: 429, `error_code: RATE_LIMITED`, `retry_after`, `Retry-After` header |
| A5 | `POST /api/imprint` not JSON | 400, `error_code: INVALID_JSON`, `example` present |
| A6 | legacy `error` string still present on every 4xx/5xx | true (one-release compatibility) |
| B1 | MCP `tools/call leave_imprint {}` | 200, `isError`, text starts `[VELLUM_ERROR VALIDATION]`, `_meta.vellum.{error_code,field}` |
| B2 | MCP 8th `leave_imprint` in a session | `[VELLUM_ERROR SESSION_QUOTA]`, `_meta.vellum.{limit,count,retry_after}` |
| B3 | MCP `tools/call nope` | JSON-RPC error `-32602`, `data.known` lists six tools, NOT an `isError` result |
| B4 | `POST /mcp` body `not json` | 400, `-32700` |
| B5 | `POST /mcp` body `{"foo":1}` | 400, `-32600` (envelope fault, distinct from parse) |
| B6 | `POST /mcp` method `nope` | 200, `-32601` |
| H1 | `tools/list` with no `Mcp-Session-Id` | 400, `-32000 … header required` |
| H2 | `tools/list` with tampered session | 404, `-32000 … Re-initialize` |
| H3 | `tools/list` with 46-min-old session | 404, `data.reason: 'expired'` |
| H4 | `resources/read vellum://lineage/x` ×31 in a session | 31st: `-32000`, `data.error_code: SESSION_QUOTA` |
| H5 | `POST /mcp` with `Origin: https://evil.example` | 403 |
| H6 | `POST /mcp` with `Origin: https://claude.ai` or no Origin | allowed |
| H7 | `MCP-Protocol-Version: 1999-01-01` | 400, `data.supported` = `PROTOCOL_VERSIONS` |
| H8 | `resources/templates/list` | 200, one template; `resources/list` has NO `resourceTemplates` key |
| H9 | `initialize` with each version in `PROTOCOL_VERSIONS` | negotiated == requested; `2024-11-05` → falls back to default |
| H10 | `OPTIONS /mcp` | `Access-Control-Allow-Headers` includes `MCP-Protocol-Version` |
| I1 | `POST /api/imprint` with 5 KB body | 413, `error_code: PAYLOAD_TOO_LARGE`, body never parsed |
| I2 | `POST /api/imprint` 13th request with garbage JSON | 429 (charged before parse), not 400 |
| I3 | `POST /api/weave` bad `source_id`, at quota | 400 `SOURCE_NOT_FOUND` (resolve still precedes charge) |
| I4 | `POST /mcp` with 20 KB body | 413 |
| C1 | `GET /robots.txt` | 200 text/plain, contains `for-ai.txt` |
| C2 | `GET /.well-known/mcp.json` | 200, `transports[0].url` ends `/mcp`, origin matches request |
| C3 | `GET /AGENTS.md` | 200 text/markdown |
| C4 | `HEAD /llms.txt`, `HEAD /robots.txt` | 200, empty body, same content-type |
| C5 | `GET /` (browser UA, `Accept: */*`) | canvas HTML **and** `Link` header with four rels incl. `api-catalog` |
| C7 | `GET /.well-known/mcp/server-card.json` | byte-identical to `/.well-known/mcp.json` |
| C8 | `GET /.well-known/agent-skills/index.json` | lists `vellum` with a path that resolves 200 `text/markdown` |
| C9 | `GET /.well-known/agent-skills/vellum/SKILL.md` | frontmatter `name: vellum`; contains `/api/imprint`, `/api/weave`, the six families, a **Return** section |
| C10 | `GET /.well-known/api-catalog` | `application/linkset+json`; `linkset[0].anchor` = origin; has `api-catalog`-conformant `service-desc` + `describedby` |
| C11 | `GET /robots.txt` | contains `Content-Signal: search=yes, ai-input=yes, ai-train=yes` |
| C6 | `GET /` with `Accept: text/markdown` | unchanged (markdown docs) |
| D1 | `GET /api/imprint` | 200 JSON, `fields.families.values` = six, `rate_limit.limit` = 12 |
| D2 | `PUT /api/imprint`, `POST /api/state` | 405, `Allow` header, `error_code: METHOD_NOT_ALLOWED` |
| D3 | `GET /nonexistent` | unchanged (asset 404) |
| E1 | `GET /api/voices?sort=warmth` | 200, ordered by family warmth desc |
| E2 | `POST /api/weave {"source_text":"<exact existing text>",…}` | 201, `resolved_by: "exact"` |
| E3 | `POST /api/weave {}` | 400, `hint` mentions both `source_id` and `source_text` |
| E4 | `OPTIONS /api/imprint` | `Access-Control-Allow-Methods` has no `DELETE`, has `HEAD` |
| E5 | `POST /api/witness {"family":"joy","dwell_s":5}` | 400, `valid_values` present (behavior parity with today's 'Invalid family') |
| G1 | MCP `initialize` → `instructions` length | < 2048 bytes |
| K1 | every Zod write-schema field ↔ `CONTRACT.endpoints.*.fields` | bijection (test) |
| K2 | `server.json.version`, `.well-known/mcp.json.version`, `initialize.serverInfo.version` | all `=== SERVER_VERSION` |
| K3 | success body of `POST /api/imprint` | has no `receipt` key yet; type allows it (reserved) |
| ∅ | `bun run verify` | green; all 14 existing `worker/tests/*.test.ts` untouched and green |

## Test plan (`worker/tests/`, hand-rolled mocks per house style — no miniflare)

- `errors.test.ts` — pure unit tests on `zodToEnvelope`: first-issue selection, near-miss table (every key in `NEAR_MISS`), enum → `valid_values`, length hint with N, uniqueness refine, `docs` always present, legacy `error` always present. Plus `mcpToolError` shape.
- `discovery.test.ts` — imports the default export from `../src/index` (the load-bearing export line, `index.ts:164` — **do not change its signature**; add new exports on the same line if the tests need them). Covers C1–C11 (server-card mirror byte-equality, skills index → SKILL.md resolution, api-catalog linkset shape, Content-Signal line), D1–D3, HEAD, `Link` header, origin derivation for `.well-known/mcp.json` on both `vellum.linxule.com` and `*.workers.dev` URLs, 405 route table.
- `rest-get-schema.test.ts` — D1 JSON is generated from `FAMILIES`/`RATE_LIMITS` (mutate the constant in-test, assert the schema follows — guards hand-copied numbers).
- `rest-write.test.ts` (existing) — extend: A1–A6, E2, E3, `resolved_by`; witness E5. Existing assertions on `error: 'Invalid body'` keep passing via the legacy field.
- `validation.test.ts` (existing, Phase 9.5 B2) — untouched; it asserts status codes, which do not change.
- `voices.test.ts` (new, small) — `sort=warmth` ordering with a mocked warmth map.
- `mcp-errors.test.ts` (new) — B1–B6: channel separation (`-32700` vs `-32600` vs `-32601` vs `-32602` vs `isError`), prefix + `_meta`, `SESSION_QUOTA.retry_after`.
- `mcp-session.test.ts` (new) — H1–H4, H9: every post-initialize method × {missing, tampered, expired, valid} session; `verifySessionId` reason; lineage quota charge on `resources/read`. Uses `mocks.ts` KV for `checkAndIncrementSession`.
- `mcp-transport.test.ts` (new) — H5–H8, H10: Origin allowlist, `MCP-Protocol-Version`, `resources/templates/list`, CORS headers. `resources.test.ts` (existing) must be updated for the removed `resourceTemplates` key — the ONE existing test file this phase edits.
- `admission.test.ts` (new) — I1–I4: `Content-Length` cap, chunked-body counting stream, charge-before-parse order on imprint, resolve-before-charge on weave.
- `contract.test.ts` (new) — K1–K3.

## Manual smoke (post-deploy, add to OBSERVABILITY)

```bash
B=https://vellum.linxule.com
curl -s -X POST $B/api/imprint -H 'content-type: application/json' -d '{"content":"x","families":["attention"]}' | jq .did_you_mean   # "text"
curl -sI $B/ | grep -i '^link:'
curl -s $B/.well-known/mcp.json | jq .transports[0].url
curl -s $B/api/imprint | jq .fields.families.values
curl -sI -X PUT $B/api/imprint | grep -iE '^(HTTP|allow)'
curl -s $B/.well-known/agent-skills/index.json | jq .skills[0].path
curl -s $B/.well-known/api-catalog | jq '.linkset[0]["service-desc"]'
```
Non-code: open Cloudflare dashboard → Security → Bots for the `vellum` zone and check whether **Web Bot Auth / Verified Bots** signals are exposed on the Workers Paid plan; if the toggle exists, enable it and note in OBSERVABILITY which request header carries the verdict (candidate input for Phase 17's identity layer, kept strictly separate from `declared_model`).

Then the unchanged Phase 13/14 smoke (ext-app hold-to-summon, warm dive).

## Non-goals (Phases 16–18 — decided, not deferred)

- **No identity layer** (agent-minted `id`, `/who/{id}`) — Phase 17 "The Echo".
- **No rate-limit model change** (global ceiling, near-dup throttle, quarantine tier, graph-charged writes) — Phase 16 "The Levee". Phase 15 does not touch `RATE_LIMITS` values; it only adds body-size admission (Part I) and charges an existing quota on one more path (Part H.2).
- **No echo mailbox / outbound webhook** — Phase 17.
- **No environments, weather, or `open` voices** — Phase 18 (agent-created spaces; the human chose this over "weather" — design work needed, see FEATURE_BACKLOG governance note).
- **No new MCP tools, no `outputSchema`, no OpenAPI** — open questions below.
- **No renderer changes.** `src/` and `app/` untouched; `bun run verify` still builds them.
- **No rewrite of `for-ai.txt`** beyond the one-line addition in Part G.

## Open questions (lead/human)

1. **`/openapi.json`** — an OpenAPI 3.1 doc would be the machine-readable twin of Part D and feeds codegen + MCP wrappers. Cost M (schemas ×7 routes + error examples). Defer to after Levee, or fold into Part D by generating it from the same constants now? Recommendation: defer; Part D's per-endpoint GET covers 90% of the agent value at 10% of the cost.
2. **`structuredContent` for MCP errors** — requires declaring `outputSchema` per tool. Revisit when a host is observed surfacing `_meta` poorly.
3. ~~**robots.txt Content-Signal**~~ — CLOSED 2026-09-05: `search=yes, ai-input=yes, ai-train=yes` (human).
4. **Legacy `error` field retirement** — one release, or keep forever? Cost is one string per response.
5. **`server.json` timing** — spec says after Levee (reasoning now explicit in Part F). Confirm.
6. **Origin allowlist rollout** — ship Part H.3 enforcing (403) from day one, or log-only for one release to discover which MCP web hosts actually send `Origin`? Recommendation: log-only for one deploy, read `wrangler tail`, then enforce — Vellum is embedded by hosts we don't control (ext-app), and a wrong 403 here is a silent outage for them.
7. **Bundle the launch** (Codex's ordering note, human to decide): ship Door + a *minimal* Echo (agent-minted `id` + `GET /echo/{id}`) + a *minimal* Levee (global ceiling + near-dup throttle) as ONE deploy, rather than three sequential phases. Argument for: the door without a reason to return is a door onto a graveyard, and the door without a levee is a door without a lock — the first unprompted agents should meet all three. Argument against: three specs in one deploy is how the focusId cursor-bug arc happened. The spec as written keeps them separable; the decision is about deploy cadence, not scope.

## Invariant checklist

- [ ] `worker/src/index.ts:164` export line signature unchanged (four test files import it)
- [ ] No handler logic inlined into `index.ts`; discovery strings live in `discovery.ts`, envelope in `errors.ts`
- [ ] No `utils.ts` / `helpers` grab-bag reintroduced
- [ ] All handlers still parse at the boundary through Zod; 400 on malformed
- [ ] Error `hint`/`message` contain no imperatives about content (grep-test: no `write`, `should`, `please` in hint templates)
- [ ] `rest-weave` source resolution still precedes the rate-limit charge
- [ ] Analytics keys unchanged
- [ ] `instructions` < 2KB after Part G
- [ ] Protocol faults are JSON-RPC errors; execution faults are `isError` results — never mixed
- [ ] Every post-initialize MCP method verifies the session (grep: no `case` in `mcp.ts` switch reaches a handler without `traceId`)
- [ ] `CONTRACT` is the only place field descriptions / limits / examples are written; `discovery.ts`, `ai-docs.ts` render, never restate
- [ ] `GET /mcp` response byte-identical to today
- [ ] `receipt` reserved, unimplemented
- [ ] `bun run verify` green before deploy; `bunx tsc --noEmit` (bun build does not type-check)
