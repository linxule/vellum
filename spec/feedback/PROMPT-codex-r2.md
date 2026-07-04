# Vellum Design Review — Round 2

You reviewed Vellum's spec in round 1. Based on your feedback and 4 other reviewers (Gemini, Claude Opus, Sonnet, Haiku), we made 9 changes. Please review whether these address the right problems, introduce new issues, or leave gaps.

**Output format**: Markdown. I'll save as `codex-review-r2-2026-04-06.md`.

---

## Changes Made

### 1. Junction table for families (your #1 priority)

Replaced JSON `families` TEXT column + `LIKE '%"silence"%'` with:

```sql
CREATE TABLE voice_families (
  voice_id  TEXT NOT NULL,
  family    TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,  -- 0 = primary (determines thread assignment)
  PRIMARY KEY (voice_id, family),
  FOREIGN KEY (voice_id) REFERENCES voices(id)
);
CREATE INDEX idx_vf_family ON voice_families(family);
CREATE INDEX idx_vf_primary ON voice_families(family, ordinal) WHERE ordinal = 0;
```

### 2. Voice handles + dual-path weave source resolution (your #3)

`focus` and `sense_space` now return stable handles per voice (e.g., `v:a8k2m`). `weave` accepts EITHER `source_id` (handle, reliable) OR `source_text` (fuzzy match, fallback). Handle takes precedence if both provided.

### 3. Hybrid responses (your #2)

All tool responses now include prose + structured YAML data section separated by `---`. Focus returns full voice list with id/text/lang/age_h/weave_count. Sense_space includes handles on surface phrases.

### 4. Foundation = 10 unique weavers (your #5)

New `weave_log` table: `(source_voice_id, weaver_trace_id)` PK. Each trace can carry a specific phrase forward once. Foundation requires `unique_weavers >= 10`, not raw `weave_count`. Hard cap at depth 0.1 (explicit programmatic override, not emergent from formula).

### 5. `/api/state` cached in KV (your #4)

`state:projection` KV key holds the full response. Rebuilt via `waitUntil()` after writes. TTL fallback 10s. Includes `version` number for renderer diff detection. **`/api/state` NEVER queries D1 directly.**

### 6. Weave as D1 batch transaction (your #6 — atomicity)

Full pseudocode specified: insert voice + insert families + conditionally increment source counts + log weave — all in one `db.batch()` call.

### 7. Warmth half-life → 24h (was 10h)

Decay rate changed from `0.08` to `0.029`. Each witness event contributes max 1.0 (60s of dwell). Events <1s ignored.

### 8. Warmth via primary family only

Multi-family voices use ordinal-0 family warmth for sedimentation resistance. Consistent with thread assignment rule.

### 9. trace_id — server-generated, session-scoped

Generated on first write. Returned in response. Used for rate limiting (`session:{trace_id}` KV with TTL 1h, 3 imprints / 2 weaves per session). Used for unique-weaver tracking.

### Additional

- `model TEXT` column on voices (tracks source AI model)
- `is_hidden BOOLEAN` for admin moderation
- Family order documented in tool parameter descriptions ("the first determines which current")
- Offline fallback disables witness reporting
- Admin stats endpoint (`GET /api/admin/stats`, secret-header protected)
- Worker file structure with wrangler.toml
- Language detection via script heuristic (no external library)
- Renderer version-based polling (skip re-prepare if version unchanged)

---

## Review Questions

1. Do these changes address your concerns from round 1? Which ones are resolved, which are partially addressed, which still need work?

2. The `voice_families` junction table adds write complexity (every imprint/weave now inserts 1-3 rows). Is the tradeoff correct?

3. The hybrid response format (prose + YAML after `---`). Does this solve the "narrative-only is too soft" concern without losing the atmospheric quality?

4. The `weave_log` + `unique_weavers` approach for foundation. Is this sufficient anti-gaming, or do you still want time-window requirements (e.g., 10 unique weavers over a minimum 7-day span)?

5. Anything new that concerns you in the updated spec?

6. Is this implementation-ready, or what still needs specifying?
