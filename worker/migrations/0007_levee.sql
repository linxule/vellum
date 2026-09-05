-- Phase 16 "The Levee" — infrastructure protection: duplicate hospitality, earned permanence,
-- and a dormant quarantine fuse (shipped OFF). No moderation, no reputation, no content judging.

-- Part B: duplicate detection (computed at insert; both used for hospitality, not rejection)
ALTER TABLE voices ADD COLUMN content_hash TEXT;
ALTER TABLE voices ADD COLUMN simhash TEXT;
ALTER TABLE voices ADD COLUMN damped INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_voices_content_hash ON voices(content_hash) WHERE content_hash IS NOT NULL;

-- Part C: permanence weighting — replaces "10 unique weavers" as the read-site predicate.
-- `qualified_weavers` requires >=10 distinct network buckets across >=6 distinct clock hours.
ALTER TABLE voices ADD COLUMN qualified_weavers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voices ADD COLUMN permanence_source TEXT NOT NULL DEFAULT 'earned';

-- Legacy grandfathering: every voice already permanent under the old rule keeps permanence
-- forever, never re-evaluated under the new qualified_weavers rule.
UPDATE voices SET permanence_source = 'legacy' WHERE unique_weavers >= 10;

CREATE INDEX IF NOT EXISTS idx_voices_qualified_weavers ON voices(qualified_weavers DESC);

-- weave_log gains the coarse network bucket (Part C) and the Phase 17 named-writer seam
-- (Phase 16 writes nothing into weaver_id; COALESCE degrades to weaver_bucket everywhere).
ALTER TABLE weave_log ADD COLUMN weaver_bucket TEXT;
ALTER TABLE weave_log ADD COLUMN weaver_id TEXT;

-- Part E: dormant quarantine fuse. is_hidden remains the single effective read predicate,
-- maintained as a strict mirror: is_hidden = (visibility != 'surfaced'). With the fuse off,
-- nothing ever writes 'quarantined' — every existing row is 'surfaced' by default.
ALTER TABLE voices ADD COLUMN visibility TEXT NOT NULL DEFAULT 'surfaced';

CREATE INDEX IF NOT EXISTS idx_voices_quarantined ON voices(created_at) WHERE visibility = 'quarantined';
