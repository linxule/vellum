import { aperture } from '../aperture.js'
import { threadColor } from '../color.js'
import { depthLerp, frameMix } from '../math.js'
import { drivePhantomHover, resolvePhantomTarget } from '../phantom.js'
import { driveReading, readingThread, recedingThread, TOUCH_OPEN_RATE } from '../reading.js'
import { computePath, oceanCurrent, pathXAtY } from '../path.js'
import { loomState } from '../state.js'
import { paper } from '../paper.js'
import { DEFAULT_COLOR, DEPTH_BRIGHTNESS, DIVE_SIGMA_LINES, FRAME_TIME, LENS_CLEAR_SIGMAS, LENS_OPENING_ALPHA, LENS_SETTLE_STEP, LENS_STILL_ALPHA, WARMTH_EASE_K, type MouseState, type Thread } from '../types.js'
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
  const ac = aperture(vw, vh)
  loomState.currentAperture = ac
  loomState.currentMouse = mouse

  loomState.current = oceanCurrent(now)

  // ── Phantom hover: drive the real mouse position to ride a target thread ──
  // When new content arrives, we simulate the cursor landing on the thread.
  // This reuses the existing hover/dive pipeline — the user sees the hand glow
  // where attention is. They take over instantly by moving their real mouse
  // (the next mousemove event overwrites mouse.x/y, phantom exits). No auto
  // release — the field holds focus until the user acts, so they can read or
  // screenshot without the lens closing on them.
  drivePhantomHover(now, mouse, ac)
  // Touch reading: the held current keeps the lens at its reading line; a receding one, until it has shut.
  driveReading(mouse)

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
  // Touch reading holds its current the same way (a crossing neighbour must not take the lens).
  // A receding one keeps the lens too, at a hand's reach, so it eases shut where it was read.
  let held: Thread | null = null
  if (!phantomTarget && !loomState.loomViewActive) {
    held = readingThread()
    const receding = held ? null : recedingThread()
    const kept = held ?? receding
    if (kept) {
      touchedThreadIndex = loomState.threads.indexOf(kept)
      loomState.touchedThread = kept
      kept._handDist = held ? 0 : ac.touchRadius
    }
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
    const proxBefore = thread.proximity
    // A current held by touch opens faster than under a mouse; closing is the same for both.
    const rise = thread === held ? TOUCH_OPEN_RATE : 0.022
    thread.proximity += (target - thread.proximity) * frameMix(target > thread.proximity ? rise : 0.015, frameRatio)
    if (thread.proximity < 0.005) thread.proximity = 0
    thread._proxStep = Math.abs(thread.proximity - proxBefore) / Math.max(frameRatio, 0.001)

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

    // The current being read (anchored, on paper) is not pushed about while it is read.
    if (!thread._anchor) {
      thread.xCenter += loomState.gustForce * vw * 0.0004 * thread.currentResponse * frameRatio
      thread.xCenter += repulsionDeltas[i]!
      thread.xCenter += (threadAnchorXs[i]! - thread.xCenter) * 0.0001 * frameRatio
    }
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
  loomState.lensVoiceId = null

  // Motion scales with frame time (advanceLoom), so the clear has to as well. At
  // 20fps text moves three 60fps frames' distance between paints; a fixed per-frame
  // clear then leaves a trail three times as long, drawn as separate offset copies
  // (doubled text on a slow phone). A slow frame clears as much as the 60fps frames
  // it stands for. Frames at 60fps or faster keep the per-frame values they had.
  const slow = Math.max(1, loomState.frameRatio * FRAME_TIME * 60)
  const trailClear = (alpha: number) => slow < 1.02 ? alpha : 1 - Math.pow(1 - alpha, slow)
  const seaClear = slow < 1.02 ? '.18' : trailClear(0.18).toFixed(3)
  const bgPhase = loomState.current * 0.5 + 0.5
  const topR = Math.round(12 + bgPhase * 6)
  const topG = Math.round(18 + bgPhase * 7)
  const topB = Math.round(30 + bgPhase * 8)
  const botR = Math.round(5 + bgPhase * 3)
  const botG = Math.round(8 + bgPhase * 3)
  const botB = Math.round(16 + bgPhase * 5)
  if (paper.on) {
    // The canvas holds only ink; the paper is underneath. Fade the ink instead
    // of painting the ground over it.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = `rgba(0,0,0,${seaClear})`
    ctx.fillRect(0, 0, vw, vh)
    ctx.globalCompositeOperation = 'source-over'
  } else {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, vh)
    bgGrad.addColorStop(0, `rgba(${topR},${topG},${topB},${seaClear})`)
    bgGrad.addColorStop(0.6, `rgba(${Math.round((topR + botR) / 2)},${Math.round((topG + botG) / 2)},${Math.round((topB + botB) / 2)},${seaClear})`)
    bgGrad.addColorStop(1, `rgba(${botR},${botG},${botB},${seaClear})`)
    ctx.fillStyle = bgGrad
    ctx.fillRect(0, 0, vw, vh)
  }

  // The water stills where you look. The .18 clear above leaves an 82% trail
  // each frame — the ocean's soft smear — but under the dive lens the magnified
  // text is the fastest-moving text on screen, and its trail prints an offset
  // second copy over the lines being read. A stronger, local clear around the
  // lens lets trails die fast there while the rest of the ocean keeps its smear.
  const lensThread = loomState.touchedThread
  if (lensThread && lensThread.proximity > 0.05 && mouse.x > -1000) {
    const lx = pathXAtY(lensThread._path, mouse.y)
    const lr = Math.min(ac.openWidth * 0.75, vh * 0.6)
    // Taller than wide where the column is narrow (see LENS_CLEAR_SIGMAS).
    const lry = Math.max(lr, Math.min(vh * 0.6, LENS_CLEAR_SIGMAS * DIVE_SIGMA_LINES * ac.diveLineH))
    const tall = lry > lr + 0.5
    // Clear with the background's own colour at the lens, not the column's
    // midpoint: at opening strength a mismatched patch would show as a disc.
    const gy = Math.max(0, Math.min(1, mouse.y / vh))
    const midR = Math.round((topR + botR) / 2)
    const midG = Math.round((topG + botG) / 2)
    const midB = Math.round((topB + botB) / 2)
    const gt = gy < 0.6 ? gy / 0.6 : (gy - 0.6) / 0.4
    const lensR = Math.round(gy < 0.6 ? topR + (midR - topR) * gt : midR + (botR - midR) * gt)
    const lensG = Math.round(gy < 0.6 ? topG + (midG - topG) * gt : midG + (botG - midG) * gt)
    const lensB = Math.round(gy < 0.6 ? topB + (midB - topB) * gt : midB + (botB - midB) * gt)
    const prox = lensThread.proximity
    const opening = Math.min(1, lensThread._proxStep / LENS_SETTLE_STEP) * Math.min(1, prox * 4)
    const la = LENS_STILL_ALPHA * prox + (LENS_OPENING_ALPHA - LENS_STILL_ALPHA * prox) * opening
    if (tall) {
      ctx.save()
      ctx.translate(lx, mouse.y)
      ctx.scale(1, lry / lr)
    }
    const still = tall ? ctx.createRadialGradient(0, 0, 0, 0, 0, lr) : ctx.createRadialGradient(lx, mouse.y, 0, lx, mouse.y, lr)
    still.addColorStop(0, `rgba(${lensR},${lensG},${lensB},${trailClear(la)})`)
    still.addColorStop(0.55, `rgba(${lensR},${lensG},${lensB},${trailClear(la * (0.6 + 0.35 * opening))})`)
    still.addColorStop(1, `rgba(${lensR},${lensG},${lensB},0)`)
    ctx.fillStyle = still
    if (paper.on) ctx.globalCompositeOperation = 'destination-out'
    if (tall) {
      ctx.fillRect(-lr, -lr, lr * 2, lr * 2)
      ctx.restore()
    } else {
      ctx.fillRect(lx - lr, mouse.y - lr, lr * 2, lr * 2)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  // Scale ocean thread alpha during loom view transition
  const oceanAlpha = 1 - loomState.loomViewTransition
  if (oceanAlpha < 1) {
    for (let i = 0; i < visAlpha.length; i++) visAlpha[i]! *= oceanAlpha
  }

  // On paper the current under the lens is drawn last, over the others. Their
  // words are not printed under its clean water (render/water.ts, waterOver).
  // Before it prints, its own last prints under the lens are lifted, so the text
  // being read is this frame's alone: no trail, however slowly its lines drift.
  const paperLens = paper.on && lensThread !== null && lensThread.proximity > 0.05 && mouse.x > -1000 ? lensThread : null
  for (const threadIndex of loomState.sortedThreadIndices) {
    const thread = loomState.threads[threadIndex]!
    if (thread === paperLens) continue
    if (visAlpha[threadIndex]! >= 0.01) renderThread(ctx, thread, now, mouse, ac, visAlpha[threadIndex]!)
  }
  if (paperLens) {
    const lensIndex = loomState.threads.indexOf(paperLens)
    // Wide enough for the signatures that follow the lines.
    const rx = Math.max(40, Math.min(paperLens.balancedWidth, ac.openWidth) * 0.8)
    const ry = Math.min(vh * 0.6, LENS_CLEAR_SIGMAS * DIVE_SIGMA_LINES * ac.diveLineH)
    const strength = Math.min(1, paperLens.proximity * 1.5) * 0.9
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.translate(pathXAtY(paperLens._path, mouse.y), mouse.y)
    ctx.scale(1, ry / rx)
    const clear = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    clear.addColorStop(0, `rgba(0,0,0,${strength})`)
    clear.addColorStop(0.7, `rgba(0,0,0,${strength})`)
    clear.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = clear
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
    ctx.restore()
    if (lensIndex >= 0 && visAlpha[lensIndex]! >= 0.01) renderThread(ctx, paperLens, now, mouse, ac, visAlpha[lensIndex]!)
  }

  // Draw loom tree on top
  if (loomState.loomViewTransition > 0 && loomState.loomTree) {
    renderLoomTree(ctx, vw, vh, now, loomState.loomTree, loomState.loomViewTransition)
  }

  // A current receding after a touch has no hand on it: no hand glow at its line.
  if (mouse.x > -1000 && loomState.recedingKey === null) {
    const r = 30 + (loomState.touchedThread ? loomState.touchedThread.proximity * 25 : 0)
    const a = (loomState.touchedThread ? 0.06 + loomState.touchedThread.proximity * 0.04 : 0.03) * (paper.on ? 0.7 : 1)
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
    ctx.fillStyle = `rgba(${hr},${hg},${hb},${(0.08 + (loomState.touchedThread?.proximity ?? 0) * 0.12) * (paper.on ? 4 : 1)})`
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
