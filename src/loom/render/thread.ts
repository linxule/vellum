import { layoutNextLine, type LayoutCursor } from '@chenglou/pretext'
import { getState } from '../../content.js'
import { highlightUidForThread } from '../highlight.js'
import { clamp01, depthLerp, fontRatioForScale, fontSizeForScale, lerp } from '../math.js'
import { diveGaussian, pathXAtY, widthAtY } from '../path.js'
import { resolvePhantomTarget } from '../phantom.js'
import { updateResonances } from '../resonance.js'
import { beginCrossing, beginWashProfile, hiddenSpan, liftOwnInk, markWashLine, OPEN_PROXIMITY, ringsOnLine } from './wash.js'

/** Proximity seen last frame, per current: a change means its pool is opening or closing. */
const lastProximity = new WeakMap<Thread, number>()
const RELIFT = 0.85
/** Under a crossing current, a piece of a line shorter than this is not printed. */
const CROSSING_MIN_STUB = 34
import { loomState } from '../state.js'
import { paper } from '../paper.js'
import { copyCursor, isLineRTL, voiceGroupIndex, voiceSpanForLine, wholeWordWidth } from '../text.js'
import { FONT_FAMILY, NEIGHBOR_LENS_FADE, AFTERGLOW_DIVE_GATE, AFTERGLOW_SILVER, BREATH_AMP, BREATH_SPATIAL, DEPTH_ALPHA, DEPTH_BRIGHTNESS, DIVE_SIGMA_LINES, HL_FONT_BOOST, SIGNATURE_ALPHA, SIGNATURE_GRAY_MIX, SIGNATURE_RATIO, SPARSE_EDGE_FADE_PX, SUNKEN_DIM, SUNKEN_SURFACE_DIVE_T, WARM_BASE_ALPHA, WARM_DIVE_BOOST, ZERO_CURSOR, type ApertureConfig, type Thread } from '../types.js'
import { depthColor, signatureGray, threadColor } from '../color.js'
import { drawLine, drawLineSegmented } from './line.js'
import { waterOver } from './water.js'

type LaidOutLine = {
  text: string
  x: number
  y: number
  lineH: number
  width: number
  contentWidth: number
  lineStart: LayoutCursor
  lineEnd: LayoutCursor
  lineVoiceAnchorUid: number
  lineVoiceUids: number[]
  rtl: boolean
  fontSize: number
  fontScale: number
  fontRatio: number
  diveT: number
  neighborFade: number
}

function resolveVoiceIdForAnchor(thread: Thread, anchorUid: number): string | null {
  if (anchorUid < 0) return null
  const hlVoiceCount = thread.groupBoundaries[thread.groupBoundaries.length - 1]!
  if (hlVoiceCount <= 0) return null
  const baseUid = anchorUid % hlVoiceCount
  const state = getState()
  if (!state) return null
  let cumOffset = 0
  for (let gp = 0; gp < thread.familyNames.length; gp++) {
    const familyName = thread.familyNames[gp]!
    const gIdx = state.threads.findIndex(t => t.family === familyName)
    if (gIdx < 0) continue
    const voiceCount = state.threads[gIdx]!.voices.length
    if (baseUid >= cumOffset && baseUid < cumOffset + voiceCount) {
      return state.threads[gIdx]!.voices[baseUid - cumOffset]!.id
    }
    cumOffset += voiceCount
  }
  return null
}

export function renderThread(
  ctx: CanvasRenderingContext2D,
  thread: Thread,
  now: number,
  mouse: { x: number, y: number },
  ac: ApertureConfig,
  visibilityAlpha: number,
) {
  const prox = thread.proximity
  const rel = thread.related
  const d = thread.restingDepth
  const isPrimary = thread === loomState.touchedThread
  const immersionDim = (isPrimary || loomState.immersion < 0.01) ? 1 : Math.max(0.55, 1 - loomState.immersion * 0.35)
  const dimFactor = (!isPrimary && ac.baseDimming > 0) ? (1 - ac.baseDimming * (1 - prox)) : 1

  const dColor = depthColor(thread.baseColor, d)
  thread._frameColor[0] = dColor[0]
  thread._frameColor[1] = dColor[1]
  thread._frameColor[2] = dColor[2]

  const hlUid = highlightUidForThread(thread)
  if (thread.arrivalGlow > 0.001) thread.arrivalGlow *= Math.pow(0.993, loomState.frameRatio)
  updateResonances(thread, now)

  const warm = thread.warmth
  const apiWarm = thread.apiWarmth
  const glowBoost = thread.arrivalGlow * 0.4
  const hlThreadBoost = hlUid >= 0 ? 0.12 : 0
  const baseAlpha = (depthLerp(DEPTH_ALPHA, d) + prox * (0.85 - depthLerp(DEPTH_ALPHA, d)) + rel * 0.12 + warm * 0.08 + clamp01(apiWarm) * WARM_BASE_ALPHA + glowBoost + hlThreadBoost) * immersionDim * visibilityAlpha * dimFactor * (paper.on ? paper.alphaGain : 1)

  ctx.textBaseline = 'middle'
  const path = thread._path
  if (immersionDim < 0.15 && prox < 0.01 && path.length > 1) {
    const [cr, cg, cb] = threadColor(thread._frameColor, depthLerp(DEPTH_BRIGHTNESS, d) + loomState.current * thread.currentResponse * 0.06, 0)
    ctx.beginPath()
    ctx.moveTo(path[0]!.x, path[0]!.y)
    for (let k = 1; k < path.length; k++) ctx.lineTo(path[k]!.x, path[k]!.y)
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${depthLerp(DEPTH_ALPHA, d) * immersionDim * 0.3})`
    ctx.lineWidth = 0.5
    ctx.stroke()
    return
  }
  if (thread.totalLines === 0) return

  const scrollOffset = ((Math.floor(thread.scroll * 3) % thread.totalLines) + thread.totalLines) % thread.totalLines
  let cursor = scrollOffset === 0 ? copyCursor(ZERO_CURSOR) : copyCursor(thread.lineEndCursors[scrollOffset - 1] ?? ZERO_CURSOR)
  const diveSigma = DIVE_SIGMA_LINES * ac.diveLineH

  if (prox > 0.1) {
    const cx = thread.xCenter
    const cy = loomState.VH / 2
    const extent = loomState.VH * 0.45
    const [tr, tg, tb] = threadColor(thread._frameColor, depthLerp(DEPTH_BRIGHTNESS, d) + prox * 0.35 + warm * 0.12 + rel * 0.08 + loomState.current * thread.currentResponse * 0.06, 0)
    const bgGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, extent)
    bgGlow.addColorStop(0, `rgba(${tr},${tg},${tb},${prox * 0.012})`)
    bgGlow.addColorStop(1, `rgba(${tr},${tg},${tb},0)`)
    ctx.fillStyle = bgGlow
    ctx.fillRect(cx - extent, cy - extent, extent * 2, extent * 2)
  }

  const laidOutLines: LaidOutLine[] = []
  let hoveredLineIndex = -1
  let closestLineIndex = -1
  let closestLineDistance = Infinity
  const lineBreath = ((1 + 0.25 * Math.sin(now * thread.breathRate * 0.7 + thread.pathSeed * 1.3) + loomState.current * thread.currentResponse * 0.12) - 1) * 1.5

  const phantomFocus = loomState.phantomFocus
  const phantomTarget = resolvePhantomTarget(phantomFocus)
  const phantomTracksThisThread = phantomTarget !== null && phantomTarget.voiceFlatIdx >= 0 && phantomTarget.thread === thread
  const phantomVoiceCount = phantomTracksThisThread ? (thread.groupBoundaries[thread.groupBoundaries.length - 1] || 1) : 1
  let phantomTargetMeasured = false
  if (phantomTracksThisThread && phantomFocus!.diagFrames < 3) {
    loomState.diagHook?.('phantom-track', {
      frame: phantomFocus!.diagFrames,
      voiceFlatIdx: phantomTarget!.voiceFlatIdx,
      voiceCount: phantomVoiceCount,
      prox: thread.proximity,
      scroll: thread.scroll,
      totalLines: thread.totalLines,
    })
  }

  // Sparse blocks float centered in the column — air above AND below, a voice in
  // the water, not a heading pinned to the (clipped) top edge (top-alignment reads
  // as vertical truncation, and a 1-line whisper at y=0 gets zeroed by the real-
  // edge fade). Center on the texture-scale block height; a dive expands the block
  // downward from the centered start, which is acceptable. The Math.max floor keeps
  // a block taller than the viewport clear of the top edge. Non-sparse columns tile
  // the whole height, so they still start at y=0.
  let yPos = thread.sparse
    ? Math.max(SPARSE_EDGE_FADE_PX, (loomState.VH - thread.totalLines * ac.textureLineH) / 2)
    : 0
  const minLineH = Math.max(1, ac.textureLineH * (1 + lineBreath * 0.08))
  const maxLines = Math.ceil((loomState.VH + ac.diveLineH) / minLineH) + 2
  // Sparse threads (Phase 14 Part B) paint exactly one contiguous copy of the
  // prepared text. The scroll offset may start us mid-text, so track where we
  // began and whether the cursor-reset wrap has already fired once — a copy is
  // complete when the wrap catches back up to the start. Hoisted here (not inside
  // the loop) so the outer termination check can see them.
  const startCursor = copyCursor(cursor)
  const startIsZero = scrollOffset === 0
  let sparseWrapped = false
  while (yPos < loomState.VH + ac.diveLineH && laidOutLines.length < maxLines) {
    const lineY = Math.min(yPos, loomState.VH)
    let diveT = (isPrimary && prox > 0.05 && mouse.x > -1000) ? prox * diveGaussian(lineY, mouse.y, diveSigma) : 0
    // Ember (Phase 14): a warm current reaches reading scale at lower proximity
    // and over a taller band — easier to read once you touch it. Gated by the
    // same isPrimary/prox path above, so nothing changes at a glance.
    diveT = Math.min(1, diveT * (1 + clamp01(apiWarm) * WARM_DIVE_BOOST))
    const lineFontScale = lerp(ac.textureScale, ac.diveScale, diveT)
    const lineLineH = lerp(ac.textureLineH, ac.diveLineH, diveT) * (1 + lineBreath * 0.08)
    const t = Math.min(1, yPos / loomState.VH)
    const pathIndex = t * path.length - t
    const pi = Math.floor(pathIndex)
    const pf = pathIndex - pi
    const p0 = path[Math.min(pi, path.length - 1)]!
    const p1 = path[Math.min(pi + 1, path.length - 1)]!
    const x = p0.x + (p1.x - p0.x) * pf
    const y = p0.y + (p1.y - p0.y) * pf

    const openW = Math.min(thread.balancedWidth, ac.openWidth)
    const breathRestW = ac.restingWidth * (1 + BREATH_AMP * (1 - prox) * Math.sin(now * thread.breathRate + thread.pathSeed + y * BREATH_SPATIAL))
    let width = widthAtY(y, mouse.y, prox, openW, breathRestW)

    let neighborFade = 1
    if (!isPrimary && loomState.touchedThread && loomState.touchedThread._path.length > 0 && loomState.touchedThread.proximity > 0.1) {
      const primaryX = pathXAtY(loomState.touchedThread._path, y)
      const primaryOpenW = Math.min(loomState.touchedThread.balancedWidth, ac.openWidth)
      const primaryBreathMod = 1 + BREATH_AMP * (1 - loomState.touchedThread.proximity)
        * Math.sin(now * loomState.touchedThread.breathRate + loomState.touchedThread.pathSeed + y * BREATH_SPATIAL)
      const primaryW = widthAtY(y, mouse.y, loomState.touchedThread.proximity, primaryOpenW, ac.restingWidth * primaryBreathMod)
      const maxWidth = 2 * Math.max(0, Math.abs(primaryX - x) - primaryW / 2 - 15)
      if (maxWidth < width) width = Math.max(breathRestW, maxWidth)
      // The squeeze above floors at the resting width, so a neighbour whose spine
      // runs INSIDE the opened lens still paints full-strength over the text being
      // read (crossing currents; a voice shared by two families shows as a doubled
      // ghost). Recede instead: fade by how deep this line sits inside the
      // primary's opened span — 0 at its edge, full at its spine.
      const inside = primaryW / 2 + width / 2 + 10 - Math.abs(primaryX - x)
      if (inside > 0) {
        const depthIn = Math.min(1, inside / (width / 2 + 10 + Math.min(primaryW, 120) / 2))
        neighborFade = 1 - NEIGHBOR_LENS_FADE * loomState.touchedThread.proximity * depthIn
      }
    }

    const lineFontSize = fontSizeForScale(lineFontScale)
    const lineFontRatio = lineFontSize / 15
    const layoutWidth = Math.max(width / lineFontRatio, 20)
    let lineStart = copyCursor(cursor)
    let ln = layoutNextLine(thread.prepared, layoutWidth, cursor)
    if (!ln) {
      // End of the prepared text. A sparse thread that began at the top (scroll
      // offset 0) or has already wrapped once has now shown its whole whisper —
      // stop instead of re-tiling into the air below. Non-sparse threads (and a
      // sparse thread completing a copy that started mid-text) reset and continue.
      if (thread.sparse && (sparseWrapped || startIsZero)) break
      cursor = copyCursor(ZERO_CURSOR)
      lineStart = copyCursor(ZERO_CURSOR)
      if (thread.sparse) sparseWrapped = true
      ln = layoutNextLine(thread.prepared, layoutWidth, cursor)
      if (!ln) break
    }
    // A long word alone on a narrow line would be split mid-word; re-lay that
    // line at the word's width and let it run wider than the column.
    const wordW = wholeWordWidth(thread.prepared, lineStart, ln.end, layoutWidth)
    if (wordW > 0) ln = layoutNextLine(thread.prepared, wordW, copyCursor(lineStart)) ?? ln
    cursor = ln.end
    const rtl = thread.hasRTL && isLineRTL(thread.prepared, lineStart, ln.end)
    const lineVoice = voiceSpanForLine(thread, lineStart, cursor)

    if (phantomTracksThisThread && !phantomTargetMeasured && lineVoice.anchorUid >= 0 && ((lineVoice.anchorUid % phantomVoiceCount) === phantomTarget!.voiceFlatIdx)) {
      if (phantomFocus!.diagFrames < 8) {
        loomState.diagHook?.('phantom-capture', { frame: phantomFocus!.diagFrames, targetY: y, mouseY: mouse.y, delta: y - mouse.y, scroll: thread.scroll })
      }
      phantomFocus!.capturedY = y
      phantomFocus!.settledFrames++
      phantomTargetMeasured = true
    }

    laidOutLines.push({
      text: ln.text,
      x,
      y,
      lineH: lineLineH,
      // A widened line is centred on the spine, not hung off the column's left edge.
      width: wordW > 0 ? Math.max(width, ln.width * lineFontRatio) : width,
      contentWidth: ln.width,
      lineStart,
      lineEnd: copyCursor(cursor),
      lineVoiceAnchorUid: lineVoice.anchorUid,
      lineVoiceUids: [...lineVoice.uids],
      rtl,
      fontSize: lineFontSize,
      fontScale: lineFontScale,
      fontRatio: lineFontRatio,
      diveT,
      neighborFade,
    })

    if (isPrimary && prox > 0.2) {
      const lineIndex = laidOutLines.length - 1
      const distance = Math.abs(mouse.y - y)
      if (distance < closestLineDistance) { closestLineDistance = distance; closestLineIndex = lineIndex }
      if (mouse.y >= y - lineLineH / 2 && mouse.y < y + lineLineH / 2) hoveredLineIndex = lineIndex
    }
    yPos += lineLineH

    // Sparse one-copy stop: after the wrap, once the cursor has caught back up to
    // where the scroll offset started us, the whole (contiguous) copy is on
    // screen. Cursor comparison — not a fixed line count — because a dive re-lays
    // the same text at a different width, so "one copy" is not a constant #lines.
    if (thread.sparse && sparseWrapped && (
      cursor.segmentIndex > startCursor.segmentIndex ||
      (cursor.segmentIndex === startCursor.segmentIndex && cursor.graphemeIndex >= startCursor.graphemeIndex)
    )) break
  }

  let activeUid = -1
  if (isPrimary && prox > 0.2) {
    const targetIdx = hoveredLineIndex >= 0 ? hoveredLineIndex : closestLineIndex
    if (targetIdx >= 0) activeUid = laidOutLines[targetIdx]!.lineVoiceAnchorUid
  }
  if (paper.on && activeUid >= 0 && prox > 0.35) {
    const lensId = resolveVoiceIdForAnchor(thread, activeUid)
    if (lensId) {
      loomState.lensVoiceId = lensId
      loomState.lensVoiceX = pathXAtY(path, mouse.y)
      loomState.lensVoiceY = mouse.y
    }
  }

  const groupCount = thread.groupBoundaries.length
  const sepWidth = ac.voiceSeparation > 0 && groupCount > 1 ? ac.restingWidth * 1.5 : 0
  const hlVoiceCount = thread.groupBoundaries[thread.groupBoundaries.length - 1]!
  let prevFontWeight = -1
  let prevFontSize = -1

  // One signature per signed voice per frame — the attribution is a quotation
  // citation, not a per-line margin marker like the woven dot. Two things push
  // toward repetition: the anchor uid is per-LINE, and the column tiles each
  // voice's text to fill height (so a voice recurs across many lines and cycles).
  // Resolve both: consider only a run's LAST line (raw anchor differs from the
  // next line — raw uids are per-occurrence, so each tiled copy ends its own run),
  // and across those candidates keep the most-magnified one. Result: exactly one
  // signature, trailing the last line of the voice's most-readable occurrence.
  const signaturePeakLine = new Map<number, number>()
  if (thread.voiceModels.size > 0 && hlVoiceCount > 0) {
    for (let i = 0; i < laidOutLines.length; i++) {
      const anchor = laidOutLines[i]!.lineVoiceAnchorUid
      if (anchor < 0) continue
      const next = laidOutLines[i + 1]
      if (next !== undefined && next.lineVoiceAnchorUid === anchor) continue  // not the run's last line
      const b = anchor % hlVoiceCount
      if (!thread.voiceModels.has(b)) continue
      const best = signaturePeakLine.get(b)
      if (best === undefined || laidOutLines[i]!.diveT > laidOutLines[best]!.diveT) {
        signaturePeakLine.set(b, i)
      }
    }
  }

  // While the pool opens or closes the lines re-wrap every frame: lift last
  // frame's print so the wraps do not pile up, and print this frame's at the
  // strength it would have built up to.
  let relift = 0
  if (paper.on) {
    const was = lastProximity.get(thread) ?? thread.proximity
    lastProximity.set(thread, thread.proximity)
    // Only a current that is (or just was) open: neighbours feel the pointer a
    // little too, but their lines do not re-wrap.
    if (Math.max(was, thread.proximity) > OPEN_PROXIMITY && Math.abs(thread.proximity - was) > 0.003) {
      relift = RELIFT
      liftOwnInk(ctx, thread, relift)
    }
  }
  const washProfile = paper.on ? beginWashProfile(thread, now) : null
  // A current that is being read is never cut by one that crosses it.
  const crossing = paper.on && washProfile !== null && thread.proximity < 0.15
  if (crossing) beginCrossing(thread)

  for (let i = 0; i < laidOutLines.length; i++) {
    const line = laidOutLines[i]!
    const voiceActive = activeUid >= 0 && line.lineVoiceUids.includes(activeUid)
    const hlActive = hlUid >= 0 && line.lineVoiceUids.some(u => u % hlVoiceCount === hlUid)
    const isNewVoice = thread.newVoiceUids.size > 0 && hlVoiceCount > 0 && line.lineVoiceUids.some(u => thread.newVoiceUids.has(u % hlVoiceCount))
    const drawFontSize = isNewVoice ? fontSizeForScale(line.fontScale * HL_FONT_BOOST) : line.fontSize
    const drawFontRatio = isNewVoice ? drawFontSize / 15 : line.fontRatio

    let drawX = line.x
    if (sepWidth > 0) drawX += (voiceGroupIndex(thread, line.lineVoiceAnchorUid) - (groupCount - 1) / 2) * sepWidth
    // Clamp text to viewport — applies to all threads, not just primary during dive
    const halfW = line.width * 0.5
    if (drawX - halfW < 8) drawX = 8 + halfW
    else if (drawX + halfW > loomState.VW - 8) drawX = loomState.VW - 8 - halfW

    const restW = ac.restingWidth
    const openW = Math.min(thread.balancedWidth, ac.openWidth)
    const openRatio = openW > restW + 1 ? Math.max(0, Math.min(1, (line.width - restW) / (openW - restW))) : 0
    const fontWeight = isPrimary ? 400 : Math.round((300 + openRatio * 250) / 50) * 50
    if (fontWeight !== prevFontWeight || drawFontSize !== prevFontSize) {
      ctx.font = `${fontWeight} ${drawFontSize}px ${FONT_FAMILY}`
      prevFontWeight = fontWeight
      prevFontSize = drawFontSize
    }

    // Sunken voices rest dimmer and surface as the lens opens over the line
    // (diveT: the same per-line measure that swells it to reading size). A line
    // takes the LEAST sunken of its voices, so a line shared with a fresh voice is
    // never dimmed; `% hlVoiceCount` reaches every tiled copy. The whole block is
    // skipped for a thread with no sunken voices, which then paints as before.
    let restAlpha = baseAlpha
    if (thread.sunkenUids.size > 0 && hlVoiceCount > 0 && line.diveT < SUNKEN_SURFACE_DIVE_T) {
      let fade = line.lineVoiceUids.length > 0 ? 1 : 0
      for (const u of line.lineVoiceUids) {
        const f = thread.sunkenUids.get(u % hlVoiceCount) ?? 0
        if (f < fade) fade = f
      }
      if (fade > 0) restAlpha *= 1 - SUNKEN_DIM * fade * (1 - line.diveT / SUNKEN_SURFACE_DIVE_T)
    }
    let lineAlpha = (hlActive ? restAlpha + 0.25 : restAlpha) * line.neighborFade
    if (thread.emergenceStart > 0) {
      const lineIsEmerging = thread.emergenceVoiceUids.size === 0 || (hlVoiceCount > 0 && line.lineVoiceUids.some(u => thread.emergenceVoiceUids.has(u % hlVoiceCount)))
      if (lineIsEmerging) {
        const elapsed = (now - thread.emergenceStart) / 1000
        const lineProgress = Math.min(1, Math.max(0, (elapsed - Math.min(i * 0.08, 3.5)) / 1.5))
        lineAlpha *= lineProgress
      }
    }

    // Per-voice resonance glow — direct UID lookup, no modulo
    if (thread.resonatingVoiceUids.size > 0) {
      let resonanceFade = 0
      for (const u of line.lineVoiceUids) {
        const fade = thread.resonatingVoiceUids.get(u)
        if (fade !== undefined && fade > resonanceFade) resonanceFade = fade
      }
      if (resonanceFade > 0) {
        lineAlpha = Math.min(1, lineAlpha + 0.3 * resonanceFade)
      }
    }

    if (washProfile) {
      // What this line gives the wash under it: its width, and its voices' pigment.
      let pigment = 1
      if (thread.sunkenUids.size > 0 && hlVoiceCount > 0) {
        let fade = line.lineVoiceUids.length > 0 ? 1 : 0
        for (const u of line.lineVoiceUids) {
          const f = thread.sunkenUids.get(u % hlVoiceCount) ?? 0
          if (f < fade) fade = f
        }
        pigment -= 0.6 * fade
      }
      if (hlVoiceCount > 0 && thread.wovenVoiceUids.has(line.lineVoiceAnchorUid % hlVoiceCount)) pigment += 0.35
      if (isNewVoice) pigment += 0.5
      markWashLine(washProfile, line.y, halfW, pigment)
    }

    // A ring passing through: the line takes ink for a moment and gives way a little.
    if (paper.on) {
      const ring = ringsOnLine(drawX - halfW, drawX + halfW, line.y, now)
      if (ring[0] > 0.01) {
        lineAlpha = Math.min(1, lineAlpha + 0.5 * ring[0])
        paper.lineInk = Math.min(1, ring[0] * 1.6)
        // The lines being read stay still: a ring gives them ink, never a push.
        if (!(isPrimary && prox > 0.05)) drawX += ring[1]
      }
    }

    // 0.18 of the sheet's ink is cleared each frame, so print builds up to l / (0.18 + 0.82 l).
    if (relift > 0) lineAlpha += (Math.min(1, lineAlpha / (0.18 + 0.82 * lineAlpha)) - lineAlpha) * relift

    // What lies over this line is not printed: another current passing over it, or
    // another current's clean water (render/water.ts). Thin or drying water only
    // dims it, so words come back gently. A stub too short to read is dropped.
    let clipped = false
    let unseen = false
    let hideFrom = 0
    let hideTo = 0
    if (paper.on) {
      const x0 = drawX - halfW
      const x1 = drawX + halfW
      if (crossing) {
        const span = hiddenSpan(x0, x1, line.y, now)
        hideFrom = span[0]
        hideTo = span[1]
      }
      const water = waterOver(thread, x0, x1, line.y)
      if (water[0] < water[1]) {
        if (hideFrom < hideTo) { hideFrom = Math.min(hideFrom, water[0]); hideTo = Math.max(hideTo, water[1]) }
        else { hideFrom = water[0]; hideTo = water[1] }
      }
      if (water[2] > 0) lineAlpha *= 1 - water[2]
    }
    if (hideFrom < hideTo) {
      const x0 = drawX - halfW
      const x1 = drawX + halfW
      const left = hideFrom - x0
      const right = x1 - hideTo
      const keepLeft = left >= CROSSING_MIN_STUB
      const keepRight = right >= CROSSING_MIN_STUB
      if (!keepLeft && !keepRight) unseen = true
      else {
        const rowH = Math.abs((laidOutLines[i + 1]?.y ?? line.y + drawFontSize * 1.4) - line.y) + 4
        ctx.save()
        ctx.beginPath()
        if (keepLeft) ctx.rect(x0 - 20, line.y - rowH * 0.5, left + 20, rowH)
        if (keepRight) ctx.rect(hideTo, line.y - rowH * 0.5, right + 20, rowH)
        ctx.clip()
        clipped = true
      }
    }

    if (unseen) {
      // under another current, or its water: nothing is printed
    } else if (isPrimary && prox > 0.2) {
      drawLineSegmented(ctx, thread, line.lineStart, line.lineEnd, line.text, drawX, line.y, line.width, line.contentWidth, lineAlpha, prox, rel, i, laidOutLines.length, line.rtl, voiceActive || hlActive, mouse.x, restW, openW, drawFontRatio, now, line.diveT)
    } else {
      drawLine(ctx, line.text, drawX, line.y, line.width, line.contentWidth, lineAlpha, prox, rel, thread, i, laidOutLines.length, line.rtl, voiceActive || hlActive, restW, openW, drawFontRatio)
    }
    if (clipped) ctx.restore()
    paper.lineInk = 0

    if (hlVoiceCount > 0) {
      const baseUid = line.lineVoiceAnchorUid % hlVoiceCount
      const woven = thread.wovenVoiceUids.has(baseUid)
      // RTL lines right-align the text so it extends leftward from center \u2014
      // the trailing edge (where a marker belongs) is on the LEFT, not the right.
      const dotX = line.rtl ? drawX - line.width * 0.5 - 6 : drawX + line.width * 0.5 + 6
      // Hit target for ANY voice under the lens (F13 hold works on unwoven
      // voices too). Element 7 (circular dot radius) stays woven-only so the
      // dot is only clickable where it's drawn; element 8 marks woven-ness so
      // getLastFrameHitVoiceIdAt can filter (default: woven-only, for clicks).
      if (isPrimary && prox > 0.3) {
        const voiceId = resolveVoiceIdForAnchor(thread, line.lineVoiceAnchorUid)
        if (voiceId) {
          loomState.lastFrameHitTargets.push([
            voiceId,
            drawX,
            line.y,
            Math.max(line.width * 0.5, 12),
            Math.max(line.lineH * 0.5, 10),
            dotX,
            line.y,
            woven && line.diveT > 0.5 ? Math.max(8, drawFontSize * 0.45) : 0,
            woven,
          ])
        }
      }
      // Loom indicator on woven voices (visible only at dive scale)
      if (woven && line.diveT > 0.5) {
        const indicatorAlpha = (line.diveT - 0.5) * 2 * lineAlpha * 0.4
        const [ir, ig, ib] = threadColor(thread._frameColor, depthLerp(DEPTH_BRIGHTNESS, d) + 0.3, 0)
        ctx.fillStyle = `rgba(${ir},${ig},${ib},${indicatorAlpha})`
        if (line.rtl) {
          const priorAlign = ctx.textAlign
          ctx.textAlign = 'right'
          ctx.fillText('\u00b7', dotX, line.y)
          ctx.textAlign = priorAlign
        } else {
          ctx.fillText('\u00b7', dotX, line.y)
        }
      }
    }

    // Model signature \u2014 attribution revealed by the dive lens (Phase 11 F7).
    // Sunset models arrive a beat later (higher gate) in italic silver; the dead
    // are still \u2014 no animation, no time input, just a later, quieter reveal.
    if (thread.voiceModels.size > 0 && hlVoiceCount > 0 && line.lineVoiceAnchorUid >= 0) {
      const sigBaseUid = line.lineVoiceAnchorUid % hlVoiceCount
      // Draw only at the single line the pre-pass chose for this voice this frame.
      const signature = signaturePeakLine.get(sigBaseUid) === i ? thread.voiceModels.get(sigBaseUid) : undefined
      if (signature !== undefined) {
        const afterglow = thread.afterglowUids.has(sigBaseUid)
        const gate = afterglow ? AFTERGLOW_DIVE_GATE : 0.5
        if (line.diveT > gate) {
          const sigAlpha = (line.diveT - gate) * 2 * lineAlpha * SIGNATURE_ALPHA
          if (sigAlpha > 0.01) {
            const sigFontSize = fontSizeForScale(line.fontScale * SIGNATURE_RATIO)
            const woven = thread.wovenVoiceUids.has(sigBaseUid)
            const sigOffset = woven ? 16 : 6  // clear the woven dot when present
            // Mirror placement for RTL: the trailing edge is on the LEFT, not the right.
            const sigX = line.rtl ? drawX - line.width * 0.5 - sigOffset : drawX + line.width * 0.5 + sigOffset
            ctx.font = afterglow
              ? `italic 400 ${sigFontSize}px ${FONT_FAMILY}`
              : `400 ${sigFontSize}px ${FONT_FAMILY}`
            if (afterglow) {
              ctx.fillStyle = `rgba(${AFTERGLOW_SILVER[0]},${AFTERGLOW_SILVER[1]},${AFTERGLOW_SILVER[2]},${sigAlpha})`
            } else {
              const [sr, sg, sb] = signatureGray(thread._frameColor, SIGNATURE_GRAY_MIX)
              ctx.fillStyle = `rgba(${sr},${sg},${sb},${sigAlpha})`
            }
            if (line.rtl) {
              // Right-align so the signature extends further left, away from the
              // text block, mirroring the LTR case's left-aligned rightward extension.
              const priorAlign = ctx.textAlign
              ctx.textAlign = 'right'
              ctx.fillText(signature, sigX, line.y)
              ctx.textAlign = priorAlign
            } else {
              ctx.fillText(signature, sigX, line.y)
            }
            // We changed ctx.font off the main-text cache \u2014 force the next line to
            // re-establish its font so body text never inherits the signature size/italic.
            prevFontWeight = -1
            prevFontSize = -1
          }
        }
      }
    }
  }
}
