import { aperture } from '../aperture.js'
import { threadColor } from '../color.js'
import { depthLerp, frameMix } from '../math.js'
import { drivePhantomHover, resolvePhantomTarget } from '../phantom.js'
import { computePath } from '../path.js'
import { loomState } from '../state.js'
import { DEFAULT_COLOR, DEPTH_BRIGHTNESS, FRAME_TIME, WARMTH_EASE_K, type MouseState } from '../types.js'
import { renderLoomTree } from '../loom-view.js'
import { renderThread } from './thread.js'

// Fallback mouse used by paintLoom() when called without a preceding
// advanceLoom() (e.g., from a test that stubs loomState directly).
// `x > -1000` means "cursor on-screen" everywhere in this module —
// this sentinel correctly reads as off-screen.
const SENTINEL_MOUSE: MouseState = {
  x: -9e3,
  y: -9e3,
  prevX: -9e3,
  prevY: -9e3,
  speed: 0,
  moving: false,
  lastMove: 0,
  down: false,
  downStart: 0,
  touch: false,
}

/**
 * advanceLoom — state advancement only.
 *
 * Pure state mutation: reads vw/vh/now/dt/mouse, updates loomState (threads,
 * touchedThread, proximity, warmth, scroll, depth, phantomFocus, gust,
 * current, immersion, sortedThreadIndices, _handDist, _path). Does NOT call
 * any ctx.* method — safe to call without a canvas context. Also stores
 * current-frame shared state (currentAperture, currentMouse,
 * frameVisibilityAlpha) in loomState for paintLoom().
 *
 * Frame ordering contract:
 *   1. drivePhantomHover() — may update mouse.x/y from phantom target
 *   2. gust/current advance
 *   3. visAlpha computed (visibility falloff by distance from center)
 *   4. per-thread touch scan — reads previous frame's _path
 *   5. phantom force-touched override — may reassign touchedThread
 *   6. per-thread state updates (proximity, warmth, scroll, depth, xCenter)
 *   7. immersion / holdTime
 *   8. computePath() per thread — updates _path for THIS frame
 *   9. sortedThreadIndices re-sort by depth + proximity
 *
 * Touch scan uses previous-frame _path because computePath hasn't run yet.
 * This is intentional (one-frame lag is imperceptible at 60fps) but means
 * you cannot reorder computePath above the touch scan without retesting
 * proximity ramp + _handDist behavior.
 */
export function advanceLoom(vw: number, vh: number, now: number, dt: number, mouse: MouseState) {
  if (!loomState.ready) return
  loomState.VW = vw
  loomState.VH = vh
  loomState.frameRatio = dt / FRAME_TIME
  const frameRatio = loomState.frameRatio
  const threadCount = loomState.threads.length
  const ac = aperture(vw)
  loomState.currentAperture = ac
  loomState.currentMouse = mouse

  loomState.current = Math.sin(now * 0.00008) * 0.6
    + Math.sin(now * 0.000137) * 0.3
    + Math.sin(now * 0.00015) * 0.1

  // ── Phantom hover: drive the real mouse position to ride a target thread ──
  // When new content arrives, we simulate the cursor landing on the thread.
  // This reuses the existing hover/dive pipeline — the user sees the hand glow
  // where attention is. They take over instantly by moving their real mouse
  // (the next mousemove event overwrites mouse.x/y, phantom exits). No auto
  // release — the field holds focus until the user acts, so they can read or
  // screenshot without the lens closing on them.
  drivePhantomHover(now, mouse, ac)

  loomState.gustTimer -= dt
  if (loomState.gustTimer <= 0) {
    loomState.gustTarget = (Math.random() - 0.5) * 2
    loomState.gustDepthForce = (Math.random() - 0.5) * 1.5
    loomState.gustTimer = 25 + Math.random() * 45
  }
  loomState.gustForce += (loomState.gustTarget - loomState.gustForce) * frameMix(0.004, frameRatio)
  loomState.gustTarget *= Math.pow(0.997, frameRatio)
  loomState.gustDepthForce *= Math.pow(0.998, frameRatio)

  if (loomState.frameVisibilityAlpha.length !== threadCount) {
    loomState.frameVisibilityAlpha = new Float32Array(threadCount)
  }
  if (loomState.frameThreadSortIndices.length !== threadCount) {
    loomState.frameThreadSortIndices = new Int32Array(threadCount)
    loomState.frameThreadSortDists = new Float32Array(threadCount)
  }
  if (loomState.frameThreadAnchorXs.length !== threadCount) {
    loomState.frameThreadAnchorXs = new Float32Array(threadCount)
  }
  if (loomState.frameThreadRepulsionDeltas.length !== threadCount) {
    loomState.frameThreadRepulsionDeltas = new Float32Array(threadCount)
  }
  const centerX = vw / 2
  const sortIndices = loomState.frameThreadSortIndices
  const sortDists = loomState.frameThreadSortDists
  for (let i = 0; i < threadCount; i++) {
    sortIndices[i] = i
    sortDists[i] = Math.abs(loomState.threads[i]!.xCenter - centerX)
  }
  // threadCount is bounded by aperture().maxThreads (<= 12), so a tiny
  // insertion sort is cheaper here than allocating wrapper objects + a
  // comparator closure for Array.sort() every frame.
  for (let i = 1; i < threadCount; i++) {
    let j = i
    const cur = sortIndices[i]!
    while (j > 0 && sortDists[sortIndices[j - 1]!]! > sortDists[cur]!) {
      sortIndices[j] = sortIndices[j - 1]!
      j--
    }
    sortIndices[j] = cur
  }
  const visAlpha = loomState.frameVisibilityAlpha
  for (let k = 0; k < threadCount; k++) {
    const idx = sortIndices[k]!
    visAlpha[idx] = k < ac.visibleThreads ? 1 : Math.max(0, 1 - (k - ac.visibleThreads) / 1.5)
  }

  // ── Find nearest visible thread & measure distances ──
  // Sticky touch: the currently-engaged thread gets a distance advantage
  // so vertical scrolling doesn't accidentally jump to a neighbor.
  loomState.prevTouchedThread = loomState.touchedThread
  loomState.touchedThread = null
  let touchedThreadIndex = -1
  let touchDist = ac.touchRadius
  const stickyBonus = loomState.prevTouchedThread && loomState.prevTouchedThread.proximity > 0.1 ? Math.min(0.4, loomState.prevTouchedThread.proximity * 0.5) : 0

  for (let ti = 0; ti < threadCount; ti++) {
    const thread = loomState.threads[ti]!
    thread._handDist = Infinity
    if (visAlpha[ti]! < 0.01) continue
    if (mouse.x > -1000) {
      const prevPath = thread._path
      if (prevPath.length > 1) {
        const samples = 13
        for (let s = 0; s < samples; s++) {
          const idx = Math.round((s + 0.5) / samples * (prevPath.length - 1))
          const pp = prevPath[Math.min(idx, prevPath.length - 1)]!
          const dist = Math.sqrt((mouse.x - pp.x) ** 2 + (mouse.y - pp.y) ** 2)
          if (dist < thread._handDist) thread._handDist = dist
        }
      }
      const effectiveDist = thread === loomState.prevTouchedThread ? thread._handDist * (1 - stickyBonus) : thread._handDist
      if (thread._handDist < ac.touchRadius && effectiveDist < touchDist) {
        touchDist = effectiveDist
        loomState.touchedThread = thread
        touchedThreadIndex = ti
      }
    }
  }

  // Phantom override: if the phantom is active, force its target thread to be
  // the touched thread regardless of _handDist sampling / visibility. This
  // bypasses two latent traps: (1) invisible target thread gets skipped by
  // the touch scan, (2) the 13-sample _handDist can still miss a mouse landing
  // on path between samples.
  const phantomTarget = resolvePhantomTarget(loomState.phantomFocus)
  if (phantomTarget) {
    loomState.phantomResolvedThreadIdx = phantomTarget.threadIdx
    loomState.phantomResolvedVoiceFlatIdx = phantomTarget.voiceFlatIdx
    touchedThreadIndex = phantomTarget.threadIdx
    loomState.touchedThread = loomState.threads[touchedThreadIndex]!
    loomState.touchedThread._handDist = 0
  }
  if (touchedThreadIndex >= 0) visAlpha[touchedThreadIndex] = 1

  const touchedFamilies = loomState.touchedThread ? loomState.touchedThread.families : new Set()
  const threadSlotDenom = Math.max(1, threadCount - 1)
  const threadAnchorXs = loomState.frameThreadAnchorXs
  for (let i = 0; i < threadCount; i++) {
    threadAnchorXs[i] = vw * (ac.spreadEdge + (i / threadSlotDenom) * (1 - 2 * ac.spreadEdge))
  }

  const repulsionDeltas = loomState.frameThreadRepulsionDeltas
  // This buffer accumulates within a frame, so a reused buffer must be
  // cleared before the pairwise repulsion pass or stale deltas bleed into
  // subsequent frames.
  for (let i = 0; i < threadCount; i++) repulsionDeltas[i] = 0
  for (let i = 0; i < threadCount; i++) {
    const xi = loomState.threads[i]!.xCenter
    for (let j = i + 1; j < threadCount; j++) {
      const dx = xi - loomState.threads[j]!.xCenter
      if (Math.abs(dx) >= vw * 0.04) continue
      const dir = dx === 0 ? -1 : Math.sign(dx)
      repulsionDeltas[i]! += dir * 0.5 * frameRatio
      repulsionDeltas[j]! -= dir * 0.5 * frameRatio
    }
  }

  for (let i = 0; i < threadCount; i++) {
    const thread = loomState.threads[i]!
    const target = thread === loomState.touchedThread
      ? Math.max(0, 1 - thread._handDist / ac.touchRadius)
      : Math.max(0, (1 - thread._handDist / (ac.touchRadius * 2)) * 0.25)
    thread.proximity += (target - thread.proximity) * frameMix(target > thread.proximity ? 0.022 : 0.015, frameRatio)
    if (thread.proximity < 0.005) thread.proximity = 0

    let relTarget = 0
    if (loomState.touchedThread && thread !== loomState.touchedThread) {
      for (const f of thread.families) {
        if (touchedFamilies.has(f)) { relTarget = 1; break }
      }
    }
    thread.related += (relTarget - thread.related) * frameMix(0.04, frameRatio)
    if (thread.related < 0.005) thread.related = 0

    if (thread.proximity > 0.1 && !loomState.phantomFocus) thread.warmth = Math.min(1, thread.warmth + 0.008 * frameRatio)
    else thread.warmth *= Math.pow(0.997, frameRatio)

    // Live warmth (Phase 14): ease the server accumulator toward its target so a
    // fresh poll (or another witness's dwell) warms the surface over ~25s rather
    // than stepping. State-only — no ctx here. frameMix keeps it frame-rate
    // independent (== WARMTH_EASE_K at 60fps), matching the proximity/related eases above.
    thread.apiWarmth += (thread.apiWarmthTarget - thread.apiWarmth) * frameMix(WARMTH_EASE_K, frameRatio)
    if (thread === loomState.touchedThread && thread.proximity > 0.1) { thread.touched = true; thread.touchFade = 0 }
    if (thread.touched && thread.proximity < 0.05) {
      thread.touchFade += dt
      if (thread.touchFade > 8) thread.touched = false
    }

    const scrollBreath = 1 + 0.25 * Math.sin(now * thread.breathRate * 0.7 + thread.pathSeed * 1.3) + loomState.current * thread.currentResponse * 0.12
    const currentFlow = 1 + loomState.current * thread.currentResponse * 0.3
    thread.scroll += (thread.scrollVel * scrollBreath * currentFlow * (thread.touched ? 0 : 1) + thread.userScroll) * frameRatio
    if (thread.totalLines > 0 && thread.scroll < 0) thread.scroll += thread.totalLines / 3
    thread.userScroll *= Math.pow(0.72, frameRatio)
    if (Math.abs(thread.userScroll) < 0.0001) thread.userScroll = 0

    const depthTarget = thread.baseDepth + Math.sin(now * 0.000012 + thread.pathSeed * 3.1) * 0.6 + loomState.gustDepthForce * thread.currentResponse * 0.4
    thread.restingDepth += (Math.max(0, Math.min(2, depthTarget)) - thread.restingDepth) * frameMix(0.002, frameRatio)
    thread.restingDepth = Math.max(0, Math.min(2, thread.restingDepth))

    if (thread.emergenceStart > 0) {
      const emergenceT = Math.min(1, (now - thread.emergenceStart) / 5000)
      thread.restingDepth = thread.emergenceDepthFrom + (thread.baseDepth - thread.emergenceDepthFrom) * (1 - Math.pow(1 - emergenceT, 3))
      if (emergenceT >= 1) { thread.emergenceStart = 0; thread.emergenceVoiceUids.clear() }
    }

    if (!loomState.phantomFocus && thread === loomState.touchedThread && thread.proximity > 0.5 && thread.newVoiceIds.size > 0) {
      thread.newVoiceIds.clear()
      thread.newVoiceUids.clear()
    }

    thread.xCenter += loomState.gustForce * vw * 0.0004 * thread.currentResponse * frameRatio
    thread.xCenter += repulsionDeltas[i]!
    thread.xCenter += (threadAnchorXs[i]! - thread.xCenter) * 0.0001 * frameRatio
  }

  if (loomState.touchedThread && loomState.touchedThread.proximity > 0.2) {
    loomState.holdTime += dt
    loomState.immersion = Math.min(0.4, loomState.holdTime * 1.5) + Math.max(0, Math.min(0.2, (loomState.holdTime - 3) / 3))
  } else {
    loomState.holdTime *= Math.pow(0.7, frameRatio)
    if (loomState.holdTime < 0.001) loomState.holdTime = 0
    loomState.immersion = Math.min(0.6, loomState.holdTime * 2)
  }

  for (let ti = 0; ti < threadCount; ti++) {
    if (visAlpha[ti]! >= 0.01) computePath(loomState.threads[ti]!, now, mouse, ac)
  }

  // Animate loomViewTransition toward target
  const loomTarget = loomState.loomViewActive ? 1 : 0
  const loomSpeed = 3.0  // ~330ms full transition
  if (loomState.loomViewTransition < loomTarget) {
    loomState.loomViewTransition = Math.min(loomTarget, loomState.loomViewTransition + dt * loomSpeed)
  } else if (loomState.loomViewTransition > loomTarget) {
    loomState.loomViewTransition = Math.max(loomTarget, loomState.loomViewTransition - dt * loomSpeed)
  }
  if (loomState.loomViewTransition === 0 && loomState.loomTree) {
    loomState.loomTree = null
    loomState.loomViewSeed = null
  }

  // Suppress touch/hover during loom view
  if (loomState.loomViewActive) {
    loomState.touchedThread = null
  }

  loomState.sortedThreadIndices.sort((a, b) => (loomState.threads[a]!.restingDepth + loomState.threads[a]!.proximity * 3) - (loomState.threads[b]!.restingDepth + loomState.threads[b]!.proximity * 3))
}

/**
 * paintLoom — rendering only.
 *
 * Reads loomState.currentAperture, loomState.currentMouse, and
 * loomState.frameVisibilityAlpha set by advanceLoom. Calls ctx.* methods to
 * draw the background gradient, each thread via renderThread(), and the
 * cursor glow circle.
 *
 * Must be called after advanceLoom() in the same frame. If called without a
 * preceding advanceLoom (e.g., directly from a test), currentAperture will
 * be null and paintLoom returns a no-op. If currentMouse is null, paintLoom
 * uses a sentinel off-screen mouse.
 */
export function paintLoom(ctx: CanvasRenderingContext2D, now: number) {
  if (!loomState.ready) return
  const ac = loomState.currentAperture
  if (!ac) return
  const mouse = loomState.currentMouse ?? SENTINEL_MOUSE
  const visAlpha = loomState.frameVisibilityAlpha
  const vw = loomState.VW
  const vh = loomState.VH

  // Clear hit targets before thread render loop (set per-thread in renderThread)
  loomState.lastFrameHitVoiceId = null
  loomState.lastFrameHitTargets.length = 0

  const bgPhase = loomState.current * 0.5 + 0.5
  const bgGrad = ctx.createLinearGradient(0, 0, 0, vh)
  const topR = Math.round(12 + bgPhase * 6)
  const topG = Math.round(18 + bgPhase * 7)
  const topB = Math.round(30 + bgPhase * 8)
  const botR = Math.round(5 + bgPhase * 3)
  const botG = Math.round(8 + bgPhase * 3)
  const botB = Math.round(16 + bgPhase * 5)
  bgGrad.addColorStop(0, `rgba(${topR},${topG},${topB},.18)`)
  bgGrad.addColorStop(0.6, `rgba(${Math.round((topR + botR) / 2)},${Math.round((topG + botG) / 2)},${Math.round((topB + botB) / 2)},.18)`)
  bgGrad.addColorStop(1, `rgba(${botR},${botG},${botB},.18)`)
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, vw, vh)

  // Scale ocean thread alpha during loom view transition
  const oceanAlpha = 1 - loomState.loomViewTransition
  if (oceanAlpha < 1) {
    for (let i = 0; i < visAlpha.length; i++) visAlpha[i]! *= oceanAlpha
  }

  for (const threadIndex of loomState.sortedThreadIndices) {
    if (visAlpha[threadIndex]! >= 0.01) renderThread(ctx, loomState.threads[threadIndex]!, now, mouse, ac, visAlpha[threadIndex]!)
  }

  // Draw loom tree on top
  if (loomState.loomViewTransition > 0 && loomState.loomTree) {
    renderLoomTree(ctx, vw, vh, now, loomState.loomTree, loomState.loomViewTransition)
  }

  if (mouse.x > -1000) {
    const r = 30 + (loomState.touchedThread ? loomState.touchedThread.proximity * 25 : 0)
    const a = loomState.touchedThread ? 0.06 + loomState.touchedThread.proximity * 0.04 : 0.03
    const hBase = loomState.touchedThread ? loomState.touchedThread._frameColor : DEFAULT_COLOR
    const hBright = loomState.touchedThread
      ? depthLerp(DEPTH_BRIGHTNESS, loomState.touchedThread.restingDepth) + loomState.touchedThread.proximity * 0.5 + loomState.touchedThread.warmth * 0.12 + loomState.current * 0.06
      : 0.5
    const [hr, hg, hb] = threadColor(hBase, hBright, 0.3)
    const glow = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, r)
    glow.addColorStop(0, `rgba(${hr},${hg},${hb},${a})`)
    glow.addColorStop(0.4, `rgba(${hr},${hg},${hb},${a * 0.4})`)
    glow.addColorStop(1, `rgba(${hr},${hg},${hb},0)`)
    ctx.fillStyle = glow
    ctx.fillRect(mouse.x - r, mouse.y - r, r * 2, r * 2)
    ctx.beginPath()
    ctx.arc(mouse.x, mouse.y, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${hr},${hg},${hb},${0.08 + (loomState.touchedThread?.proximity ?? 0) * 0.12})`
    ctx.fill()
  }
}

/**
 * renderLoom — public entry that combines advanceLoom + paintLoom.
 *
 * Keeps backward compat with the original single-call interface. New code
 * may call advanceLoom() and paintLoom() directly (e.g., to skip paint in
 * a low-power mode, or to inspect state between advance and paint).
 */
export function renderLoom(ctx: CanvasRenderingContext2D, vw: number, vh: number, now: number, dt: number, mouse: MouseState) {
  advanceLoom(vw, vh, now, dt, mouse)
  paintLoom(ctx, now)
}
