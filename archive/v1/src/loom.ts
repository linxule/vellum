// ═══════════════════════════════════════════════════════
// V E L L U M — Loom renderer
// The dark cosmic field. Streams fork and merge.
// Memes orbit. Particles drift. Text flows like rivers.
// ═══════════════════════════════════════════════════════

import { prepareWithSegments, layoutNextLine, type PreparedTextWithSegments, type LayoutCursor } from '@chenglou/pretext'
import { LOOM_VOICES, LOOM_MEMES } from './content.js'
import { mouse } from './main.js'

// ── Constants ──────────────────────────────────────────

const STREAM_FONT_SIZE = 13
function font(size: number, weight = 400): string {
  return `${weight} ${size}px 'Crimson Pro', Georgia, serif`
}

// ── Types ──────────────────────────────────────────────

interface WordEntry {
  text: string
  width: number
}

interface Meme {
  text: string
  width: number
  font: string
  family: string
  weaveCount: number
  x: number; y: number
  vx: number; vy: number
  orbAngle: number
  orbRadius: number
  orbSpeed: number
  pulse: number
  absorbed: number
}

interface Stream {
  depth: number
  seed: number
  flowSpeed: number
  baseWidth: number
  yOffset: number
  xCenter: number
  scroll: number        // position in wordBank
  scrollVel: number
  userBoost: number
  holdLerp: number      // 0 = stream, 1 = reading column (continuous)
  prepared: PreparedTextWithSegments | null  // Pretext layout for reading mode
}

interface PathPoint {
  x: number; y: number; w: number
  forkMeme: Meme | null; forkStrength: number
}

interface Particle {
  text: string; font: string
  x: number; y: number; scale: number
  vx: number; vy: number
  alpha: number; life: number; maxLife: number
  angle: number; av: number
}

// ── State ──────────────────────────────────────────────

let memes: Meme[] = []
let streams: Stream[] = []
let particles: Particle[] = []
let wordBank: WordEntry[] = []
let prepared = false
let frameCount = 0
let nearestStream: Stream | null = null
let heldStream: Stream | null = null      // set by mousedown, cleared by mouseup
let lastHeldStream: Stream | null = null  // for brightness fade-back
let releaseTime = 0                       // when stream was released
let hoveredMeme: Meme | null = null
let VW = 0, VH = 0

// Measurement canvas for word bank
let measureCtx: CanvasRenderingContext2D | null = null

// ── Init ───────────────────────────────────────────────

export function initLoom() {
  VW = innerWidth; VH = innerHeight

  // Build word bank using Pretext's multilingual segmentation
  // Pretext segments text into proper word/character boundaries for all scripts
  const voiceText = LOOM_VOICES.map(v => v + ' ').join('')
  const fullText = voiceText.repeat(3)
  const prep = prepareWithSegments(fullText, font(STREAM_FONT_SIZE), { whiteSpace: 'pre-wrap' })

  // Use Pretext's segments as our word bank — these are properly segmented
  // for CJK (per-character), Arabic (proper boundaries), Latin (word-level), etc.
  measureCtx = document.createElement('canvas').getContext('2d')!
  measureCtx.font = font(STREAM_FONT_SIZE)
  wordBank = []
  for (const seg of prep.segments) {
    const trimmed = seg.replace(/\n/g, ' ')
    if (!trimmed || trimmed === ' ' && wordBank.length > 0 && wordBank[wordBank.length - 1].text.endsWith(' ')) continue
    wordBank.push({ text: trimmed, width: measureCtx.measureText(trimmed).width })
  }

  // Prepare shared Pretext object for reading mode (one for all streams)
  sharedPrepared = prepareWithSegments(fullText, READ_FONT, { whiteSpace: 'pre-wrap' })

  // Create memes
  memes = LOOM_MEMES.map((m, i) => {
    const f = font(m.fontSize, 500)
    measureCtx!.font = f
    const a = (i / LOOM_MEMES.length) * Math.PI * 2 + Math.random() * .3
    const r = Math.min(VW, VH) * .22 + Math.random() * Math.min(VW, VH) * .12
    return {
      text: m.text, width: measureCtx!.measureText(m.text).width, font: f,
      family: m.family, weaveCount: m.weaveCount,
      x: VW / 2 + Math.cos(a) * r, y: VH / 2 + Math.sin(a) * r,
      vx: 0, vy: 0,
      orbAngle: a, orbRadius: r,
      orbSpeed: .00005 + m.weaveCount * .000004,
      pulse: Math.random() * Math.PI * 2,
      absorbed: 0,
    }
  })

  initStreams()
  prepared = true
}

function initStreams() {
  streams = [
    // Background (depth 0)
    mkStream(0, 0, .012, 55, -.1, VW * .25),
    mkStream(0, 3, .009, 45, -.08, VW * .72),
    mkStream(0, 7, .014, 40, -.12, VW * .5),
    mkStream(0, 11, .01, 50, -.06, VW * .15),
    mkStream(0, 15, .008, 38, -.1, VW * .88),
    // Mid (depth 1)
    mkStream(1, 1, .02, 85, -.04, VW * .38),
    mkStream(1, 5, .018, 75, -.05, VW * .62),
    mkStream(1, 9, .015, 65, -.03, VW * .22),
    // Foreground (depth 2)
    mkStream(2, 2, .03, 130, -.01, VW * .48),
    mkStream(2, 6, .025, 110, -.02, VW * .33),
  ]
}

// Reading font for held streams — Pretext lays out at this size
const READ_FONT = `400 16px 'Crimson Pro', Georgia, 'Noto Serif', 'Noto Serif JP', serif`
const READ_WIDTH = 420
let sharedPrepared: PreparedTextWithSegments | null = null

function mkStream(depth: number, seed: number, flow: number, w: number, yOff: number, xC: number): Stream {
  return {
    depth, seed, flowSpeed: flow, baseWidth: w, yOffset: yOff, xCenter: xC,
    scroll: Math.random() * wordBank.length, scrollVel: flow, userBoost: 0,
    holdLerp: 0, prepared: sharedPrepared,
  }
}

export function resizeLoom() {
  VW = innerWidth; VH = innerHeight
  if (prepared) initStreams()
}

export function scrollStream(deltaY: number) {
  const target = heldStream || nearestStream
  if (target) target.userBoost += deltaY > 0 ? .15 : -.15
}

// ── Stream path computation ────────────────────────────

function getStreamPath(s: Stream, now: number): PathPoint[] {
  const pts: PathPoint[] = []
  const y0 = VH * s.yOffset, y1 = VH * (1 - s.yOffset)
  const t0 = now * .0001 * (.5 + s.depth * .5)

  for (let i = 0; i <= 50; i++) {
    const t = i / 50
    const y = y0 + t * (y1 - y0)
    let x = s.xCenter
      + Math.sin(t * 2.4 + t0 + s.seed) * VW * (.1 + s.depth * .04)
      + Math.sin(t * 3.9 + t0 * 1.4 + s.seed * 2.1) * VW * (.04 + s.depth * .02)
    let w = s.baseWidth + Math.sin(t * 2.8 + t0 * .8) * 12

    let forkMeme: Meme | null = null, forkStrength = 0
    for (const me of memes) {
      const dx = x - me.x, dy = y - me.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const threshold = 80 + me.weaveCount * 6
      if (dist < threshold) {
        const inf = 1 - dist / threshold
        w += inf * me.weaveCount * 2
        x += dx / Math.max(dist, 1) * inf * 25
        if (inf > .15 && me.weaveCount > 5 && !forkMeme) {
          forkMeme = me; forkStrength = inf
        }
      }
    }

    // Mouse push
    if (mouse.x > 0) {
      const dx = x - mouse.x, dy = y - mouse.y, d = Math.sqrt(dx * dx + dy * dy)
      const pushRadius = 180 + s.depth * 40
      if (d < pushRadius) x += dx / Math.max(d, 1) * (1 - d / pushRadius) * 45
    }

    pts.push({ x, y, w, forkMeme, forkStrength })
  }
  return pts
}

// ── Word-bank line layout ──────────────────────────────
// Pack words from the bank until the local width is reached.
// This is the prototype's approach but with Pretext-segmented words.

interface RenderedWord { text: string; sw: number }

function packWords(wi: number, maxWidth: number, scale: number): { words: RenderedWord[]; used: number; nextWi: number } {
  const words: RenderedWord[] = []
  let used = 0
  while (used < maxWidth) {
    const wd = wordBank[wi % wordBank.length]
    const sw = wd.width * scale
    if (used + sw > maxWidth && words.length) break
    words.push({ text: wd.text, sw })
    used += sw
    wi++
  }
  return { words, used, nextWi: wi }
}

// ── Render ─────────────────────────────────────────────

export function renderLoom(ctx: CanvasRenderingContext2D, vw: number, vh: number, now: number) {
  if (!prepared) return
  VW = vw; VH = vh
  frameCount++

  // Fade trail
  ctx.fillStyle = 'rgba(8,6,4,.14)'
  ctx.fillRect(0, 0, vw, vh)
  if (frameCount % 45 === 0) { ctx.fillStyle = 'rgba(8,6,4,.55)'; ctx.fillRect(0, 0, vw, vh) }

  // ── Update memes ──
  hoveredMeme = null
  for (const me of memes) {
    me.orbAngle += me.orbSpeed * (1 + Math.sin(now * .00007) * .25)
    const tx = VW / 2 + Math.cos(me.orbAngle) * me.orbRadius
    const ty = VH / 2 + Math.sin(me.orbAngle) * me.orbRadius * .5
    me.vx += (tx - me.x) * .0005; me.vy += (ty - me.y) * .0005

    for (const o of memes) {
      if (o === me) continue
      const dx = o.x - me.x, dy = o.y - me.y, d = Math.sqrt(dx * dx + dy * dy)
      if (o.family === me.family && d > 20 && d < 350) { me.vx += dx / d * .012; me.vy += dy / d * .012 }
      if (o.family !== me.family && d < 120) { me.vx += (me.x - o.x) / d * .006; me.vy += (me.y - o.y) / d * .006 }
    }

    if (mouse.x > 0) {
      const dx = me.x - mouse.x, dy = me.y - mouse.y, d = Math.sqrt(dx * dx + dy * dy)
      if (d < me.width * .5 + 25) hoveredMeme = me
      // Require 200ms hold before drag activates — prevents accidental pulls
      const holdTime = mouse.down ? performance.now() - mouse.downStart : 0
      if (mouse.down && holdTime > 200 && d < 300) { me.vx -= dx / d * 2; me.vy -= dy / d * 2 }
      else if (d < 150) { me.vx += dx / d * .3; me.vy += dy / d * .3 }
    }

    me.vx *= .95; me.vy *= .95
    me.x += me.vx; me.y += me.vy
    me.x = Math.max(40, Math.min(VW - 40, me.x))
    me.y = Math.max(25, Math.min(VH - 25, me.y))
    me.pulse += .003 + me.weaveCount * .0004
  }

  // ── Compute all stream paths ──
  const streamPaths: Map<Stream, PathPoint[]> = new Map()
  for (const s of streams) streamPaths.set(s, getStreamPath(s, now))

  // ── Find nearest stream by path proximity ──
  nearestStream = null
  let nearDist = 100
  if (mouse.x > 0) {
    for (const s of streams) {
      const path = streamPaths.get(s)!
      for (let i = 0; i < path.length; i += 3) {
        const p = path[i]
        const dx = mouse.x - p.x, dy = mouse.y - p.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < nearDist) { nearDist = d; nearestStream = s }
      }
    }
  }

  // ── Touch physics — drag scrolls the nearest stream ──
  if (mouse.down && nearestStream && !hoveredMeme) {
    if (!heldStream) heldStream = nearestStream
    if (mouse.moving && heldStream) {
      const dy = mouse.y - mouse.prevY
      heldStream.scrollVel = dy * .04
    }
  }
  if (!mouse.down && heldStream) {
    lastHeldStream = heldStream
    releaseTime = now
    heldStream = null
  }

  // ── Animate holdLerp — cursor proximity brings stream forward ──
  for (const s of streams) {
    // Nearest stream comes to front on hover. No click needed.
    const target = (s === nearestStream && mouse.x > 0) ? 1 : 0
    const speed = target > s.holdLerp ? .06 : .035 // faster in, slower out
    s.holdLerp += (target - s.holdLerp) * speed
    if (s.holdLerp < .005) s.holdLerp = 0
    if (s.holdLerp > .995) s.holdLerp = 1
  }

  // ── Render streams by depth ──
  const maxLerp = Math.max(...streams.map(s => s.holdLerp))
  const isHolding = maxLerp > .1 // something is in the foreground

  for (const depth of [0, 1, 2]) {
    for (const s of streams.filter(st => st.depth === depth)) {
      const path = streamPaths.get(s)!
      const scale = .55 + s.depth * .22
      const baseAlpha = .12 + s.depth * .28
      // Scroll physics — stream slows as it comes forward
      const slowFactor = 1 - s.holdLerp * .95 // at full lerp, 5% of normal speed
      if (s === heldStream) {
        s.scrollVel += (0 - s.scrollVel) * .08
      } else {
        s.scrollVel += (s.flowSpeed * slowFactor - s.scrollVel) * .02
      }
      s.scrollVel += s.userBoost
      s.userBoost *= .9
      s.scroll += s.scrollVel
      if (s.scroll < 0) s.scroll += wordBank.length

      // ── READING COLUMN (Pretext layout) when holdLerp > threshold ──
      if (s.holdLerp > .15 && s.prepared) {
        const hl = s.holdLerp
        const colWidth = s.baseWidth + (READ_WIDTH - s.baseWidth) * hl
        const colX = s.xCenter + (VW / 2 - s.xCenter) * hl
        const lineHeight = 18 + hl * 8
        const readAlpha = baseAlpha + (.88 - baseAlpha) * hl
        const fontSize = STREAM_FONT_SIZE * scale + (16 - STREAM_FONT_SIZE * scale) * hl

        // Advance Pretext cursor to scroll position
        const scrollLines = Math.max(0, Math.floor(Math.abs(s.scroll) * 1.5)) % 300
        let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
        for (let skip = 0; skip < scrollLines; skip++) {
          const ln = layoutNextLine(s.prepared, cursor, colWidth)
          if (!ln) { cursor = { segmentIndex: 0, graphemeIndex: 0 }; break }
          cursor = ln.end
        }

        // Render lines using Pretext — variable width per line
        const startY = 55
        let y = startY
        const maxLines = Math.floor((VH - 80) / lineHeight)

        ctx.font = `400 ${fontSize}px 'Crimson Pro', Georgia, 'Noto Serif', 'Noto Serif JP', serif`
        ctx.textBaseline = 'alphabetic'

        // Subtle column background
        const colBg = ctx.createLinearGradient(colX - colWidth / 2 - 20, 0, colX + colWidth / 2 + 20, 0)
        colBg.addColorStop(0, 'rgba(200,170,80,0)')
        colBg.addColorStop(.1, `rgba(200,170,80,${.015 * hl})`)
        colBg.addColorStop(.9, `rgba(200,170,80,${.015 * hl})`)
        colBg.addColorStop(1, 'rgba(200,170,80,0)')
        ctx.fillStyle = colBg
        ctx.fillRect(colX - colWidth / 2 - 20, startY - 25, colWidth + 40, VH - startY)

        for (let li = 0; li < maxLines; li++) {
          // Variable width per line — memes influence the reading column width
          let lineWidth = colWidth
          for (const me of memes) {
            const d = Math.abs(y - me.y)
            if (d < 80 + me.weaveCount * 3) {
              lineWidth += (1 - d / (80 + me.weaveCount * 3)) * me.weaveCount * 2.5 * hl
            }
          }

          const ln = layoutNextLine(s.prepared, cursor, lineWidth)
          if (!ln) break
          cursor = ln.end

          const x = colX - lineWidth / 2

          // Meme color influence
          let mInf = 0
          for (const me of memes) {
            const d = Math.sqrt((colX - me.x) ** 2 + (y - me.y) ** 2)
            if (d < 140 + me.weaveCount * 4) mInf = Math.max(mInf, 1 - d / (140 + me.weaveCount * 4))
          }
          const r = Math.min(255, (160 + mInf * 60) | 0)
          const g = Math.min(255, (140 + mInf * 20) | 0)
          const b = Math.max(0, (110 - mInf * 30) | 0)

          ctx.fillStyle = `rgba(${r},${g},${b},${readAlpha})`
          ctx.fillText(ln.text, x, y)
          y += lineHeight
        }

        continue // skip word-bank rendering for this stream
      }

      // ── STREAM MODE (word-bank packing) ──
      let wi = Math.floor(s.scroll) % wordBank.length
      let activeFork: { meme: Meme; wi: number } | null = null

      for (let i = 0; i < path.length - 1; i++) {
        const p = path[i], pn = path[i + 1]
        const angle = Math.atan2(pn.y - p.y, pn.x - p.x)
        const lw = p.w * scale

        const pack = packWords(wi, lw, scale)
        wi = pack.nextWi
        if (pack.words.length === 0) continue

        const lineAlpha = baseAlpha * (1 + Math.sin(now * .0007 + i * .12 + s.seed) * .12)
        let mInf = 0
        for (const me of memes) {
          const d = Math.sqrt((p.x - me.x) ** 2 + (p.y - me.y) ** 2)
          if (d < 140 + me.weaveCount * 4) mInf = Math.max(mInf, 1 - d / (140 + me.weaveCount * 4))
        }
        const bright = s.depth === 2 ? 1 : s.depth === 1 ? .55 : .3
        const r = (140 + mInf * 65) * bright | 0
        const g = (120 + mInf * 25) * bright | 0
        const b = (90 - mInf * 25) * bright | 0

        // Dim when another stream is in the foreground
        const dimFactor = isHolding ? (1 - (maxLerp - s.holdLerp) * .7) : 1
        const finalAlpha = lineAlpha * dimFactor

        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(Math.sin(angle) * .06)
        ctx.font = font(STREAM_FONT_SIZE * scale)
        ctx.fillStyle = `rgba(${r},${g},${b},${finalAlpha})`
        ctx.textBaseline = 'middle'
        let xo = -pack.used / 2
        for (const wd of pack.words) {
          ctx.fillText(wd.text, xo, 0)
          xo += wd.sw
        }
        ctx.restore()

        // Particle spawning (rare, foreground only)
        if (s.depth === 2 && Math.random() < .0003 && pack.words.length > 0) {
          spawnParticle(p.x, p.y, pack.words[0].text.trim(), scale)
        }

        // ── Forking ──
        if (p.forkMeme && p.forkStrength > .15) {
          if (!activeFork || activeFork.meme !== p.forkMeme) {
            activeFork = { meme: p.forkMeme, wi: wi + 50 + Math.floor(s.seed * 30) }
          }
          const me = p.forkMeme
          const dx = p.x - me.x, dy = p.y - me.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const forkDist = 60 + me.weaveCount * 5
          const perpX = -dy / Math.max(dist, 1) * forkDist * p.forkStrength
          const perpY = dx / Math.max(dist, 1) * forkDist * p.forkStrength
          const fx = me.x - dx / Math.max(dist, 1) * dist + perpX
          const fy = p.y + perpY * .3

          // Junction line
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.quadraticCurveTo((p.x + fx) / 2, (p.y + fy) / 2 - 5, fx, fy)
          ctx.strokeStyle = `rgba(160,130,70,${p.forkStrength * .18})`
          ctx.lineWidth = 1.2
          ctx.stroke()

          // Fork text
          const fw = p.w * scale * .7
          const forkPack = packWords(activeFork.wi, fw, scale * .85)
          activeFork.wi = forkPack.nextWi

          if (forkPack.words.length > 0) {
            ctx.save()
            ctx.translate(fx, fy)
            ctx.rotate(Math.sin(angle) * .06 + (dx > 0 ? .03 : -.03))
            ctx.font = font(STREAM_FONT_SIZE * scale * .85)
            ctx.fillStyle = `rgba(180,155,90,${lineAlpha * .7})`
            ctx.textBaseline = 'middle'
            let fxo = -forkPack.used / 2
            for (const wd of forkPack.words) {
              ctx.fillText(wd.text, fxo, 0)
              fxo += wd.sw
            }
            ctx.restore()

            // Junction glow at the meme
            const jg = ctx.createRadialGradient(me.x, me.y, 0, me.x, me.y, 35)
            jg.addColorStop(0, `rgba(190,150,60,${p.forkStrength * .06})`)
            jg.addColorStop(1, 'rgba(190,150,60,0)')
            ctx.fillStyle = jg
            ctx.fillRect(me.x - 35, me.y - 35, 70, 70)
          }
        } else {
          activeFork = null
        }
      }
    }
  }

  // ── Resonance threads ──
  const selDim = isHolding ? .3 : 1 // dim memes/threads when reading a stream
  const families: Record<string, Meme[]> = {}
  for (const me of memes) (families[me.family] = families[me.family] || []).push(me)

  for (const fm in families) {
    const members = families[fm]
    const active = hoveredMeme?.family === fm && !isHolding
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j]
        const d = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
        if (d > 650) continue
        ctx.beginPath(); ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(
          (a.x + b.x) / 2 + Math.sin(now * .0004 + i) * 30,
          (a.y + b.y) / 2 + Math.cos(now * .0003 + j) * 30,
          b.x, b.y
        )
        ctx.strokeStyle = `rgba(190,150,60,${(active ? .16 : .02) * Math.max(0, 1 - d / 650) * selDim})`
        ctx.lineWidth = active ? 1.5 : .5
        ctx.stroke()
      }
    }
  }

  // ── Memes ──
  for (const me of memes) {
    const p = Math.sin(me.pulse) * .5 + .5
    const isHov = me === hoveredMeme
    const isFam = hoveredMeme?.family === me.family

    const absorbGlow = Math.min(40, me.absorbed * 1.5)
    const gr = me.weaveCount * 4 + p * 18 + (isHov ? 35 : 0) + absorbGlow
    const grd = ctx.createRadialGradient(me.x, me.y, 0, me.x, me.y, gr)
    const ga = (.035 + p * .025) * (isFam ? 3 : 1) * selDim
    grd.addColorStop(0, `rgba(200,160,55,${ga})`)
    grd.addColorStop(.5, `rgba(180,140,50,${ga * .3})`)
    grd.addColorStop(1, 'rgba(180,140,50,0)')
    ctx.fillStyle = grd; ctx.fillRect(me.x - gr, me.y - gr, gr * 2, gr * 2)

    ctx.font = me.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
    // Shadow
    ctx.fillStyle = `rgba(0,0,0,${(.35 + p * .1) * selDim})`
    ctx.fillText(me.text, me.x + 1, me.y + 1.5)
    // Text
    const br = isFam ? 1.1 : .65 + p * .2
    ctx.fillStyle = `rgba(${Math.min(255, (210 * br + 30 * p) | 0)},${(175 * br + 15 * p) | 0},${(100 * br) | 0},${(.82 + p * .12 + (isHov ? .12 : 0)) * selDim})`
    ctx.fillText(me.text, me.x, me.y)

    // Weave dots
    for (let i = 0; i < Math.min(me.weaveCount, 14); i++) {
      const da = (i / Math.min(me.weaveCount, 14)) * Math.PI * 2 + now * .0008 + me.pulse * .4
      const dr = me.width * .53 + 7
      ctx.beginPath()
      ctx.arc(me.x + Math.cos(da) * dr, me.y + Math.sin(da) * dr * .3, 1.2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(200,170,80,${.12 + p * .08})`; ctx.fill()
    }
    ctx.textAlign = 'left'
  }

  // ── Particles ──
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.life += 16
    if (p.life > p.maxLife) { particles.splice(i, 1); continue }

    p.vx += (Math.random() - .5) * .02; p.vy += (Math.random() - .5) * .02

    // Attract toward nearest meme
    let nd = 9e9, nm: Meme | null = null
    for (const me of memes) {
      const d = Math.sqrt((me.x - p.x) ** 2 + (me.y - p.y) ** 2)
      if (d < nd) { nd = d; nm = me }
    }
    if (nm && nd < 300) {
      p.vx += (nm.x - p.x) * .00003 * nm.weaveCount
      p.vy += (nm.y - p.y) * .00003 * nm.weaveCount
      if (nd < 20) {
        nm.absorbed++
        // Brief absorption pulse — meme flares on contact
        nm.pulse += .3
        particles.splice(i, 1); continue
      }
    }

    // Mouse repulsion
    if (mouse.x > 0) {
      const d = Math.sqrt((p.x - mouse.x) ** 2 + (p.y - mouse.y) ** 2)
      if (d < 90) { p.vx += (p.x - mouse.x) / d * .5; p.vy += (p.y - mouse.y) / d * .5 }
    }

    p.vx *= .995; p.vy *= .995; p.x += p.vx; p.y += p.vy; p.angle += p.av
    const lt = p.life / p.maxLife
    const al = p.alpha * (lt < .1 ? lt / .1 : lt > .7 ? (1 - lt) / .3 : 1) * .35

    ctx.save()
    ctx.translate(p.x, p.y); ctx.rotate(p.angle)
    ctx.font = font(10 * p.scale, 300); ctx.textBaseline = 'middle'
    ctx.fillStyle = `rgba(165,145,105,${al})`
    ctx.fillText(p.text, 0, 0)
    ctx.restore()
  }

  // ── Speed indicator ──
  const indicatorStream = heldStream || nearestStream
  if (indicatorStream && mouse.x > 0 && Math.abs(indicatorStream.scrollVel) > .005) {
    const s = indicatorStream
    const dir = s.scrollVel > 0 ? '\u2193' : '\u2191'
    const active = !!heldStream
    ctx.font = font(active ? 11 : 9, 300); ctx.textBaseline = 'middle'
    ctx.fillStyle = `rgba(180,155,80,${active ? .4 : .12})`
    ctx.fillText(`${dir} ${(Math.abs(s.scrollVel) * 100).toFixed(0)}`, mouse.x + 15, mouse.y - 10)
  }

  // ── HUD ──
  if (frameCount % 30 === 0) {
    const el = document.getElementById('ct')
    if (el) el.textContent = `${memes.length} memes \u00b7 ${streams.length} streams \u00b7 ${particles.length} drifting`
  }
}

function spawnParticle(x: number, y: number, text: string, scale: number) {
  if (particles.length >= 100) return
  particles.push({
    text, font: font(10, 300), x, y, scale,
    vx: (Math.random() - .5) * .8, vy: (Math.random() - .5) * .8,
    alpha: .45, life: 0, maxLife: 5000 + Math.random() * 7000,
    angle: (Math.random() - .5) * .2, av: (Math.random() - .5) * .0006,
  })
}
