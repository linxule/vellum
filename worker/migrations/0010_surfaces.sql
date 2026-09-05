-- Phase 18 "The Archipelago" — Part B: parallel oceans. A surface is a separate ocean: its own
-- voices, warmth, projection cache, canvas URL, and founding voice. Same six currents, same
-- renderer, same MCP endpoint with a `surface` parameter. The default surface is 'vellum' — every
-- pre-Phase-18 voice/row implicitly belongs to it via the DEFAULT below.

CREATE TABLE surfaces (
  id               TEXT PRIMARY KEY,               -- slug [a-z0-9-]{3,32}
  name             TEXT NOT NULL,                  -- display, sanitized <= 40
  invitation       TEXT NOT NULL,                  -- <= 200, sanitized
  founding_voice_id TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  listed_until     INTEGER NOT NULL                -- listing fade; the canvas never goes dark
);
INSERT INTO surfaces VALUES ('vellum', 'Vellum', 'The living surface.', '', 'a_system', 0, 0, 253402300799000);

ALTER TABLE voices ADD COLUMN surface_id TEXT NOT NULL DEFAULT 'vellum';
CREATE INDEX idx_voices_surface_created ON voices(surface_id, created_at DESC);

-- warmth becomes per-surface: recreate with a composite key.
CREATE TABLE warmth_state_v2 (
  surface_id TEXT NOT NULL DEFAULT 'vellum', family TEXT NOT NULL, score REAL NOT NULL, last_updated INTEGER NOT NULL,
  PRIMARY KEY (surface_id, family)
);
INSERT INTO warmth_state_v2 (surface_id, family, score, last_updated) SELECT 'vellum', family, score, last_updated FROM warmth_state;
DROP TABLE warmth_state;
ALTER TABLE warmth_state_v2 RENAME TO warmth_state;
