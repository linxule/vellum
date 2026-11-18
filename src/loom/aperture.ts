import { lerp, smoothstep } from './math.js'
import { TEXTURE_LINE_H, TEXTURE_SCALE, type ApertureConfig } from './types.js'

export const MIN_RESTING_WIDTH_PX = 34

export function aperture(vw: number): ApertureConfig {
  const t = smoothstep(vw / 1440)
  return {
    t,
    visibleThreads: Math.max(8, Math.min(12, Math.round(lerp(8, 12, t)))),
    // Floor: below ~650px wide the proportional width drops under one word at
    // texture scale (22px at 390w), and Pretext splits words mid-glyph
    // ("questio / n"). 34px holds a typical word; wide viewports are unaffected.
    // Longer words ("announcement") are kept whole per line — see wholeWordWidth.
    restingWidth: Math.max(MIN_RESTING_WIDTH_PX, vw * lerp(0.06, 0.04, t)),
    openWidth: Math.min(vw * lerp(0.85, 0.4, t), 700),
    touchRadius: vw * lerp(0.45, 0.14, t),
    touchPersistence: lerp(4, 2, t),
    baseDimming: lerp(0.3, 0, t),
    pathAmplitude: lerp(0.12, 0.2, t),
    spreadEdge: lerp(0.1, 0.2, t),
    voiceSeparation: smoothstep(Math.max(0, (t - 0.3) / 0.5)),
    textureScale: TEXTURE_SCALE,
    diveScale: lerp(1.4, 1.7, t),
    textureLineH: TEXTURE_LINE_H,
    diveLineH: lerp(28, 36, t),
    maxThreads: Math.max(8, Math.min(12, Math.round(lerp(8, 12, t)))),
  }
}
