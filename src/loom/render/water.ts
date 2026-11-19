// Water on the sheet. Touch wets, time dries: wet paint moves and spreads, dry paint
// holds still and crisp. This file owns the water; the bands (wash.ts) and the text
// only ask it how wet things are (wetnessOf) and whether water lies over a line
// (waterOver).
//
// The pointer, or a finger, is a drop of clean water. Where a current is read, clean
// water lies under its readable lines: the wash's pigment is pushed out of it into a
// rim, so the text sits on clear paper. The water spreads a little where the paper is
// already wet, unevenly along the fibres, and dries from its thin edges inward. Where
// it stopped, a fine tide line stays and fades.
//
// A coarse grid over the sheet (WATER_CELL px), fixed to the sheet: the currents move
// on, the water stays where it fell. Each cell records whose water it holds as a slot
// (a current's group key), never a colour: the inks change in place by day and night.
// Only the box that holds water is worked on; a dry sheet costs nothing.
//
// The grid is module state, not an object, so the minifier can shorten every name in
// the hot loops (the bundle has a size limit).

import { clamp01 } from '../math.js'
import { paper } from '../paper.js'
import { wordlessAmount } from '../reading.js'
import { threadGroupKey } from '../refresh.js'
import { loomState } from '../state.js'
import { DEFAULT_COLOR, type Thread } from '../types.js'

/** Grid cell, CSS px. */
export const WATER_CELL = 6
/**
 * Where warmth would make a current's paper damp (damp paper spreads water further
 * and holds it longer, so much-read currents would have livelier edges). Zero by
 * design: livelier edges where a current is read more would be a mark of standing.
 */
export const WARMTH_DAMPNESS = 0
/** How long a tide line takes to fade once its paper is dry. */
export const TIDE_LIFE_MS = 26000
/** Water at least this deep hides another current's words; thinner water lets them back, gently. */
export const HIDING_WATER = 0.25
/** How much of the wash the clean water clears at most (a breath of tint stays). */
export const CLEAR_MAX = 0.94
/** How magnified (as the text painter's diveT) a line must be for clean water to lie under it. */
export const READABLE = 0.4
/** How many finished reads are kept as records. */
export const READ_RECORDS = 32

const smooth = (a: number, b: number, v: number) => { const x = clamp01((v - a) / (b - a)); return x * x * (3 - 2 * x) }

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smooth value noise, 0..1, one unit per lattice step. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let tx = x - ix
  let ty = y - iy
  tx = tx * tx * (3 - 2 * tx)
  ty = ty * ty * (3 - 2 * ty)
  const a = hash2(ix, iy, seed)
  const b = hash2(ix + 1, iy, seed)
  const top = a + (b - a) * tx
  const c = hash2(ix, iy + 1, seed)
  return top + (c + (hash2(ix + 1, iy + 1, seed) - c) * tx - top) * ty
}

// ── The field ─────────────────────────────────────────────────────────────────

/** Where clean water is being poured: the readable block of the open current. */
export interface Bloom {
  slot: number
  cx: number
  cy: number
  rx: number
  ry: number
  /** Which side the pigment gathers on more (-1 left, 1 right), and an offset into the noise: each read is its own. */
  side: number
  ox: number
  oy: number
}

/**
 * How much pushed pigment gathers at a point of the wet front: heavier low and on
 * one side, thin or missing in stretches. Pigment does not gather evenly, and an
 * even rim reads as a frame.
 */
export function rimBias(b: Bloom, x: number, y: number): number {
  const u = Math.max(-1, Math.min(1, (x - b.cx) / Math.max(1, b.rx)))
  const v = (y - b.cy) / Math.max(1, b.ry)
  return (0.25 + 1.25 * smooth(-0.7, 1.1, v)) * (1 + 0.6 * b.side * u)
    * smooth(0.3, 0.62, valueNoise(x * 0.014 + b.ox, y * 0.014 + b.oy, 7))
}

let gw = 0
let gh = 0
let fieldW = -1
let fieldH = -1
/** How wet the paper is, 0..1 (and its next step). */
let water = new Float32Array(0)
let next = new Float32Array(0)
/** Whether water has reached here (the tide line's mask), and how much of that line's life is left. */
let reach = new Float32Array(0)
let life = new Float32Array(0)
/** How much pigment the water has pushed away here, 0..1. */
let clear = new Float32Array(0)
/** Pigment gathered at the wet front, as an amount (its colour is the owner's ink). */
let dep = new Float32Array(0)
/** The wet front this step: thin water beside dry paper. */
let front = new Float32Array(0)
/** Paper permeability: where water runs easily. */
let perm = new Float32Array(0)
let smoothed = new Float32Array(0)
/** Whose water: a slot, or -1. */
let owner = new Int8Array(0)
/** Cells holding water, by owner slot, as of the last step. */
const wetCells = new Int32Array(128)
/** Cells where water reached and has since dried: where a tide line can be. */
let tideCells = 0
// The box that holds anything (inclusive, padded); empty when bx1 < bx0.
let bx0 = 1
let by0 = 1
let bx1 = 0
let by1 = 0

/** A dry sheet of vw x vh px. */
export function newField(vw: number, vh: number, seed = 4242): void {
  gw = Math.ceil(vw / WATER_CELL) + 2
  gh = Math.ceil(vh / WATER_CELL) + 2
  fieldW = vw
  fieldH = vh
  const n = gw * gh
  const F = () => new Float32Array(n)
  water = F(); next = F(); reach = F(); life = F(); clear = F()
  dep = F(); front = F(); perm = F(); smoothed = F()
  owner = new Int8Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const x = i % gw
    const y = (i - x) / gw
    perm[i] = 0.65 * valueNoise(x / 4.5, y / 4.5, seed) + 0.35 * valueNoise(x / 1.7, y / 1.7, seed + 1)
  }
  bx0 = by0 = 1
  bx1 = by1 = 0
  masks = null
}

const isDry = () => bx1 < bx0

function setBox(x0: number, y0: number, x1: number, y1: number): void {
  bx0 = Math.max(1, x0 - 3)
  by0 = Math.max(1, y0 - 3)
  bx1 = Math.min(gw - 2, x1 + 3)
  by1 = Math.min(gh - 2, y1 + 3)
}

function waterAt(x: number, y: number): number {
  const gx = Math.round(x / WATER_CELL)
  const gy = Math.round(y / WATER_CELL)
  return gx < 0 || gy < 0 || gx >= gw || gy >= gh ? 0 : water[gy * gw + gx]!
}

/**
 * Holds clean water under a block given row by row: (cx, y, half) triples, sorted
 * by y, half being the water's half-width there. The shape is the caller's (the
 * readable lines), not the spreading's; the paper's grain only lobes its edge.
 */
export function pour(rows: ArrayLike<number>, slot: number, amount: number, dt: number): void {
  const n = Math.floor(rows.length / 3)
  if (n < 2 || amount <= 0) return
  const c = WATER_CELL
  const rate = Math.min(1, dt * 9)
  let k = 0
  let x0 = gw, y0 = gh, x1 = -1, y1 = -1
  const gyEnd = Math.min(gh - 2, Math.floor(rows[(n - 1) * 3 + 1]! / c))
  for (let gy = Math.max(1, Math.ceil(rows[1]! / c)); gy <= gyEnd; gy++) {
    const y = gy * c
    while (k < n - 2 && rows[k * 3 + 4]! < y) k++
    const ya = rows[k * 3 + 1]!
    const f = clamp01((y - ya) / Math.max(1e-6, rows[k * 3 + 4]! - ya))
    const cx = rows[k * 3]! + (rows[k * 3 + 3]! - rows[k * 3]!) * f
    const half = rows[k * 3 + 2]! + (rows[k * 3 + 5]! - rows[k * 3 + 2]!) * f
    if (half <= 1) continue
    const gxEnd = Math.min(gw - 2, Math.ceil((cx + half * 1.2) / c))
    for (let gx = Math.max(1, Math.floor((cx - half * 1.2) / c)); gx <= gxEnd; gx++) {
      const i = gy * gw + gx
      const d = Math.abs(gx * c - cx) / (half * (0.84 + 0.3 * perm[i]!))
      if (d >= 1) continue
      const v = Math.min(1, (1 - d) * 2.6) * amount
      if (v > water[i]!) {
        water[i]! += (v - water[i]!) * rate
        owner[i] = slot
      }
      if (gx < x0) x0 = gx
      if (gx > x1) x1 = gx
      if (gy < y0) y0 = gy
      if (gy > y1) y1 = gy
    }
  }
  if (x1 < 0) return
  if (isDry()) setBox(x0, y0, x1, y1)
  else setBox(Math.min(bx0 + 3, x0), Math.min(by0 + 3, y0), Math.max(bx1 - 3, x1), Math.max(by1 - 3, y1))
}

/**
 * Advances the water by dt seconds: it spreads into wet paper, dries from its thin
 * edges, pushes pigment out of its middle and leaves it at its front (only while
 * `bloom` still pours), and records how far it reached. Returns false, having done
 * nothing, when the sheet holds no water and no trace of any.
 */
export function stepField(dt: number, bloom: Bloom | null): boolean {
  if (isDry() || dt <= 0) return false
  const h = dt / 2
  for (let s = 0; s < 2; s++) {
    next.set(water)
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = y * gw + x
        const a = water[i]!
        // Right neighbour, then the one below: each pair once.
        for (let j = i + 1; j <= i + gw; j += gw - 1) {
          const b = water[j]!
          if (a <= 0.002 && b <= 0.002) continue
          // Water runs only where the paper is already wet (flux ~ w^1.5), more easily
          // along the fibres. Damp paper (WARMTH_DAMPNESS) would add to the fibres' pull here.
          const m = (a + b) * 0.5
          const p = (perm[i]! + perm[j]!) * 0.5
          const f = Math.min(0.2, 7 * h * m * Math.sqrt(m) * (0.08 + 2.2 * p * p)) * (a - b)
          next[i]! -= f
          next[j]! += f
          // Dry paper takes the owner of the water it receives.
          if (f > 0 && owner[j]! < 0) owner[j] = owner[i]!
          else if (f < 0 && owner[i]! < 0) owner[i] = owner[j]!
        }
      }
    }
    const t = water
    water = next
    next = t
  }
  const fade = dt / (TIDE_LIFE_MS / 1000)
  wetCells.fill(0)
  tideCells = 0
  let nx0 = gw, ny0 = gh, nx1 = -1, ny1 = -1
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = y * gw + x
      let w = water[i]!
      // Drying: a thin film goes first (damp paper would hold it longer).
      if (w > 0) {
        w -= dt * (0.05 + 0.22 * (1 - w))
        if (w < 0.004) w = 0
        water[i] = w
      }
      // How far the water reached: yes or no, kept until its tide line has faded,
      // so the line stays exactly where the water stopped.
      if (w > 0.03) { reach[i] = 1; life[i] = 1 }
      else if (reach[i]! > 0 && w === 0) {
        tideCells++
        if ((life[i]! -= fade) <= 0) reach[i] = life[i] = 0
      }
      // Clean water pushes the pigment away; once dry, the pale patch fills back slowly.
      const target = smooth(0.1, 0.5, w) * CLEAR_MAX
      const cl = clear[i]!
      clear[i] = target > cl ? cl + (target - cl) * Math.min(1, dt * 7) : Math.max(target, cl - dt * 0.09)
      // The wet front: thin water next to dry paper, where the pushed pigment gathers.
      let fr = 0
      if (w > 0.006 && w < 0.32) {
        const ddx = water[i + 1]! - water[i - 1]!
        const ddy = water[i + gw]! - water[i - gw]!
        fr = Math.min(1, Math.sqrt(ddx * ddx + ddy * ddy) * 6) * smooth(0.006, 0.05, w) * (1 - smooth(0.16, 0.32, w))
      }
      front[i] = fr
      const o = owner[i]!
      if (fr > 0 && bloom && o === bloom.slot) dep[i] = Math.min(1.4, dep[i]! + dt * 0.7 * fr * rimBias(bloom, x * WATER_CELL, y * WATER_CELL))
      else if (dep[i]! > 0 && w < 0.01) dep[i] = Math.max(0, dep[i]! - fade)
      if (w > 0 && o >= 0) wetCells[o]!++
      if (w === 0 && dep[i] === 0 && clear[i] === 0 && reach[i] === 0) owner[i] = -1
      else {
        if (x < nx0) nx0 = x
        if (x > nx1) nx1 = x
        if (y < ny0) ny0 = y
        if (y > ny1) ny1 = y
      }
    }
  }
  if (nx1 >= 0) setBox(nx0, ny0, nx1, ny1)
  else { bx0 = by0 = 1; bx1 = by1 = 0 }
  return true
}

/**
 * Marching squares through `src` (smoothed once, so the line is the water's outline
 * rather than the grid's), at threshold T. Segments are grouped by whose water it is
 * and by strength (three steps): key = slot * 3 + step. Each group is a flat list of
 * segment end points, x0 y0 x1 y1 ..., in sheet px. A segment under 0.04 strength is
 * left out, so a line can break.
 */
/** Marching squares: for each corner code, the sides its segments join (0 top, 1 right, 2 bottom, 3 left). */
const EDGES = ['', '32', '21', '31', '01', '3021', '02', '30', '30', '02', '0132', '01', '31', '21', '32']

export function contour(src: Float32Array, T: number, strengthAt: (i: number, slot: number) => number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  if (isDry()) return out
  const f = smoothed
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = y * gw + x
      f[i] = (4 * src[i]! + 2 * (src[i - 1]! + src[i + 1]! + src[i - gw]! + src[i + gw]!)
        + src[i - gw - 1]! + src[i - gw + 1]! + src[i + gw - 1]! + src[i + gw + 1]!) / 16
    }
  }
  const c = WATER_CELL
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const i = y * gw + x
      const a = f[i]!, b = f[i + 1]!, cc = f[i + gw + 1]!, d = f[i + gw]!
      const code = (a > T ? 8 : 0) | (b > T ? 4 : 0) | (cc > T ? 2 : 0) | (d > T ? 1 : 0)
      if (code === 0 || code === 15) continue
      const o = Math.max(owner[i]!, owner[i + 1]!, owner[i + gw]!, owner[i + gw + 1]!)
      if (o < 0) continue
      const strength = strengthAt(i, o)
      if (strength < 0.04) continue
      const key = o * 3 + (strength > 0.66 ? 2 : strength > 0.33 ? 1 : 0)
      let S = out.get(key)
      if (!S) out.set(key, S = [])
      const X = x * c
      const Y = y * c
      // Where the line crosses each side of the square: top, right, bottom, left.
      const px = [X + c * (T - a) / (b - a), X + c, X + c * (T - d) / (cc - d), X]
      const py = [Y, Y + c * (T - b) / (cc - b), Y + c, Y + c * (T - a) / (d - a)]
      for (const e of EDGES[code]!) S.push(px[+e]!, py[+e]!)
    }
  }
  return out
}

// ── The sheet's water ─────────────────────────────────────────────────────────

let lastStep = 0
let bloom: Bloom | null = null
/** Owner slots: a current's group key, so a slot outlives a rebuilt Thread object. */
const slotKeys: string[] = []
let slotOfThread = new WeakMap<Thread, number>()
let wetness = new WeakMap<Thread, number>()
let anyWet = false

/** What a finished read leaves behind: where its water reached, whose it was, when it dried. No pixels. */
export interface ReadRecord {
  key: string
  driedAt: number
  /** The tide line, as segments x0 y0 x1 y1 ... in sheet px. */
  outline: Float32Array
}
const records: ReadRecord[] = []
/** Slots whose read has ended, waiting for their water to dry before they are recorded. */
const ending = new Set<number>()

/** A current's owner slot; -1 if it has never held water and `make` is false. */
function slotOf(thread: Thread, make = false): number {
  let slot = slotOfThread.get(thread)
  if (slot !== undefined) return slot
  const key = threadGroupKey(thread.familyNames)
  slot = slotKeys.indexOf(key)
  if (slot < 0) {
    if (!make) return -1
    if (slotKeys.length > 120) resetWater()
    slot = slotKeys.push(key) - 1
  }
  slotOfThread.set(thread, slot)
  return slot
}

/** How wet this current is now, 0 (dry: thin, still, crisp) to 1 (under standing water). */
export function wetnessOf(thread: Thread): number {
  return clamp01(Math.max(wetness.get(thread) ?? 0, WARMTH_DAMPNESS * clamp01(thread.apiWarmth)))
}

/** The open current's readable block, as the text painter last laid it out. */
export interface LensPour {
  thread: Thread
  /** The half-width of the line drawn at path point k (0 where none was). */
  half: (k: number) => number
  /** The reading line's height. */
  y: number
  /** How far the lens's magnification reaches up and down (its gaussian's sigma, px). */
  sigma: number
  /** How open the lens is (its proximity), and how far that reaches (a warm current reads sooner, as the text painter has it). */
  amount: number
  reach: number
}

const rows: number[] = []

/**
 * The water under the open current's readable lines: as wide as they are (with a
 * margin) where they are near reading size, narrowing and rounding off where they
 * fall back toward the resting size. Centred as the text painter centres them,
 * kept inside the sheet's edges. Fills `rows`; returns the bloom's centre and size.
 */
function lensRows(lens: LensPour, vw: number): [number, number, number] | null {
  const path = lens.thread._path
  rows.length = 0
  let top = Infinity
  let bottom = -Infinity
  let widest = 0
  let cx0 = 0
  let nearest = Infinity
  for (let k = 0; k < path.length; k++) {
    const p = path[k]!
    const dy = (p.y - lens.y) / lens.sigma
    const f = Math.min(1, lens.amount * Math.exp(-0.5 * dy * dy) * lens.reach)
    const h = lens.half(k)
    let cx = p.x
    if (cx - h < 8) cx = 8 + h
    else if (cx + h > vw - 8) cx = vw - 8 - h
    if (Math.abs(dy) < nearest) { nearest = Math.abs(dy); cx0 = cx }
    if (!(f > READABLE) || h <= 0) {
      // Close the block with a zero-width row at each end.
      if (rows.length > 0 && rows[rows.length - 1] !== 0) rows.push(cx, p.y, 0)
      continue
    }
    const half = (h * 1.04 + 16) * (0.35 + 0.65 * smooth(READABLE, 0.75, f))
    if (rows.length === 0 && k > 0) rows.push(cx, path[k - 1]!.y, 0)
    rows.push(cx, p.y, half)
    top = Math.min(top, p.y)
    bottom = Math.max(bottom, p.y)
    widest = Math.max(widest, half)
  }
  return widest > 0 ? [cx0, widest, Math.max(20, (bottom - top) / 2)] : null
}

/**
 * Advances the sheet's water to `now`, pouring under `lens` while a current is
 * open. Called once per wash frame, before the bands are painted (they read
 * wetnessOf). Does nothing at all while the sheet holds no water.
 */
export function stepWater(now: number, lens: LensPour | null): void {
  const vw = loomState.VW
  const vh = loomState.VH
  const dt = lastStep > 0 ? Math.max(0, Math.min(0.1, (now - lastStep) / 1000)) : 1 / 30
  lastStep = now
  if (!lens && isDry() && !anyWet) { bloom = null; return }
  if (fieldW !== vw || fieldH !== vh) newField(vw, vh)
  const shape = lens && lens.amount > 0.05 ? lensRows(lens, vw) : null
  if (lens && shape) {
    const slot = slotOf(lens.thread, true)
    const [cx, rx, ry] = shape
    // A new read (another current, or the lens moved well away) gathers its pigment its own way.
    if (!bloom || bloom.slot !== slot || Math.abs(bloom.cy - lens.y) > ry * 1.6) {
      if (bloom) ending.add(bloom.slot)
      bloom = { slot, cx, cy: lens.y, rx, ry, side: Math.random() < 0.5 ? -1 : 1, ox: Math.random() * 97, oy: Math.random() * 97 }
    }
    Object.assign(bloom, { cx, cy: lens.y, rx, ry })
    ending.delete(slot)
    pour(rows, slot, smooth(0.05, 0.75, lens.amount), dt)
  } else if (bloom) {
    ending.add(bloom.slot)
    bloom = null
  }
  stepField(dt, bloom)
  for (const slot of ending) if (wetCells[slot] === 0) recordDried(slot, now)
  // How wet each current is: the water lying along it, rising fast, drying slowly.
  anyWet = false
  const reachX = (loomState.currentAperture?.restingWidth ?? 40) * 0.5
  for (const thread of loomState.threads) {
    const path = thread._path
    let lying = 0
    if (!isDry()) {
      for (let k = 0; k < path.length; k += 2) {
        const p = path[k]!
        lying = Math.max(lying, waterAt(p.x, p.y), waterAt(p.x - reachX, p.y), waterAt(p.x + reachX, p.y))
      }
    }
    const was = wetness.get(thread) ?? 0
    const target = Math.min(1, lying * 1.25)
    let w = was + (target - was) * Math.min(1, dt * (target > was ? 4 : 0.8))
    if (w < 0.002 && target === 0) w = 0
    wetness.set(thread, w)
    if (w > 0) anyWet = true
  }
}

function recordDried(slot: number, now: number): void {
  ending.delete(slot)
  const outline: number[] = []
  for (const S of contour(reach, 0.5, (_i, o) => (o === slot ? 1 : 0)).values()) outline.push(...S)
  if (outline.length === 0) return
  records.push({ key: slotKeys[slot] ?? '', driedAt: now, outline: Float32Array.from(outline.slice(0, 8000)) })
  if (records.length > READ_RECORDS) records.shift()
}

/** What finished reads have left behind, oldest first. Not painted: kept so a sheet can one day show its history. */
export function readRecords(): readonly ReadRecord[] {
  return records
}

// ── Text under water ──────────────────────────────────────────────────────────

const over: [number, number, number] = [0, 0, 0]

/**
 * Whether another current's water lies over a line of `thread` spanning x0..x1 at
 * height y: [from, to, fade]. The stretch from..to is under clean water and is not
 * printed (from >= to when none is); fade (0..1) dims the rest where the water is
 * thin or drying, so words come back gently as it dries. The current being read is
 * never covered. On a small sheet, or while a current is held by touch, the open
 * current's water is taken to cover the whole sheet (reading.ts, wordlessAmount).
 * A scratch tuple: read it at once.
 */
export function waterOver(thread: Thread, x0: number, x1: number, y: number): [number, number, number] {
  over[0] = over[1] = over[2] = 0
  if (!paper.on || (thread === loomState.touchedThread && thread.proximity > 0.1)) return over
  const sheet = wordlessAmount(thread)
  if (sheet >= 1) { over[0] = -Infinity; over[1] = Infinity; return over }
  over[2] = sheet
  const gy = Math.round(y / WATER_CELL)
  if (isDry() || fieldW !== loomState.VW || fieldH !== loomState.VH || gy < by0 || gy > by1) return over
  const own = slotOf(thread)
  let from = Infinity
  let to = -Infinity
  const end = Math.min(bx1, Math.ceil(x1 / WATER_CELL))
  for (let gx = Math.max(bx0, Math.floor(x0 / WATER_CELL)); gx <= end; gx++) {
    const i = gy * gw + gx
    const w = water[i]!
    const o = owner[i]!
    if (w <= 0.004 || o < 0 || o === own) continue
    if (w >= HIDING_WATER) {
      from = Math.min(from, (gx - 0.5) * WATER_CELL)
      to = Math.max(to, (gx + 0.5) * WATER_CELL)
    } else over[2] = Math.max(over[2], w / HIDING_WATER)
  }
  if (from < to) { over[0] = from; over[1] = to }
  return over
}

// ── Painting ──────────────────────────────────────────────────────────────────

interface MaskCanvas {
  width: number
  height: number
  getContext(kind: '2d'): CanvasRenderingContext2D | null
}
type MaskFactory = (w: number, h: number) => MaskCanvas | null

const browserCanvas: MaskFactory = (w, h) => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas') as unknown as MaskCanvas
  canvas.width = w
  canvas.height = h
  return canvas
}
let makeCanvas = browserCanvas

/** The clear and the rim at grid resolution, drawn scaled up (smoothly) onto the wash. */
type Mask = [MaskCanvas, CanvasRenderingContext2D, ImageData]
let masks: [Mask, Mask] | null = null
let masksFailed = false
// The box written into the masks last time, to wipe it as the water moves on.
let mx0 = 0, my0 = 0, mx1 = -1, my1 = -1

function mask(): Mask | null {
  const canvas = makeCanvas(gw, gh)
  const ctx = canvas?.getContext('2d')
  return canvas && ctx && typeof ctx.createImageData === 'function' ? [canvas, ctx, ctx.createImageData(gw, gh)] : null
}

/** Each slot's ink, read from its current at every paint (the inks change in place by day and night; a cell holds no colour). */
const slotInk: Array<readonly [number, number, number]> = []

function buildMasks(m: [Mask, Mask]): void {
  const dc = m[0][2].data
  const dr = m[1][2].data
  dc.fill(0)
  dr.fill(0)
  const active = bloom ? bloom.slot : -1
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = y * gw + x
      const j = i * 4
      dc[j + 3] = clear[i]! * 255
      const o = owner[i]!
      // Eased over its neighbours, so pigment lies in a soft band, not in grains:
      // fuller while wet, a faint stain once dry (the tide line is stroked over it).
      const d = (4 * dep[i]! + dep[i - 1]! + dep[i + 1]! + dep[i - gw]! + dep[i + gw]!) / 8
      const a = d * (0.06 + 0.2 * smooth(0, 0.04, water[i]!)) + (o === active ? front[i]! * 0.12 * Math.min(1, d * 2) : 0)
      if (a > 0.004 && o >= 0) {
        const ink = slotInk[o] ?? DEFAULT_COLOR
        dr[j] = ink[0]
        dr[j + 1] = ink[1]
        dr[j + 2] = ink[2]
        dr[j + 3] = Math.min(0.36, a) * 255
      }
    }
  }
  const ux0 = Math.min(mx0, bx0), uy0 = Math.min(my0, by0)
  const w = Math.max(mx1, bx1) - ux0 + 1, h = Math.max(my1, by1) - uy0 + 1
  for (const [, ctx, img] of m) ctx.putImageData(img, 0, 0, ux0, uy0, w, h)
  mx0 = bx0; my0 = by0; mx1 = bx1; my1 = by1
}

function strokeGroups(ctx: CanvasRenderingContext2D, groups: Map<number, number[]>, alphas: readonly number[], width: number): void {
  ctx.lineWidth = width
  for (const [key, S] of groups) {
    const ink = slotInk[Math.floor(key / 3)] ?? DEFAULT_COLOR
    ctx.strokeStyle = `rgba(${ink[0] | 0},${ink[1] | 0},${ink[2] | 0},${alphas[key % 3]})`
    ctx.beginPath()
    for (let i = 0; i < S.length; i += 4) {
      ctx.moveTo(S[i]!, S[i + 1]!)
      ctx.lineTo(S[i + 2]!, S[i + 3]!)
    }
    ctx.stroke()
  }
}

// The tide line once dry: fine and delicate, broken where little pigment reached.
const TIDE = [0.06, 0.12, 0.2]

/**
 * Paints the water onto the wash, after the bands and before the rings: the clean
 * water clears the pigment under it, the pushed pigment gathers at its front (soft
 * and full while wet), and where it has dried a fine tide line stays. `ocean` fades it with the loom view.
 */
export function paintWater(ctx: CanvasRenderingContext2D, ocean: number, blend: GlobalCompositeOperation): void {
  if (isDry() || ocean <= 0.01 || fieldW !== loomState.VW || fieldH !== loomState.VH) return
  for (const thread of loomState.threads) {
    const s = slotOf(thread)
    if (s >= 0) slotInk[s] = thread.baseColor
  }
  const c = WATER_CELL
  ctx.globalAlpha = ocean
  if (!masks && !masksFailed) {
    const a = mask()
    const b = mask()
    masks = a && b ? [a, b] : null
    masksFailed = !masks
    mx0 = my0 = 0
    mx1 = my1 = -1
  }
  if (masks) {
    buildMasks(masks)
    ctx.imageSmoothingEnabled = true
    // A cell's pixel is centred on its grid point.
    const sx = bx0 - 1
    const sy = by0 - 1
    const sw = bx1 - bx0 + 3
    const sh = by1 - by0 + 3
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(masks[0][0] as unknown as CanvasImageSource, sx, sy, sw, sh, (sx - 0.5) * c, (sy - 0.5) * c, sw * c, sh * c)
    ctx.globalCompositeOperation = blend
    ctx.drawImage(masks[1][0] as unknown as CanvasImageSource, sx, sy, sw, sh, (sx - 0.5) * c, (sy - 0.5) * c, sw * c, sh * c)
  }
  ctx.globalCompositeOperation = blend
  ctx.lineCap = 'round'
  if (tideCells > 0) strokeGroups(ctx, contour(reach, 0.5, (i) => {
    const j = [i, i + 1, i + gw, i + gw + 1]
    const most = (a: Float32Array) => Math.max(a[j[0]!]!, a[j[1]!]!, a[j[2]!]!, a[j[3]!]!)
    return (0.2 + 0.8 * Math.min(1, most(dep) * 2.2)) * most(life) * (1 - smooth(0, 0.04, most(water)))
  }), TIDE, 0.9)
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/** Test-only: a dry sheet, no slots, no records. */
export function resetWater(): void {
  fieldW = fieldH = -1
  gw = gh = 0
  bx0 = by0 = 1
  bx1 = by1 = 0
  tideCells = 0
  lastStep = 0
  bloom = null
  anyWet = false
  slotKeys.length = 0
  slotOfThread = new WeakMap()
  wetness = new WeakMap()
  records.length = 0
  ending.clear()
  slotInk.length = 0
  masks = null
  masksFailed = false
}

/** Test-only: where mask canvases come from (null: the browser's). */
export function setWaterCanvasForTest(factory: MaskFactory | null): void {
  makeCanvas = factory ?? browserCanvas
  masks = null
  masksFailed = false
}

/** Test-only: the grid as it stands. */
export function waterForTest() {
  return { gw, gh, water, reach, life, clear, dep, owner, box: [bx0, by0, bx1, by1], dry: isDry() }
}
