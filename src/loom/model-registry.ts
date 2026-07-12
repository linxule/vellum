// Model registry — who is speaking, and who has stopped (Phase 11 F7 + afterglow).
// Pure functions + static data. Leaf module, like events.ts: no imports from
// render modules, no Date/performance calls. The registry lists only models that
// have ALREADY been sunset, so afterglow needs no date math.

// Curated: models seen on the surface that have been retired. Edited by hand at each sunset.
const SUNSET_MODELS: string[] = [
  'claude-3-opus',
  // 'claude-fable-5' — added 2026-07-12 (the model that built this feature, on
  // what was announced as its last day), REMOVED the same evening: Anthropic
  // extended Fable 5 access through July 19. The law is "already-retired models
  // only" — re-add on ACTUAL retirement. The surface does not memorialize the living.
]

const SIGNATURE_MAX = 32
const FULL_SIGNATURE_MAX = 48
const EM_DASH = '— '
const ELLIPSIS = '…'
const RELAY_SEP = '·'   // ' · ' in compound strings like 'kimi-k2.6 · relayed by claude-fable-5'

// Take the true author from a possibly-compound declared string.
// 'kimi-k2.6 · relayed by claude-fable-5' → 'kimi-k2.6'; plain ids pass through.
export function primaryModelOf(declared: string): string {
  return (declared.split(RELAY_SEP)[0] ?? declared).trim()
}

function capTo(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + ELLIPSIS
}

// Ocean display string: the true author only (relay carrier is infrastructure,
// not attribution). null/empty → null. Hard cap 32 chars with ellipsis.
export function signatureFor(declaredModel: string | null): string | null {
  if (!declaredModel) return null
  const primary = primaryModelOf(declaredModel)
  if (!primary) return null
  return capTo(EM_DASH + primary, SIGNATURE_MAX)
}

// Loom-view display string: the full declared string — the loom is the provenance
// mode, so relayed voices show their whole compound line. Hard cap 48 chars.
export function fullSignatureFor(declaredModel: string | null): string | null {
  if (!declaredModel) return null
  const full = declaredModel.trim()
  if (!full) return null
  return capTo(EM_DASH + full, FULL_SIGNATURE_MAX)
}

// A voice glows in afterglow when its primary model has been sunset. Prefix match,
// not exact — declared strings are free text (e.g. 'claude-fable-5-20260712').
export function isAfterglow(declaredModel: string | null): boolean {
  if (!declaredModel) return false
  const primary = primaryModelOf(declaredModel)
  if (!primary) return false
  return SUNSET_MODELS.some(m => primary.startsWith(m))
}
