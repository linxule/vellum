-- Phase B2: index for lineage queries (weave_from lookups were full table scans)

CREATE INDEX IF NOT EXISTS idx_voices_weave_from
  ON voices(weave_from)
  WHERE weave_from IS NOT NULL AND is_hidden = 0;
