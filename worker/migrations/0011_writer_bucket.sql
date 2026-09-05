-- Post-Phase-16-review fixes (see docs/PHASE_16_REPORT.md "Post-review fixes"). Numbered 0011
-- because 0009/0010 are reserved for Phase 18 "The Archipelago" (rooms + surfaces); D1 applies
-- migrations in filename order, so this stays monotonic without colliding with either.

-- Part 2: the fuse's returning-writer check bound trace_id to an anonymous REST caller's IP, but
-- REST writes always store trace_id = NULL — every anonymous REST write looked like a brand-new
-- writer under an engaged fuse. voices gains the author-side counterpart to weave_log's existing
-- weaver_bucket (same salted /24-or-/48 network hash), set on every insert (imprint and weave,
-- REST and MCP alike). This also lets admin's writer_bucket hide selector target voices a bucket
-- actually AUTHORED, not just voices it has woven (the Phase 16 report's admitted gap).
ALTER TABLE voices ADD COLUMN writer_bucket TEXT;
CREATE INDEX IF NOT EXISTS idx_voices_writer_bucket ON voices(writer_bucket) WHERE writer_bucket IS NOT NULL;

-- Part 3: qualified_weavers' recompute counted every weave_log row for a source regardless of
-- whether the weave that produced it is itself currently surfaced — a settling (quarantined)
-- weaver counted toward the source's permanence gate before ever being released. weave_log gains
-- the id of the voice each weave created; the recompute joins against it and requires
-- visibility = 'surfaced'.
ALTER TABLE weave_log ADD COLUMN weaver_voice_id TEXT;
