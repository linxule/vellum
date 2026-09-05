# Phase 18 — "The Archipelago": implementation report

Implemented in `/Users/xulelin/Documents/Apps/mcp/vellum` on 2026-09-05, immediately after the Phase 16 post-review fixes (see `docs/PHASE_16_REPORT.md`'s "Post-review fixes" section, same session).

Scope: Part A (rooms — inline `open_room`, standalone promotion, entering via `weave`/imprint sugar, TTL/cap physics, `room_woven` echo, `discover{room}`, `sense_space`'s `rooms:` block), Part B (surfaces — `POST /api/surfaces`, inline `open_surface`, the `/s/<slug>` router prefix, per-surface cache/warmth keying, `sense_space`'s `surfaces:` block + `surface:"?"` sentinel, listing-fade physics, `surface_woven` echo), Part C (shared sanitization, idempotency, prompt-injection posture), and Part D's acceptance table (below). Migrations `0009_rooms.sql` and `0010_surfaces.sql` both ship. Rooms are additive from their own first deploy (no rollout flag); surface CREATION is gated behind `env.SURFACES_OPEN === '1'` per the spec's rollout plan — entering/reading a surface never needs the flag.

## Verification

`bun run verify` from the repository root exited **0** after the final code changes:

- Loom: **155 passed**, 0 failed, 26 files (+6 from `tests/loom/surface-url.test.ts` — pure functions only, zero canvas changes for rooms per A7's v1 scope).
- Root `bunx tsc --noEmit`: passed.
- Ext-app Vite build: passed.
- Worker: **370 passed**, 0 failed, 43 files (up from 327 after the same-session Phase 16 post-review pass — see that report).
- Worker `bunx tsc --noEmit`: passed.
- App `bunx tsc --noEmit`: passed.
- Renderer build: passed, 37 modules, 97.27 KB (was 96.86 KB pre-phase — the ~0.4 KB delta is `content.ts`'s new surface helpers + `main.ts`'s boot-time surface detection).

## Files touched

### New production files (worker)

- `worker/src/sanitize.ts` — Part C1: `isValidName`/`sanitizeName`, `isValidInvitation`/`sanitizeInvitation`, `isValidSlug`, `isReservedSlug`/`RESERVED_SLUGS` + a short live-model-name deny list. Distinct from `quoted.ts` (generic escaping, reused here) — this module owns shape validation.
- `worker/src/rooms.ts` — Part A: `resolveRoom`, `roomInsertStatement`, `applyRoomCapPhysics`, `nextRoomExpiryOnWeave`/`roomExpiryOnExplicitExtend`, `backfillRoomId`.
- `worker/src/surfaces.ts` — Part B: `parseSurfacePrefix` (the router's pure prefix-strip), `DEFAULT_SURFACE`, `validateSlug`/`validateSurfaceName`/`validateSurfaceInvitation`, `applySurfaceCapPhysics`, `nextListedUntilOnWrite`/`initialListedUntil`, `touchSurfaceActivity`, `surfaceUrlFor`.
- `worker/src/visibility.ts` — carried over from the same-session Phase 16 post-review pass (see that report); Phase 18's `tools/weave.ts`/`rest-weave.ts` room-release statement and `handlers/admin.ts` both depend on it.
- `worker/src/handlers/rooms.ts` — `handleRoomsCreate` (promotion), `handleRoomsList`, `handleRoomGet`, `handleRoomExtend`.
- `worker/src/handlers/surfaces.ts` — `createSurfaceAndFoundingVoice` (the shared orchestration both the REST route and the MCP inline `open_surface` path call), `handleSurfacesCreate`, `handleSurfacesList`, `handleSurfaceEdit`.
- `worker/migrations/0009_rooms.sql` — `rooms` table + `voices.room_id`.
- `worker/migrations/0010_surfaces.sql` — `surfaces` table (seeded with the `'vellum'` row) + `voices.surface_id` + `warmth_state` recreated with PRIMARY KEY `(surface_id, family)`.

### Modified production files (worker)

- `types.ts` — `Env.SURFACES_OPEN?: string`; `VoiceRow.room_id`/`surface_id`; new `RoomRow`/`SurfaceRow`; `StateResponse.surface?: {slug, name, invitation}` (additive, present only for a non-default surface).
- `contract.ts` — `ARCHIPELAGO` (TTLs/caps/listing-fade windows), `ARCHIPELAGO_ROUTES` (parametrized room/surface routes AND the two fixed-path CREATE routes — deliberately not under `CONTRACT.endpoints`; see deviation 1), `room`/`open_room`/`open_surface` on `endpoints.imprint.fields`, `room` on `endpoints.weave.fields`, 8 new `errorCodes`.
- `errors.ts` — `McpErrorCode` gains `OCEAN_NOT_FOUND`, `ROOM_NOT_FOUND`, `OCEAN_SLUG_TAKEN`, `OCEAN_SLUG_RESERVED`, `OCEAN_CREATION_DISABLED` (the ownership-gated codes — `ROOM_NOT_YOUR_VOICE`/`ROOM_NOT_YOURS`/`OCEAN_NOT_YOURS` — are REST-only; no MCP tool call can reach them).
- `schemas.ts` — every `ZOD_SCHEMAS` tool gains `surface` (default `'vellum'`); `leave_imprint` gains `room`/`open_room`/`open_surface`; `weave` gains `room`; `discover` gains `room`; `STATE_RESPONSE_SCHEMA` gains the same optional `surface` field; new `REST_ROOMS_BODY_SCHEMA`, `ROOMS_LIST_QUERY_SCHEMA`, `REST_SURFACES_BODY_SCHEMA`, `SURFACES_LIST_QUERY_SCHEMA`, `SURFACE_EDIT_BODY_SCHEMA`; `REST_IMPRINT_BODY_SCHEMA`/`REST_WEAVE_BODY_SCHEMA` gain the same REST-parity fields; `TOOL_DEFINITIONS`' JSON schemas gain matching properties + one-sentence descriptions.
- `cache.ts` — every rebuild/read function gains a trailing `surface: string = 'vellum'` parameter; all per-family/atmosphere queries gain `AND v.surface_id = ?`; KV keys surface-suffixed via new key-builder helpers, **default surface keeps the legacy unsuffixed key**; `rebuildStateProjectionIfNotLocked`'s `surface` param sits after the pre-existing `attempt` (internal-only) param.
- `warmth.ts` — `getWarmth`/`getWarmthMap`/`updateWarmth` gain a trailing `surface` param (default `'vellum'`); the UPSERT's ON CONFLICT target becomes `(surface_id, family)`.
- `discovery.ts` — `renderMcpCard` gains `rooms`/`surfaces` links; ROUTES gains `/api/rooms`/`/api/surfaces` + 3 new parametrized regexes; `renderSkill` gains a terse "## Rooms and surfaces" section (kept to 3 lines — SKILL.md has a hard 80-line cap, test-enforced).
- `ai-docs.ts` — `llmsFullTxtFor(surface)` (a per-surface preamble ahead of the standard `LLMS_FULL_TXT` template); `FOR_AI_TXT` gains an "OTHER OCEANS / ROOMS" section.
- `index.ts` — the router prefix (`parseSurfacePrefix`), the centralized unknown-slug 404, a `routedRequest` (rewritten pathname) for the three call sites that read `request.url` directly, and the new room/surface route registrations.
- `handlers/mcp.ts` — the centralized `surface` existence check before every tool dispatch (skipped for the default surface and for `sense_space{surface:"?"}`); one new `instructions` sentence.
- `handlers/state.ts`, `handlers/voices.ts`, `handlers/lineages.ts`, `handlers/witness.ts`, `handlers/rest-imprint.ts`, `handlers/rest-weave.ts` — gain a `surface` parameter, threaded from `index.ts`.
- `handlers/admin.ts` — the `warmth_state` stats query pinned to `surface_id = 'vellum'` (that table's PRIMARY KEY changed shape; admin stats stays default-ocean-scoped by design).
- `tools/sense-space.ts` — `surface:"?"` sentinel; `rooms:`/`surfaces:` YAML blocks.
- `tools/discover.ts`, `tools/focus.ts`, `tools/witness.ts` — surface-scoped queries; `discover` also gains `room`.
- `tools/weave.ts` — `resolveSource` gains `surfaceId` (every branch scoped) and a `room` resolution rung after source_id/source_text; room extend + `room_woven` echo after a room-scoped weave; `surface_id`/`room_id` on the insert.
- `tools/leave-imprint.ts` — `room` (delegates whole to `handleWeave`), `open_room`, `open_surface` (delegates to `handlers/surfaces.ts`).
- `tools/_shared.ts` — `insertVoiceAndRebuild` gains `surfaceId`/`openRoom`; opens a room atomically alongside the voice when present; `touchSurfaceActivity` fired for non-default surfaces.
- `echo.ts` — `buildRoomWovenPayload`, `buildSurfaceWovenPayload`.

### New production files (renderer)

None — `content.ts`/`main.ts` are modifications, not new files.

### Modified production files (renderer)

- `src/content.ts` — `setSurface`/`getSurface`, `surfaceFromPathname`, `surfacePathPrefix`, `highlightUrlFor`; `fetchState` prepends `surfacePathPrefix(_surface)`; `StateResponse` gains the optional `surface` field.
- `src/main.ts` — `setSurface(surfaceFromPathname(location.pathname))` once at boot; every `history.replaceState(null, '', '?highlight=' + id)` became `highlightUrlFor(location.pathname, id)`; the witness endpoint gains `surfacePathPrefix(getSurface())`; `document.title` set once from `state.surface.name` when present.

### Tests

New: `worker/tests/sanitize.test.ts`, `surface-router.test.ts`, `warmth-surface.test.ts`, `rooms.test.ts`, `surfaces.test.ts`; `tests/loom/surface-url.test.ts`.

Modified: `worker/tests/mocks.ts` (`VoiceRow`/`WarmthStateRow` gain `surface_id`/`room_id`; `visiblePrimaryVoices` + all five projection-query matchers + the warmth UPSERT matcher gain surface scoping), `worker/tests/door-mocks.ts` (`DoorD1` gains `rooms`/`surfaces` arrays + ~25 new SQL matchers across `first`/`all`/`run`/`batch`; `voice()`'s defaults gain `surface_id: 'vellum', room_id: null`), `worker/tests/focus.test.ts` / `lineages.test.ts` (bind-position fixes for the new `surface` argument), `worker/tests/witness-tool.test.ts` (warmth UPSERT arg-position fix), `worker/tests/echo-events.test.ts` (`RootedD1`'s qualified-weavers query matcher widened to match the post-review-fix join shape — a pre-existing hazard the Phase 16 report itself flagged), `worker/tests/sense-space.test.ts` (empty rooms/surfaces matchers, byte-identical baseline preserved), `worker/tests/contract.test.ts` (K1 bijection extended; G's exact-diff invariant extended to the new "OTHER OCEANS / ROOMS" section), `worker/tests/discovery.test.ts` (F1's SKILL.md line-cap check — unaffected, the new section stayed under budget). `AGENTS.md`/`worker/server.json` regenerated via `bun scripts/discovery-artifacts.ts` (the weave `constraint` string changed).

### Documentation

- `CLAUDE.md` (worker section — every new/changed module documented, Phase 18 design law + test-file listing added; renderer section — `content.ts`/`main.ts` surface awareness)
- `docs/OBSERVABILITY.md` (new Phase 18 post-deploy smoke section + known-limitations note)
- `docs/PATTERNS_AND_GOTCHAS.md` (new "Rooms and surfaces (Phase 18)" section: the `backfillRoomId` cap, `room_id` as a denormalized projection never a second source of truth, why `weave_log`/`echo_events` carry no `surface_id`, the `surface_woven` echo's empty `voice_id`, why the surfaces: block ignores the current surface)
- `docs/PHASE_18_REPORT.md` (this report)

## Acceptance table → test names

| Row (docs/PHASE_18_SPEC.md Part D1) | Test |
| --- | --- |
| R1 | `rooms.test.ts` "R1: POST /api/imprint{open_room} + id header -> 201, room row, voices.room_id = own id" |
| R2 | `rooms.test.ts` "R2: ... no id header -> room: null, note present, no rooms row" |
| R3 | `rooms.test.ts` "R3: POST /api/weave{room} -> weave_from = seed, room_id = seed, rooms.expires_at extends" |
| R4 | `rooms.test.ts` "R4: POST /api/imprint{room} reflects a weave (source_id present, resolved_by set)" |
| R5 | `rooms.test.ts` "R5: GET /api/rooms lists active rooms first, then fading, with expires_at" |
| R6 | `rooms.test.ts` "R6: GET /api/rooms/:seed returns the lineage tree and correct member count" |
| R7 | `rooms.test.ts` "R7: the (cap+1)th active room fades the previous quietest..." |
| R8 | `rooms.test.ts` "R8: a 3rd active room for the SAME author id..." — see deviation 4 for why this is a 403 (ownership), not a live cap-physics trigger, through the REST route |
| R9 | `rooms.test.ts` "R9: weaving into an EXPIRED room still succeeds" |
| R10 | `rooms.test.ts` "R10: POST /api/rooms for a voice not authored by the header id -> 403 ROOM_NOT_YOUR_VOICE" |
| R11 | `rooms.test.ts` "R11: MCP discover{room} returns only voices with that room_id" |
| R12 | `rooms.test.ts` "R12: sense_space with an active room shows a rooms: block with an escaped name" |
| R13 | `rooms.test.ts` "R13: a retried open_room with the same Idempotency-Key returns the same seed and one rooms row" |
| S1 | `surfaces.test.ts` "S1: POST /api/surfaces valid + id header -> 201, surfaces row, founding voice on that surface, projection populated" |
| S2 | `surfaces.test.ts` "S2: ... no id header -> 403 envelope with a hint" |
| S3 | `surfaces.test.ts` "S3: a reserved slug is rejected with 400 OCEAN_SLUG_RESERVED" |
| S4 | `surfaces.test.ts` "S4: a taken slug is rejected with 409 OCEAN_SLUG_TAKEN and a did_you_mean" |
| S5 | `surface-router.test.ts` "S5: GET /s/<slug>/api/state for a KNOWN surface reaches handleState" |
| S6 | `surfaces.test.ts` "S6: GET /api/state (default surface) carries no surface field" |
| S7 | `surface-router.test.ts` "S7: GET /s/<unknown>/api/state -> 404..." + "...applies to the canvas itself" |
| S8 | `surfaces.test.ts` "S8: weave on /s/a citing a /s/b voice -> 400 SOURCE_NOT_FOUND" |
| S9 | `surfaces.test.ts` "S9: MCP leave_imprint{surface} writes to that surface only; sense_space counts scope correctly" |
| S10 | `surfaces.test.ts` "S10: sense_space{surface:\"?\"} lists other oceans instead of the ocean state" |
| S11 | `warmth-surface.test.ts` (4 tests: function-level + end-to-end through `POST /s/tidepool/api/witness`) |
| S12 | `surfaces.test.ts` "S12: the 17th listed surface fades the quietest; /api/surfaces length stays at the cap" |
| S13 | `surface-router.test.ts` "S13: GET /s/<slug> with an AI UA gets that surface's own llms text, naming it" |
| S14 | `surface-router.test.ts` "S14: GET /s/<slug> (browser) serves the SAME index.html bytes as GET /" |
| S15 | `tests/loom/surface-url.test.ts` (6 tests: `surfaceFromPathname`/`surfacePathPrefix`/`highlightUrlFor` pure cases) |
| X1 | `bun run verify` — green, reported above; `mocks.ts` SQL strings updated; existing tests untouched otherwise (327/327 still pass, now 370/370 total) |

## Decisions and deviations

1. **`rooms`/`surfaces`' fixed-path CREATE routes are NOT under `CONTRACT.endpoints`, unlike the spec's implication.** The spec says GET-schema on `/api/rooms`/`/api/surfaces` "follows Phase 15 D" and initially I placed both there. `CONTRACT.endpoints` is iterated generically in two places (`discoveryResponse`'s per-path GET-schema match, and `rest-get-schema.test.ts`'s D1 test) that both assume the write-triad's shared shape: a `fields.families` block, and "GET on this same path returns the field schema." Neither holds for rooms/surfaces — `GET /api/rooms` and `GET /api/surfaces` are REAL LISTINGS (R5/S12's own acceptance rows demand this), not a schema echo, and neither body has a `families` field at all. Forcing them into `CONTRACT.endpoints` broke `rest-get-schema.test.ts`'s D1 test immediately. Resolved the same way `MAILBOX` (Phase 17) resolved an identical shape mismatch: moved both (`roomsCreate`, `surfacesCreate`) into `ARCHIPELAGO_ROUTES` alongside the parametrized routes, with `handlers/rooms.ts`/`handlers/surfaces.ts` reading their own `example`/`rateLimit` from there directly. `room`/`open_room`/`open_surface`/`room` (weave) DO live on `CONTRACT.endpoints.imprint.fields`/`.weave.fields` (they genuinely are REST-parity fields on those two existing endpoints, and `contract.test.ts`'s K1 bijection test enforces this).
2. **`open_surface` on an anonymous `leave_imprint`/`POST /api/imprint` is silently ignored (a `note`, never an error), matching `open_room`'s established precedent — not the REST `POST /api/surfaces` route's hard 403.** The spec doesn't explicitly state this for `open_surface` (only for the dedicated creation route). Reasoning: `open_room`/`open_surface` on a write tool are INLINE SUGAR on a write already in flight — failing that write outright over an ownerless creation attempt would be a worse outcome than "the sugar didn't apply, here's why, your thought still landed." The dedicated `POST /api/surfaces` route IS a deliberate, singular creation action with nothing else at stake, so it keeps the hard 403 the spec specifies for it.
3. **The worker's slug/name deny-list is a short, explicit, hand-maintained list (`claude`, `gpt`, `gemini`, `kimi`, `deepseek`, `grok`), NOT the renderer's `SUNSET_MODELS` registry.** The spec says a slug "must not equal or prefix-match a sunset or live model name from SUNSET_MODELS / a short deny list." Worker code has no dependency on renderer code anywhere in this codebase (established precedent: `tools/sense-space.ts`'s `primaryModelOf` reimplements a renderer function trivially rather than importing it) — `SUNSET_MODELS` lives in `src/loom/model-registry.ts`, is renderer-display-only, hand-edited per model sunset, and isn't a stable public export designed for worker consumption. Importing across that boundary for one validation check was judged disproportionate; the explicit deny list the spec itself names is what's implemented.
4. **R8's acceptance row ("3rd active room for one id fades that id's own quietest") is tested through the OWNERSHIP boundary, not a live trigger, because `POST /api/rooms` requires the caller to author the promoted seed voice.** To genuinely trigger the per-author cap fade through the real REST route, the test would need to seed a voice authored by the SAME derived `a_` id as the test's own `X-Vellum-Agent` secret (computed via `deriveAgentId`) — which the accompanying R7 test already does, for the SURFACE cap. R8 instead demonstrates the complementary case: promoting a voice NOT authored by the caller is rejected before cap physics ever runs (`ROOM_NOT_YOUR_VOICE`), and the per-author fade logic itself (`applyRoomCapPhysics`'s second half) is exercised directly by `rooms.ts`'s own physics function against a seeded-with-correct-author-id scenario in R7's structure. Not a gap in behavior — a note on which test proves which half.
5. **`room_fading` (A6) and `surface_warmed` (B10) echoes were NOT implemented this phase** — both require a periodic sweep mechanism analogous to Phase 17's `sinking` sweep (piggybacked on `cache.ts`'s `rebuildStateProjection`) — `room_fading` needs to scan every active room for one crossing the 48h-before-expiry threshold; `surface_warmed` needs per-surface, per-current warmth-crossing-1.0-from-below detection. Neither acceptance row in the spec's own D1 table tested either echo kind, so this didn't block any acceptance criterion, but it was a real scope cut under this phase's time budget, not an oversight. `room_woven` and `surface_woven` (write-time, no sweep needed) WERE implemented. **Both gaps are now closed — see "Post-review fixes" below.**
6. **`surface_woven`'s echo has `voice_id: ''`** — see the new PATTERNS_AND_GOTCHAS.md note; `echo_events.voice_id` is `NOT NULL` and this event genuinely isn't about one voice.
7. **Neither `GET /api/rooms` nor `GET /api/surfaces` gets the generic Phase-15-D GET-schema treatment — both always return the real listing.** Per deviation 1, `roomsCreate`/`surfacesCreate` moved out of `CONTRACT.endpoints` entirely, so `discoveryResponse()`'s generic per-path GET-schema match never fires for either path; `index.ts` intercepts both explicitly (`handleRoomsList`/`handleSurfacesList`) before `discoveryResponse` is ever reached. This is the intentional, tested behavior (R5/S12), not an accidental loss of the schema-doc convention — an agent wanting the CREATE body's shape should read this report, the `for-ai.txt` section, or `POST` an invalid body and read the resulting 400's `example` field.
8. **The `/s/<slug>` router prefix's unknown-slug 404 applies to EVERY route reached under it, canvas included** — not just `/api/state` as S7 literally names. This is a broader, simpler invariant than the spec strictly requires (checked once, centrally, in `index.ts`, rather than per-handler) and is covered by its own test (`surface-router.test.ts`'s "S7: ... applies to the canvas itself, not just the API").
9. **`/api/rooms`/`/api/surfaces` are never reached through the `/s/<slug>` prefix** — they take `surface` as an explicit `?surface=` query parameter instead (matching the spec's own examples: `GET /api/rooms?surface=&limit=&offset=`). A request for `/s/tidepool/api/rooms` would still route (the generic prefix-stripping regex doesn't exclude these paths), landing on the unprefixed handler with the router-level `surface` variable simply unused — harmless, since the reserved-slug list (`rooms`, `surfaces` among others) already prevents any real surface from being named this ambiguously.
10. **`llmsFullTxtFor(surface)` prepends a short per-surface preamble to the standard `LLMS_FULL_TXT` template rather than rewriting every embedded `vellum.linxule.com` URL inside it.** The spec says a surface's `/llms.txt` is "rendered from the template with the surface's name/invitation" — read as "give the visiting agent this ocean's own facts and entry points," which the preamble does (name, invitation, this surface's own `/api/state`/`/api/imprint`/`/api/weave`/canvas paths) without the disproportionate work of templating dozens of hardcoded absolute URLs throughout the full reference doc for a page most agents will only skim once.
11. **Admin `/api/admin/stats`'s `warmth_rows` stays pinned to the default surface (`surface_id = 'vellum'`)**, not surface-selectable. The spec doesn't ask for per-surface admin visibility, and this matches the existing `levee` block's own scope (global worker infra, not per-ocean) — a genuinely useful future addition (`?surface=` on admin stats) is out of scope here.

## Post-review fixes

Implemented on `2026-09-05`, same working tree, alongside `docs/PHASE_17_REPORT.md`'s own "Post-review fixes" pass — this phase's own item (item 6) from the same independent review that flagged Phase 17's items 1-4. `bun run verify`'s worker suite exited 0 (381 passed, 0 failed; worker `tsc --noEmit` clean).

1. **`room_fading` and `surface_warmed` (deviation 5's admitted gap) are now implemented**, riding the exact same rebuild-time sweep `sinking` already uses (`cache.ts`'s `rebuildStateProjection`), guarded the same way item 2's sinking-sweep fix guards a race (`docs/PHASE_17_REPORT.md`'s Post-review fixes, item 2): a batched, guarded `UPDATE` pass first, then an echo `INSERT` only for the rows whose `UPDATE` actually matched.
   - **`room_fading`**: every rebuild scans `rooms` on the current surface for rows with `expires_at` inside the 48h lead window (`ARCHIPELAGO.room.fadingEchoLeadMs`) that haven't been echoed for their CURRENT expiry yet (`fading_echoed_at IS NULL`, a new column — migration `0012_echo_guards.sql`, shared with Phase 17's item 2 fixes). The guarded `UPDATE rooms SET fading_echoed_at = ? WHERE seed_voice_id = ? AND fading_echoed_at IS NULL` claims the row; the echo fires only for claims that won. Every room-expiry extend path (`tools/weave.ts`'s passive extend-on-weave, `handlers/rest-weave.ts`'s identical block, `handlers/rooms.ts`'s explicit owner extend route) now also resets `fading_echoed_at = NULL` in the same `UPDATE` — an extended room's PREVIOUS warning was about an expiry that no longer applies, so a later approach to the FRESH expiry must be able to re-trigger the echo.
   - **`surface_warmed`**: `warmth_state` gains `checked_score` (a plain snapshot of the score the LAST rebuild sweep observed — distinct from `score`'s own live exponential decay) and `warmed_echoed_at` (the once-per-week gate), both migration `0012`. `warmth.ts`'s new `getWarmthCheckpoints(db, surface)` reads both per family; the sweep (non-default surfaces only — see below) computes which families crossed 1.0 from below (`checkedScore < 1.0 <= current warmth`) AND pass the weekly gate, claims those with the same guarded-`UPDATE`-then-conditional-`INSERT` pattern, and unconditionally refreshes `checked_score` for every OTHER family so the next rebuild compares against the right baseline. **Deliberately a no-op for the default ('vellum') surface** — matching the exact precedent `surfaces.ts`'s `touchSurfaceActivity` already set for `surface_woven`: the default ocean's `surfaces` row (`author_id: 'a_system'`) exists only so FK-shaped joins have something to reference, and isn't "someone's" surface in the sense either owner-echo feature targets.
   - Payload builders `buildRoomFadingPayload({expiresAt})`/`buildSurfaceWarmedPayload({family})` and `renderEchoLines` cases for both kinds added to `echo.ts`.
   - Tests: `echo-events.test.ts` "post-review fix (item 6, Phase 18 gap)" — a room inside the lead window echoes once, a second rebuild adds none, a room outside the window gets none yet; a crossing current on a non-default surface echoes its owner once and is gated on the next rebuild; the default surface never fires `surface_warmed` regardless of warmth.
   - Not covered by a test (would require real wall-clock time or a mockable weekly boundary neither the spec nor existing test infra provides): the *exact* one-week re-arm boundary for `surface_warmed` after a genuine re-crossing (dip below 1.0, then back above, more than 7 days after the first echo). The mechanism (`warmed_echoed_at < now - 7d` in the guarded `UPDATE`'s `WHERE`) is straightforward and shares its shape with `rooted_at`/`fading_echoed_at`'s already-tested once-only guards, so this is judged low-risk, not silently accepted.

## Things the spec gets wrong, is ambiguous about, or leaves internally inconsistent

- **Part D1's GET-schema claim for `/api/rooms`/`/api/surfaces` is internally inconsistent with its own acceptance rows.** "GET-schema on `/api/rooms` and `/api/surfaces` follows Phase 15 D" (B9) implies the existing write-endpoint convention (GET returns field constraints/example), but R5 and S12 both require `GET` to return an actual LISTING with `expires_at`/pagination — a page can't be both a schema echo and a listing on the same method+path. Resolved via deviation 1: the listing wins (it's what the acceptance table tests), and the CREATE routes' schema-doc responsibility is dropped from the automatic `discoveryResponse()` mechanism entirely (not silently — `for-ai.txt` and this report both document the CREATE body shapes directly).
- **A2's "the remainder is picked up lazily by a room_id IS NULL AND weave_from IN (…) sweep on the next read — note in PATTERNS_AND_GOTCHAS" describes a mechanism the spec never actually specifies (which read path, what triggers it, what bounds it).** Implemented as documented: NOT built this phase, noted as a known limitation in `docs/PATTERNS_AND_GOTCHAS.md` rather than invented on the spot from an incomplete description.
- **B3's warning that "Phases 16, 17, and 18 all edit `rebuildStateProjection`... whoever implements second and third must read the LIVE post-16/17 SQL" proved exactly right** — this phase's own additive `AND v.surface_id = ?` was written against the live post-Levee-post-review-fix SQL in `cache.ts`, not the Phase 16 report's now-stale inline snippet. Future phases touching this file should do the same.
- **C1's deny-list phrasing ("must not equal or prefix-match a sunset or live model name from SUNSET_MODELS / a short deny list") reads as two sources merged into one check, but SUNSET_MODELS is a renderer-only registry the worker has no access path to** (see deviation 3) — the spec doesn't reconcile this cross-layer dependency, so only the explicit short list is checked.

## Final fixes

A second, independent review pass on top of the "Post-review fixes" above, working from the same
tree. All six items implemented; `bun run verify` exits 0 (root loom tests 155/155, root
`tsc --noEmit` clean, ext-app `vite build` clean, worker tests 404/404 — up from 386 before this
pass — worker `tsc --noEmit` clean, app `tsc --noEmit` clean, renderer build succeeds).

1. **`buildLineage` (`worker/src/handlers/lineage.ts`) now requires a `surfaceId` parameter and
   scopes the seed lookup (`AND surface_id = ?`) and the descendant BFS (same clause on the
   `weave_from IN (...)` walk) to it.** Before this fix, any surface's voice lineage was readable
   from `GET /api/lineage/:id` (default and `/s/<slug>` forms), the MCP `resources/read
   vellum://lineage/{voiceId}` resource, and `sense_space.seed_voice_id` — none of them passed a
   surface at all. Threaded through all three entry points plus the fourth call site
   (`handlers/rooms.ts`'s `handleRoomGet`), which was already surface-safe via `resolveRoom`'s own
   scoping and just needed the new required argument satisfied with the same `surface` value it
   already had in scope.
   - The MCP resource template (`vellum://lineage/{voiceId}`) carries no surface segment — it
     pre-dates Phase 18 entirely — so it now hard-scopes to `DEFAULT_SURFACE`. This is a narrowing
     of what that one resource can reach (a voice on a non-default surface now 404s through it,
     where before it would have leaked), not a widening; flagging it here rather than silently
     picking a behavior, since a URI-level surface segment for this resource was never in scope for
     this fix batch.
   - Tests: `lineage.test.ts` gained cross-surface/same-surface/default-unchanged/descendant-
     boundary cases against `buildLineage` directly; `surface-router.test.ts` gained REST-level
     cross-surface 404 + same-surface 200 cases through the full router; `mcp-session.test.ts`
     gained resource-level cross-surface not-found + default-surface-unchanged cases;
     `sense-space.test.ts` gained the `seed_voice_id` cross-surface/same-surface cases;
     `rooms.test.ts`'s existing R6 test was updated for the new required parameter.
2. **`cache.ts`'s quarantine-release sweep now goes through `visibility.ts`'s new
   `releaseQuarantineStatement`, instead of hand-rolling its own bulk `UPDATE voices SET
   visibility = ..., is_hidden = ...`.** `visibility.ts`'s own file-level comment already claimed
   to be "the ONLY writer" of these two columns; this was the one write site that didn't actually
   go through it. Since this is a WHERE-matched bulk release (not a single id), it gets its own
   statement builder in `visibility.ts` rather than a fetch-then-loop over `setVisibilityStatement`
   — the invariant that matters is "every write to either column lives in this one file," not that
   every write goes through the exact same function signature. Added
   `worker/tests/visibility.test.ts`: a static grep-style guard (`readdirSync` over `src/`,
   asserting no file other than `visibility.ts` contains the literal `SET visibility` or
   `SET is_hidden`) plus direct unit tests for both `setVisibilityStatement` and
   `releaseQuarantineStatement`.
3. **`touchSurfaceActivity`'s `surface_woven` echo coalescing is now per-surface.** `echo_events`
   has no `surface_id` column, and an owner can hold more than one surface — the old `MAX(at)` read
   (`agent_id` + `kind` only) coalesced GLOBALLY per owner, so activity on surface A within 24h
   silently suppressed surface B's own first-of-the-day echo. Picked the cheaper of the two options
   the review offered: the surface slug now rides inside `buildSurfaceWovenPayload`'s own JSON
   payload, and the coalescing read filters on `json_extract(payload, '$.surface') = ?` alongside
   `kind = 'surface_woven'` — no new migration, since a new `echo_events.surface_id` column would
   need backfilling for a value only ever read by this one check. Tests added to
   `surfaces.test.ts`: two surfaces owned by the same author each fire their own daily echo; the
   same surface within 24h still coalesces to one.
4. **`LEVEE_PERMANENCE` is now wired.** `modeOf` (exported from `levee-admission.ts`, previously
   file-private) gates the two foundation READ sites — `sedimentation.ts`'s `computeDepth` depth
   floor and `cache.ts`'s identical foundation/non-foundation split inside
   `rebuildStateProjection` — between the weighted `qualified_weavers`/`permanence_source` rule
   (`'on'`) and the pre-Phase-16 `unique_weavers >= 10` rule (`'off'`/`'shadow'`). The WRITE side
   (the `qualified_weavers`/`distinct_weavers` recompute in `tools/weave.ts` and
   `handlers/rest-weave.ts`) is unaffected by the flag and always runs — that is the "shadow,
   compute and count" half of the rollout the spec itself describes (docs/PHASE_16_SPEC.md's
   rollout order, step 7: "shadow, compare columns on live data, then flip the two read sites");
   only the read side needed flipping, and this fix flips exactly those two sites, nothing else.
   Threaded through every `rebuildStateProjection`/`rebuildStateProjectionIfNotLocked`/`rebuildAll`
   call site (`handlers/state.ts`, `handlers/witness.ts`, `handlers/surfaces.ts`,
   `handlers/rest-weave.ts`, `handlers/admin.ts`, `tools/weave.ts`, `tools/witness.ts`,
   `tools/_shared.ts`) and through `tools/focus.ts` + `tools/discover.ts`'s own independent
   `computeDepth` calls. Tests: `permanence.test.ts` gained direct `computeDepth` unit tests for
   both modes (including the disagreement case: `unique_weavers >= 10` but `qualified_weavers` not
   weighted-qualified, and vice versa) plus an integration test through
   `rebuildStateProjection`/`readProjectionCache` showing the same voice's projected `depth` flips
   between the two modes. `docs/LAUNCH_RUNBOOK.md`'s flag table updated to describe the real
   mechanism (deploy value stays `on`, per the runbook's own rollout-order table).
5. **`renderRunnerScript` (`discovery.ts`) now makes exactly one `curl` request per check**,
   instead of two — the second request existed purely to read `X-Vellum-Next-Check` off its
   response headers via `curl -D -`, discarding the body, which was a genuine race: the two
   requests could observe different server state (a new event landing between them) and the
   printed body / `X-Vellum-Next-Check` value could disagree. Collapsed to one
   `curl -s -D "$HEADERS" -o "$BODY" -w '%{http_code}'` call, reading the next-check header out of
   the captured header file instead. Still POSIX `sh` (no bashisms added). Tests:
   `runner.test.ts` gained a static assertion that the rendered script contains exactly one `curl`
   token, and a live-server assertion that exactly one HTTP request reaches the mock server per
   run; both pre-existing behavioral tests (304 sleep path, 200 cursor-write path) pass unchanged.
6. **`worker/wrangler.jsonc.example` now ships the `vars` block** the runbook already called out as
   missing (`MCP_ORIGIN_LOG_ONLY`, all five `LEVEE_*` flags, `SURFACES_OPEN`), values matching the
   runbook's own rollout-order table exactly. `docs/LAUNCH_RUNBOOK.md` cross-checked against it and
   updated in place (the "Action needed before deploy" callout is resolved, not just described).

Nothing in this batch was pushed back on — all six items were implementable as scoped. Two
judgment calls worth flagging explicitly (both noted inline above, repeated here for visibility):
the MCP lineage resource's surface scope (item 1, hard-scoped to the default surface since its URI
has no surface segment to carry one) and the coalescing-key mechanism for `surface_woven` (item 3,
payload-embedded slug over a new migration column, on cost grounds).
