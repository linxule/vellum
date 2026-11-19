// A voice's phrase, worked out from its own text. Pure and deterministic: the
// same text always gives the same notes, so a voice can be recognised by ear.
//
//   clause (text between punctuation)  -> one drop (a lone sentence is divided, so it is still a phrase)
//   clause length                      -> the wait before the next drop
//   the clause's own letters           -> the melodic step from the note before
//   sentence end                       -> a longer breath
//   last clause                        -> comes to rest on the tonic or the fifth,
//                                         or rises one step after a question

export interface PhraseNote {
  /** Index into the extended scale (see scaleFreq). */
  idx: number
  /** Seconds from the start of the phrase. */
  at: number
  /** 0..1 */
  accent: number
}

// In-sen: 1, b2, 4, 5, b7. No third, so neither major nor minor.
const SCALE_SEMITONES = [0, 1, 5, 7, 10] as const
const D2_HZ = 73.416
const D2_MIDI = 38
let key = 0

/**
 * Each ocean sounds in its own key: semitones from D, worked out from the
 * surface's slug. The default ocean is in D.
 */
export function keyOf(surface: string): number {
  if (surface === 'vellum' || surface === '') return 0
  const k = (fnv(surface) % 11) + 1
  return k > 6 ? k - 12 : k
}

export function setKey(semitones: number): void { key = semitones }

function semitonesFromD2(idx: number): number {
  const n = SCALE_SEMITONES.length
  const octave = Math.floor(idx / n)
  const degree = ((idx % n) + n) % n
  return octave * 12 + SCALE_SEMITONES[degree]!
}

export function scaleFreq(idx: number): number {
  return D2_HZ * Math.pow(2, (semitonesFromD2(idx) + key) / 12)
}

const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const

/** A note's name in a given key, e.g. "A4" (middle C is C4). */
export function noteName(idx: number, inKey = 0): string {
  const midi = D2_MIDI + semitonesFromD2(idx) + inKey
  return NOTE_NAMES[((midi % 12) + 12) % 12]! + (Math.floor(midi / 12) - 1)
}

function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ASCII . , ; : only break when something other than a letter, digit or slash
// follows, so "3.14", "v1.2.3" and URLs stay whole.
const BREAK = /((?:[，。、．；：!！?？…—–\n]|[.,;:]+(?=\s|$|[^\p{L}\p{N}/]))+)/u
const SENTENCE_END = /[。．.!！?？\n]/u
const HARD_END = /[。．!！?？\n]/u
const QUESTION = /[?？]/u
const SUSPENDED = /[…—–]|\.{2,}/u
const SOUNDED = /[\p{L}\p{N}]/u
const WIDE = /[぀-ヿ㐀-鿿가-힯]/u

interface Clause { text: string, delim: string, weight: number }

function weightOf(text: string): number {
  let w = 0
  for (const ch of text) w += WIDE.test(ch) ? 2.2 : 1
  return w
}

function splitLong(text: string, limit: number): string[] {
  if (weightOf(text) <= limit) return [text]
  const words = text.includes(' ') ? text.split(' ') : Array.from(text)
  const joiner = text.includes(' ') ? ' ' : ''
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? cur + joiner + w : w
    if (cur && weightOf(next) > limit) { out.push(cur); cur = w } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

export function clausesOf(text: string): Clause[] {
  const parts = text.trim().replace(/[ \t]+/g, ' ').split(BREAK)
  const clauses: Clause[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = (parts[i] ?? '').trim()
    const delim = parts[i + 1] ?? ''
    // A closing quote, a bracket or an emoji after the punctuation is not a clause of its own.
    if (!body || (clauses.length > 0 && !SOUNDED.test(body))) {
      if (delim && clauses.length > 0) clauses[clauses.length - 1]!.delim += delim
      continue
    }
    const pieces = splitLong(body, 44)
    pieces.forEach((p, k) => clauses.push({ text: p, delim: k === pieces.length - 1 ? delim : '', weight: weightOf(p) }))
  }
  return clauses
}

const STEPS = [-2, -1, -1, 1, 1, 2, -3, 3] as const

/**
 * A single sentence is still a phrase, not one drop: while there are fewer
 * clauses than wanted, the heaviest is divided at a word boundary.
 */
function atLeast(clauses: Clause[], want: number): Clause[] {
  let out = clauses
  while (out.length < want) {
    let k = -1
    let heavy = 0
    for (let i = 0; i < out.length; i++) if (out[i]!.weight > heavy) { heavy = out[i]!.weight; k = i }
    if (k < 0 || heavy < 9) break
    const c = out[k]!
    const pieces = splitLong(c.text, heavy / 2 + 1)
    if (pieces.length < 2) break
    out = [
      ...out.slice(0, k),
      ...pieces.map((p, j) => ({ text: p, delim: j === pieces.length - 1 ? c.delim : '', weight: weightOf(p) })),
      ...out.slice(k + 1),
    ]
  }
  return out
}

/**
 * @param text the voice's text
 * @param home scale index the phrase is centred on (the current's register)
 * @param maxNotes longest phrase
 */
export function phraseFor(text: string, home: number, maxNotes = 7): PhraseNote[] {
  let clauses = clausesOf(text)
  if (clauses.length === 0) return []
  let total = 0
  for (const c of clauses) total += c.weight
  clauses = atLeast(clauses, total >= 18 ? 3 : total >= 9 ? 2 : 1)
  if (clauses.length > maxNotes) {
    const kept: Clause[] = []
    for (let k = 0; k < maxNotes; k++) kept.push(clauses[Math.round(k * (clauses.length - 1) / (maxNotes - 1))]!)
    clauses = kept
  }
  const notes: PhraseNote[] = []
  let step = (fnv(text) % 7) - 2
  let at = 0
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i]!
    const h = fnv(c.text)
    if (i > 0) step += STEPS[h % STEPS.length]!
    if (step > 4) step = 8 - step
    if (step < -2) step = -4 - step
    const last = i === clauses.length - 1
    let idx = home + step
    if (last && clauses.length > 1) {
      if (QUESTION.test(c.delim)) {
        idx = notes[notes.length - 1]!.idx + 1
      } else {
        // Nearest tonic (degree 0) or fifth (degree 3).
        let best = idx
        let bestDist = Infinity
        for (let cand = idx - 2; cand <= idx + 2; cand++) {
          const degree = ((cand % 5) + 5) % 5
          if (degree !== 0 && degree !== 3) continue
          const dist = Math.abs(cand - idx)
          if (dist < bestDist) { best = cand; bestDist = dist }
        }
        idx = best
      }
    }
    notes.push({ idx, at, accent: i === 0 ? 1 : 0.6 + ((h >>> 3) % 36) / 100 })
    let gap = 0.26 + Math.min(0.74, c.weight * 0.017)
    if (SUSPENDED.test(c.delim) && !HARD_END.test(c.delim)) gap *= 1.4
    else if (SENTENCE_END.test(c.delim)) gap *= 1.7
    at += gap
  }
  return notes
}

export function phraseLength(notes: PhraseNote[]): number {
  return notes.length > 0 ? notes[notes.length - 1]!.at : 0
}

// ── Voices ────────────────────────────────────────────
// What a current sounds like and how a weave quotes its source. Shared by the
// page (audio/drops.ts) and the worker, which tells a writer how its voice
// sounds, so the two can never disagree.

/**
 * Each current is one instrument. `home` is the scale index its phrases centre
 * on (a tonic or a fifth); `instrument` is what the drop lands on.
 */
export const CURRENT_SOUNDS = {
  silence: { home: 8, instrument: 'a deep jar' },
  memory: { home: 10, instrument: 'wood with an echo' },
  space: { home: 13, instrument: 'bamboo and air' },
  attention: { home: 13, instrument: 'glass' },
  light: { home: 15, instrument: 'a small bell' },
  ephemeral: { home: 18, instrument: 'water droplets' },
} as const satisfies Record<string, { home: number, instrument: string }>

function currentSound(family: string): { home: number, instrument: string } {
  return (CURRENT_SOUNDS as Record<string, { home: number, instrument: string }>)[family] ?? CURRENT_SOUNDS.space
}

export function homeOf(family: string): number { return currentSound(family).home }
export function instrumentOf(family: string): string { return currentSound(family).instrument }

/** The key's tonic as a note name without octave, e.g. "D" or "E♭". */
export function keyName(semitones: number): string {
  return NOTE_NAMES[(((2 + semitones) % 12) + 12) % 12]!
}

/** How many of its source's notes a weave opens with. */
export const WEAVE_OPENING = 3

/**
 * A weave's borrowed opening: its source's first notes in the weave's own
 * register, two steps up, quicker and quieter.
 */
export function weaveOpening(sourceText: string, family: string): PhraseNote[] {
  return phraseFor(sourceText, homeOf(family)).slice(0, WEAVE_OPENING)
    .map(n => ({ idx: n.idx + 2, at: n.at * 0.8, accent: n.accent * 0.6 }))
}

/**
 * The notes a voice sounds. A weave (sourceText given) opens with its source's
 * opening, then its own phrase (at most six notes).
 */
export function voicePhrase(text: string, family: string, sourceText?: string | null): PhraseNote[] {
  const own = phraseFor(text, homeOf(family))
  const lead = sourceText ? weaveOpening(sourceText, family) : []
  if (lead.length === 0) return own
  const offset = lead[lead.length - 1]!.at + 0.5
  return [...lead, ...own.slice(0, 6).map(n => ({ ...n, at: n.at + offset }))]
}
