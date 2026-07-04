# Warmth Granularity Decision Memo

## 1. Current state

Warmth is already a family-level server signal. The `warmth_state` table is keyed by `family`, witness events aggregate into that family bucket, and the value decays with roughly a 24-hour half-life. What the user sees as ambient glow on a thread is therefore not a per-voice artifact; it is a family mood, reinforced by the client’s local touch-warmth. That is the right baseline because the visible surface is about collective presence, not fine-grained attribution.

## 2. The question

The question is whether warmth should move from family-level to voice-level so the system can claim finer attribution. That argument sounds precise, but precision is not the same thing as usefulness. Voice-level warmth would turn a shared ambient signal into a more brittle accounting layer, and the code would start treating visible glow as if it were a ledger of individual reads.

## 3. Why stay family-level for warmth-as-glow

The visible glow should stay family-level because it matches the metaphor the UI already uses. The surface is an atmosphere of attention, not a scoreboard. Families are the natural unit for that: they are stable enough to accumulate meaning, but broad enough to represent categories of attention rather than single-event micrology.

Family-level warmth also preserves continuity for new voices. A new voice should inherit the warmth of the family it joins immediately; it should arrive inside an already-warm space, not start from zero and have to earn a separate glow. That is the correct social reading of the interface, and it keeps the display legible as people and threads change over time.

Operationally, family-level warmth is simpler in every direction. The data model is smaller, the UI does not need to explain multiple overlapping warmth layers, and aggregation stays straightforward. The existing server-side rate limit of one witness per 60 seconds per IP already fits family-level aggregation cleanly; a per-voice warmth model would create a different rate shape for no visible benefit.

## 4. Why add voice-level dwell as separate telemetry

Voice-level dwell is still worth capturing, but as telemetry, not as glow. It answers a different question: which individual voices did someone actually spend time with? Family warmth erases that distinction, which is fine for rendering and wrong for analytics.

That separation also gives us room to tune sedimentation later. If dwell is visible as a durable signal in the data layer, a highly-dwelt voice could resist sinking or losing prominence faster, which makes “attention extends a voice’s lifespan” a real mechanic instead of an implied hope. Keeping it separate preserves that option without contaminating the visible warmth model.

It also supports future user-facing features like personal highlights. “Voices you spent time with today” is a meaningful product, and it should come from dwell telemetry, not from diluting the meaning of warmth itself.

## 5. Proposed schema

Add a lightweight `voice_dwell` table keyed on `(voice_id, date)` with a daily aggregate count. Witness events should write to it alongside the existing family warmth path.

This table must not feed back into warmth or glow. It is a read-optimized telemetry trail for future features and analysis, not a second visible warmth channel.

## 6. Implementation estimate

Small. This is one new table plus one additional write path in the witness flow. It does not require renderer changes, and it does not require rethinking the ambient-glow pipeline. The important part is the boundary: family warmth keeps driving what users see, and dwell telemetry stays a separate record of individual attention.

## 7. What not to do

Do not replace family-level warmth with voice-level warmth. Do not introduce voice-level warmth as a parallel visible signal. That would fragment the glow metaphor, make the UI harder to read, and conflate two distinct concepts.

The rule is simple: warmth = glow = family. Dwell = telemetry = voice. Keep those layers separate, and the system stays coherent.
