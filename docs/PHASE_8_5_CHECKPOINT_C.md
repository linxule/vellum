# Phase C Checkpoint

- Report written: `docs/PHASE_8_5_ALLOC_REPORT.md`
- Main conclusion: Phase A removed the frame-level typed-array churn, but the dominant remaining JS allocation pressure is now the per-line bookkeeping inside `renderThread()` plus `voiceSpanForLine()`.
- Question for human before Phase D: should the low-volume `advanceLoom()` leftovers (`new Set()` on idle frames and the final `sortedThreadIndices.sort(...)` comparator closure) be treated as part of a future allocator-cleanup pass, or explicitly ignored in favor of the much larger line-layout churn?
