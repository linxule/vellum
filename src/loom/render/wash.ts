// Ink washes under the text (sketch, paper look only).
//
// Each current is a band of floated ink that follows the thread's path: a few
// overlapping glazes with uneven edges and uneven strength, a darker tide line
// where the pigment settled, and hairline contours inside, as in suminagashi.
// Bands multiply, so two currents overprint where they cross. Where a current is
// read, clean water clears the pigment and pushes it into a rim (render/water.ts).
// A drop leaves a ring that spreads and fades; a phrase leaves one per note.
//
// Painted on its own low-resolution canvas beneath the text canvas, a few times
// a second. Reads loomState; never writes it.

import { clamp01 } from '../math.js'
import { paper, PAPER_RGB } from '../paper.js'
import { pathXAtY } from '../path.js'
import { loomState } from '../state.js'
import { DEFAULT_COLOR, DIVE_SIGMA_LINES, FAMILY_COLOR, WARM_DIVE_BOOST, type ApertureConfig, type Thread } from '../types.js'
import { paintWater, resetWater, stepWater, wetnessOf, type LensPour } from './water.js'

interface Ripple {
  family: string
  x: number
  y: number
  color: readonly [number, number, number]
  start: number
  strength: number
  seed: number
  // The current it fell on, how far from that current's centre line, and
  // where the current's text stood then: the ring travels with those words.
  thread: Thread | null
  off: number
  line0: number
  // Where it is this frame (set by placeRipples).
  cx: number
  cy: number
  lean: number
}

const RIPPLE_LIFE_S = 9
const MAX_RIPPLES = 90
const ripples: Ripple[] = []

export function addRipple(family: string, x: number, y: number, strength: number, now: number): void {
  if (ripples.length >= MAX_RIPPLES) ripples.shift()
  // A ring rides with the text of its current; where its family has none, it stays on bare paper.
  const thread = loomState.threads.find(t => t.familyNames.includes(family) && t._path.length >= 2) ?? null
  ripples.push({
    family, x, y, color: FAMILY_COLOR[family] ?? DEFAULT_COLOR, start: now, strength, seed: Math.random() * 100,
    thread, off: thread ? x - pathXAtY(thread._path, y) : 0, line0: thread ? Math.floor(thread.scroll * 3) : 0,
    cx: x, cy: y, lean: 0,
  })
}

const RING_STRETCH = 0.45
// How far (px) a passing ring pushes a line aside.
const RING_PUSH = 7
/** A ring on a current grows longer along it; one on bare paper stays round. Drawing and inking both use this. */
function ringStretch(rp: Ripple, age: number): number {
  return rp.thread ? 1 + RING_STRETCH * Math.min(1, age / 3) : 0.94
}

// What the text painter saw along a current this frame, one entry per path
// point: the half-width of the widest line there, and how much pigment its
// voices carry (fresh and woven voices more, sunken ones less).
export interface WashProfile { half: Float32Array, ink: Float32Array, top: number, bottom: number, at: number }
const profiles = new WeakMap<Thread, WashProfile>()

export function beginWashProfile(thread: Thread, now = 0): WashProfile | null {
  const path = thread._path
  if (path.length < 2) return null
  let p = profiles.get(thread)
  if (!p || p.half.length !== path.length) {
    p = { half: new Float32Array(path.length), ink: new Float32Array(path.length), top: 0, bottom: 1, at: 0 }
    profiles.set(thread, p)
  }
  p.half.fill(0)
  p.ink.fill(0)
  p.at = now
  p.top = path[0]!.y
  p.bottom = path[path.length - 1]!.y
  return p
}

// Crossings. Currents are painted one after another, deepest first, so the ones
// later in the order lie over the one being painted. Where one of them covers a
// resting line, that stretch of the line is not printed: the words pass under
// and only the wash shows through. Nothing is erased, so the ink that builds up
// on the sheet between frames is left alone.
const lyingOver: Thread[] = []
const hidden: [number, number] = [0, 0]

/** Called once per current per frame, before its lines. */
export function beginCrossing(thread: Thread): void {
  lyingOver.length = 0
  let later = false
  for (const index of loomState.sortedThreadIndices) {
    const other = loomState.threads[index]!
    if (other === thread) { later = true; continue }
    // An open current's pool is water, not a crossing: render/water.ts hides the words under it.
    if (later) lyingOver.push(other)
  }
}

/**
 * The stretch [from, to] of a line at height y that a current lying over this
 * one hides; from >= to when none does. A scratch tuple: read it at once.
 * Columns are last frame's (a later current has not been painted yet this frame).
 */
export function hiddenSpan(x0: number, x1: number, y: number, now: number): [number, number] {
  hidden[0] = 0
  hidden[1] = 0
  for (const other of lyingOver) {
    const p = profiles.get(other)
    if (!p || now - p.at > 400) continue
    const n = p.half.length
    const k = Math.round(((y - p.top) / (p.bottom - p.top)) * (n - 1))
    if (k < 0 || k >= n) continue
    // Lines are sparser than path points, so read the column eased over its neighbours.
    const half = eased(p.half, k, 0)
    if (half === 0) continue
    const from = other._path[k]!.x - half - CROSSING_GAP
    const to = other._path[k]!.x + half + CROSSING_GAP
    if (to <= x0 || from >= x1) continue
    if (hidden[0] >= hidden[1]) { hidden[0] = from; hidden[1] = to }
    else { hidden[0] = Math.min(hidden[0], from); hidden[1] = Math.max(hidden[1], to) }
  }
  return hidden
}
const CROSSING_GAP = 5
/** Above this a current counts as open: it lies over the others, and its own print is lifted while it opens or closes. */
export const OPEN_PROXIMITY = 0.25

/**
 * Lifts a current's own print off the sheet, along the column it filled last
 * frame. Used while its pool is opening or closing: its lines re-wrap every
 * frame then, and each old wrap would otherwise stay for a moment as smeared,
 * doubled print. Call before beginWashProfile (which empties the column).
 * Other currents' words are not under it: they part around a pool (crossings).
 */
export function liftOwnInk(ctx: CanvasRenderingContext2D, thread: Thread, strength: number): void {
  const p = profiles.get(thread)
  const path = thread._path
  if (!p || p.half.length !== path.length || path.length < 2) return
  const step = Math.abs(path[1]!.y - path[0]!.y) + 1
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = `rgba(0,0,0,${strength})`
  for (let k = 0; k < path.length; k++) {
    const half = eased(p.half, k, 0)
    if (half === 0) continue
    ctx.fillRect(path[k]!.x - half - 6, path[k]!.y - step * 0.5, half * 2 + 12, step)
  }
  ctx.globalCompositeOperation = 'source-over'
}

export function markWashLine(p: WashProfile, y: number, halfWidth: number, ink: number): void {
  const n = p.half.length
  const k = Math.round(((y - p.top) / (p.bottom - p.top)) * (n - 1))
  if (k < 0 || k >= n) return
  if (halfWidth > p.half[k]!) p.half[k] = halfWidth
  if (ink > p.ink[k]!) p.ink[k] = ink
}

/** A profile value at path point k, eased over its neighbours; `empty` where no line was drawn. */
function eased(a: Float32Array, k: number, empty: number): number {
  let sum = 0
  let weight = 0
  for (let d = -2; d <= 2; d++) {
    const v = a[k + d]
    if (v === undefined || v === 0) continue
    const wt = 3 - Math.abs(d)
    sum += v * wt
    weight += wt
  }
  return weight > 0 ? sum / weight : empty
}

function ringRadius(age: number): number { return 5 + 46 * Math.pow(age, 0.72) }
function ringAlpha(rp: Ripple, age: number): number { return rp.strength * 0.62 * Math.pow(1 - age / RIPPLE_LIFE_S, 1.6) }

/**
 * Moves each ring to where its words are now: a current's text travels along
 * its path, and a ring that fell on it goes with it, leaning the way the
 * current runs there. Called once a frame, before anything reads the rings.
 */
export function placeRipples(now: number): void {
  const lineH = loomState.currentAperture?.textureLineH ?? 0
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i]!
    if ((now - rp.start) / 1000 > RIPPLE_LIFE_S) { ripples.splice(i, 1); continue }
    let thread = rp.thread
    if (thread && !loomState.threads.includes(thread)) {
      // Its current was rebuilt (new voices arrived): the ring stays where it
      // was last drawn and rides the rebuilt current from there.
      thread = loomState.threads.find(t => t.familyNames.includes(rp.family) && t._path.length >= 2) ?? null
      rp.thread = thread
      rp.x = rp.cx
      rp.y = rp.cy
      if (thread) { rp.off = rp.cx - pathXAtY(thread._path, rp.cy); rp.line0 = Math.floor(thread.scroll * 3) }
    }
    if (!thread || thread._path.length < 2) { rp.cx = rp.x; rp.cy = rp.y; if (!thread) rp.lean = 0; continue }
    const moved = (Math.floor(thread.scroll * 3) - rp.line0) * lineH
    // A jump (the text wrapped, or was thrown by the wheel) leaves the ring where it is.
    if (Math.abs(moved) > loomState.VH) { rp.x = rp.cx; rp.y = rp.cy; rp.line0 = Math.floor(thread.scroll * 3); continue }
    rp.cy = rp.y - moved
    rp.cx = pathXAtY(thread._path, rp.cy) + rp.off
    rp.lean = Math.atan2(pathXAtY(thread._path, rp.cy + 24) - pathXAtY(thread._path, rp.cy - 24), 48)
  }
}

const _ring: [number, number] = [0, 0]
/**
 * What the rings do to a line of text spanning x0..x1 at height y: [ink, push].
 * Ink (0..1) is how strongly a ring's edge is crossing the line now; push is a
 * small sideways shift away from that ring's centre, in px. Scratch tuple:
 * read it at once.
 */
export function ringsOnLine(x0: number, x1: number, y: number, now: number): [number, number] {
  let ink = 0
  let push = 0
  for (const rp of ripples) {
    const age = (now - rp.start) / 1000
    if (age < 0 || age > RIPPLE_LIFE_S) continue
    // The ring is longer along its current than across it.
    const dy = (y - rp.cy) / ringStretch(rp, age)
    const r = ringRadius(age)
    const band = 9 + 2.6 * age
    if (Math.abs(dy) > r + band * 2.5) continue
    let dist: number
    if (Math.abs(dy) <= r) {
      const half = Math.sqrt(r * r - dy * dy)
      const a = rp.cx - half
      const b = rp.cx + half
      const da = a < x0 ? x0 - a : a > x1 ? a - x1 : 0
      const db = b < x0 ? x0 - b : b > x1 ? b - x1 : 0
      dist = Math.min(da, db)
    } else {
      const dx = rp.cx < x0 ? x0 - rp.cx : rp.cx > x1 ? rp.cx - x1 : 0
      dist = Math.hypot(dx, Math.abs(dy) - r)
    }
    const f = ringAlpha(rp, age) * Math.exp(-(dist / band) * (dist / band))
    if (f > ink) {
      ink = f
      const mid = (x0 + x1) * 0.5
      push = f * RING_PUSH * Math.max(-1, Math.min(1, (mid - rp.cx) / Math.max(12, r)))
    }
  }
  _ring[0] = Math.min(1, ink)
  _ring[1] = push
  return _ring
}

/** Test-only: no rings, and no current left lying over from an earlier frame. */
export function resetWashForTest(): void {
  ripples.length = 0
  lyingOver.length = 0
  resetWater()
  bandStates.clear()
  wetSource = wetnessOf
}

/** A point on a current, for drops that fall without a hand: the family's thread at height yFrac. */
export function pointOnCurrent(family: string, yFrac: number): { x: number, y: number } | null {
  for (const thread of loomState.threads) {
    if (!thread.familyNames.includes(family) || thread._path.length < 2) continue
    const y = loomState.VH * yFrac
    return { x: pathXAtY(thread._path, y), y }
  }
  return null
}

/** A current picked at random, warm ones more often, and a height on it. */
export function randomCurrent(): { family: string, point: { x: number, y: number } } | null {
  const vis = loomState.frameVisibilityAlpha
  let total = 0
  const weights: number[] = []
  for (let i = 0; i < loomState.threads.length; i++) {
    const thread = loomState.threads[i]!
    const w = (vis[i] ?? 0) > 0.5 && thread._path.length > 1 ? 0.35 + clamp01(thread.apiWarmth) : 0
    weights.push(w)
    total += w
  }
  if (total <= 0) return null
  let r = Math.random() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!
    if (r > 0) continue
    const thread = loomState.threads[i]!
    const family = thread.familyNames[Math.floor(Math.random() * thread.familyNames.length)]
    if (!family) return null
    const y = loomState.VH * (0.18 + Math.random() * 0.64)
    return { family, point: { x: pathXAtY(thread._path, y), y } }
  }
  return null
}

function wobble(y: number, seed: number, t: number): number {
  return Math.sin(y * 0.011 + seed * 1.7 + t * 0.9) * 0.5
    + Math.sin(y * 0.023 + seed * 3.1 - t * 0.6) * 0.3
    + Math.sin(y * 0.047 + seed * 5.3 + t * 1.3) * 0.2
}

const GLAZE_WIDTH = [0.68, 0.5, 0.3] as const
const GLAZE_ALPHA = [0.5, 0.55, 0.7] as const
const GLAZE_BULGE = [1, 0.6, 0.25] as const
// How far each glaze reaches past the text it lies under, wet.
const GLAZE_WRAP = [1.34, 1.02, 0.62] as const
const GLAZE_MARGIN = [12, 5, 0] as const

// Dry and wet (water.ts says how wet). A dry band is a narrow, pale stain that
// hugs its words, with a crisp edge, and holds still; water spreads it to the
// glazes above and deepens it, and its edge is redrawn on a slow clock, as in
// hand-drawn animation. Text moving fast breaks it into dry-brush streaks.
const DRY_WRAP = [1.02, 0.8, 0.48] as const
const DRY_MARGIN = [2, 0, 0] as const
const DRY_DEPTH = 0.9
const WET_DEPTH = 1.2
/** The slow clock: a wet edge is redrawn this often (ms). */
const BOIL_MS = 125
/** How far (px) a fully wet outer edge wanders per drawing; the inner glazes less. */
const BOIL_PX = 2.2
/** Wetness eases toward water.ts's value: quickly as it wets, more slowly as it dries (ms). */
const WET_RISE_MS = 250
const WET_DRY_MS = 900
/** Text speed (lines a second) where the brush starts to run dry, and where it is fully broken. */
const ROUGH_FROM = 30
const ROUGH_FULL = 150
/** Faster than this is a jump (a wrap, a voice brought into view), not a stroke. */
const ROUGH_JUMP = 600
const ROUGH_HEAL_MS = 350
/** Dry-brush lanes are about this far apart (px), between 6 and 28 of them across a band. */
const DRY_LANE_PX = 7

interface BandState { wet: number, rough: number, scroll: number, at: number, tick: number, tickAt: number, clock: number }
// Kept by family group, so a current rebuilt when voices arrive keeps its state.
const bandStates = new Map<string, BandState>()
const bandKeys = new WeakMap<Thread, string>()
let wetSource: (thread: Thread) => number = wetnessOf
/** Test-only: how wet each current is, in place of water.ts. */
export function setWetnessForTest(source: ((thread: Thread) => number) | null): void { wetSource = source ?? wetnessOf }

/** How wet and how rough a band is now, and its own clock, which runs only while it is wet. */
function bandState(thread: Thread, now: number): BandState {
  let key = bandKeys.get(thread)
  if (key === undefined) { key = thread.familyNames.join('|'); bandKeys.set(thread, key) }
  const target = wetSource(thread)
  const tick = Math.floor(now / BOIL_MS)
  let s = bandStates.get(key)
  if (!s) {
    s = { wet: target, rough: 0, scroll: thread.scroll, at: now, tick, tickAt: now, clock: 0 }
    bandStates.set(key, s)
    return s
  }
  const dt = Math.max(0, Math.min(250, now - s.at))
  s.at = now
  s.wet += (target - s.wet) * (1 - Math.exp(-dt / (target > s.wet ? WET_RISE_MS : WET_DRY_MS)))
  if (Math.abs(target - s.wet) < 0.002) s.wet = target
  if (dt > 0) {
    const rate = (Math.abs(thread.scroll - s.scroll) * 3 * 1000) / dt
    const stroke = rate < ROUGH_JUMP && !loomState.phantomFocus ? clamp01((rate - ROUGH_FROM) / (ROUGH_FULL - ROUGH_FROM)) : 0
    s.rough = Math.max(stroke, s.rough * Math.exp(-dt / ROUGH_HEAL_MS))
    if (s.rough < 0.02) s.rough = 0
  }
  s.scroll = thread.scroll
  if (tick !== s.tick) {
    s.clock += (now - s.tickAt) * 0.00012 * s.wet
    s.tick = tick
    s.tickAt = now
  }
  return s
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}
/** Smooth value noise in [-1, 1]. */
function vnoise(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1
}

/**
 * Dry brush: paper shows through the band in broken streaks along its run,
 * riding with its text. Lifted out of this band's outline only.
 */
function dryBrush(ctx: CanvasRenderingContext2D, path: readonly { x: number, y: number }[], left: number[], right: number[], rough: number, flow: number, seed: number): void {
  const n = path.length
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(left[0]!, path[0]!.y)
  for (let k = 1; k < n; k++) ctx.lineTo(left[k]!, path[k]!.y)
  for (let k = n - 1; k >= 0; k--) ctx.lineTo(right[k]!, path[k]!.y)
  ctx.closePath()
  ctx.clip()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  const mid = n >> 1
  const span = right[mid]! - left[mid]!
  const lanes = Math.max(6, Math.min(28, Math.round(span / DRY_LANE_PX)))
  const stretch = 0.6 + 1.2 * rough
  for (let j = 0; j < lanes; j++) {
    const h = hash(seed * 31 + j * 7.3)
    const f = (j + 0.5) / lanes + ((h - 0.5) * 0.4) / lanes
    const edge = Math.abs(f - 0.5) * 2
    const strength = clamp01(rough * (0.55 + 0.6 * edge) * (0.6 + 0.6 * hash(seed + j * 3.1)))
    if (strength < 0.03) continue
    // Bristle gaps: long thin runs of bare paper, longer the faster it goes, with short breaks.
    const on = (40 + 160 * hash(seed + j * 5.7)) * stretch
    const period = on + (8 + 40 * hash(seed + j * 9.1)) / stretch
    const phase = flow + 200 * hash(seed + j * 1.3)
    ctx.strokeStyle = `rgba(0,0,0,${strength})`
    ctx.lineWidth = 0.8 + (span / lanes) * 0.4 * h
    ctx.beginPath()
    let down = false
    let px = 0
    let py = 0
    for (let k = 0; k < n; k++) {
      const y = path[k]!.y
      const pos = (((y + phase) % period) + period) % period
      if (pos >= on) { down = false; continue }
      // Along the band's smoothed outline: a bristle does not follow every ripple of the edge.
      const a = k > 0 ? k - 1 : k
      const b = k < n - 1 ? k + 1 : k
      const l = (left[a]! + 2 * left[k]! + left[b]!) / 4
      const x = l + ((right[a]! + 2 * right[k]! + right[b]!) / 4 - l) * f
      // A streak runs with the current: where the band swings out sideways (a pool's rim), it breaks.
      if (down && Math.abs(x - px) <= Math.abs(y - py)) ctx.lineTo(x, y); else ctx.moveTo(x, y)
      down = true
      px = x
      py = y
    }
    ctx.stroke()
  }
  ctx.restore()
  ctx.globalCompositeOperation = paper.night ? 'screen' : 'multiply'
}

function paintBand(ctx: CanvasRenderingContext2D, thread: Thread, visibility: number, ac: ApertureConfig, t: number, ocean: number, sigma: number, now: number): void {
  const path = thread._path
  const mouse = loomState.currentMouse
  const [r, g, b] = thread.baseColor
  const ink = `${r | 0},${g | 0},${b | 0}`
  const warmth = clamp01(thread.apiWarmth)
  const prox = thread === loomState.touchedThread ? thread.proximity : 0
  const alpha = (0.085 + 0.11 * warmth) * (1 - 0.3 * prox) * visibility * ocean
  const seed = thread.pathSeed
  const openW = Math.min(thread.balancedWidth, ac.openWidth)
  const top = path[0]!.y
  const bottom = path[path.length - 1]!.y
  // No profile yet (a current whose text has not been painted): a plain band along its path.
  const profile = profiles.get(thread)
  const fromText = profile !== undefined && profile.half.length === path.length
  // The wash's grain rides with the text instead of standing still under it.
  const flow = fromText ? thread.scroll * 3 * ac.textureLineH : 0

  // Its own clock (still while dry), how wet, and the drawing it is on.
  const band = bandState(thread, now)
  const w = band.wet
  const bt = band.clock
  const drawing = band.tick
  // A brush running dry carries its pigment strong, in broken strokes.
  const depth = (DRY_DEPTH + (WET_DEPTH - DRY_DEPTH) * w) * (1 + 0.9 * band.rough)

  let outerLeft: number[] = []
  let outerRight: number[] = []
  for (let layer = 0; layer < 3; layer++) {
    const left: number[] = []
    const right: number[] = []
    const ls = seed + layer * 2.3
    const wrap = DRY_WRAP[layer]! + (GLAZE_WRAP[layer]! - DRY_WRAP[layer]!) * w
    const margin = DRY_MARGIN[layer]! + (GLAZE_MARGIN[layer]! - DRY_MARGIN[layer]!) * w
    const boil = BOIL_PX * w * (1 - layer * 0.3)
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!
      const wy = p.y + flow
      let base = ac.restingWidth * 1.3 * GLAZE_WIDTH[layer]! * (0.75 + 0.25 * w)
      let bulge = 0
      let swellAmp = 0.38
      let ragged = 1
      if (fromText) {
        // The glaze lies under the lines actually drawn here: it widens where
        // they widen (the lens, a passing ring) and narrows where they narrow.
        base = eased(profile.half, k, ac.restingWidth * 0.5) * wrap + margin
        swellAmp = 0.12 + 0.04 * w
        ragged = 0.2 + 0.3 * w
      } else {
        // Ink pools where the page is being read.
        const dy = mouse && prox > 0 ? (p.y - mouse.y) / sigma : 9
        bulge = prox * openW * 0.52 * Math.exp(-dy * dy * 0.5) * GLAZE_BULGE[layer]!
      }
      // Each glaze sits a little off the one below it, so the strength is uneven across the band.
      const shift = layer === 0 ? 0 : Math.min(base, ac.restingWidth) * (0.15 + 0.15 * w) * wobble(wy * 0.7, ls + 11.3, bt * 0.7)
      // Slow swelling and thinning along the band, plus a finer ragged edge.
      const swell = 1 + swellAmp * wobble(wy * 0.45, ls + 3.7, bt * 0.5)
      let hl = (base * swell + bulge) * (1 + ragged * (0.24 * wobble(wy, ls, bt) + 0.07 * wobble(wy * 3.6, ls + 1.9, bt * 2)))
      let hr = (base * swell + bulge) * (1 + ragged * (0.24 * wobble(wy, ls + 7.9, bt) + 0.07 * wobble(wy * 3.6, ls + 5.2, bt * 2)))
      if (boil > 0) {
        // Each drawing redraws the wet edge with a little fresh wander.
        hl += boil * vnoise(wy * 0.055 + drawing * 17.31 + layer * 5.1)
        hr += boil * vnoise(wy * 0.055 + drawing * 23.77 + layer * 3.3 + 40)
      }
      left.push(p.x + shift - hl)
      right.push(p.x + shift + hr)
    }
    ctx.beginPath()
    ctx.moveTo(left[0]!, path[0]!.y)
    for (let k = 1; k < path.length; k++) ctx.lineTo(left[k]!, path[k]!.y)
    for (let k = path.length - 1; k >= 0; k--) ctx.lineTo(right[k]!, path[k]!.y)
    ctx.closePath()
    // Pigment settles unevenly down the length of a wash.
    const a = alpha * depth * GLAZE_ALPHA[layer]!
    const settle = ctx.createLinearGradient(0, top, 0, bottom)
    const stops = fromText ? 14 : 6
    for (let s = 0; s <= stops; s++) {
      const f = s / stops
      // Pigment gathers under fresh and woven voices and thins under sunken ones.
      const carried = fromText ? 0.45 + 0.6 * eased(profile.ink, Math.round(f * (path.length - 1)), 1) : 1
      const uneven = fromText ? 0.2 : 0.42
      settle.addColorStop(f, `rgba(${ink},${a * carried * (1 + uneven * wobble(f * 900 + flow, ls + 23.1, bt * 0.4))})`)
    }
    ctx.fillStyle = settle
    ctx.fill()
    if (layer === 0) { outerLeft = left; outerRight = right }
  }

  // Tide line: pigment gathers at the edge of a wash as it dries. A dry edge is a fine, crisp line.
  ctx.strokeStyle = `rgba(${ink},${alpha * 1.5})`
  ctx.lineWidth = 0.9 + 0.4 * w
  for (const edge of [outerLeft, outerRight]) {
    ctx.beginPath()
    ctx.moveTo(edge[0]!, path[0]!.y)
    for (let k = 1; k < path.length; k++) ctx.lineTo(edge[k]!, path[k]!.y)
    ctx.stroke()
  }

  // Contours: the rings of floated ink, drawn out long by the current. Fainter on a dry band.
  ctx.strokeStyle = `rgba(${ink},${alpha * (0.6 + 0.5 * w)})`
  ctx.lineWidth = 0.9
  for (let j = 0; j < 4; j++) {
    const frac = (j + 0.5) / 4
    ctx.beginPath()
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!
      const span = outerRight[k]! - outerLeft[k]!
      const x = outerLeft[k]! + span * (frac + 0.1 * wobble((p.y + flow) * 1.7, seed + j * 4.1, bt * 1.6))
      if (k === 0) ctx.moveTo(x, p.y); else ctx.lineTo(x, p.y)
    }
    ctx.stroke()
  }

  if (band.rough > 0) dryBrush(ctx, path, outerLeft, outerRight, band.rough, flow, seed)
}

/** The open current's readable block, as its text was last laid out, for the water to pour under. */
function lensPour(touched: Thread | null, mouse: { x: number, y: number } | null, ac: ApertureConfig): LensPour | null {
  if (!touched || !mouse || mouse.x <= -1000 || touched.proximity <= 0.05 || loomState.loomViewActive) return null
  const profile = profiles.get(touched)
  if (!profile || profile.half.length !== touched._path.length || touched._path.length < 2) return null
  return {
    thread: touched,
    half: (k: number) => eased(profile.half, k, 0),
    y: mouse.y,
    sigma: DIVE_SIGMA_LINES * ac.diveLineH,
    amount: touched.proximity,
    reach: 1 + clamp01(touched.apiWarmth) * WARM_DIVE_BOOST,
  }
}

export function paintWash(ctx: CanvasRenderingContext2D, scale: number, now: number): void {
  const vw = loomState.VW
  const vh = loomState.VH
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, vw, vh)
  const ac = loomState.currentAperture
  if (!loomState.ready || !ac) return
  // Glazes darken each other on cream paper and brighten each other on indigo.
  ctx.globalCompositeOperation = paper.night ? 'screen' : 'multiply'
  ctx.lineJoin = 'round'
  const t = now * 0.00012
  const mouse = loomState.currentMouse
  const vis = loomState.frameVisibilityAlpha
  const ocean = 1 - loomState.loomViewTransition
  const sigma = DIVE_SIGMA_LINES * ac.diveLineH * 1.25
  const touched = loomState.touchedThread

  // The water first: the bands ask it how wet they are.
  stepWater(now, lensPour(touched, mouse, ac))

  if (ocean > 0.01) {
    let touchedVisibility = 0
    for (let ti = 0; ti < loomState.threads.length; ti++) {
      const thread = loomState.threads[ti]!
      const v = vis[ti] ?? 0
      if (v < 0.01 || thread._path.length < 2) continue
      if (thread === touched) { touchedVisibility = v; continue }
      paintBand(ctx, thread, v, ac, t, ocean, sigma, now)
    }
    if (touched && touchedVisibility > 0) paintBand(ctx, touched, touchedVisibility, ac, t, ocean, sigma, now)
    // Clean water where a current is read: the pigment under it cleared into a rim.
    paintWater(ctx, ocean, paper.night ? 'screen' : 'multiply')
  }

  // Drops.
  placeRipples(now)
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i]!
    const age = (now - rp.start) / 1000
    if (age < 0) continue
    const radius = ringRadius(age)
    const a = ringAlpha(rp, age)
    const [r, g, b] = rp.color
    const stretch = ringStretch(rp, age)
    const cos = Math.cos(rp.lean)
    const sin = Math.sin(rp.lean)
    ctx.strokeStyle = `rgba(${r},${g},${b},${a})`
    ctx.lineWidth = 1.1 + rp.strength * 0.9
    ctx.beginPath()
    const segs = 44
    for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2
      const rr = radius * (1 + 0.05 * Math.sin(th * 3 + rp.seed) + 0.03 * Math.sin(th * 5 + rp.seed * 2 + age * 0.4))
      // Across the current, then along it (longer), then leaned the way it runs.
      const u = Math.cos(th) * rr
      const v = Math.sin(th) * rr * stretch
      const x = rp.cx + u * cos + v * sin
      const y = rp.cy - u * sin + v * cos
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()
    if (age < 0.5) {
      // The drop itself, before it spreads.
      ctx.fillStyle = `rgba(${r},${g},${b},${rp.strength * 0.7 * (1 - age / 0.5)})`
      ctx.beginPath()
      ctx.arc(rp.cx, rp.cy, 2.5 + 5 * age, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
}

/** A small repeating tile of paper tooth and ink drop-out, as a data URL. */
export function grainTile(size = 256): string {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = Math.random()
    if (n < 0.13) {
      // Paper showing through the ink.
      d[i] = PAPER_RGB[0]; d[i + 1] = PAPER_RGB[1]; d[i + 2] = PAPER_RGB[2]
      d[i + 3] = 40 + Math.random() * 90
    } else if (n > 0.9) {
      // Tooth: a darker fleck by day, a pale fibre by night.
      if (paper.night) { d[i] = 150; d[i + 1] = 158; d[i + 2] = 200 } else { d[i] = 96; d[i + 1] = 84; d[i + 2] = 64 }
      d[i + 3] = Math.random() * 20
    }
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}
