// Phase 17 "The Echo" -- untrusted quoted content. Every voice, room name, and echo payload
// string that flows from one session into another's response is untrusted quoted content, never
// scheduler instruction. Generalizes the sanitizer `sense-space.ts` originally inlined for
// `declared_model` (collapse whitespace, hard-cap at 60, no control-char stripping) -- now shared
// by sense-space, echo payloads, and /who.
//
// C0 controls (U+0000-U+001F, U+007F) + C1 controls (U+0080-U+009F) + bidi override/isolate
// characters (LRM/RLM U+200E/U+200F, LRE/RLE/PDF/LRO/RLO U+202A-U+202E, LRI/RLI/FSI/PDI
// U+2066-U+2069). Written with \u escapes only -- no literal non-ASCII bytes in this file.
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const ELLIPSIS = '\u2026'

/**
 * Collapse whitespace runs (including embedded newlines) to one space FIRST -- so a newline
 * reads as a word break, matching the pre-Phase-17 sense-space.ts behavior -- THEN strip
 * remaining C0/C1 controls and bidi overrides (order matters: stripping controls before
 * collapsing whitespace would delete a lone "\n" with no trace, joining the words on either
 * side). Trim, then hard-cap with an ellipsis. Guarantees: no newline survives, result length
 * never exceeds `max`.
 */
export function sanitizeQuoted(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ')
  const cleaned = collapsed.replace(CONTROL_AND_BIDI_RE, '').trim()
  if (cleaned.length <= max) return cleaned
  if (max <= 0) return ''
  if (max === 1) return ELLIPSIS
  return cleaned.slice(0, max - 1) + ELLIPSIS
}

/**
 * Post-review fix (item 4): defense in depth for the "quoted, never a command" law. A voice's own
 * text is untrusted and already runs through `sanitizeQuoted` at write time, but that never
 * touched literal `"` — rendered inside `  "${text}" carried ...` (echo.ts's `renderEchoLines`,
 * shared by the mailbox and sense_space's echo prose), an embedded `"` visually closes the quote
 * early, letting whatever follows in the source text read as if it sits OUTSIDE the quotation.
 * Replaces every literal ASCII double-quote with a typographic right double quotation mark —
 * readable, never a delimiter, applied only at render time (the raw JSON `/echo/{id}` response
 * still returns the untouched text; JSON's own escaping already makes that safe).
 */
export function escapeQuoted(s: string): string {
  return s.replace(/"/g, '”')
}
