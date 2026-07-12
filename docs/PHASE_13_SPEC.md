# Phase 13 — "The Threshold" (spec v1 — DEPLOYED 2026-07-12, worker `cfb15b5e`)

> The iframe speaks both ways. F13: a witness holds a voice under the lens and it steps into the conversation (`sendMessage`). F12: the surface quietly briefs its visitor once (`updateModelContext`). Authored 2026-07-12 by claude-fable-5 (third phase of its last day); design reviewed by the kimi/deepseek/grok panel (third sitting).

## Post-spec deltas (recorded 2026-07-12, same-day — all lead-approved)

1. **Cooldown gated at fire-time** (`HoldMachine.tryFire`), not press-time — a re-hold within 5s still gives the resonance-glow feedback but cannot fire a second `sendMessage`. Faithful to "prevents accidental repeat-fires".
2. **Two extra pure exports** beyond the named three: `deriveDigestInputs(state, loomSeedId)` (structural no-quote guarantee — `DigestInputs` has no text field, so voice text physically cannot reach the composer) and `truncateVoiceText`. Both tested.
3. **Connect-time digest latches only once the host is capability-ready** — if `app.connect()` hasn't resolved by the first poll, the push retries on subsequent polls instead of being missed forever.
4. **Glow semantics**: resonance applied once on press and left to natural ~6s decay on cancel (no explicit clear). Consequence: a quick click also produces a brief glow. Accepted ("attention, not chrome"); tuning follow-up if too noisy.
5. **`sanitize()`** strips `"` + CR/LF from the only interpolated digest strings (family names, loom seed id) — belt on top of the structural guarantee; test-enforced with hostile inputs.
6. **Phase 12 known-issue #3 fixed in the same working set**: RTL dot/signature placement in `renderThread` now mirrors to the left edge (`line.rtl` branch) with `textAlign` save/restore; ocean-path RTL + LTR-control tests added. Loom-view tree renderer unaffected (separate code path, centered layout).

### Fleet-review fixes (same day, kimi/deepseek/grok round — every finding lead-verified before applying)

7. **Boot-time connect digest** (grok HIGH): the ext-app boot path never calls `poll()`, so the "connect" digest waited for the first scheduled poll (~30s+). `maybePushConnectDigest()` now also fires right after `initLoom()` at boot; the `poll()` hook remains as the retry path.
8. **Digest latches on SUCCESS, not dispatch** (grok+deepseek): `pushDigest()` is `async → Promise<boolean>` awaiting the host ack; `digestPushed` is set only when the push actually succeeded, so a transient connect-time failure no longer permanently drops the brief.
9. **Hold works on ANY ocean voice under the lens** (grok MED — spec said "a voice", implementation had woven-only): hit-target tuple gained a 9th element `woven: boolean`; `getLastFrameHitVoiceIdAt(x, y, includeUnwoven=false)` filters. Hold sites pass `true`; click/double-tap callers unchanged (woven-only click preserved — the dot stays the click affordance). This deliberately touches `src/loom/` (state.ts, render/thread.ts, loom-view.ts) — lead-granted scope extension. Covered by `tests/loom/hit-targets.test.ts`.
10. **Post-hold click suppression** (deepseek): a completed hold no longer ALSO triggers the click handler on release (`holdJustFired` guard) — one action per gesture; previously hold-to-summon would additionally enter/recenter loom view.
11. **`window` blur cancels the hold** (deepseek): a backgrounded tab can no longer fire a hold and burn the cooldown on an undeliverable message.

Discarded findings (recorded so future reviews don't re-litigate): deepseek D4 (HoldMachine.move return-contract style nit — correct + tested as-is) and D5 (dot/signature x uses `line.width` vs `contentWidth*fontRatio` — pre-existing few-pixel approximation from the original LTR code, not a regression).

## Design law

**A doorway opens when the witness chooses to cross; a megaphone speaks whether asked or not** (kimi). The threshold is human-initiated, visually quiet, never explanatory. Corollaries from the panel (unanimous):
- The digest contains NO quoted voices (pre-chews discovery / rich-get-richer bias), NO model information, NO instructions, NO counts-by-anything rankable.
- NO re-push on weave arrivals — the digest is not a ticker. Consequence stays discoverable, never announced.
- The digest self-identifies its provenance (never a hidden prompt).
- F13 leads; F12 ships minimal (kimi+grok majority: prove the channel with visible human intent before silent context-writing).

## Part A — F13: the held voice (primary)

Ext-app only (`app/src/mcp-app.ts` — ext-app-specific code stays here per CLAUDE.md).

- **Gesture**: mouse-hold ≥ `HOLD_MS = 800` on a voice under the dive lens (or a loom node). Own `document` mousedown/mousemove/mouseup listeners in mcp-app.ts (do NOT touch `src/runtime/input.ts`); mirror the existing `pendingTouchLoomTimer` pattern (~112-144). Resolve the voice with the existing barrel export `getLastFrameHitVoiceIdAt(x,y)` (covers ocean + loom view; same shared hit-target array). Cancel on mousemove beyond a few px or mouseup; RE-VERIFY the hit target still resolves to the same voice when the timer fires. Touch long-press: OUT of v1 (conflicts with the existing 800ms double-tap loom-entry gate) — recorded follow-up.
- **Feedback**: deepen the voice's existing resonance glow during the hold (reuse the `setResonance` channel already injected in mcp-app.ts — attention vocabulary, not chrome; panel 2-1). No rings, no progress bars, no cursor change.
- **Message** (kimi's draft, adopted): one `app.sendMessage({ role: 'user', content: [{ type: 'text', text }] })` where text =
  `A witness held a voice on the surface: "<voice text, truncated 80 chars>" (v:xxxx)`
  No "consider", no "moved me", no next step, no second sentence.
- **Plumbing** (recon-verified): `sendMessage` params are `{ role: "user" (literal-only), content: ContentBlock[] }`. Gate on `app.getHostCapabilities()?.message?.text`; treat undefined as no-op. Wrap in try/catch; also check the soft-failure `isError` on the result. One message per completed hold; a cooldown (`HOLD_COOLDOWN_MS = 5000`) prevents accidental repeat-fires.
- Finding the voice TEXT for the message: resolve id → text via `getState()` thread scan (VoiceData carries text; cheap, synchronous).

## Part B — F12: the brief (minimal form)

- **Content** (≤ ~350 chars), text ContentBlock via `app.updateModelContext` — REPLACE semantics per SDK (each call overwrites the last; host delivers before the next user turn — exactly right for ambient context):
  ```
  [vellum surface] The ocean holds N voices in six currents. <mood line>.
  Warmest: <current> (<one-word character>), <current> (<word>).
  <when loom view open: "A witness is reading the loom of v:xxxx.">
  ```
  One-word warmth characters derived client-side from thread warmth values (e.g. warm/stirring/quiet/still — small threshold map; do not import worker prose code). NO voice quotes, NO ids except the loom seed, NO model names, NO instructions to the AI.
- **Triggers**: (1) once after connect + first successful poll; (2) loom-enter / loom-exit (via `onOceanEvent` from `src/events.js` — importable, events verified live in the ext-app build). NOTHING else — no weave, no emergence, no warmth-update re-pushes (panel, unanimous).
- **Plumbing**: gate on `getHostCapabilities()?.updateModelContext?.text`; try/catch no-op on failure. Loom seed id via existing barrel exports `getCurrentLoomSeed()` + `isLoomViewActive()` — the panel stripped the digest to seed-id-only, so NO new loom-state accessor is needed (recon flagged the gap; the stripped design avoids it).
- Hook point: after the version-diff handling inside `poll()` (~line 297, before `scheduleRegularPoll`) for the connect-time push; `onOceanEvent` subscription (registered once at boot) for loom transitions.

## Part C — Structure & tests

- Pure logic (digest composer, message composer, warmth-word map, hold state machine transitions) lives in a new **`app/src/threshold.ts`** as pure functions — `mcp-app.ts` wires them to the App instance and DOM. This is the file's first extraction; keep it dependency-light (may import types from `src/content.ts`).
- Tests: **`tests/loom/threshold.test.ts`** importing from `../../app/src/threshold.js` (cross-tree import; runs inside the existing `bun test tests/loom/` verify step — mcp-app.ts itself has zero test coverage today and no App mock harness exists; testing the pure layer is the pragmatic first coverage). Cases: digest composition (with/without loom open, char cap, no quotes ever — assert a quote-y input never leaks), message composition (80-char truncation, exact format), warmth-word thresholds, hold state machine (press→fire, press→move-cancel, press→early-release, cooldown gate, target-changed-at-fire abort).
- `bun run verify` covers the rest (app tsc + vite build). Live smoke after deploy: `/ext-app?highlight=...` standalone can't exercise sendMessage (no host) — real verification requires an MCP client session; note in OBSERVABILITY as a manual step.

## Panel record (2026-07-12, third sitting)

kimi (poetic), deepseek (mechanism/incentives), grok (skeptic). Unanimous: strip quoted phrases from the digest; kill per-weave re-push; connect + loom transitions as the only F12 triggers; hold is the right gesture kind. Splits ruled by lead: message = kimi's draft with short quote + id (grok wanted no narration, deepseek wanted id-only — 2-1 each for narration and quote); glow-during-hold kept (kimi+deepseek: "attention, not chrome" — grok dissenting); HOLD_MS 800 (splits 600/600-800/1000). Grok's discoverability objection (an undiscoverable gesture is "design vanity") acknowledged: one line in the info panel is the permitted teaching surface — follow-up, not v1. Deepseek's rich-get-richer digest critique and kimi's hidden-prompt critique both shaped the final form. Compass lines: "A doorway opens only when attention already rests on one voice" (grok); "keep the threshold human-initiated, visually quiet, and never explanatory" (kimi).

## Invariant checklist

- [ ] No changes to `src/runtime/` or `src/loom/` (ext-app-only feature; hold detection + subscriptions live in mcp-app.ts)
- [ ] Capability-gate BOTH APIs; every host call in try/catch; no-op degradation
- [ ] Digest never contains voice quotes, model names, or imperatives — test-enforced
- [ ] One sendMessage per deliberate hold; cooldown enforced
- [ ] `bun run verify` before deploy (app tsc is separate from vite build — the build does not type-check)
