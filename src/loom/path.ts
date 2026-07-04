import { layout, prepare } from '@chenglou/pretext'
import { loomState } from './state.js'
import { depthLerp } from './math.js'
import { DEPTH_AMPLITUDE, DEPTH_CURRENT, DEPTH_PULL, DRIFT_RATE, PATH_POINTS, type ApertureConfig, type MouseState, type PathPoint, type Thread } from './types.js'

export function computeBalancedWidth(text: string, font: string, maxWidth: number, minWidth = 200): number {
  const prepared = prepare(text, font, { whiteSpace: 'pre-wrap' })
  const targetLines = layout(prepared, maxWidth, 1).lineCount
  if (targetLines <= 1) return maxWidth

  let lo = minWidth
  let hi = maxWidth
  while (hi - lo > 2) {
    const mid = (lo + hi) / 2
    const lines = layout(prepared, mid, 1).lineCount
    if (lines <= targetLines) hi = mid
    else lo = mid
  }
  return Math.ceil(hi)
}

export function pathXAtY(path: PathPoint[], y: number): number {
  const t = Math.max(0, Math.min(1, y / (path[path.length - 1]?.y || 1)))
  const idx = t * (path.length - 1)
  const i = Math.floor(idx)
  const f = idx - i
  const p0 = path[Math.min(i, path.length - 1)]!
  const p1 = path[Math.min(i + 1, path.length - 1)]!
  return p0.x + (p1.x - p0.x) * f
}

export function computePath(thread: Thread, now: number, mouse: MouseState, ac: ApertureConfig): PathPoint[] {
  const { current, touchedThread, VW, VH } = loomState
  const points = thread._path
  const phase = now * DRIFT_RATE * (0.2 + thread.restingDepth * 0.4)
  const ampScale = ac.pathAmplitude > 0 ? ac.pathAmplitude / 0.1 : 0
  const pathBreath = 1 + 0.15 * Math.sin(now * thread.breathRate * 0.4 + thread.pathSeed * 2.7)
    + 0.08 * Math.sin(now * thread.breathRate * 0.7 + thread.pathSeed * 4.3)
  const amp = depthLerp(DEPTH_AMPLITUDE, thread.restingDepth) * ampScale * thread.ampMult * pathBreath
  const dampFactor = 0.9 - thread.proximity * 0.5
  const wanderPhase = now * 0.000015 + thread.pathSeed * 7.7
  const wander = Math.sin(wanderPhase) * VW * 0.06
    + Math.sin(wanderPhase * 1.3 + 2.1) * VW * 0.03

  let baseX = thread.xCenter + wander
  if (touchedThread && thread !== touchedThread && thread.related > 0.05) {
    baseX += (touchedThread.xCenter - thread.xCenter) * thread.related * 0.15
  }

  const f1 = 2.5 * thread.freqMult
  const f2 = 4.1 * thread.freqMult + thread.pathSeed * 0.3
  const f3 = 6.7 + thread.pathSeed * 0.5
  const f4 = 1.1 + thread.pathSeed * 0.2
  const p2 = phase * 1.4 + thread.pathSeed * 2.1
  const p3 = phase * 0.7 + thread.pathSeed * 3.3
  const p4 = phase * 0.3 + thread.pathSeed * 5.1
  const currentAmp = 1 + current * 0.25 * thread.currentResponse

  for (let i = 0; i <= PATH_POINTS; i++) {
    const t = i / PATH_POINTS
    const y = t * VH
    const kelpSway = 0.5 + (1 - t)
    const edgeBoost = 1 + 0.4 * Math.pow(Math.abs(t - 0.5) * 2, 1.5)
    let x = baseX
      + current * VW * 0.012 * depthLerp(DEPTH_CURRENT, thread.restingDepth) * thread.currentResponse * kelpSway
      + Math.sin(t * f1 + phase + thread.pathSeed) * VW * amp * dampFactor * edgeBoost * currentAmp
      + Math.sin(t * f2 + p2) * VW * amp * 0.4 * dampFactor * edgeBoost * currentAmp
      + Math.sin(t * f3 + p3) * VW * amp * 0.2 * dampFactor
      + Math.sin(t * f4 + p4) * VW * amp * 0.6 * dampFactor

    if (mouse.x > -1000 && thread.proximity > 0.01) {
      const dx = mouse.x - x
      const dy = mouse.y - y
      const dist = Math.sqrt(dx * dx + dy * dy) + 1
      const pull = thread.proximity * 25 * depthLerp(DEPTH_PULL, thread.restingDepth) / (1 + dist * 0.008)
      x += (dx / dist) * pull
    }

    points[i]!.x = x
    points[i]!.y = y
  }
  return points
}

export function diveGaussian(y: number, cursorY: number, sigma: number): number {
  const dy = y - cursorY
  return Math.exp(-(dy * dy) / (2 * sigma * sigma))
}

export function widthAtY(y: number, handY: number, proximity: number, openWidth: number, restW: number): number {
  if (proximity < 0.01) return restW
  const dy = y - handY
  const spread = loomState.VH * (0.25 + proximity * 0.25)
  const gaussian = Math.exp(-(dy * dy) / (2 * spread * spread))
  const baseWidth = restW + (openWidth - restW) * proximity * gaussian
  const aboveSigma = loomState.VH * 0.15
  const belowSigma = loomState.VH * 0.1
  const sigma = dy < 0 ? aboveSigma : belowSigma
  const pinch = Math.exp(-(dy * dy) / (2 * sigma * sigma))
  const pinchAmount = proximity * 0.35
  return baseWidth * (1 - pinchAmount * pinch)
}
