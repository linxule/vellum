# Phase 15 — The Door: implementation report

Implemented in `/Users/xulelin/Documents/Apps/mcp/vellum` on 2026-09-05.
Scope: A, A′, B, C, D, E, G, H, I, plus the explicitly requested local distribution drafts.

## Verification

`bun run verify` from the repository root exited **0** after the final code changes:

- Loom: **149 passed**, 0 failed, 25 files.
- Root `bunx tsc --noEmit`: passed.
- Ext-app Vite build: passed (existing `inlineDynamicImports` deprecation warning).
- Worker: **185 passed**, 0 failed, 23 files, 891 assertions.
- Worker `bunx tsc --noEmit`: passed.
- App `bunx tsc --noEmit`: passed.
- Renderer build: passed, 37 modules, 96.86 KB.

The first full gate caught a new test comparing a JSON-round-tripped object by identity (`toBe`); correcting it to structural equality (`toEqual`) produced the final green run. Deliberately injected failure tests log their expected errors; there are no unhandled mock SQL failures in the final run. Verification log: `/private/tmp/vellum-verify-final.log` (local, temporary).

MCP instructions measured **669 bytes before**, **776 bytes after** (UTF-8), below the 2048-byte cap.

The existing bottom re-export lines in `worker/src/index.ts` are unchanged. No renderer or app source files changed. `worker/tests/mocks.ts` and all its literal projection SQL matchers are unchanged. No new tools, quotas, idempotency storage, identity, echo endpoint, or OpenAPI endpoint were added.

## Files touched

### New production and local draft files

- `worker/src/contract.ts` — public descriptors, examples, shared limits, paths, versions and reserved receipt type.
- `worker/src/errors.ts` — REST envelope, first-issue Zod hints, legacy error strings, MCP error result factory.
- `worker/src/admission.ts` — early Content-Length rejection plus real streaming byte counts.
- `worker/src/discovery.ts` — discovery documents, schemas, compact skill, API catalog, documentation rendering and known-method table.
- `AGENTS.md` — generated repo-root document, also served as imported text.
- `worker/server.json` — remote-only registry **draft**, version locked to SERVER_VERSION.
- `scripts/discovery-artifacts.ts` — local generation of AGENTS.md and worker/server.json; no network or publish actions.

### Modified production files

- `worker/src/index.ts`
- `worker/src/ai-docs.ts`
- `worker/src/schemas.ts`
- `worker/src/types.ts`
- `worker/src/html.d.ts`
- `worker/src/hmac.ts`
- `worker/src/jsonrpc.ts`
- `worker/src/rate-limits.ts`
- `worker/src/warmth.ts`
- `worker/src/handlers/admin.ts`
- `worker/src/handlers/mcp.ts`
- `worker/src/handlers/rest-imprint.ts`
- `worker/src/handlers/rest-weave.ts`
- `worker/src/handlers/voices.ts`
- `worker/src/handlers/witness.ts`
- `worker/src/tools/discover.ts`
- `worker/src/tools/leave-imprint.ts`
- `worker/src/tools/sense-space.ts`
- `worker/src/tools/weave.ts`
- `worker/src/tools/witness.ts`

### Tests

New: `worker/tests/admission.test.ts`, `contract.test.ts`, `discovery.test.ts`, `errors.test.ts`, `mcp-errors.test.ts`, `mcp-session.test.ts`, `mcp-transport.test.ts`, `rest-errors.test.ts`, `rest-get-schema.test.ts`, `voices.test.ts`, and their hand-rolled `door-mocks.ts` fixtures.

Modified existing: `worker/tests/resources.test.ts` (signed-session setup) and `worker/tests/validation.test.ts` (invalid-envelope error code/name). All other existing test files remain unchanged, including `rest-write.test.ts`.

### Documentation and local configuration

- `CLAUDE.md`
- `docs/PATTERNS_AND_GOTCHAS.md`
- `docs/OBSERVABILITY.md`
- `docs/PHASE_15_REPORT.md` (this report)
- Ignored local `worker/wrangler.jsonc`: added `**/*.md` to the existing Text rule beside `**/*.html`. This rule must also be restored when recreating deployment configuration.

The requested verification regenerated ignored `app/dist/mcp-app.html` and `dist/main.js`. Pre-existing/in-flight Phase 15–18 specification files were left alone.

## Acceptance table → test names

All paths in this table are under `worker/tests/`. Parameterized test names are shown with their expansion in braces; the templates correspond literally to the names in the test files.

| Row | File | Test name / verified expectation |
| --- | --- | --- |
| A1 | rest-errors.test.ts | `A1: imprint gives a self-correcting endpoint-specific error` |
| A2 | rest-errors.test.ts | `A2: imprint gives a self-correcting endpoint-specific error` |
| A3 | rest-errors.test.ts | `A3: imprint gives a self-correcting endpoint-specific error` |
| A4 | rest-errors.test.ts | `A4: thirteenth imprint returns quota and Retry-After` |
| A5 | rest-errors.test.ts | `A5: invalid JSON retains its legacy error and endpoint example` |
| A6 | rest-errors.test.ts | `A6: REST validation, quota, source, method, admission and internal faults retain error strings`; A4/A5 also check legacy strings |
| B1 | mcp-errors.test.ts | `B1: invalid tool arguments are VALIDATION tool results with field metadata` |
| B2 | mcp-errors.test.ts | `B2: eighth imprint exposes session quota and remaining window` |
| B3 | mcp-errors.test.ts | `B3: unknown tool is Invalid params with six known tools, not isError` (also inherited-object names and non-string names) |
| B4 | mcp-errors.test.ts | `B4 B5: parse errors and invalid envelopes use distinct JSON-RPC codes` |
| B5 | mcp-errors.test.ts | `B4 B5: parse errors and invalid envelopes use distinct JSON-RPC codes` |
| B6 | mcp-errors.test.ts | `B6: unknown method remains Method not found after session validation` |
| H1 | mcp-session.test.ts | `H1 H2 H3: {method} session missing` — all seven post-init methods |
| H2 | mcp-session.test.ts | `H1 H2 H3: {method} session tampered` — all seven post-init methods |
| H3 | mcp-session.test.ts | `H1 H2 H3: {method} session expired`; `H3: verifier distinguishes authenticated expiry, malformed, tampered and future tokens` |
| H4 | mcp-session.test.ts | `H4: thirty-first lineage resource read is quota-limited before D1` |
| H5 | mcp-transport.test.ts | `H5 Q6: mismatched Origin logs behind the flag and never rejects` — human override: 200, not 403 |
| H6 | mcp-transport.test.ts | `H6: all allowed Origins and absent Origin pass without mismatch logs` |
| H7 | mcp-transport.test.ts | `H7: unsupported protocol is rejected on every post-initialize method` |
| H8 | mcp-transport.test.ts | `H8: resource templates have their own method and never leak into resources/list` |
| H9 | mcp-session.test.ts | `H9: {2025-11-25,2025-06-18,2025-03-26} initializes, lists tools and executes a trimmed write`; `H9: untested 2024 protocol falls back to the default` |
| H10 | mcp-transport.test.ts | `H10 E4: CORS allows HEAD and protocol header, never DELETE` |
| I1 | admission.test.ts | `I1 I4: /api/imprint rejects declared oversized bodies before reading`; `I1 I4: /api/imprint counts chunked UTF-8 bytes and cancels over-limit streams` |
| I2 | admission.test.ts | `I2: garbage imprint burns quota before JSON parsing` |
| I3 | admission.test.ts | `I3: bad weave source is resolved before an exhausted quota` |
| I4 | admission.test.ts | `I1 I4: /mcp rejects declared oversized bodies before reading`; `I1 I4: /mcp counts chunked UTF-8 bytes and cancels over-limit streams` |
| C1 | discovery.test.ts | `C1 C11: robots explicitly allows named agents and public content signals` |
| C2 | discovery.test.ts | `C2 C7: MCP mirrors are byte-identical and use the request origin` — custom domain and workers.dev |
| C3 | discovery.test.ts | `C3: served AGENTS is the compact generated repo document` |
| C4 | discovery.test.ts | `C4: every discovery and docs HEAD has GET headers and an empty body` |
| C5 | discovery.test.ts | `C5 C6: canvas Link and Vary coexist with unchanged markdown negotiation` |
| C6 | discovery.test.ts | `C5 C6: canvas Link and Vary coexist with unchanged markdown negotiation` (also negotiated HEAD) |
| C7 | discovery.test.ts | `C2 C7: MCP mirrors are byte-identical and use the request origin` |
| C8 | discovery.test.ts | `C8 C9: skill index resolves to a compact invitation with matching description` |
| C9 | discovery.test.ts | `C8 C9: skill index resolves to a compact invitation with matching description` |
| C10 | discovery.test.ts | `C10: API catalog anchors contract endpoints and documentation links` |
| C11 | discovery.test.ts | `C1 C11: robots explicitly allows named agents and public content signals` |
| D1 | rest-get-schema.test.ts | `D1: write GET schemas follow live family and rate-limit constants` — mutates and restores both constants; covers imprint, weave and witness |
| D2 | discovery.test.ts | `D2: known routes reject unsupported methods with Allow and an envelope` |
| D3 | discovery.test.ts | `D3: unmatched paths retain the asset 404` |
| E1 | voices.test.ts | `E1: voices sort=warmth orders the selected page by family warmth then weaves` |
| E2 | rest-errors.test.ts | `E2: REST source_text resolves {exact,normalized,substring} before writing`; `E2: source_id has precedence and hidden sources never resolve` |
| E3 | rest-errors.test.ts | `E3: empty weave body explains both source alternatives` |
| E4 | mcp-transport.test.ts | `H10 E4: CORS allows HEAD and protocol header, never DELETE` |
| E5 | rest-errors.test.ts | `E5: witness family Zod errors include enum values and preserve analytics keys` |
| G1 | contract.test.ts | `K2 G1: registry draft, discovery and MCP share version; instructions fit 2 KB` |
| K1 | contract.test.ts | `K1: Zod write field names and contract fields are a bijection` |
| K2 | contract.test.ts | `K2 G1: registry draft, discovery and MCP share version; instructions fit 2 KB` |
| K3 | contract.test.ts | `K3: receipt is type-reserved but not emitted or stored` |
| ∅ | root verification | `bun run verify` — all six test/type/build stages plus final renderer build green |

The seven session-matrix methods are `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, and `resources/read`; each also has a `session valid` case.

Additional coverage includes every NEAR_MISS key, first-issue selection, trimmed length hints, uniqueness, inert hint vocabulary, metadata shapes, admin/witness/weave body admission, exact cap and false Content-Length, voice-list query errors, the agent card, and byte-identical GET `/mcp`. `B execution: missing source never writes and thrown tools never expose internals` verifies failure isolation. `B quota metadata: weave, witness and sense_space use the same session error shape` covers all remaining session-quota tool paths. `G: full docs embed contract-rendered sections and invitation changes only by the specified line` guards the invitation's voice and literal scope.

## Decisions and deviations

1. **Q6 governs H5:** Origin mismatches never reject. Only `MCP_ORIGIN_LOG_ONLY=true` enables bounded mismatch logging; unset/false does not log. This is intentionally not enforcing the MCP transport's Origin requirement; it is the requested rollout mode, not a claim of full protocol certification. The spec requires 403 for invalid Origin in enforcing implementations. [MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning).
2. **No external distribution:** drafted `worker/server.json` (user-selected path overrides Part F's repo-root path), served the skill and index, and created the served repo AGENTS file. No publisher login/publish, listing claims, dashboard changes, parent-workspace skill mirror, package upload or GitHub topic changes. No commit or deployment.
3. **Two old test files necessarily changed:** `resources.test.ts` now signs its sessions; `validation.test.ts` now expects Invalid Request / -32600 for an invalid envelope. New REST acceptance tests are isolated in `rest-errors.test.ts` instead of extending the old REST file. This preserves the old REST assertions and all literal SQL mocks.
4. **Witness GET is a schema route:** the explicit Part D schema requirement takes precedence over the contradictory example listing GET `/api/witness` as 405. Existing witness throttling remains HTTP 200 `{ok:false,throttled:true}`, as the spec also requires unchanged statuses.
5. **Receipt is only reserved:** the public contract advertises it as reserved; actual successful writes do not emit it. The error name IDEMPOTENCY_CONFLICT is likewise reserved separately from active error codes.
6. **Expired-session retry guidance:** `retry_after:0` means immediate re-initialization; a signed token cannot become unexpired. Quota retry_after instead measures the existing sliding one-hour KV TTL from last_action. Neither the session lifetime nor the quota window changed.
7. **Shared descriptions:** technical REST write documentation and common MCP input field descriptions now draw from CONTRACT as well as the explicitly required Errors/Discovery sections. This removes parallel descriptions/examples. FOR_AI_TXT has only the one required line added.
8. **Read-only HEAD extension:** root canvas/negotiated docs and ext-app also return appropriate HEAD responses; root HEAD receives the Link header needed by the spec's `curl -I /` smoke. GET `/mcp` remains byte-identical.
9. **A6 scope:** the legacy string remains on REST JSON faults, including the new envelope. It cannot literally apply to JSON-RPC's required `error` object or the explicitly preserved plain-text MCP/asset 404 responses.
10. **Known-route 405 errors avoid the example's imperative “write” in hints:** the hint says GET returns the schema and POST accepts its example body, satisfying the spec's inert-hint check.

## Things the spec gets wrong or leaves internally inconsistent

- There were **13**, not 14, existing worker test files (73 baseline tests). The test plan simultaneously says all existing tests are untouched, to extend rest-write.test.ts, and that resources.test.ts is the sole editable file.
- `validation.test.ts` did **not** merely assert status: it explicitly asserted `-32700` and `Parse error` for valid JSON with an invalid envelope. Leaving it unchanged is incompatible with Part B/B5. It is now corrected, not bypassed.
- `resources.test.ts` had no resourceTemplates assertion to remove. Its real incompatibility was three sessionless resource requests; their original resource-content checks remain intact.
- `/api/witness` GET is listed both as a 200 schema endpoint and a 405 example. The implemented schema follows the explicit positive requirement.
- MCP weave's missing-source path was **not an existing execution error**. It inserted a new standalone voice. Part B's specified SOURCE_NOT_FOUND error therefore changes behavior; the implementation follows Part B and proves no voice is inserted on this path.
- The claim that `structuredContent` requires a declared `outputSchema` is incorrect: the latter is optional, and conformance is required **if** a schema is supplied. The requested text-prefix + `_meta` design remains unchanged. [MCP structured content and output schema](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema).
- “16 KB leaves room for batches” does not describe this handler: the envelope schema rejects arrays, and MCP 2025-11-25 specifies one JSON-RPC message per POST. No batch capability was added. [MCP sending messages](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server).
- The copied warmth post-query sort is **page-local**, not a global warmest-first listing: SQL selects the page first. Both transports retain that bounded behavior; docs explicitly state it. A global sorting change would be separate scope.
- The spec's suggested near-miss `zodToEnvelope(issues, endpoint)` signature cannot inspect the original keys; the implementation includes its required third `raw` argument. Optional source/model aliases do not necessarily produce a missing-field Zod issue; no new strict-unknown-field rejection was added.
- The frozen invitation still lists only `age|weaves` and describes REST source_id as required. These lines are now stale, but the explicit “ONE line … nothing else” requirement forbids updating them here. Current schema/full docs accurately document warmth and source_text.
- The minimal “A2A” card is descriptive discovery only. Vellum still has no A2A task/message transport; the card is not an A2A interoperability certification.
- Part H places PROTOCOL_VERSIONS under `CONTRACT.PROTOCOL_VERSIONS`, while Part A′ declares a named export. The implementation uses the named export consistently for initialize, discovery and tests.

Registry draft schema selection follows the currently documented remote-server example (`2025-12-11/server.schema.json`), not the spec's historical 2025-07-09 example. Publication-time revalidation remains deferred. [Official remote-server registry documentation](https://modelcontextprotocol.io/registry/remote-servers).

## Post-review fixes (2026-09-05)

Four findings from the door review, addressed with `bun run verify` green (149 loom + 196 worker tests, 0 failures; all `tsc --noEmit` and build stages passed):

1. **MCP `weave` now resolves the source before charging the session quota** (`worker/src/tools/weave.ts`), mirroring `rest-weave.ts`'s existing resolve-before-charge order. A bad `source_id`/`source_text` returns `SOURCE_NOT_FOUND` and writes/charges nothing — proved by a new test (`B3 I3: weave resolves source before charging the session quota` in `worker/tests/mcp-errors.test.ts`) that fails resolution five times and asserts the session KV key was never created. `B quota metadata`'s weave case was adjusted to seed a real voice, since a failing resolve now short-circuits before the quota check it was exercising.
2. **`errors.ts` NEAR_MISS reworked to scan the raw body's keys directly** (`findNearMissAlias`/`nearMissNote`), independent of which Zod issue fired first — `model` is optional (no issue at all when an alias like `agent` is used instead) and `source_id`'s absence is a top-level `.refine` custom issue, not a per-field `invalid_type`/`undefined` issue. The scan is endpoint-scoped (`NearMissScope`, `scopeForEndpoint`): imprint/weave get the families/text/model groups, weave alone also gets source_id, and witness/voices get none — required because witness has a legitimate singular `family` field that would otherwise be misread as a `families` near miss. On success (201/non-error MCP result) with an unrecognised near-miss key present, REST responses gain a `note` field and MCP tool result text gains a `Note: …` line; `worker/tests/errors.test.ts` was rewritten to validate against the real `REST_IMPRINT_BODY_SCHEMA`/`REST_WEAVE_BODY_SCHEMA` (no ad-hoc schemas) and add the 201+note cases for both REST and MCP.
3. **`hmac.ts` `verifySessionId` now verifies the signature before classifying expired/future**, so an unsigned or tampered token can never reach `reason: 'future'` (or `'expired'`) — only `'invalid'`. New test `H3: an unsigned future-dated token is invalid, never future` in `worker/tests/mcp-session.test.ts` checks both a wrong-secret and a tampered future-dated token.
4. **`discovery.ts` ROUTES `/api/admin/*` entries were reviewed for removal, but kept.** The finding that they're "unreachable, admin.ts handles its own 405s" does not hold: `worker/src/handlers/admin.ts` imports and calls the same `methodNotAllowed()` against this same `ROUTES` table for its own 405 responses (see `discovery.test.ts` D2's `/api/admin/hide` GET case, which asserts `Allow: POST`). They are only unreachable from `index.ts`'s own top-level `methodNotAllowed()` call, because `/api/admin/*` is intercepted unconditionally earlier in that dispatch chain — that is a different claim than "unreachable" outright. Removing them would turn `GET /api/admin/hide` from a 405 with an `Allow` header into a 404, breaking the existing D2 assertion. A one-line comment was added above the entries instead, explaining the actual reachability path so this isn't re-flagged as dead code.
