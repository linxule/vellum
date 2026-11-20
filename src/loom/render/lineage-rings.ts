// Lineage rings (sketch, paper look only).
//
// On paper a lineage is floated ink, as in suminagashi: the seed is the last
// drop, a pool in the middle of the sheet, and every generation away from it is
// a ring around it. Ancestors keep the top of their ring (up is the past) and
// draw it doubled and still, the way an older ring has been pushed out and
// thinned; descendants share out the rest of theirs, each taking the arc over
// its own branch, single and still spreading. Each arc is in its voice's ink.
// A ring is drawn out to a point toward each voice that was woven from it,
// the way a needle drags floated ink: outward toward a descendant, inward
// toward the seed from an ancestor. Those points replace the filaments.
//
// Colours come only from FAMILY_COLOR / AFTERGLOW_SILVER / DEFAULT_COLOR and the
// blend is the caller's, so the same drawing works on a dark sheet with pale inks.
//
// The text sits on its ring and the ink parts around it, so each opening in a
// ring is exactly a voice's hit target.
//
// Two halves: a pure layout (`layoutRings`, used by loom-view.ts to place the
// text) and a painter for the low-resolution wash canvas (`paintLineageRings`,
// called by the sketch after paintWash). Reads loomState; never writes it.

import { paper } from '../paper.js'
import { loomState } from '../state.js'
import {
  AFTERGLOW_SILVER, DEFAULT_COLOR, FAMILY_COLOR, SEAM_DASH,
  TREE_EMERGENCE_DURATION,
  type LoomNode, type LoomTree,
} from '../types.js'

// ── Layout ───────────────────────────────────────────

/** The resting size of a voice's text block, in CSS px. */
export interface RingBox { w: number, h: number }

export interface RingPlace {
  ring: number            // generations from the seed (0 = the seed)
  side: -1 | 0 | 1        // ancestor, seed, descendant
  angle: number           // radians, screen space (y down): -PI/2 is straight up
  a0: number              // the arc of the ring this voice's ink covers, a0 < a1
  a1: number
  x: number               // centre of the text block, layout space (no scroll, no breath)
  y: number
  w: number
  h: number
}

export interface RingLayout {
  cx: number              // the seed, layout space
  cy: number
  ax: number              // ellipse aspect: a ring of radius r has semi-axes r*ax, r*ay
  ay: number
  radii: number[]         // radius per ring; radii[0] encloses the seed's text
  pool: { rx: number, ry: number }  // the seed's own drop, hugging its text
  places: Map<string, RingPlace>
}

const UP = -Math.PI / 2
/** The top of every ring is kept for the past, open when the seed has no ancestors. */
export const RING_PAST_SECTOR = (60 * Math.PI) / 180
const GAP_X = 14          // clear paper between text blocks
const GAP_Y = 8
const MIN_RING_STEP = 34  // px between neighbouring rings along the long axis
const MAX_RADIUS = 6000
const MARGIN = 24

// Ring shapes tried for a lineage, as [ax, ay]: from wide (a landscape sheet) to
// tall and narrow (a phone). The roundest that fits the sheet wins.
const ASPECTS: ReadonlyArray<readonly [number, number]> = [
  [1, 0.55], [1, 0.7], [1, 0.85], [1, 1], [0.85, 1], [0.7, 1], [0.55, 1], [0.45, 1], [0.36, 1], [0.28, 1], [0.22, 1], [0.17, 1], [0.13, 1], [0.1, 1],
]

function overlaps(a: RingPlace, b: RingPlace): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + GAP_X * 2
    && Math.abs(a.y - b.y) * 2 < a.h + b.h + GAP_Y * 2
}

/**
 * Places a lineage on concentric rings around its seed, centred on the sheet
 * when it fits. Pure: depends only on the tree's shape, the text block sizes
 * and the viewport.
 */
export function layoutRings(tree: LoomTree, boxes: ReadonlyMap<string, RingBox>, vw: number, vh: number): RingLayout {
  const margin = Math.min(MARGIN, vw * 0.03)
  let best: RingLayout | null = null
  let bestScore = Infinity
  for (const [ax, ay] of ASPECTS) {
    const layout = placeOnRings(tree, boxes, ax, ay)
    const b = bounds(layout)
    const overX = Math.max(0, b.maxX - b.minX - (vw - 2 * margin))
    const overY = Math.max(0, b.maxY - b.minY - (vh - 2 * margin))
    // Sideways overflow is the worst (a page scrolls down, not across); then
    // prefer the roundest ring, then the smallest.
    const score = overX * 40 + overY + 80 * Math.abs(Math.log(ay / ax)) + (b.maxX - b.minX + b.maxY - b.minY) * 0.05
    if (best === null || score < bestScore) { bestScore = score; best = layout }
  }
  const layout = best!
  // Centre the text and the outermost ring together where they fit, else the
  // text alone; when even that does not fit, keep the seed on the sheet (the
  // rest is a pan away).
  const b = bounds(layout)
  const outer = layout.radii[layout.radii.length - 1]!
  const seed = layout.places.get(tree.seed)!
  const fit = (lo: number, hi: number, ring: number, size: number, half: number) => {
    const wlo = Math.min(lo, -ring)
    const whi = Math.max(hi, ring)
    const [a, z] = whi - wlo <= size - 2 * margin ? [wlo, whi] : [lo, hi]
    return Math.max(margin + half, Math.min(size - margin - half, size / 2 - (a + z) / 2))
  }
  const cx = fit(b.minX, b.maxX, outer * layout.ax, vw, seed.w / 2)
  const cy = fit(b.minY, b.maxY, outer * layout.ay, vh, seed.h / 2)
  for (const p of layout.places.values()) { p.x += cx; p.y += cy }
  layout.cx = cx
  layout.cy = cy
  return layout
}

function bounds(layout: RingLayout): { minX: number, maxX: number, minY: number, maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of layout.places.values()) {
    minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2)
    minY = Math.min(minY, p.y - p.h / 2); maxY = Math.max(maxY, p.y + p.h / 2)
  }
  return { minX, maxX, minY, maxY }
}

/** One ring shape: places every voice, seed at the origin. */
function placeOnRings(tree: LoomTree, boxes: ReadonlyMap<string, RingBox>, ax: number, ay: number): RingLayout {
  const places = new Map<string, RingPlace>()
  const box = (id: string): RingBox => boxes.get(id) ?? { w: 40, h: 30 }
  const seed = tree.nodes.get(tree.seed)
  const seedBox = box(tree.seed)
  const radii: number[] = [Math.hypot(seedBox.w / 2 / ax, seedBox.h / 2 / ay) + 6]
  const pool = { rx: seedBox.w / 2 + 14, ry: seedBox.h / 2 + 14 }
  places.set(tree.seed, { ring: 0, side: 0, angle: UP, a0: -Math.PI, a1: Math.PI, x: 0, y: 0, w: seedBox.w, h: seedBox.h })
  if (!seed) return { cx: 0, cy: 0, ax, ay, radii, pool, places }

  // Descendants: each branch takes a share of its parent's arc in proportion to
  // its leaves, so a voice's children sit on the next ring within its own arc.
  const leaves = new Map<string, number>()
  const kidsOf = (id: string): string[] => {
    const node = tree.nodes.get(id)!
    return node.childIds.filter(c => tree.nodes.get(c)?.generationDepth === node.generationDepth + 1)
  }
  const countLeaves = (id: string): number => {
    let n = 0
    for (const c of kidsOf(id)) n += countLeaves(c)
    const v = Math.max(1, n)
    leaves.set(id, v)
    return v
  }
  countLeaves(tree.seed)
  const byRing: string[][] = []
  const assign = (id: string, a0: number, a1: number) => {
    const kids = kidsOf(id)
    const total = kids.reduce((s, c) => s + leaves.get(c)!, 0)
    let a = a0
    for (const c of kids) {
      const span = (a1 - a0) * leaves.get(c)! / total
      const ring = tree.nodes.get(c)!.generationDepth
      const b = box(c)
      places.set(c, { ring, side: 1, angle: a + span / 2, a0: a, a1: a + span, x: 0, y: 0, w: b.w, h: b.h })
      ;(byRing[ring] ??= []).push(c)
      assign(c, a, a + span)
      a += span
    }
  }
  assign(tree.seed, UP + RING_PAST_SECTOR / 2, UP + 2 * Math.PI - RING_PAST_SECTOR / 2)

  // Ancestors: one per ring, at the top.
  for (const node of tree.nodes.values()) {
    if (node.generationDepth >= 0) continue
    const ring = -node.generationDepth
    const b = box(node.voiceId)
    places.set(node.voiceId, { ring, side: -1, angle: UP, a0: UP - RING_PAST_SECTOR / 2, a1: UP + RING_PAST_SECTOR / 2, x: 0, y: 0, w: b.w, h: b.h })
    ;(byRing[ring] ??= []).push(node.voiceId)
  }

  // Grow each ring until its voices clear one another and everything inside it.
  const placed: RingPlace[] = [places.get(tree.seed)!]
  const minStep = MIN_RING_STEP / Math.max(ax, ay)
  for (let k = 1; k < byRing.length; k++) {
    const ring = (byRing[k] ?? []).map(id => places.get(id)!)
    let r = radii[k - 1]! + minStep
    for (; r < MAX_RADIUS; r += Math.max(2, r * 0.015)) {
      for (const p of ring) { p.x = Math.cos(p.angle) * r * ax; p.y = Math.sin(p.angle) * r * ay }
      let clear = true
      for (let i = 0; i < ring.length && clear; i++) {
        for (let j = i + 1; j < ring.length && clear; j++) if (overlaps(ring[i]!, ring[j]!)) clear = false
        for (const q of placed) if (clear && overlaps(ring[i]!, q)) clear = false
      }
      if (clear) break
    }
    radii[k] = r
    placed.push(...ring)
    // An ancestor's ring is whole wherever no descendant shares it.
    const anc = ring.find(p => p.side === -1)
    if (anc) {
      let lo = Infinity
      let hi = -Infinity
      for (const p of ring) {
        if (p.side !== 1) continue
        lo = Math.min(lo, p.a0)
        hi = Math.max(hi, p.a1)
      }
      anc.a0 = hi > -Infinity ? hi - 2 * Math.PI : UP - Math.PI
      anc.a1 = lo < Infinity ? lo : UP + Math.PI
    }
  }
  return { cx: 0, cy: 0, ax, ay, radii, pool, places }
}

/**
 * How far a lineage laid out on rings may be panned (the tree's scroll offsets,
 * px): along an axis where its text fits the sheet inside `margin`, not at all;
 * where it does not, just far enough to bring its farthest text in. Pure.
 */
export function ringPanRange(layout: RingLayout, vw: number, vh: number, margin: number): { x0: number, x1: number, y0: number, y1: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of layout.places.values()) {
    minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2)
    minY = Math.min(minY, p.y - p.h / 2); maxY = Math.max(maxY, p.y + p.h / 2)
  }
  return {
    x0: Math.min(0, minX - margin), x1: Math.max(0, maxX + margin - vw),
    y0: Math.min(0, minY - margin), y1: Math.max(0, maxY + margin - vh),
  }
}

/** A point on ring `radius` at `angle`. */
export function ringPoint(layout: RingLayout, radius: number, angle: number): { x: number, y: number } {
  return { x: layout.cx + Math.cos(angle) * radius * layout.ax, y: layout.cy + Math.sin(angle) * radius * layout.ay }
}

const layouts = new WeakMap<LoomTree, RingLayout>()
export function setRingLayout(tree: LoomTree, layout: RingLayout): void { layouts.set(tree, layout) }
export function ringLayoutFor(tree: LoomTree): RingLayout | null { return layouts.get(tree) ?? null }

// ── Arcs ─────────────────────────────────────────────

function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}

export interface Cusp { id: string, angle: number, pull: number, tip: number }

/** Longest a ring is drawn out, in px: a point, not a filament. */
export const CUSP_MAX = 46

/** The points toward which a voice's ring is drawn out: one per voice woven from it. */
export function ringCusps(tree: LoomTree, layout: RingLayout, id: string): Cusp[] {
  const node = tree.nodes.get(id)
  const place = layout.places.get(id)
  if (!node || !place) return []
  const out: Cusp[] = []
  const r = layout.radii[place.ring]!
  for (const c of node.childIds) {
    const cp = layout.places.get(c)
    if (!cp) continue
    const step = layout.radii[cp.ring]! - r
    // Outward toward a descendant, inward from an ancestor toward the one it led to.
    // A drop pulled many ways at once stays nearly round.
    const share = place.side === 0 ? 0.5 : 0.62
    const many = place.side === 0 ? Math.pow(Math.max(1, node.childIds.length - 1), 1.5) : 1
    const pull = Math.sign(step) * Math.min(Math.abs(step) * share, CUSP_MAX) / many
    const angle = cp.side === 1 ? cp.angle : place.angle
    out.push({ id: c, angle, pull, tip: Math.max(7, Math.abs(pull) * 0.3) })
  }
  return out
}

/** Radius of a ring at `angle`, drawn out at each cusp: a broad swell ending in a point. */
export function cuspedRadius(radius: number, angle: number, cusps: readonly Cusp[]): number {
  let r = radius
  for (const c of cusps) {
    const d = Math.abs(wrapAngle(angle - c.angle)) * Math.max(1, radius) / c.tip
    r += c.pull * (0.55 * Math.exp(-d) + 0.45 * Math.exp(-d * d / 9))
  }
  return r
}

/** Sample angles over [a0, a1]: about every `stepPx` along the ring, plus each cusp tip exactly. */
export function arcSamples(a0: number, a1: number, radius: number, cusps: readonly Cusp[], stepPx: number): number[] {
  const n = Math.max(2, Math.ceil(((a1 - a0) * Math.max(1, radius)) / stepPx))
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(a0 + ((a1 - a0) * i) / n)
  for (const c of cusps) {
    // The tip angle, unwrapped into [a0, a1].
    let a = c.angle
    while (a < a0) a += 2 * Math.PI
    while (a > a1 && a - 2 * Math.PI >= a0) a -= 2 * Math.PI
    if (a >= a0 && a <= a1) out.push(a)
  }
  return out.sort((p, q) => p - q)
}

// ── Painter ──────────────────────────────────────────

function emergence(tree: LoomTree, delay: number, now: number): number {
  if (tree.enteredAt <= 0) return 1
  const e = now - tree.enteredAt - delay
  if (e <= 0) return 0
  if (e >= TREE_EMERGENCE_DURATION) return 1
  const t = e / TREE_EMERGENCE_DURATION
  return 1 - Math.pow(1 - t, 3)
}

function ink(rgb: readonly number[], a: number): string {
  return `rgba(${rgb[0]! | 0},${rgb[1]! | 0},${rgb[2]! | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

const RING_LINE_ALPHA = 0.6
const RING_BLEED_ALPHA = 0.085
const POOL_ALPHA = 0.05
const PULSE_S = 1.6

/**
 * The opening in the ink under a voice's text: an ellipse around its hit target,
 * fully clear out to RING_CLEAR_FULL of its radius, feathered beyond.
 */
export function ringOpening(hw: number, hh: number): { rx: number, ry: number } {
  return { rx: hw * 1.3 + 8, ry: hh * 1.3 + 8 }
}
export const RING_CLEAR_FULL = 0.78
const RING_CLEAR_STRENGTH = 0.94

// A voice of the open lineage being heard: its ring darkens and swells a little.
const pulses = new Map<string, { start: number, strength: number }>()

/**
 * A drop fell at (x, y). If it fell on a voice of the open lineage (paper only),
 * that voice's ring takes it, and this returns true; otherwise false, and the
 * caller leaves its usual ripple.
 */
export function pulseLineageRing(x: number, y: number, strength: number, now: number): boolean {
  const tree = loomState.loomTree
  if (!paper.on || !tree || !loomState.loomViewActive || !layouts.has(tree)) return false
  let best: string | null = null
  let bestD = 24 * 24
  for (const n of tree.nodes.values()) {
    const d = (n.renderX - x) ** 2 + (n.renderY - y) ** 2
    if (d <= bestD) { bestD = d; best = n.voiceId }
  }
  if (!best) return false
  // A pulse is removed when painted after its time; one never painted again (the view closed) is swept here.
  if (pulses.size > 40) for (const [id, p] of pulses) if ((now - p.start) / 1000 > PULSE_S) pulses.delete(id)
  pulses.set(best, { start: now, strength })
  return true
}

/**
 * Paints the open lineage's rings on the wash canvas. Call right after
 * paintWash, with the same context, scale and blend (the wash's: 'multiply' for
 * ink on a light sheet, 'screen' for pale ink on a dark one). Does nothing
 * unless the paper look is on and a lineage is showing.
 */
export function paintLineageRings(ctx: CanvasRenderingContext2D, scale: number, now: number, blend: GlobalCompositeOperation = 'multiply'): void {
  if (!paper.on) return
  const tree = loomState.loomTree
  const transition = loomState.loomViewTransition
  if (!tree || transition < 0.01) return
  const layout = layouts.get(tree)
  if (!layout) return

  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.globalCompositeOperation = blend
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const ox = loomState.current * 2 - loomState.loomTreeScrollX
  const oy = -loomState.loomTreeScrollY
  const cx = layout.cx + ox
  const cy = layout.cy + oy
  const t = now * 0.00012
  let maxProx = 0
  for (const n of tree.nodes.values()) if (n.proximity > maxProx) maxProx = n.proximity
  const spot = maxProx > 0.3 ? Math.min(1, (maxProx - 0.3) / 0.7) : 0

  const xs: number[] = []
  const ys: number[] = []
  const trace = (shrink: number, close: boolean) => {
    ctx.beginPath()
    for (let i = 0; i < xs.length; i++) {
      const x = cx + (xs[i]! - cx) * shrink
      const y = cy + (ys[i]! - cy) * shrink
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    if (close) ctx.closePath()
  }
  // The seed opened by the lens: its drop grows to hold the opened text, the other rings' ink
  // parts around it as around any voice, and it is painted after that parting. At rest it is
  // painted in turn, as it always was.
  const seedNode = tree.nodes.get(tree.seed)
  const seedOpen = seedNode && seedNode.proximity > 0.01 ? smooth(seedNode.proximity) : 0
  const seedHit = seedOpen > 0 ? loomState.lastFrameHitTargets.find(t => t[0] === tree.seed) : undefined
  const paintNode = (node: LoomNode) => {
    const place = layout.places.get(node.voiceId)
    if (!place) return
    const et = emergence(tree, node.emergenceDelay, now)
    if (et < 0.01) return
    const color = node.afterglow ? AFTERGLOW_SILVER : (FAMILY_COLOR[node.family] ?? DEFAULT_COLOR)
    const pulse = pulses.get(node.voiceId)
    let heard = 0
    if (pulse) {
      const age = (now - pulse.start) / 1000
      if (age > PULSE_S) pulses.delete(node.voiceId)
      else if (age > 0) heard = Math.min(1, pulse.strength) * Math.pow(1 - age / PULSE_S, 2) * Math.min(1, age * 8)
    }
    const focus = 1 + node.proximity * 0.9 + heard * 1.2
    const dim = 1 - spot * 0.5 * (1 - node.proximity)
    const a = transition * et * focus * dim
    // A ring spreads out from the one inside it as the voice arrives.
    const inner = place.ring > 0 ? layout.radii[place.ring - 1]! : 0
    const pool = place.side === 0 && seedHit ? openPool(layout.pool, seedHit[3], seedHit[4], seedOpen) : layout.pool
    const full = place.side === 0 ? Math.max(pool.rx, pool.ry) : layout.radii[place.ring]!
    const r = inner + (full - inner) * (0.55 + 0.45 * et) + heard * 4
    // The seed's pool has its own shape; every other ring shares the lineage's.
    const kx = place.side === 0 ? pool.rx / full : layout.ax
    const ky = place.side === 0 ? pool.ry / full : layout.ay
    const cusps = ringCusps(tree, layout, node.voiceId)
    for (const c of cusps) {
      const child = tree.nodes.get(c.id)
      if (child) c.pull *= emergence(tree, child.emergenceDelay, now)
    }
    // Ancestors are still; descendants are still moving.
    const life = place.side === -1 ? 0.15 : 1
    const seed = node.breathSeed
    const samples = arcSamples(place.a0, place.a1, r, cusps, 5)
    xs.length = 0
    ys.length = 0
    for (const th of samples) {
      const wob = 1 + 0.012 * Math.sin(th * 3 + seed + t * life) + 0.007 * Math.sin(th * 7 + seed * 2.3 - t * 1.7 * life)
      const rr = cuspedRadius(r * wob, th, cusps)
      xs.push(cx + Math.cos(th) * rr * kx)
      ys.push(cy + Math.sin(th) * rr * ky)
    }
    const whole = place.a1 - place.a0 >= 2 * Math.PI - 1e-6
    if (place.side === 0) {
      // The seed: the drop itself, a pale pool whose pigment gathers at the rim.
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(kx, ky)
      const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
      pool.addColorStop(0, ink(color, POOL_ALPHA * 0.3 * a))
      pool.addColorStop(0.7, ink(color, POOL_ALPHA * a))
      pool.addColorStop(1, ink(color, POOL_ALPHA * 2 * a))
      ctx.fillStyle = pool
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    if (node.afterglow) ctx.setLineDash(SEAM_DASH)
    trace(1, whole)
    ctx.strokeStyle = ink(color, RING_BLEED_ALPHA * a)
    ctx.lineWidth = 7
    ctx.stroke()
    ctx.strokeStyle = ink(color, RING_LINE_ALPHA * a)
    ctx.lineWidth = 1.2 + node.proximity * 0.6 + heard * 0.8
    ctx.stroke()
    if (place.side === -1) {
      // An older ring, pushed out and thinned into two.
      trace(1 - 5 / Math.max(20, r), whole)
      ctx.strokeStyle = ink(color, RING_LINE_ALPHA * 0.55 * a)
      ctx.lineWidth = 0.8
      ctx.stroke()
    }
    if (node.afterglow) ctx.setLineDash([])
  }
  for (const node of tree.nodes.values()) if (node !== seedNode || !seedHit) paintNode(node)

  // The ink parts around the words: each voice's opening is its hit target.
  ctx.globalCompositeOperation = 'destination-out'
  for (const [id, hx, hy, hw, hh] of loomState.lastFrameHitTargets) {
    if (id === tree.seed && !seedHit) continue
    const { rx, ry } = ringOpening(hw, hh)
    const s = (RING_CLEAR_STRENGTH * transition * (id === tree.seed ? seedOpen : 1)).toFixed(3)
    ctx.save()
    ctx.translate(hx, hy)
    ctx.scale(1, ry / rx)
    const clear = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    clear.addColorStop(0, `rgba(0,0,0,${s})`)
    clear.addColorStop(RING_CLEAR_FULL, `rgba(0,0,0,${s})`)
    clear.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = clear
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
    ctx.restore()
  }
  if (seedNode && seedHit) {
    ctx.globalCompositeOperation = blend
    paintNode(seedNode)
  }
  ctx.globalCompositeOperation = 'source-over'
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

/**
 * The seed's drop while the lens opens it: grown from its resting size toward an
 * ellipse that holds the opened text (half-size hw x hh), by `open` (0..1).
 */
export function openPool(pool: { rx: number, ry: number }, hw: number, hh: number, open: number): { rx: number, ry: number } {
  return {
    rx: pool.rx + Math.max(0, hw * 1.25 + 14 - pool.rx) * open,
    ry: pool.ry + Math.max(0, hh * 1.25 + 14 - pool.ry) * open,
  }
}
