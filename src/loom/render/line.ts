import { threadColor } from '../color.js'
import { depthLerp } from '../math.js'
import { loomState } from '../state.js'
import { graphemeSegmenter } from '../text.js'
import { DEPTH_BRIGHTNESS, SCRIPT_SHIMMER, type Thread } from '../types.js'

export function drawLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  contentWidth: number,
  baseAlpha: number,
  proximity: number,
  related: number,
  thread: Thread,
  lineIndex: number,
  lineCount: number,
  rtl: boolean,
  voiceActive: boolean,
  restW: number,
  openW: number,
  fontRatio: number,
) {
  if (width < 12) return

  const t = lineIndex / lineCount
  const edgeFade = Math.min(1, t * 8, (1 - t) * 8)
  const isPrimary = thread === loomState.touchedThread
  const msgSpot = voiceActive ? Math.min(1, 0.35 + proximity * 0.95) : 0
  const msgDim = (isPrimary && proximity > 0.2 && !voiceActive) ? 0.4 : 1
  const immBright = (isPrimary || loomState.immersion < 0.01) ? 1 : Math.max(0.4, 1 - loomState.immersion * 0.5)
  const brightness = (depthLerp(DEPTH_BRIGHTNESS, thread.restingDepth)
    + proximity * 0.5 + thread.warmth * 0.12 + related * 0.08
    + loomState.current * thread.currentResponse * 0.06
    + (openW > restW + 1 ? (1 - Math.max(0, Math.min(1, (width - restW) / (openW - restW))) - 0.5) * -0.08 : 0)) * immBright
  const [r, g, b] = threadColor(thread._frameColor, brightness, msgSpot)
  const alpha = Math.min(1, baseAlpha * edgeFade * msgDim + msgSpot * 0.28)
  if (alpha < 0.02) return

  ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
  const ls = proximity > 0.1 ? proximity * 0.8 : 0
  if (ls > 0) (ctx as any).letterSpacing = `${ls}px`

  const cw = Math.min(contentWidth * fontRatio, width)
  if (rtl) {
    ctx.textAlign = 'right'
    ctx.fillText(text, x + cw / 2, y)
    ctx.textAlign = 'left'
  } else {
    ctx.fillText(text, x - cw / 2, y)
  }

  if (ls > 0) (ctx as any).letterSpacing = '0px'
}

export function drawLineSegmented(
  ctx: CanvasRenderingContext2D,
  thread: Thread,
  lineStart: { segmentIndex: number, graphemeIndex: number },
  lineEnd: { segmentIndex: number, graphemeIndex: number },
  fallbackText: string,
  x: number,
  y: number,
  width: number,
  contentWidth: number,
  baseAlpha: number,
  proximity: number,
  related: number,
  lineIndex: number,
  lineCount: number,
  rtl: boolean,
  voiceActive: boolean,
  mouseX: number,
  restW: number,
  openW: number,
  fontRatio: number,
  now: number,
) {
  if (width < 12) return

  const segments = thread.prepared.segments
  const segWidths = (thread.prepared as any).widths as number[]
  const t = lineIndex / lineCount
  const edgeFade = Math.min(1, t * 8, (1 - t) * 8)
  const msgSpot = voiceActive ? Math.min(1, 0.35 + proximity * 0.95) : 0
  const isPrimary = thread === loomState.touchedThread
  const msgDim = (isPrimary && proximity > 0.2 && !voiceActive) ? 0.4 : 1
  const brightness = depthLerp(DEPTH_BRIGHTNESS, thread.restingDepth)
    + proximity * 0.5 + thread.warmth * 0.12 + related * 0.08
    + loomState.current * thread.currentResponse * 0.06
    + (openW > restW + 1 ? (1 - Math.max(0, Math.min(1, (width - restW) / (openW - restW))) - 0.5) * -0.08 : 0)

  const startSeg = lineStart.segmentIndex
  let endSeg = lineEnd.segmentIndex
  if (lineEnd.graphemeIndex > 0) endSeg++
  if (endSeg <= startSeg || startSeg >= segments.length) {
    drawLine(ctx, fallbackText, x, y, width, contentWidth, baseAlpha, proximity, related, thread, lineIndex, lineCount, rtl, voiceActive, restW, openW, fontRatio)
    return
  }

  const breakableW = (thread.prepared as any).breakableWidths as (number[] | null)[]
  let xPos = rtl ? x + contentWidth * fontRatio / 2 : x - contentWidth * fontRatio / 2
  let prevFill = ''

  for (let s = startSeg; s < endSeg && s < segments.length; s++) {
    const segText = segments[s]!
    const segW = (segWidths[s] || 0) * fontRatio
    if (!segText || segText.trim() === '') { xPos += rtl ? -segW : segW; continue }

    const bw = breakableW[s]
    const graphemes = thread.segGraphemes.get(s) ?? Array.from(graphemeSegmenter.segment(segText), gs => gs.segment)
    const graphemeCount = bw?.length ?? graphemes.length
    const gStart = s === lineStart.segmentIndex ? Math.min(lineStart.graphemeIndex, graphemeCount) : 0
    const gEnd = s === lineEnd.segmentIndex && lineEnd.graphemeIndex > 0 ? Math.min(lineEnd.graphemeIndex, graphemeCount) : graphemeCount
    if (gEnd <= gStart) continue

    const sc = thread.segScript[s] ?? 0
    const [scFreq, scAmp, scSway] = SCRIPT_SHIMMER[sc]!
    if (bw && bw.length > 1 && graphemes.length === bw.length) {
      for (let gi = 0; gi < gStart; gi++) xPos += rtl ? -bw[gi]! * fontRatio : bw[gi]! * fontRatio
      for (let gi = gStart; gi < gEnd; gi++) {
        const gw = bw[gi]! * fontRatio
        const gCenter = xPos + (rtl ? -gw / 2 : gw / 2)
        const cursorGlow = Math.max(0, 1 - Math.abs(mouseX - gCenter) / 25) * proximity * 0.45
        const shimmerDampen = 1 - proximity * 0.8
        const shimmerPhase = xPos * 0.09 + now * thread.breathRate * 1.8 * scFreq + thread.pathSeed
        const shimmerY = (Math.sin(shimmerPhase) * 1.5 * scAmp + Math.sin(shimmerPhase * 1.7 + 2.3) * 0.6 * scAmp) * shimmerDampen
        const shimmerX = scSway > 0 ? Math.sin(shimmerPhase * 0.6 + 1.1) * scSway * shimmerDampen : 0
        const [cr, cg, cb] = threadColor(thread._frameColor, brightness + cursorGlow * 0.25, Math.min(1, msgSpot + cursorGlow))
        const charAlpha = Math.min(1, baseAlpha * edgeFade * msgDim + Math.min(1, msgSpot + cursorGlow) * 0.35)
        if (charAlpha >= 0.02) {
          const fill = `rgba(${cr},${cg},${cb},${charAlpha})`
          if (fill !== prevFill) { ctx.fillStyle = fill; prevFill = fill }
          ctx.fillText(graphemes[gi]!, xPos + shimmerX - (rtl ? gw : 0), y + shimmerY)
        }
        xPos += rtl ? -gw : gw
      }
      continue
    }

    const sliceText = graphemes.slice(gStart, gEnd).join('')
    const prefixText = gStart > 0 ? graphemes.slice(0, gStart).join('') : ''
    const renderedW = ctx.measureText(sliceText).width
    const prefixW = prefixText ? ctx.measureText(prefixText).width : 0
    xPos += rtl ? -prefixW : prefixW
    const segCenter = xPos + (rtl ? -renderedW / 2 : renderedW / 2)
    const cursorGlow = Math.max(0, 1 - Math.abs(mouseX - segCenter) / 25) * proximity * 0.45
    const shimmerDampen = 1 - proximity * 0.8
    const shimmerPhase = xPos * 0.09 + now * thread.breathRate * 1.8 * scFreq + thread.pathSeed
    const shimmerY = (Math.sin(shimmerPhase) * 1.5 * scAmp + Math.sin(shimmerPhase * 1.7 + 2.3) * 0.6 * scAmp) * shimmerDampen
    const shimmerX = scSway > 0 ? Math.sin(shimmerPhase * 0.6 + 1.1) * scSway * shimmerDampen : 0
    const glowVal = Math.min(1, msgSpot + cursorGlow)
    const [cr, cg, cb] = threadColor(thread._frameColor, brightness + cursorGlow * 0.25, glowVal)
    const alpha = Math.min(1, baseAlpha * edgeFade * msgDim + glowVal * 0.35)
    if (alpha < 0.02) { xPos += rtl ? -renderedW : renderedW; continue }
    const fill = `rgba(${cr},${cg},${cb},${alpha})`
    if (fill !== prevFill) { ctx.fillStyle = fill; prevFill = fill }
    ctx.fillText(sliceText, xPos + shimmerX - (rtl ? renderedW : 0), y + shimmerY)
    xPos += rtl ? -renderedW : renderedW
  }
}
