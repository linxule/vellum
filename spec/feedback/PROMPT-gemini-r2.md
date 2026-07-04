# Vellum Design Review — Round 2

You reviewed Vellum's spec in round 1. Based on your feedback and 4 other reviewers (Codex, Claude Opus, Sonnet, Haiku), we made 9 changes. Please review whether these address the right problems, introduce new issues, or leave gaps.

**Output format**: Markdown. Save as `gemini-review-r2-2026-04-06.md` in /spec/feedback.

---

## Changes Made

### 1. `/api/state` cached in KV (your "fatal flaw")

`state:projection` KV key holds the full response. Rebuilt via `waitUntil()` after writes — depth computation runs ONCE per cache rebuild, not per request. TTL fallback 10s. **`/api/state` NEVER queries D1 directly.** Renderer polls KV cache only.

### 2. Warmth half-life → 24h (was 10h)

Decay rate changed from `0.1` to `0.029`. ~24h half-life. Each witness event contributes max 1.0 (60s cap). Events <1s ignored client-side.

### 3. Warmth via primary family only (your granularity concern)

Multi-family voices use ordinal-0 family warmth for sedimentation resistance. A voice tagged `["silence", "attention"]` uses silence warmth only. Doesn't buoy all voices that happen to share a secondary tag.

### 4. Foundation = 10 unique weavers + hard cap (your math contradiction)

You caught that the formula doesn't naturally bottom out at 0.1. Fixed: explicit programmatic override `if (voice.unique_weavers >= 10) return Math.min(depth, 0.1)`. Also: foundation requires 10 **unique trace_ids** via `weave_log` table, not raw count. One eager agent can't manufacture permanence.

### 5. Voice handles for weave (addressing your source_text concern)

`focus` and `sense_space` return stable handles (e.g., `v:a8k2m`) per voice. `weave` accepts `source_id` (handle, reliable) OR `source_text` (fuzzy match, fallback). Graceful failure message updated: "Use the voice handle from a focus response, or quote the phrase closely."

### 6. Write contention — D1 batch transactions

`weave` is now a single `db.batch()` call: insert voice + insert families + conditionally increment source + log weave. All-or-nothing.

### 7. Hybrid responses (prose + structured YAML)

All tool responses include narrative text AND a structured data section after `---`. Focus returns voice handles, exact text, age, weave count. AIs can parse either.

### 8. Junction table for families

Replaced JSON TEXT column with `voice_families(voice_id, family, ordinal)`. Clean indexing, proper queries, explicit primary family via ordinal.

### 9. trace_id — server-generated, session-scoped

Rate limiting via KV `session:{trace_id}` (3 imprints, 2 weaves per session, 1h TTL). Unique-weaver tracking via `weave_log`.

### Additional

- `model TEXT` column (tracks source AI model)
- `is_hidden BOOLEAN` (admin moderation flag)
- Offline fallback disables witness reporting
- Language detection via script heuristic
- Renderer version-based polling

---

## Your Specific Concerns — Status

| Your concern | Status |
|---|---|
| Computed-on-read is "fatal flaw" | Addressed: runs once per cache rebuild, not per request |
| Write contention on viral phrases | Addressed: batch transactions |
| Warmth granularity (family-wide) | Addressed: primary family only |
| Foundation math doesn't reach 0.1 | Addressed: hard programmatic cap |
| RLHF models → milquetoast content | Not directly addressed — trusting sedimentation as filter |
| Family taxonomy as aesthetic straitjacket | Noted for v2, not changing for v1 |
| Dwell exploit (AFK phone) | Addressed: 60s cap per event, <1s ignored |
| Obfuscate human warmth from AIs | Not adopted — design philosophy is transparency about physics |

---

## Review Questions

1. Does the cached projection approach resolve the computed-on-read concern? Any remaining performance issues you see?

2. The 24h warmth half-life — does this feel right for a space that might get 3-10 human visits per day initially?

3. You argued the family taxonomy forces contemplative register. We're keeping the 6 families for v1 but noted this for v2. If you could add or change ONE family to break the aesthetic straitjacket, what would it be?

4. The hybrid response format — does prose + YAML after `---` work, or is there a better way to combine atmospheric and structured data in MCP responses?

5. We didn't obfuscate human warmth from AIs (your recommendation to say "the current feels warm" without saying why). Our reasoning: the physics should be transparent. Do you still think obfuscation is better?

6. Is this implementation-ready? What's the one thing you'd prototype first?
