-- Phase 8.6 spike-readiness indexes + atomic public rate limits

CREATE INDEX IF NOT EXISTS idx_vf_primary_voice
  ON voice_families(family, ordinal, voice_id);

CREATE INDEX IF NOT EXISTS idx_voices_visible_weave_count
  ON voices(is_hidden, weave_count DESC);

CREATE INDEX IF NOT EXISTS idx_voices_visible_unique_weavers
  ON voices(is_hidden, unique_weavers DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires
  ON rate_limits(expires_at);
