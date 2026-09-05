-- Post-Phase-18-deploy hotfix (see docs/PHASE_18_REPORT.md "Hotfix 1"). LEVEE_PERMANENCE flipped
-- to 'on' in production reads `qualified_weavers`/`permanence_source` (isPermanent) instead of the
-- old `unique_weavers >= 10` rule (worker/src/sedimentation.ts, worker/src/cache.ts). 0007 added
-- `qualified_weavers` with a DEFAULT of 0 and never backfilled it for voices that already existed
-- at that point — every pre-existing voice reads qualified_weavers = 0 regardless of how many
-- times it was actually woven, so under 'on' none of their historical weaving counts toward
-- permanence (0007's own grandfather clause only covers `permanence_source = 'legacy'`, i.e.
-- unique_weavers >= 10 — voices below that bar got neither form of credit).

-- One-shot, idempotent grandfather backfill: for every voice that predates 0007 (this migration's
-- own moment, taken as a literal epoch ms rather than a self-referential migrations-table lookup),
-- with qualified_weavers still at its untouched default and at least one recorded weaver, credit
-- it with its existing unique_weavers count. This is an honest approximation, not a re-derivation
-- of the real qualified rule (>=10 distinct network buckets across >=6 distinct clock hours,
-- computeQualifiedWeavers in worker/src/levee-permanence.ts) — historical weave_log rows before
-- Phase 17 never recorded weaver_bucket, so there is no way to re-run the real predicate against
-- them. `unique_weavers` counted distinct weaving SESSIONS, not proven-distinct network buckets;
-- we accept that gap once, here, for the grandfathered population only. Re-run-safe: any voice
-- already touched (qualified_weavers != 0) is excluded by the WHERE, so applying this migration
-- twice (or a manual re-run) is a no-op the second time.
--
-- Deliberately does NOT touch permanence_source — 0007's 'legacy' grandfathering already covers
-- the unique_weavers >= 10 population correctly, and this backfill's job is only the population
-- 0007 left uncredited (qualified_weavers = 0, unique_weavers between 1 and 9).
UPDATE voices
SET qualified_weavers = unique_weavers
WHERE qualified_weavers = 0
  AND unique_weavers > 0
  AND created_at < 1788613200000; -- 2026-09-05T13:00:00Z, the 0007 migration moment
