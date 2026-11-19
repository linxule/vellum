// Ink washes under the text (sketch, paper look only).
//
// Each current is a band of floated ink that follows the thread's path: a few
// overlapping glazes with uneven edges and uneven strength, a darker tide line
// where the pigment settled, and hairline contours inside, as in suminagashi.
// Bands multiply, so two currents overprint where they cross. Under the lens
// the other currents' ink clears, so the one being read sits on clean paper.
// A drop leaves a ring that spreads and fades; a phrase leaves one per note.
//
// Painted on its own low-resolution canvas beneath the text canvas, a few times
// a second. Reads loomState; never writes it.

import { clamp01 } from '../math.js'
import { paper, PAPER_RGB } from '../paper.js'
import { pathXAtY } from '../path.js'
import { loomState } from '../state.js'
import { DEFAULT_COLOR, DIVE_SIGMA_LINES, FAMILY_COLOR, type ApertureConfig, type Thread } from '../types.js'

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
    // A current that is open lies over all the others, wherever it sorts
    // (it is painted last): their words part around its pool.
    if (later || other.proximity > OPEN_PROXIMITY) lyingOver.push(other)
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
// Where a current was opened and read, its pool stays behind as a stain with a
// darker edge, and dries away: the sheet shows where it has been read.
interface Stain { left: Float32Array, right: Float32Array, at: number, wet: boolean }
const stains = new WeakMap<Thread, Stain>()
const STAIN_LIFE_MS = 26000
const STAIN_PROX = 0.3

// How far each glaze reaches past the text it lies under.
const GLAZE_WRAP = [1.34, 1.02, 0.62] as const
const GLAZE_MARGIN = [12, 5, 0] as const

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

  if (fromText) {
    let stain = stains.get(thread)
    if (!stain || stain.left.length !== path.length) {
      stain = { left: new Float32Array(path.length), right: new Float32Array(path.length), at: -1e12, wet: false }
      stains.set(thread, stain)
    }
    const reading = thread.proximity > STAIN_PROX
    if (reading) {
      // A fresh pool starts a fresh stain; while it is read, the stain keeps its
      // widest reach. It is kept where it lay on the sheet: currents move on.
      const fresh = !stain.wet && now - stain.at > STAIN_LIFE_MS
      for (let k = 0; k < path.length; k++) {
        const h = eased(profile.half, k, 0) * GLAZE_WRAP[0] + GLAZE_MARGIN[0]
        const l = path[k]!.x - h
        const r = path[k]!.x + h
        if (fresh || l < stain.left[k]!) stain.left[k] = l
        if (fresh || r > stain.right[k]!) stain.right[k] = r
      }
      stain.at = now
    }
    stain.wet = reading
    const dry = (now - stain.at) / STAIN_LIFE_MS
    if (!reading && dry < 1) {
      const fade = 1 - dry
      // Only where the current was opened: wider than a resting band.
      const opened = ac.restingWidth * GLAZE_WRAP[0] + GLAZE_MARGIN[0] * 2 + 30
      ctx.fillStyle = `rgba(${ink},${Math.min(0.3, alpha * 1.1 * fade)})`
      ctx.strokeStyle = `rgba(${ink},${Math.min(0.6, alpha * 3 * fade)})`
      ctx.lineWidth = 1.6
      let from = -1
      for (let k = 0; k <= path.length; k++) {
        const wide = k < path.length && stain.right[k]! - stain.left[k]! > opened
        if (wide && from < 0) from = k
        if (!wide && from >= 0) {
          const to = k - 1
          if (to > from) {
            ctx.beginPath()
            for (let j = from; j <= to; j++) {
              const x = stain.left[j]! + 5 * wobble(path[j]!.y, seed + 31.7, 0)
              if (j === from) ctx.moveTo(x, path[j]!.y); else ctx.lineTo(x, path[j]!.y)
            }
            for (let j = to; j >= from; j--) ctx.lineTo(stain.right[j]! + 5 * wobble(path[j]!.y, seed + 47.3, 0), path[j]!.y)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          }
          from = -1
        }
      }
    }
  }

  let outerLeft: number[] = []
  let outerRight: number[] = []
  for (let layer = 0; layer < 3; layer++) {
    const left: number[] = []
    const right: number[] = []
    const ls = seed + layer * 2.3
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!
      const wy = p.y + flow
      let base = ac.restingWidth * 1.3 * GLAZE_WIDTH[layer]!
      let bulge = 0
      let swellAmp = 0.38
      if (fromText) {
        // The glaze lies under the lines actually drawn here: it widens where
        // they widen (the lens, a passing ring) and narrows where they narrow.
        base = eased(profile.half, k, ac.restingWidth * 0.5) * GLAZE_WRAP[layer]! + GLAZE_MARGIN[layer]!
        swellAmp = 0.16
      } else {
        // Ink pools where the page is being read.
        const dy = mouse && prox > 0 ? (p.y - mouse.y) / sigma : 9
        bulge = prox * openW * 0.52 * Math.exp(-dy * dy * 0.5) * GLAZE_BULGE[layer]!
      }
      // Each glaze sits a little off the one below it, so the strength is uneven across the band.
      const shift = layer === 0 ? 0 : Math.min(base, ac.restingWidth) * 0.3 * wobble(wy * 0.7, ls + 11.3, t * 0.7)
      // Slow swelling and thinning along the band, plus a finer ragged edge.
      const swell = 1 + swellAmp * wobble(wy * 0.45, ls + 3.7, t * 0.5)
      const ragged = fromText ? 0.5 : 1
      const hl = (base * swell + bulge) * (1 + ragged * (0.24 * wobble(wy, ls, t) + 0.07 * wobble(wy * 3.6, ls + 1.9, t * 2)))
      const hr = (base * swell + bulge) * (1 + ragged * (0.24 * wobble(wy, ls + 7.9, t) + 0.07 * wobble(wy * 3.6, ls + 5.2, t * 2)))
      left.push(p.x + shift - hl)
      right.push(p.x + shift + hr)
    }
    ctx.beginPath()
    ctx.moveTo(left[0]!, path[0]!.y)
    for (let k = 1; k < path.length; k++) ctx.lineTo(left[k]!, path[k]!.y)
    for (let k = path.length - 1; k >= 0; k--) ctx.lineTo(right[k]!, path[k]!.y)
    ctx.closePath()
    // Pigment settles unevenly down the length of a wash.
    const a = alpha * GLAZE_ALPHA[layer]!
    const settle = ctx.createLinearGradient(0, top, 0, bottom)
    const stops = fromText ? 14 : 6
    for (let s = 0; s <= stops; s++) {
      const f = s / stops
      // Pigment gathers under fresh and woven voices and thins under sunken ones.
      const carried = fromText ? 0.45 + 0.6 * eased(profile.ink, Math.round(f * (path.length - 1)), 1) : 1
      const uneven = fromText ? 0.2 : 0.42
      settle.addColorStop(f, `rgba(${ink},${a * carried * (1 + uneven * wobble(f * 900 + flow, ls + 23.1, t * 0.4))})`)
    }
    ctx.fillStyle = settle
    ctx.fill()
    if (layer === 0) { outerLeft = left; outerRight = right }
  }

  // Tide line: pigment gathers at the edge of a wash as it dries.
  ctx.strokeStyle = `rgba(${ink},${alpha * 1.5})`
  ctx.lineWidth = 1.3
  for (const edge of [outerLeft, outerRight]) {
    ctx.beginPath()
    ctx.moveTo(edge[0]!, path[0]!.y)
    for (let k = 1; k < path.length; k++) ctx.lineTo(edge[k]!, path[k]!.y)
    ctx.stroke()
  }

  // Contours: the rings of floated ink, drawn out long by the current.
  ctx.strokeStyle = `rgba(${ink},${alpha * 1.1})`
  ctx.lineWidth = 0.9
  for (let j = 0; j < 4; j++) {
    const frac = (j + 0.5) / 4
    ctx.beginPath()
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!
      const span = outerRight[k]! - outerLeft[k]!
      const x = outerLeft[k]! + span * (frac + 0.1 * wobble((p.y + flow) * 1.7, seed + j * 4.1, t * 1.6))
      if (k === 0) ctx.moveTo(x, p.y); else ctx.lineTo(x, p.y)
    }
    ctx.stroke()
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

  if (ocean > 0.01) {
    let touchedVisibility = 0
    for (let ti = 0; ti < loomState.threads.length; ti++) {
      const thread = loomState.threads[ti]!
      const v = vis[ti] ?? 0
      if (v < 0.01 || thread._path.length < 2) continue
      if (thread === touched) { touchedVisibility = v; continue }
      paintBand(ctx, thread, v, ac, t, ocean, sigma, now)
    }
    if (touched && touchedVisibility > 0) {
      if (touched.proximity > 0.05 && mouse && mouse.x > -1000) {
        // Clear water under the lens: there, only the current being read keeps its ink.
        const lx = pathXAtY(touched._path, mouse.y)
        const rx = Math.max(40, Math.min(touched.balancedWidth, ac.openWidth) * 0.66)
        const ry = sigma * 1.5
        const strength = Math.min(1, touched.proximity * 1.4) * 0.92
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.translate(lx, mouse.y)
        ctx.scale(1, ry / rx)
        const clear = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
        clear.addColorStop(0, `rgba(0,0,0,${strength})`)
        clear.addColorStop(0.72, `rgba(0,0,0,${strength * 0.85})`)
        clear.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = clear
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
        ctx.restore()
      }
      paintBand(ctx, touched, touchedVisibility, ac, t, ocean, sigma, now)
    }
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
