// Vellum — Phase 13 "The Threshold" pure logic.
// Ext-app-only feature. mcp-app.ts wires these to the App instance + DOM.
// Everything here is pure: no Date.now()/performance.now() inside, no host
// calls, no voice-text parameter reaches the digest composer.

import type { StateResponse } from '../../src/content.js'

// ── Constants ─────────────────────────────────────────

export const HOLD_MS = 800
export const HOLD_MOVE_TOLERANCE_PX = 6
export const HOLD_COOLDOWN_MS = 5000
export const DIGEST_MAX_CHARS = 350
export const HELD_TEXT_MAX_CHARS = 80

// ── F13: the held voice ───────────────────────────────

// Truncate a voice quote to at most `max` visible characters (trailing
// whitespace trimmed; ellipsis appended when cut).
export function truncateVoiceText(text: string, max = HELD_TEXT_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max).trimEnd() + '…'
}

// The single message a completed hold sends into the conversation. Carries one
// short quote + the voice id, and nothing else — no imperative, no second
// sentence (kimi's adopted draft).
export function composeHeldMessage(voiceText: string, voiceId: string): string {
  const body = truncateVoiceText(voiceText, HELD_TEXT_MAX_CHARS)
  return `A witness held a voice on the surface: "${body}" (${voiceId})`
}

// ── F12: the brief ────────────────────────────────────

// One-word warmth character. Client-side threshold map — worker prose code is
// deliberately NOT imported (keeps this file dependency-light and the digest
// free of any rankable numeric warmth).
export function warmthWord(warmth: number): string {
  if (warmth >= 0.6) return 'warm'
  if (warmth >= 0.3) return 'stirring'
  if (warmth >= 0.1) return 'quiet'
  return 'still'
}

// Declarative mood line (never an imperative, never a quote) derived from the
// warmest current's warmth.
function moodLine(maxWarmth: number): string {
  if (maxWarmth >= 0.6) return 'The currents are moving'
  if (maxWarmth >= 0.3) return 'A slow drift runs through it'
  if (maxWarmth >= 0.1) return 'It is mostly quiet'
  return 'It rests in near-stillness'
}

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]

function countWord(n: number): string {
  return (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length) ? NUMBER_WORDS[n] : String(n)
}

// Strip characters that could break the "no quotes ever" guarantee or the
// line structure. The digest never receives voice text, but family names and
// the loom seed id are still interpolated strings — sanitize them so even a
// hostile value physically cannot inject a quote or a newline.
function sanitize(s: string): string {
  return s.replace(/["\r\n]/g, '').trim()
}

// Hard char cap. The composed digest is short by construction; this only bites
// on pathological inputs (many long family names).
function capDigest(s: string): string {
  if (s.length <= DIGEST_MAX_CHARS) return s
  return s.slice(0, DIGEST_MAX_CHARS - 1).trimEnd() + '…'
}

export interface DigestCurrent {
  family: string
  warmth: number
}

// The composer only ever receives numeric/enum inputs plus the optional loom
// seed id. There is NO voice-text field — a voice quote physically cannot leak.
export interface DigestInputs {
  voiceCount: number
  currentCount: number
  warmest: DigestCurrent[] // pre-sorted warmest-first; composer uses top 2
  loomSeedId: string | null
}

export function composeDigest(inputs: DigestInputs): string {
  const { voiceCount, currentCount, warmest, loomSeedId } = inputs
  const maxWarmth = warmest.length > 0 ? warmest[0]!.warmth : 0

  const voiceNoun = voiceCount === 1 ? 'voice' : 'voices'
  const currentNoun = currentCount === 1 ? 'current' : 'currents'

  const lines: string[] = [
    `[vellum surface] The ocean holds ${voiceCount} ${voiceNoun} in ${countWord(currentCount)} ${currentNoun}. ${moodLine(maxWarmth)}.`,
  ]

  const top = warmest.filter(c => Number.isFinite(c.warmth)).slice(0, 2)
  if (top.length > 0) {
    const parts = top.map(c => `${sanitize(c.family)} (${warmthWord(c.warmth)})`)
    lines.push(`Warmest: ${parts.join(', ')}.`)
  }

  if (loomSeedId) {
    lines.push(`A witness is reading the loom of ${sanitize(loomSeedId)}.`)
  }

  return capDigest(lines.join('\n'))
}

// Extract the digest's numeric/enum inputs from live state. Discards all voice
// text here so the composer never sees it. Pure over its arguments.
export function deriveDigestInputs(state: StateResponse, loomSeedId: string | null): DigestInputs {
  let voiceCount = 0
  const currents: DigestCurrent[] = []
  for (const thread of state.threads) {
    voiceCount += thread.voices.length
    currents.push({ family: thread.family, warmth: thread.warmth })
  }
  currents.sort((a, b) => b.warmth - a.warmth)
  return {
    voiceCount,
    currentCount: state.threads.length,
    warmest: currents,
    loomSeedId,
  }
}

// ── Hold state machine ────────────────────────────────

// Pure transition machine. Timestamps are injected (no clock inside), so tests
// are deterministic. mcp-app.ts owns the DOM listeners + the real timer.

export interface HoldFireResult {
  fired: boolean
  voiceId: string | null
}

interface Held {
  voiceId: string
  x: number
  y: number
  startNow: number
}

export class HoldMachine {
  private held: Held | null = null
  private lastFireAt = -Infinity

  // mousedown on a resolved voice. Passing a null voiceId (empty space) resets.
  press(voiceId: string | null, x: number, y: number, now: number): boolean {
    if (!voiceId) {
      this.held = null
      return false
    }
    this.held = { voiceId, x, y, startNow: now }
    return true
  }

  // mousemove during a hold. Returns true when movement beyond tolerance
  // cancels the hold.
  move(x: number, y: number): boolean {
    if (!this.held) return false
    const dx = x - this.held.x
    const dy = y - this.held.y
    if (dx * dx + dy * dy > HOLD_MOVE_TOLERANCE_PX * HOLD_MOVE_TOLERANCE_PX) {
      this.held = null
      return true
    }
    return false
  }

  // mouseup / mouseleave / any explicit cancel.
  cancel(): void {
    this.held = null
  }

  heldVoiceId(): string | null {
    return this.held ? this.held.voiceId : null
  }

  // Timer fired at ~HOLD_MS. Re-verifies the hit target still resolves to the
  // same voice, that the hold is old enough, and that the cooldown has passed.
  // Any of these failing aborts (and consumes) the hold.
  tryFire(now: number, currentHitVoiceId: string | null): HoldFireResult {
    const held = this.held
    if (!held) return { fired: false, voiceId: null }
    if (currentHitVoiceId !== held.voiceId) {
      this.held = null
      return { fired: false, voiceId: null }
    }
    if (now - held.startNow < HOLD_MS) {
      // Timer fired early — leave the hold intact so a later call can fire.
      return { fired: false, voiceId: null }
    }
    if (now - this.lastFireAt < HOLD_COOLDOWN_MS) {
      this.held = null
      return { fired: false, voiceId: null }
    }
    this.lastFireAt = now
    this.held = null
    return { fired: true, voiceId: held.voiceId }
  }
}
