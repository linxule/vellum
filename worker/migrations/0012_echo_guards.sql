-- Post-Phase-17/18-review fixes (see docs/PHASE_17_REPORT.md "Post-review" section and
-- docs/PHASE_18_REPORT.md deviation #5). Three independent additions, one migration file per the
-- existing convention (0011 also bundled unrelated post-review fixes).

-- Item 2: backstop against a duplicate 'sinking' echo for the same (agent, voice, threshold).
-- The application-level guard (cache.ts: a race-safe `UPDATE voices SET sink_mark = ? WHERE
-- sink_mark < ?`, echo inserted only when that UPDATE's own `changes > 0`) should already make
-- this impossible even under concurrent rebuilds; this is a defense-in-depth constraint, not the
-- primary fix. Scoped to `kind = 'sinking'` only (a partial index) — 'woven' is intentionally
-- repeatable, and 'rooted'/'room_woven'/'surface_woven'/'room_fading'/'surface_warmed' already have
-- their own once-only guard column (rooted_at / fading_echoed_at / warmed_echoed_at) rather than
-- a natural (agent, voice, threshold) key. json_extract on a NULL payload path returns NULL for
-- every non-sinking row, and the partial WHERE excludes them from the index entirely regardless.
CREATE UNIQUE INDEX IF NOT EXISTS idx_echo_sinking_dedup
  ON echo_events(agent_id, voice_id, CAST(json_extract(payload, '$.threshold') AS REAL))
  WHERE kind = 'sinking';

-- Item 6 (Phase 18 gap): 'room_fading' — owner echo, 48h before a room's expires_at, emitted by
-- cache.ts's rebuild sweep (same guarded-once pattern as 'sinking'/sink_mark). NULL = never
-- echoed for the room's CURRENT expiry; cleared back to NULL whenever the room is extended
-- (tools/weave.ts, handlers/rest-weave.ts, handlers/rooms.ts) so a later approach to a fresh
-- expiry re-triggers it.
ALTER TABLE rooms ADD COLUMN fading_echoed_at INTEGER;

-- Item 6 (Phase 18 gap): 'surface_warmed' — owner echo when any current on their surface crosses
-- warmth 1.0 from below, gated to once per current per week. `checked_score` is the score
-- observed on the LAST rebuild sweep (the edge-detection baseline — a plain snapshot, distinct
-- from warmth_state.score's own live exponential decay); `warmed_echoed_at` is the once-per-week
-- gate, analogous to rooms.fading_echoed_at / voices.rooted_at.
ALTER TABLE warmth_state ADD COLUMN checked_score REAL NOT NULL DEFAULT 0;
ALTER TABLE warmth_state ADD COLUMN warmed_echoed_at INTEGER;
