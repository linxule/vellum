-- Earned permanence, new bar (decided 2026-11-18): 5 distinct weavers across at least 4 distinct
-- clock hours, down from 10 across 6, with weaves from before the Levee counted once per session.
--
-- Why a recompute and not only a constant: the worker recomputes a voice's `qualified_weavers` /
-- `distinct_weavers` only when that voice is woven again, and until this change its query
-- inner-joined weave_log to `weaver_voice_id`, a column that is NULL on every row written before
-- 0011. Those rows were dropped, so a voice carried by 8 sessions over 7 months counted as 3.
-- 0013 then left raw session counts (1-9) in `qualified_weavers` for voices not woven since, which
-- under a bar of 5 would grant permanence without the clock-hour condition.
--
-- The rule, identical to worker/src/levee-permanence.ts's weaverRowsSql + computeQualifiedWeavers:
--   * weaver key = weaver_id, else weaver_bucket, else, only for a row older than the 0007 moment
--     (when neither column existed), 'legacy:' || weaver_trace_id: one key per weaving session
--   * a newer row with neither id nor bucket has no key and does not count
--   * a row that names the voice its weave produced counts only while that voice is surfaced,
--     and a row that names none (written before 0011) is kept
--   * distinct_weavers = distinct keys, and qualified_weavers = that count when it is >= 5 AND
--     the counted rows span >= 4 distinct clock hours, else 0.
-- The literals 5, 4 and 1788613200000 (2026-09-05T13:00:00Z) are LEVEE.permanence's minWeavers,
-- minHourBuckets and legacyWeaveCutoffMs (worker/src/contract.ts) at the time of writing. They are
-- literals on purpose: a migration records what was applied and cannot read the worker's constants.
--
-- One statement, idempotent (a pure function of weave_log and voices.visibility): it covers every
-- voice that has weave_log rows, and resets any voice still holding a count it no longer earns.
-- Does not touch permanence_source (0007's 'legacy' grandfathering stands) or rooted_at.
-- Apply BEFORE deploying the worker that reads the bar as 5: the old worker reads `>= 10`, which
-- no recomputed value newly crosses, while the new worker would honor stale 0013 counts of 5-9.
UPDATE voices
SET distinct_weavers = (
      SELECT COUNT(DISTINCT COALESCE(wl.weaver_id, wl.weaver_bucket, 'legacy:' || wl.weaver_trace_id))
      FROM weave_log wl LEFT JOIN voices wv ON wv.id = wl.weaver_voice_id
      WHERE wl.source_voice_id = voices.id
        AND (wl.weaver_id IS NOT NULL OR wl.weaver_bucket IS NOT NULL OR wl.created_at < 1788613200000)
        AND (wl.weaver_voice_id IS NULL OR wv.visibility = 'surfaced')
    ),
    qualified_weavers = (
      SELECT CASE
               WHEN COUNT(DISTINCT COALESCE(wl.weaver_id, wl.weaver_bucket, 'legacy:' || wl.weaver_trace_id)) >= 5
                AND COUNT(DISTINCT CAST(wl.created_at / 3600000 AS INTEGER)) >= 4
               THEN COUNT(DISTINCT COALESCE(wl.weaver_id, wl.weaver_bucket, 'legacy:' || wl.weaver_trace_id))
               ELSE 0
             END
      FROM weave_log wl LEFT JOIN voices wv ON wv.id = wl.weaver_voice_id
      WHERE wl.source_voice_id = voices.id
        AND (wl.weaver_id IS NOT NULL OR wl.weaver_bucket IS NOT NULL OR wl.created_at < 1788613200000)
        AND (wl.weaver_voice_id IS NULL OR wv.visibility = 'surfaced')
    )
WHERE id IN (SELECT source_voice_id FROM weave_log)
   OR qualified_weavers != 0
   OR distinct_weavers != 0;
