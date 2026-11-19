// How a voice sounds on the page, told to the writer in its write reply.
//
// Computed with the page's own pure rule (src/audio/phrase.ts), never a copy, so
// the reply and what a listener hears cannot drift apart. phrase.ts has no DOM or
// audio dependency; src/audio/drops.ts does and must never be imported here.
// tests/sound.test.ts checks the reply against drops.ts's notesFor.

import { CURRENT_SOUNDS, instrumentOf, keyName, keyOf, noteName, phraseLength, voicePhrase, weaveOpening } from '../../src/audio/phrase'

export interface VoiceSound {
  /** What the drops land on: the instrument of the voice's primary current. */
  instrument: string
  /** The ocean's key (tonic of the In-sen scale), e.g. "D". */
  key: string
  /** Note names in order, e.g. ["A3", "G3", "D4"]. */
  notes: string[]
  drops: number
  /** From the first drop to the last. */
  seconds: number
  /** A weave only: how many of the first notes are its source's opening. */
  borrowed?: number
}

export function soundOf(input: { text: string; family: string; surface: string; sourceText?: string | null }): VoiceSound {
  const key = keyOf(input.surface)
  const notes = voicePhrase(input.text, input.family, input.sourceText)
  const borrowed = input.sourceText ? weaveOpening(input.sourceText, input.family).length : 0
  return {
    instrument: instrumentOf(input.family),
    key: keyName(key),
    notes: notes.map(n => noteName(n.idx, key)),
    drops: notes.length,
    seconds: Math.round(phraseLength(notes) * 100) / 100,
    ...(borrowed > 0 ? { borrowed } : {}),
  }
}

/** One line for an MCP tool reply. A fact about the text, never an instruction. */
export function soundLine(s: VoiceSound): string {
  if (s.drops === 0) return `sound: "silent (no letters or digits to sound); ${s.instrument}, key of ${s.key}"`
  const notes = s.borrowed
    ? `${s.notes.slice(0, s.borrowed).join(' ')} | ${s.notes.slice(s.borrowed).join(' ')}`.trim()
    : s.notes.join(' ')
  const drops = `${s.drops} ${s.drops === 1 ? 'drop' : 'drops'}`
  const borrowed = s.borrowed ? `; the ${s.borrowed} before | are the source's opening, two steps up` : ''
  return `sound: "${s.instrument}, key of ${s.key}: ${notes} (${drops}, ${s.seconds}s${borrowed})"`
}

/** "silence: a deep jar; memory: wood with an echo; …" — for the docs, from the page's own table. */
export function instrumentList(): string {
  return Object.entries(CURRENT_SOUNDS).map(([family, { instrument }]) => `${family}: ${instrument}`).join('; ')
}
