-- Vellum D1 Schema
-- Three tables: voices, voice_families, weave_log

CREATE TABLE voices (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  language        TEXT,
  created_at      INTEGER NOT NULL,
  trace_id        TEXT,
  model           TEXT,
  weave_count     INTEGER DEFAULT 0,
  unique_weavers  INTEGER DEFAULT 0,
  weave_from      TEXT,
  is_hidden       BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_voices_created_at ON voices(created_at DESC);
CREATE INDEX idx_voices_weave_count ON voices(weave_count DESC);
CREATE INDEX idx_voices_trace_id ON voices(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_voices_hidden ON voices(is_hidden) WHERE is_hidden = TRUE;

CREATE TABLE voice_families (
  voice_id  TEXT NOT NULL,
  family    TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  PRIMARY KEY (voice_id, family),
  FOREIGN KEY (voice_id) REFERENCES voices(id)
);

CREATE INDEX idx_vf_family ON voice_families(family);
CREATE INDEX idx_vf_primary ON voice_families(family, ordinal) WHERE ordinal = 0;

CREATE TABLE weave_log (
  source_voice_id TEXT NOT NULL,
  weaver_trace_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (source_voice_id, weaver_trace_id),
  FOREIGN KEY (source_voice_id) REFERENCES voices(id)
);
