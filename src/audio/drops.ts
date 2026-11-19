// The drop instrument (sketch). Plain Web Audio, no pattern engine.
//
// Rest is near silence. Sound happens where attention is: a voice under the
// lens sounds its phrase (audio/phrase.ts), one drop per clause. Every note is a
// water drop landing on something: a short rising "plip", then the ring of what
// it hit, in a long room.
//
//   current  -> what the drop lands on (TIMBRE) and its register
//   depth    -> distance (darker, wetter)
//   afterglow-> no beat: the tone is still
//   a weave  -> opens with its source's first notes, moved up two steps

import { homeOf, phraseFor, phraseLength, scaleFreq, voicePhrase, type PhraseNote } from './phrase.js'

// Each current's register, instrument name and the weave rule live in phrase.ts
// (pure), so the worker can tell a writer exactly what this file plays.

export interface DropVoice {
  id: string
  text: string
  family: string
  depth: number
  weaveFrom: string | null
  weaveCount: number
  afterglow: boolean
}

export interface DropPoint { x: number, y: number }
export type DropListener = (family: string, point: DropPoint, strength: number) => void

// One instrument family, six materials. Every current shares the scale, the
// room, the struck-and-decaying shape and the water transient; what the drop
// lands on differs.
// The register each current's phrases centre on is CURRENT_SOUNDS[family].home
// in phrase.ts.
interface Timbre {
  attack: number
  /** Seconds for the fundamental to die away. */
  decay: number
  /** Loudness trim, so the six sit level with each other. */
  level: number
  /** [frequency ratio, amplitude, decay as a fraction of `decay`] */
  partials: ReadonlyArray<readonly [number, number, number]>
  /** Detune of a second fundamental, for a slow beat. 0 = none. */
  beat: number
  /** The water transient, 0..1. */
  plip: number
  /** Air: noise through a narrow band at the note. */
  breath: number
  /** A dull knock at the onset. */
  knock: number
  /** Small drops just before the note. */
  grace: number
  wet: number
  echo: number
}

const TIMBRE: Record<string, Timbre> = {
  // The jar itself: low, round, slow to speak, longest to fade.
  silence: { attack: 0.018, decay: 4.4, level: 1.15, partials: [[1, 1, 1], [0.5, 0.22, 0.9], [2, 0.16, 0.6]], beat: 0.0025, plip: 0.12, breath: 0, knock: 0, grace: 0, wet: 0.55, echo: 0 },
  // Wood: a knock, a warm bar tone that dies quickly, and an echo. Memory repeats.
  memory: { attack: 0.003, decay: 1.5, level: 1.25, partials: [[1, 1, 1], [3.93, 0.3, 0.14], [9.6, 0.08, 0.06]], beat: 0, plip: 0.1, breath: 0, knock: 0.5, grace: 0, wet: 0.45, echo: 0.34 },
  // Bamboo and air: a breathy tone with hollow (odd) overtones in a wide room.
  space: { attack: 0.045, decay: 2.6, level: 1.0, partials: [[1, 1, 1], [3, 0.16, 0.5], [5, 0.05, 0.3]], beat: 0.004, plip: 0.15, breath: 0.9, knock: 0, grace: 0, wet: 0.75, echo: 0 },
  // Glass: a clean, exact tap.
  attention: { attack: 0.002, decay: 2.0, level: 0.9, partials: [[1, 1, 1], [2.76, 0.3, 0.45], [5.4, 0.12, 0.25], [8.93, 0.04, 0.15]], beat: 0.002, plip: 0.45, breath: 0, knock: 0, grace: 0, wet: 0.4, echo: 0 },
  // A small bell: paired overtones that shimmer as they fade.
  light: { attack: 0.003, decay: 3.2, level: 0.85, partials: [[1, 1, 1], [2.0, 0.42, 0.8], [2.008, 0.3, 0.8], [3.01, 0.2, 0.55], [4.2, 0.08, 0.35]], beat: 0.003, plip: 0.3, breath: 0, knock: 0, grace: 0, wet: 0.55, echo: 0 },
  // Water alone: a scatter of droplets, gone almost at once.
  ephemeral: { attack: 0.002, decay: 0.5, level: 1.6, partials: [[1, 0.8, 1], [2.4, 0.12, 0.5]], beat: 0, plip: 1, breath: 0, knock: 0, grace: 2, wet: 0.65, echo: 0 },
}
const DEFAULT_TIMBRE = TIMBRE.space!

export function timbreFor(family: string): Timbre { return TIMBRE[family] ?? DEFAULT_TIMBRE }

/** The notes a voice sounds, including the borrowed opening of a weave. */
export function notesFor(voice: DropVoice, lookup: (id: string) => DropVoice | null): PhraseNote[] {
  const source = voice.weaveFrom ? lookup(voice.weaveFrom) : null
  return voicePhrase(voice.text, voice.family, source?.text)
}

let ac: AudioContext | null = null
let master: GainNode | null = null
let reverb: ConvolverNode | null = null
let echoIn: GainNode | null = null
let roomGain: GainNode | null = null
let on = false
let lookupVoice: (id: string) => DropVoice | null = () => null
let listener: DropListener = () => {}

const lastPlayed = new Map<string, number>()
let lensId: string | null = null
let lensSince = 0
let lensPlayedId: string | null = null
let nextIdleAt = 0
const timers = new Set<ReturnType<typeof setTimeout>>()

function buildImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate
      const env = Math.exp(-t * 2.1) * (1 - Math.exp(-t * 60))
      // The tail darkens as it decays.
      const k = 0.55 - 0.45 * Math.min(1, t / seconds)
      lp += ((Math.random() * 2 - 1) - lp) * k
      d[i] = lp * env
    }
  }
  return buf
}

function buildNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let brown = 0
  for (let i = 0; i < len; i++) {
    brown = (brown + (Math.random() * 2 - 1) * 0.04) * 0.996
    d[i] = brown * 3
  }
  return buf
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()
function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx)
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noiseBuffers.set(ctx, buf)
  }
  return buf
}

/** Builds the fixed part of the graph on any context (live or offline). */
export function buildGraph(ctx: BaseAudioContext): { master: GainNode, reverb: ConvolverNode, echoIn: GainNode, roomGain: GainNode } {
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -10
  limiter.ratio.value = 8
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
  limiter.connect(ctx.destination)

  // Take the edge off the top: small speakers make anything above this glassy.
  const soften = ctx.createBiquadFilter()
  soften.type = 'highshelf'
  soften.frequency.value = 4200
  soften.gain.value = -5
  soften.connect(limiter)

  const m = ctx.createGain()
  m.gain.value = 0.9
  m.connect(soften)

  const rv = ctx.createConvolver()
  rv.buffer = buildImpulse(ctx, 3.4)
  const rvOut = ctx.createGain()
  rvOut.gain.value = 0.55
  rv.connect(rvOut).connect(m)

  // Memory repeats itself: a soft echo that only its notes are sent to.
  const eIn = ctx.createGain()
  const delay = ctx.createDelay(1)
  delay.delayTime.value = 0.43
  const fb = ctx.createGain()
  fb.gain.value = 0.36
  const dark = ctx.createBiquadFilter()
  dark.type = 'lowpass'
  dark.frequency.value = 1900
  eIn.connect(delay).connect(dark).connect(fb).connect(delay)
  dark.connect(m)
  dark.connect(rv)

  // Room tone: barely there, so drops do not land in digital silence.
  const room = ctx.createGain()
  room.gain.value = 0.005
  const noise = ctx.createBufferSource()
  noise.buffer = buildNoise(ctx, 4)
  noise.loop = true
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 520
  band.Q.value = 0.5
  noise.connect(band).connect(room).connect(m)
  noise.start()

  return { master: m, reverb: rv, echoIn: eIn, roomGain: room }
}

export interface StrikeOptions {
  family: string
  idx: number
  accent: number
  depth: number
  pan: number
  still: boolean
  gain: number
  /** 0..1: how much the voice has been woven from. It rings longer and further into the room. */
  resonance?: number
}

/** One drop at time `t` (context time). */
export function strike(ctx: BaseAudioContext, graph: { master: AudioNode, reverb: AudioNode, echoIn: AudioNode }, t: number, o: StrikeOptions): void {
  const timbre = timbreFor(o.family)
  const f = scaleFreq(o.idx)
  const depth = Math.max(0, Math.min(1, o.depth))
  const resonance = Math.max(0, Math.min(1, o.resonance ?? 0))
  const peak = 0.2 * timbre.level * o.accent * o.gain * (1 - depth * 0.35)

  const bus = ctx.createGain()
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 9000 - depth * 7200
  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.max(-0.85, Math.min(0.85, o.pan))
  bus.connect(tone).connect(pan)
  const dry = ctx.createGain()
  dry.gain.value = 1 - depth * 0.4
  pan.connect(dry).connect(graph.master)
  const wet = ctx.createGain()
  wet.gain.value = Math.min(1, timbre.wet + depth * 0.3 + resonance * 0.18)
  pan.connect(wet).connect(graph.reverb)
  if (timbre.echo > 0) {
    const send = ctx.createGain()
    send.gain.value = timbre.echo
    pan.connect(send).connect(graph.echoIn)
  }

  let longest = 0
  const ring = (ratio: number, amp: number, decayFrac: number, detune: number) => {
    const dur = Math.max(0.2, timbre.decay * decayFrac * (1 + 0.6 * resonance))
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f * ratio * (1 + detune)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak * amp, t + timbre.attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + timbre.attack + dur)
    osc.connect(g).connect(bus)
    osc.start(t)
    osc.stop(t + timbre.attack + dur + 0.05)
    if (dur > longest) longest = dur
  }
  for (const [ratio, amp, decayFrac] of timbre.partials) ring(ratio, amp, decayFrac, 0)
  if (!o.still && timbre.beat > 0) ring(1, 0.5, 1, timbre.beat)

  // The plip: a small bubble closing, so the pitch rises. Quieter as it gets
  // higher, where it would otherwise turn sharp.
  const p0 = Math.max(700, Math.min(2200, f * 2.2))
  const plipPeak = peak * 0.55 * timbre.plip * Math.min(1, 950 / p0)
  const drip = (at: number, pitch: number, amount: number) => {
    if (amount <= 0.0002) return
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(pitch, at)
    osc.frequency.exponentialRampToValueAtTime(pitch * 1.9, at + 0.022)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(amount, at + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.055)
    osc.connect(g).connect(bus)
    osc.start(at)
    osc.stop(at + 0.07)
  }
  drip(t, p0, plipPeak)
  for (let k = 1; k <= timbre.grace; k++) drip(Math.max(0, t - 0.07 * k), p0 * (1 + 0.22 * k), plipPeak * 0.45)

  if (timbre.breath > 0 || timbre.knock > 0) {
    const burst = (filter: BiquadFilterNode, amount: number, rise: number, fall: number) => {
      const src = ctx.createBufferSource()
      src.buffer = whiteNoise(ctx)
      src.loop = true
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(amount, t + rise)
      g.gain.exponentialRampToValueAtTime(0.0001, t + rise + fall)
      src.connect(filter).connect(g).connect(bus)
      src.start(t, Math.random() * 0.5)
      src.stop(t + rise + fall + 0.05)
    }
    if (timbre.breath > 0) {
      const band = ctx.createBiquadFilter()
      band.type = 'bandpass'
      band.frequency.value = f
      band.Q.value = 24
      burst(band, peak * timbre.breath * 5, 0.035, 0.9)
    }
    if (timbre.knock > 0) {
      const low = ctx.createBiquadFilter()
      low.type = 'lowpass'
      low.frequency.value = Math.min(900, f * 2)
      burst(low, peak * timbre.knock * 2.4, 0.001, 0.04)
    }
  }

  // Free the note's nodes once everything has rung out (live contexts only).
  if ('setTimeout' in globalThis && ctx instanceof AudioContext) {
    const ms = (t - ctx.currentTime + longest + 4.5) * 1000
    const id = setTimeout(() => { timers.delete(id); try { pan.disconnect(); dry.disconnect(); wet.disconnect() } catch { /* already gone */ } }, Math.max(0, ms))
    timers.add(id)
  }
}

export function configureDrops(opts: { lookup: (id: string) => DropVoice | null, onDrop: DropListener }): void {
  lookupVoice = opts.lookup
  listener = opts.onDrop
  nextIdleAt = performance.now() + 4000
}

// Off means off: the context is suspended once the last notes have rung out,
// so a tab left open with sound off does no audio work.
const SUSPEND_AFTER_MS = 8000
let suspendTimer: ReturnType<typeof setTimeout> | null = null

function setOn(value: boolean): void {
  on = value
  try { localStorage.setItem('vellum-sound', on ? 'on' : 'off') } catch { /* private mode */ }
  if (!ac || !master) return
  if (suspendTimer !== null) { clearTimeout(suspendTimer); suspendTimer = null }
  if (on) {
    if (ac.state !== 'running' && ac.state !== 'closed') void ac.resume()
    master.gain.setTargetAtTime(0.9, ac.currentTime, 0.05)
    nextIdleAt = performance.now() + 2500
  } else {
    master.gain.setTargetAtTime(0, ac.currentTime, 0.08)
    suspendTimer = setTimeout(() => { suspendTimer = null; if (!on && ac) void ac.suspend() }, SUSPEND_AFTER_MS)
  }
}

export async function initDrops(): Promise<boolean> {
  try {
    if (!ac) {
      ac = new AudioContext({ latencyHint: 'interactive' })
      const graph = buildGraph(ac)
      master = graph.master
      reverb = graph.reverb
      echoIn = graph.echoIn
      roomGain = graph.roomGain
    }
    if (ac.state === 'suspended') await ac.resume()
  } catch (e) {
    console.error('[vellum] drops init failed (silent fallback):', e)
    return false
  }
  setOn(true)
  return true
}

export function dropsReady(): boolean { return ac !== null }
/** For the ?probe readout: the audio context's state, or 'none' before the first start. */
export function dropsAudioState(): string { return ac ? ac.state : 'none' }
export function dropsOn(): boolean { return on }
/** After a tab switch, a phone lock or an audio interruption. */
export function resumeDrops(): void { if (on && ac && ac.state !== 'running' && ac.state !== 'closed') void ac.resume() }

export function toggleDrops(): boolean {
  if (!ac || !master) return false
  setOn(!on)
  return on
}

// ── Schedule ──────────────────────────────────────────
// Notes wait in a queue and are handed to the audio clock only a moment before
// they fall, once per frame. So a phrase can be stopped (the lens moved on, the
// loom view closed), nothing plays late after the page was away, and a note's
// ring on the wash comes from the same entry as its sound.

/** What a phrase belongs to; each can be stopped on its own. */
export type DropGroup = 'lens' | 'passage' | 'lineage' | 'idle'

interface Pending {
  due: number
  id: string
  voice: DropVoice
  note: PhraseNote
  gain: number
  point: () => DropPoint | null
  group: DropGroup
  struck: boolean
  /** The ring's strength over the note's (a tap's drop is heard quietly and seen fully). Default 1. */
  ring?: number
  /**
   * A tap's note may be heard late: the tap that drops it is often the gesture that starts the
   * sound, which takes a moment. Its ring falls on time; the note waits, unstruck, until the
   * audio runs or STALE_MS has passed, and then sounds at the same point.
   */
  waits?: boolean
  rung?: boolean
}

/** Time for the grace drops that fall just before a note. */
const LEAD_MS = 200
const LOOKAHEAD_MS = 200
/** A note this late (hidden tab, long stall) is dropped, not played in a bunch. */
const STALE_MS = 300
let queue: Pending[] = []

export interface PlayOptions {
  /** Where the drops land on screen, read at each note. */
  point: () => DropPoint | null
  gain?: number
  delay?: number
  /** Only the first n notes. */
  first?: number
  group?: DropGroup
  /** The voice's own phrase, without the opening a weave borrows from its source. */
  own?: boolean
}

/** Five weaves is as resonant as a voice gets. */
function resonanceOf(voice: DropVoice): number { return Math.min(1, Math.max(0, voice.weaveCount) / 5) }

/** Queues a voice's phrase. Returns its length in seconds (0 if it has no notes). */
export function playVoice(id: string, o: PlayOptions): number {
  const voice = lookupVoice(id)
  if (!voice) return 0
  let notes = o.own ? phraseFor(voice.text, homeOf(voice.family)) : notesFor(voice, lookupVoice)
  if (o.first) notes = notes.slice(0, o.first)
  if (notes.length === 0) return 0
  const base = performance.now() + LEAD_MS + (o.delay ?? 0) * 1000
  const group = o.group ?? 'idle'
  for (const note of notes) queue.push({ due: base + note.at * 1000, id, voice, note, gain: o.gain ?? 1, point: o.point, group, struck: false })
  if (!o.first) {
    // Only recent plays matter (recentlyPlayed): drop the old ones now and then.
    if (lastPlayed.size > 200) for (const [key, at] of lastPlayed) if (base - at > 120000) lastPlayed.delete(key)
    lastPlayed.set(id, base)
  }
  return phraseLength(notes)
}

/** Stops the notes of a group that have not fallen yet. A voice cut short may be heard again. */
export function cancelDrops(group: DropGroup): void {
  if (queue.length === 0) return
  const kept: Pending[] = []
  for (const p of queue) {
    if (p.group !== group || p.struck) kept.push(p)
    else lastPlayed.delete(p.id)
  }
  queue = kept
}

/** A tap's drop is heard quieter than a voice's notes... */
export const TAP_GAIN = 0.6
/** ...and seen as a full drop: its ring's strength. */
export const TAP_RING = 1
/** The lens phrase that follows a tap's drop starts no sooner than this after it. */
export const TAP_PHRASE_GAP_MS = 600
let tapAt = Number.NEGATIVE_INFINITY

/** A tap's note: the tonic at or below the current's home, so it sits in the current's own register. */
export function tapNoteIdx(family: string): number {
  const home = homeOf(family)
  return home - (((home % 5) + 5) % 5)
}

/**
 * A tap opened a current: one drop falls at the finger, now. One quiet note, the
 * current's tonic on its own instrument, and its ring, from the same queue entry
 * as every other drop (without an AudioContext the ring still falls; if the tap
 * itself is starting the sound, the note follows the ring once it can, within
 * STALE_MS, at the same point: `waits`). What the
 * lens was playing stops here; the opened voice's phrase follows (tickDrops),
 * no sooner than TAP_PHRASE_GAP_MS after.
 */
export function dropTap(family: string, point: DropPoint): void {
  const now = performance.now()
  cancelDrops('lens')
  tapAt = now
  const id = `tap:${family}`
  queue.push({
    due: now, id, voice: { id, text: '', family, depth: 0, weaveFrom: null, weaveCount: 0, afterglow: false },
    note: { idx: tapNoteIdx(family), at: 0, accent: 1 }, gain: TAP_GAIN, ring: TAP_RING / TAP_GAIN, point: () => point, group: 'lens', struck: false, waits: true,
  })
}

export function dropsPending(group?: DropGroup): boolean {
  if (!group) return queue.length > 0
  for (const p of queue) if (p.group === group) return true
  return false
}

function pump(now: number, viewportWidth: number): void {
  if (queue.length === 0) return
  const live = on && ac !== null && master !== null && reverb !== null && echoIn !== null && ac.state === 'running'
  let kept = 0
  for (const p of queue) {
    if (now - p.due > STALE_MS) continue
    if (!p.struck && p.due - now < LOOKAHEAD_MS && (live || !p.waits)) {
      p.struck = true
      if (live) {
        const at = p.point()
        const pan = at ? (at.x / Math.max(1, viewportWidth)) * 2 - 1 : 0
        strike(ac!, { master: master!, reverb: reverb!, echoIn: echoIn! }, ac!.currentTime + Math.max(0, p.due - now) / 1000, {
          family: p.voice.family, idx: p.note.idx, accent: p.note.accent, depth: p.voice.depth, pan: pan * 0.8, still: p.voice.afterglow, gain: p.gain, resonance: resonanceOf(p.voice),
        })
      }
    }
    if (p.due <= now) {
      if (!p.rung) {
        p.rung = true
        const at = p.point()
        if (at) listener(p.voice.family, at, p.note.accent * p.gain * (p.ring ?? 1) * (1 + 0.4 * resonanceOf(p.voice)))
      }
      if (p.struck) continue
    }
    queue[kept++] = p
  }
  queue.length = kept
}

/** Test accessor: empties the schedule and forgets what the lens was on. */
export function resetDropsForTest(): void {
  queue = []
  lastPlayed.clear()
  lensId = null
  lensSince = 0
  lensSeenId = null
  lensSeenSince = 0
  lensPlayedId = null
  lensPoint = null
  tapAt = Number.NEGATIVE_INFINITY
  nextIdleAt = Number.POSITIVE_INFINITY
}

export function recentlyPlayed(id: string, withinMs: number): boolean {
  const at = lastPlayed.get(id)
  return at !== undefined && performance.now() - at < withinMs
}

export interface TickInput {
  lens: { id: string, x: number, y: number } | null
  viewportWidth: number
  proximity: number
  /** Picks a voice and a place for a stray drop at rest. */
  idle: () => { id: string, point: DropPoint } | null
}

const LENS_DWELL_MS = 300
const LENS_SETTLE_MS = 140
let lensSeenId: string | null = null
let lensSeenSince = 0
/** The lens may lose its voice for a moment (a gap between voices) without the phrase stopping. */
const LENS_LEAVE_MS = 500
const LENS_REPLAY_MS = 9000
let lensPoint: DropPoint | null = null

/** Once per frame. */
export function tickDrops(input: TickInput): void {
  const now = performance.now()
  if (on && ac && roomGain && ac.state === 'running') roomGain.gain.setTargetAtTime(0.005 + input.proximity * 0.009, ac.currentTime, 0.3)

  // The voice under the lens flickers while the lens opens and the text
  // reflows, and where voices are short. A change counts only once it has
  // held for LENS_SETTLE_MS; shorter flickers leave the wait running.
  const seen = input.lens?.id ?? null
  if (seen !== lensSeenId) { lensSeenId = seen; lensSeenSince = now }
  if (seen !== lensId && (lensId === null || now - lensSeenSince >= LENS_SETTLE_MS)) { lensId = seen; lensSince = lensSeenSince }
  const id = lensId
  if (input.lens && seen === lensId) lensPoint = { x: input.lens.x, y: input.lens.y }
  if (id) {
    // The lens is the playhead: one phrase at a time, and the one before stops
    // when the next begins. An arrival is not talked over.
    if (lensPlayedId !== id && now - lensSince > LENS_DWELL_MS && !dropsPending('passage')) {
      lensPlayedId = id
      cancelDrops('lens')
      cancelDrops('lineage')
      if (!recentlyPlayed(id, LENS_REPLAY_MS)) {
        const at = lensPoint ? { x: lensPoint.x, y: lensPoint.y } : null
        // After a tap's drop, the phrase leaves it room.
        const delay = Math.max(0, tapAt + TAP_PHRASE_GAP_MS - now - LEAD_MS) / 1000
        playVoice(id, { group: 'lens', delay, point: () => { if (at && lensId === id && lensPoint) { at.x = lensPoint.x; at.y = lensPoint.y } return at } })
      }
    }
  } else if (lensPlayedId !== null && now - lensSince > LENS_LEAVE_MS) {
    lensPlayedId = null
    cancelDrops('lens')
  }

  if (now > nextIdleAt) {
    nextIdleAt = now + 6000 + Math.random() * 14000
    if (!id && queue.length === 0) {
      const pick = input.idle()
      if (pick) playVoice(pick.id, { point: () => pick.point, gain: 0.55, first: 1, group: 'idle' })
    }
  }

  pump(now, input.viewportWidth)
}
