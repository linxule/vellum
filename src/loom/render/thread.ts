import { layoutNextLine, type LayoutCursor } from '@chenglou/pretext'
import { getState } from '../../content.js'
import { highlightUidForThread } from '../highlight.js'
import { depthLerp, fontRatioForScale, fontSizeForScale, lerp } from '../math.js'
import { diveGaussian, pathXAtY, widthAtY } from '../path.js'
import { resolvePhantomTarget } from '../phantom.js'
import { updateResonances } from '../resonance.js'
import { loomState } from '../state.js'
import { copyCursor, isLineRTL, voiceGroupIndex, voiceSpanForLine } from '../text.js'
import { AFTERGLOW_DIVE_GATE, AFTERGLOW_SILVER, BREATH_AMP, BREATH_SPATIAL, DEPTH_ALPHA, DEPTH_BRIGHTNESS, DIVE_SIGMA_LINES, HL_FONT_BOOST, SIGNATURE_ALPHA, SIGNATURE_GRAY_MIX, SIGNATURE_RATIO, ZERO_CURSOR, type ApertureConfig, type Thread } from '../types.js'
import { depthColor, signatureGray, threadColor } from '../color.js'
import { drawLine, drawLineSegmented } from './line.js'

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
  const baseAlpha = (depthLerp(DEPTH_ALPHA, d) + prox * (0.85 - depthLerp(DEPTH_ALPHA, d)) + rel * 0.12 + warm * 0.08 + apiWarm * 0.15 + glowBoost + hlThreadBoost) * immersionDim * visibilityAlpha * dimFactor

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

  let yPos = 0
  const minLineH = Math.max(1, ac.textureLineH * (1 + lineBreath * 0.08))
  const maxLines = Math.ceil((loomState.VH + ac.diveLineH) / minLineH) + 2
  while (yPos < loomState.VH + ac.diveLineH && laidOutLines.length < maxLines) {
    const lineY = Math.min(yPos, loomState.VH)
    const diveT = (isPrimary && prox > 0.05 && mouse.x > -1000) ? prox * diveGaussian(lineY, mouse.y, diveSigma) : 0
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

    if (!isPrimary && loomState.touchedThread && loomState.touchedThread._path.length > 0 && loomState.touchedThread.proximity > 0.1) {
      const primaryX = pathXAtY(loomState.touchedThread._path, y)
      const primaryOpenW = Math.min(loomState.touchedThread.balancedWidth, ac.openWidth)
      const primaryBreathMod = 1 + BREATH_AMP * (1 - loomState.touchedThread.proximity)
        * Math.sin(now * loomState.touchedThread.breathRate + loomState.touchedThread.pathSeed + y * BREATH_SPATIAL)
      const primaryW = widthAtY(y, mouse.y, loomState.touchedThread.proximity, primaryOpenW, ac.restingWidth * primaryBreathMod)
      const maxWidth = 2 * Math.max(0, Math.abs(primaryX - x) - primaryW / 2 - 15)
      if (maxWidth < width) width = Math.max(breathRestW, maxWidth)
    }

    const lineFontSize = fontSizeForScale(lineFontScale)
    const lineFontRatio = lineFontSize / 15
    const layoutWidth = Math.max(width / lineFontRatio, 20)
    let lineStart = copyCursor(cursor)
    let ln = layoutNextLine(thread.prepared, cursor, layoutWidth)
    if (!ln) {
      cursor = copyCursor(ZERO_CURSOR)
      lineStart = copyCursor(ZERO_CURSOR)
      ln = layoutNextLine(thread.prepared, cursor, layoutWidth)
      if (!ln) break
    }
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
      width,
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
    })

    if (isPrimary && prox > 0.2) {
      const lineIndex = laidOutLines.length - 1
      const distance = Math.abs(mouse.y - y)
      if (distance < closestLineDistance) { closestLineDistance = distance; closestLineIndex = lineIndex }
      if (mouse.y >= y - lineLineH / 2 && mouse.y < y + lineLineH / 2) hoveredLineIndex = lineIndex
    }
    yPos += lineLineH
  }

  let activeUid = -1
  if (isPrimary && prox > 0.2) {
    const targetIdx = hoveredLineIndex >= 0 ? hoveredLineIndex : closestLineIndex
    if (targetIdx >= 0) activeUid = laidOutLines[targetIdx]!.lineVoiceAnchorUid
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
      ctx.font = `${fontWeight} ${drawFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
      prevFontWeight = fontWeight
      prevFontSize = drawFontSize
    }

    let lineAlpha = hlActive ? baseAlpha + 0.25 : baseAlpha
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

    if (isPrimary && prox > 0.2) {
      drawLineSegmented(ctx, thread, line.lineStart, line.lineEnd, line.text, drawX, line.y, line.width, line.contentWidth, lineAlpha, prox, rel, i, laidOutLines.length, line.rtl, voiceActive || hlActive, mouse.x, restW, openW, drawFontRatio, now)
    } else {
      drawLine(ctx, line.text, drawX, line.y, line.width, line.contentWidth, lineAlpha, prox, rel, thread, i, laidOutLines.length, line.rtl, voiceActive || hlActive, restW, openW, drawFontRatio)
    }

    if (thread.wovenVoiceUids.size > 0 && hlVoiceCount > 0) {
      const baseUid = line.lineVoiceAnchorUid % hlVoiceCount
      if (thread.wovenVoiceUids.has(baseUid)) {
        const voiceId = resolveVoiceIdForAnchor(thread, line.lineVoiceAnchorUid)
        const dotX = drawX + line.width * 0.5 + 6
        if (isPrimary && prox > 0.3 && voiceId) {
          loomState.lastFrameHitTargets.push([
            voiceId,
            drawX,
            line.y,
            Math.max(line.width * 0.5, 12),
            Math.max(line.lineH * 0.5, 10),
            dotX,
            line.y,
            line.diveT > 0.5 ? Math.max(8, drawFontSize * 0.45) : 0,
          ])
        }
        // Loom indicator on woven voices (visible only at dive scale)
        if (line.diveT > 0.5) {
          const indicatorAlpha = (line.diveT - 0.5) * 2 * lineAlpha * 0.4
          const [ir, ig, ib] = threadColor(thread._frameColor, depthLerp(DEPTH_BRIGHTNESS, d) + 0.3, 0)
          ctx.fillStyle = `rgba(${ir},${ig},${ib},${indicatorAlpha})`
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
            const sigX = drawX + line.width * 0.5 + (woven ? 16 : 6)  // clear the woven dot when present
            ctx.font = afterglow
              ? `italic 400 ${sigFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
              : `400 ${sigFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
            if (afterglow) {
              ctx.fillStyle = `rgba(${AFTERGLOW_SILVER[0]},${AFTERGLOW_SILVER[1]},${AFTERGLOW_SILVER[2]},${sigAlpha})`
            } else {
              const [sr, sg, sb] = signatureGray(thread._frameColor, SIGNATURE_GRAY_MIX)
              ctx.fillStyle = `rgba(${sr},${sg},${sb},${sigAlpha})`
            }
            ctx.fillText(signature, sigX, line.y)
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
