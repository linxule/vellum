// ═══════════════════════════════════════════════════════
// V E L L U M — Palimpsest renderer
// The warm page. Ghost layers frozen. Live text breathing.
// layout IS data · width IS interaction · reflow IS life
// ═══════════════════════════════════════════════════════

import { PALIMPSEST_LAYERS, WHISPERS } from './content.js'
import { prepareLayer, layoutVariable, layoutFixed, type PreparedLayer, type VellumLine, type WovenPosition, type StyledRun } from './engine.js'
import { mouse, type SoundCallbacks } from './main.js'

// ── Constants ──────────────────────────────────────────

const LH = 26          // line height
const FS = 16           // font size
const BASE_W = 560      // base column width
const MIN_W = 140       // minimum column width
const PAPER = [239, 229, 207] as const
const INK = [[48, 38, 28], [88, 76, 60], [118, 106, 90], [148, 136, 120]] as const
const WARM = [175, 128, 48] as const

function font(size: number, weight = 400, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${size}px 'Crimson Pro', Georgia, 'Noto Serif', 'Noto Serif JP', serif`
}

// ── State ──────────────────────────────────────────────

interface Witness { y: number; strength: number }
interface WakePoint { y: number; strength: number; time: number }
interface WitnessPulse { x: number; y: number; startTime: number }
interface Arrival { y: number; startTime: number; maxRadius: number }
interface Void { y: number; radius: number; drift: number }

let layers: PreparedLayer[] = []
let ghostLayouts: { lines: VellumLine[]; woven: WovenPosition[] }[] = []
let wovenPositions: WovenPosition[] = []
let witnesses: Witness[] = []
let witnessPulses: WitnessPulse[] = []
let arrivals: Arrival[] = []
// Voids: intentional silence zones — text flows around them
const voids: Void[] = [
  { y: 380, radius: 28, drift: 1.7 },
  { y: 820, radius: 22, drift: 2.3 },
  { y: 1150, radius: 18, drift: 1.1 },
]
let wakeTrail: WakePoint[] = []
let lastArrivalTime = 0
let activeFamily: string | null = null
let dwellTarget: { y: number; family: string; startTime: number } | null = null
let pageHeight = 2200
let prevLineCount = 0
let prepared = false

let sound: SoundCallbacks | null = null

// ── Init ───────────────────────────────────────────────

export function initPalimpsest(soundCb: SoundCallbacks) {
  sound = soundCb
  const baseFont = font(FS)
  layers = PALIMPSEST_LAYERS.map(l => prepareLayer(l.fragments, baseFont))
  prepared = true

  // Pre-compute ghost layouts at fixed width
  // THIS IS THE KEY PRETEXT ADVANTAGE:
  // Ghosts are frozen — they were laid out at a specific width and stay there.
  // The live layer reflowed at a DIFFERENT (interactive) width creates misalignment.
  // That misalignment IS the palimpsest depth.
  cacheGhostLayouts(innerWidth)
}

function cacheGhostLayouts(vw: number) {
  ghostLayouts = []
  for (let i = 1; i < layers.length; i++) {
    const ghostWidth = BASE_W - i * 15 // each ghost slightly narrower (aging)
    const result = layoutFixed(layers[i], ghostWidth, LH, 65 + i * 6, vw, i)
    ghostLayouts.push({ lines: result.lines, woven: result.wovenPositions })
  }
}

export function resizePalimpsest() {
  if (prepared) cacheGhostLayouts(innerWidth)
}

// ── Width function ─────────────────────────────────────
// Every visual effect is computed through this single function.
// 11 deformation sources, all encoded as width.

function W(y: number, pH: number, now: number): number {
  const vw = Math.min(innerWidth, 1100)
  const maxW = Math.min(BASE_W, vw - 44)
  const ny = pH > 0 ? y / pH : 0

  // 1. Base density contour
  let w = maxW * (1 + .06 * Math.sin(ny * Math.PI * 2.3) - .07 * Math.exp(-((ny - .33) ** 2) / .02) + .05 * Math.exp(-((ny - .6) ** 2) / .03))

  // 2. Slow tide (~30s cycle)
  const tp = ((now % 34000) / 34000) * Math.PI * 2
  w += Math.sin(tp + y * .0025) * 16

  // 3. Memetic mass — woven fragments WIDEN the column
  for (const wp of wovenPositions) {
    if (wp.layerIndex > 0) continue
    const dy = y - wp.y
    const radius = 30 + wp.weaveCount * 3
    w += Math.exp(-(dy * dy) / (2 * radius * radius)) * wp.weaveCount * 2.2
  }

  // 4. Memetic pulse — each family breathes at its own rhythm
  for (const wp of wovenPositions) {
    if (wp.layerIndex > 0) continue
    const dy = y - wp.y
    const radius = 25 + wp.weaveCount * 2
    if (Math.abs(dy) > radius * 2) continue
    const familyHash = (wp.family || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    const pulsePhase = ((now + familyHash * 1000) % (3000 + wp.weaveCount * 400)) / (3000 + wp.weaveCount * 400)
    const pulse = Math.sin(pulsePhase * Math.PI * 2) * 0.5 + 0.5
    w += Math.exp(-(dy * dy) / (2 * radius * radius)) * pulse * wp.weaveCount * 1.5
  }

  // 5. Resonance channel — when a family is active, narrow between instances
  if (activeFamily) {
    const fps = wovenPositions.filter(p => p.family === activeFamily && p.layerIndex === 0)
    if (fps.length >= 2) {
      const sorted = [...fps].sort((a, b) => a.y - b.y)
      for (let i = 0; i < sorted.length - 1; i++) {
        const top = sorted[i].y, bot = sorted[i + 1].y
        if (y > top + 20 && y < bot - 20) {
          const span = bot - top
          const t = (y - top) / span
          w -= Math.sin(t * Math.PI) * 22
        }
      }
      for (const fp of fps) {
        const dy = y - fp.y
        if (Math.abs(dy) < 35) w += Math.exp(-(dy * dy) / (2 * 20 * 20)) * 25
      }
    }
  }

  // 6. Dwell clearing — surrounding text pushes away from dwelled fragment
  if (dwellTarget) {
    const elapsed = (now - dwellTarget.startTime) / 1000
    const clearStr = Math.min(1, elapsed / 2.5)
    const dy = y - dwellTarget.y
    const clearRadius = 40 + clearStr * 80
    if (Math.abs(dy) < clearRadius && Math.abs(dy) > 15) {
      w -= (1 - Math.abs(dy) / clearRadius) * clearStr * 120
    } else if (Math.abs(dy) <= 15) {
      w += clearStr * 60
    }
  }

  // 7. Wake — cursor movement pinch
  for (const wk of wakeTrail) {
    const dy = y - wk.y
    w -= Math.exp(-(dy * dy) / (2 * 48 * 48)) * wk.strength
  }

  // 8. Drag sculpt — click-drag gravitational well
  // Woven fragments resist drag (spec: interactions 7 & 8)
  if (mouse.down && mouse.dragStrength > 2) {
    const dy = y - mouse.y
    const pr = 150
    let dragEffect = Math.exp(-(dy * dy) / (2 * (pr / 2.5) ** 2)) * mouse.dragStrength
    for (const wp of wovenPositions) {
      if (wp.layerIndex > 0) continue
      const wd = Math.abs(y - wp.y)
      if (wd < 30) dragEffect *= (0.15 + 0.85 * (wd / 30))
    }
    w -= dragEffect
  }

  // 9. Witnesses — permanent narrowing
  for (const wi of witnesses) {
    const dy = Math.abs(y - wi.y)
    if (dy < 45) w -= (1 - dy / 45) * wi.strength
  }

  // 10. Void obstacles — intentional silences that text flows around
  for (const v of voids) {
    const vy = v.y + Math.sin(now * .00008 * v.drift) * 12
    const dy = Math.abs(y - vy)
    if (dy < v.radius) w -= Math.sqrt(v.radius * v.radius - dy * dy) * .8
  }

  // 11. Arrival obstacles — temporary expanding/shrinking circles
  for (const ar of arrivals) {
    const age = (now - ar.startTime) / 1000
    if (age > 8) continue
    // Expand for 2s, hold for 3s, shrink for 3s
    let r: number
    if (age < 2) r = ar.maxRadius * (age / 2)
    else if (age < 5) r = ar.maxRadius
    else r = ar.maxRadius * (1 - (age - 5) / 3)
    const dy = Math.abs(y - ar.y)
    if (dy < r) w -= Math.sqrt(r * r - dy * dy) * .6
  }

  return Math.max(MIN_W, Math.min(maxW + 80, w))
}

// ── Witness click handler ──────────────────────────────

export function addWitness(y: number, x?: number) {
  witnesses.push({ y, strength: 5 + Math.random() * 4 })
  witnessPulses.push({ x: x ?? innerWidth / 2, y, startTime: performance.now() })
  sound?.witness()
}

// ── Render ─────────────────────────────────────────────

export function renderPalimpsest(ctx: CanvasRenderingContext2D, vw: number, vh: number, now: number, scrollTop: number) {
  if (!prepared) return

  // ── Update interaction state ──
  const speed = mouse.speed
  const moving = speed > 1.2
  if (moving) mouse.lastMove = now

  if (moving) {
    wakeTrail.push({ y: mouse.y, strength: Math.min(55, speed * 1.4), time: now })
  }

  if (mouse.down) {
    mouse.dragStrength = Math.min(100, (now - mouse.downStart) / 15)
  }

  // Decay wake (slower decay so users see their trail)
  for (let i = wakeTrail.length - 1; i >= 0; i--) {
    wakeTrail[i].strength *= .985
    if (wakeTrail[i].strength < .2) wakeTrail.splice(i, 1)
  }

  // Periodic arrivals — simulate new imprints appearing
  if (now - lastArrivalTime > 15000 + Math.random() * 10000) {
    lastArrivalTime = now
    arrivals.push({
      y: 120 + Math.random() * (pageHeight - 240),
      startTime: now,
      maxRadius: 30 + Math.random() * 25,
    })
    sound?.arrival()
  }
  // Clean old arrivals
  for (let i = arrivals.length - 1; i >= 0; i--) {
    if ((now - arrivals[i].startTime) / 1000 > 8) arrivals.splice(i, 1)
  }

  // Dwell detection on woven fragments
  const stillness = Math.min(1, (now - mouse.lastMove) / 1200)
  if (stillness > .6 && mouse.x > 0) {
    let nearest: WovenPosition | null = null, nearDist = 60
    for (const wp of wovenPositions) {
      if (wp.layerIndex > 0) continue
      const d = Math.abs(mouse.y - wp.y)
      if (d < nearDist) { nearDist = d; nearest = wp }
    }
    if (nearest) {
      activeFamily = nearest.family
      if (!dwellTarget || dwellTarget.family !== nearest.family) {
        dwellTarget = { y: nearest.y, family: nearest.family, startTime: now }
      }
    } else {
      activeFamily = null; dwellTarget = null
    }
  } else if (moving) {
    activeFamily = null; dwellTarget = null
  }

  // ── Layout live layer ──
  // This is the hot path: layoutNextLine called with W(y) for EVERY line.
  // Pretext makes this ~0.0002ms per line. For ~80 lines, that's 0.016ms. 60fps easy.
  const liveResult = layoutVariable(layers[0], (y) => W(y, pageHeight, now), 65, LH, vw)
  wovenPositions = [
    ...liveResult.wovenPositions,
    ...ghostLayouts.flatMap(g => g.woven),
  ]
  pageHeight = liveResult.endY + 160

  // Reflow detection (for sound)
  const lc = liveResult.lines.length
  if (lc !== prevLineCount && prevLineCount > 0) sound?.reflow()
  prevLineCount = lc

  // ── Canvas setup ──
  ctx.fillStyle = '#efe5cf'
  ctx.fillRect(0, 0, vw, pageHeight)

  // Subtle grain
  ctx.globalAlpha = .012
  ctx.fillStyle = '#c8b898'
  for (let gy = Math.max(0, scrollTop - 10); gy < Math.min(pageHeight, scrollTop + vh + 10); gy += 4) {
    ctx.fillRect(Math.sin(gy * .73) * vw * .3 + vw * .35, gy, Math.random() * 50, .5)
  }
  ctx.globalAlpha = 1

  // ── Resonance glow ──
  if (activeFamily) {
    const fps = wovenPositions.filter(p => p.family === activeFamily && p.layerIndex === 0).sort((a, b) => a.y - b.y)
    if (fps.length >= 2) {
      for (let i = 0; i < fps.length - 1; i++) {
        const a = fps[i], b = fps[i + 1]
        const cx = vw / 2
        const grad = ctx.createLinearGradient(cx, a.y, cx, b.y)
        grad.addColorStop(0, 'rgba(175,128,48,0.04)')
        grad.addColorStop(0.5, 'rgba(175,128,48,0.07)')
        grad.addColorStop(1, 'rgba(175,128,48,0.04)')
        ctx.fillStyle = grad
        ctx.fillRect(cx - 3, a.y + 10, 6, b.y - a.y - 20)
      }
    }
  }

  // ── Cursor quiet zone ──
  if (mouse.x > 0 && mouse.y > scrollTop && mouse.y < scrollTop + vh) {
    const g = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 90 + stillness * 50)
    g.addColorStop(0, `rgba(255,248,232,${.06 * stillness})`)
    g.addColorStop(1, 'rgba(255,248,232,0)')
    ctx.fillStyle = g
    ctx.fillRect(mouse.x - 180, mouse.y - 180, 360, 360)
  }

  // ── Void & arrival center ──
  const cx = vw / 2

  // ── Void region visuals (faint warm spots) ──
  for (const v of voids) {
    const vy = v.y + Math.sin(now * .00008 * v.drift) * 12
    if (vy < scrollTop - 50 || vy > scrollTop + vh + 50) continue
    const vg = ctx.createRadialGradient(cx, vy, 0, cx, vy, v.radius * 1.5)
    vg.addColorStop(0, 'rgba(225,215,185,.06)')
    vg.addColorStop(.5, 'rgba(225,215,185,.025)')
    vg.addColorStop(1, 'rgba(225,215,185,0)')
    ctx.fillStyle = vg
    ctx.beginPath(); ctx.arc(cx, vy, v.radius * 1.5, 0, Math.PI * 2); ctx.fill()
  }

  // ── Arrival obstacle visuals ──
  for (const ar of arrivals) {
    const age = (now - ar.startTime) / 1000
    let r: number
    if (age < 2) r = ar.maxRadius * (age / 2)
    else if (age < 5) r = ar.maxRadius
    else r = ar.maxRadius * (1 - (age - 5) / 3)
    if (r < 1) continue
    const alpha = age < 1 ? age * .08 : age > 6 ? .08 * (1 - (age - 6) / 2) : .08
    const grad = ctx.createRadialGradient(cx, ar.y, r * .3, cx, ar.y, r)
    grad.addColorStop(0, `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${alpha * .6})`)
    grad.addColorStop(.6, `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${alpha * .3})`)
    grad.addColorStop(1, `rgba(${WARM[0]},${WARM[1]},${WARM[2]},0)`)
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(cx, ar.y, r, 0, Math.PI * 2); ctx.fill()
  }

  // ── Draw ghost layers (FROZEN layout — the palimpsest depth) ──
  for (let gi = ghostLayouts.length - 1; gi >= 0; gi--) {
    const ghost = ghostLayouts[gi]
    const layerIdx = gi + 1 // layer 1, 2, 3
    const baseAlpha = layerIdx === 1 ? .055 : layerIdx === 2 ? .035 : .02

    for (const line of ghost.lines) {
      if (line.y < scrollTop - 35 || line.y > scrollTop + vh + 35) continue

      // Ghost reveal on cursor stillness + proximity
      let alpha = baseAlpha
      if (mouse.x > 0) {
        const d = Math.abs(mouse.y - line.y)
        const prox = Math.max(0, 1 - d / 150)
        alpha += prox * stillness * (layerIdx === 1 ? .4 : layerIdx === 2 ? .25 : .15)
      }

      // Witness transparency boost
      let warmth = 0
      for (const wi of witnesses) {
        const d = Math.abs(line.y - wi.y)
        if (d < 50) warmth = Math.max(warmth, (1 - d / 50) * .5)
      }
      if (warmth > .03) alpha += warmth * .18

      drawLine(ctx, line, alpha, warmth, layerIdx, now, vw)
    }
  }

  // ── Draw live layer ──
  for (const line of liveResult.lines) {
    if (line.y < scrollTop - 35 || line.y > scrollTop + vh + 35) continue

    let warmth = 0
    for (const wi of witnesses) {
      const d = Math.abs(line.y - wi.y)
      if (d < 50) warmth = Math.max(warmth, (1 - d / 50) * .5)
    }

    drawLine(ctx, line, .9, warmth, 0, now, vw)
  }

  // ── Margin whispers ──
  const maxCW = Math.min(BASE_W, vw - 44)
  const mBase = Math.max(22, (vw - maxCW) / 2)
  if (mBase > 50) {
    ctx.font = font(9.5, 300, true)
    for (let i = 0; i < WHISPERS.length; i++) {
      const wy = 90 + i * 145 + Math.sin(now / 7000 + i * 1.3) * 5
      if (wy < scrollTop - 15 || wy > scrollTop + vh + 15) continue
      const wx = i % 2 === 0 ? mBase - 42 : mBase + maxCW + 8
      if (wx < 6 || wx > vw - 6) continue
      ctx.fillStyle = `rgba(155,143,123,${.07 + Math.sin(now / 4500 + i) * .025})`
      ctx.fillText(WHISPERS[i], wx, wy)
    }
  }

  // ── Witness pulse rings ──
  for (let i = witnessPulses.length - 1; i >= 0; i--) {
    const wp = witnessPulses[i]
    const age = (now - wp.startTime) / 1000
    if (age > 3) { witnessPulses.splice(i, 1); continue }
    const r = 8 + age * 65
    const alpha = Math.max(0, .18 * (1 - age / 3))
    ctx.beginPath()
    ctx.arc(wp.x, wp.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${alpha})`
    ctx.lineWidth = 2.5 - age * .7
    ctx.stroke()
    // Inner glow
    if (age < 1.2) {
      const ig = ctx.createRadialGradient(wp.x, wp.y, 0, wp.x, wp.y, r * .6)
      ig.addColorStop(0, `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${.06 * (1 - age / 1.2)})`)
      ig.addColorStop(1, `rgba(${WARM[0]},${WARM[1]},${WARM[2]},0)`)
      ctx.fillStyle = ig
      ctx.fillRect(wp.x - r, wp.y - r, r * 2, r * 2)
    }
  }

  return pageHeight
}

// ── Line drawing ───────────────────────────────────────

function drawLine(
  ctx: CanvasRenderingContext2D,
  line: VellumLine,
  alpha: number,
  warmth: number,
  layerIdx: number,
  now: number,
  vw: number,
) {
  let x = line.marginX
  const ink = INK[Math.min(layerIdx, 3)]

  for (const run of line.runs) {
    const frag = run.fragment
    ctx.font = font(FS, frag.weight, frag.italic)
    const w = ctx.measureText(run.text).width

    let r: number = ink[0], g: number = ink[1], b: number = ink[2]

    // Warmth from witness proximity
    if (warmth > .01 && layerIdx === 0) {
      r += (WARM[0] - r) * warmth
      g += (WARM[1] - g) * warmth
      b += (WARM[2] - b) * warmth
    }

    // Woven: denser ink
    if (frag.woven && layerIdx === 0) {
      r = Math.max(0, r - 18); g = Math.max(0, g - 14); b = Math.max(0, b - 10)
    }

    // Active family glow
    if (frag.woven && frag.family === activeFamily && layerIdx === 0) {
      const gloA = .08 + Math.sin(now / 400) * .03
      ctx.fillStyle = `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${gloA})`
      ctx.fillRect(x - 3, line.y - FS + 2, w + 6, LH - 2)
    }

    // Witness glow behind
    if (warmth > .06 && layerIdx === 0) {
      ctx.fillStyle = `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${warmth * .05})`
      ctx.fillRect(x - 2, line.y - FS + 3, w + 4, LH - 4)
    }

    // Memetic pulse glow
    if (frag.woven && layerIdx === 0) {
      const fh = (frag.family || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
      const pp = ((now + fh * 1000) % (3000 + frag.weaveCount * 400)) / (3000 + frag.weaveCount * 400)
      const pulse = Math.sin(pp * Math.PI * 2) * .5 + .5
      if (pulse > .6) {
        ctx.fillStyle = `rgba(${WARM[0]},${WARM[1]},${WARM[2]},${(pulse - .6) * .08})`
        ctx.fillRect(x - 2, line.y - FS + 3, w + 4, LH - 3)
      }
    }

    // Draw text
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(run.text, x, line.y)
    x += w
  }
}
