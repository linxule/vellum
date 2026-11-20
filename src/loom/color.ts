import { lerp } from './math.js'
import { paper, PAPER_RGB } from './paper.js'

const _dc: [number, number, number] = [0, 0, 0]
export function depthColor(base: readonly [number, number, number], depth: number): [number, number, number] {
  const t = depth / 2
  _dc[0] = base[0] * lerp(1.08, 0.82, t)
  _dc[1] = base[1] * lerp(1.04, 0.9, t)
  _dc[2] = base[2] * lerp(0.95, 1.15, t)
  return _dc
}

// Signature tone: pull a family color toward its own gray (desaturate) so the
// attribution reads quieter than the voice text. Module-level scratch — consume
// immediately, like _dc/_tc (never hold the returned tuple across a second call).
const _sc: [number, number, number] = [0, 0, 0]
export function signatureGray(base: readonly number[], mix: number): [number, number, number] {
  const gray = (base[0]! + base[1]! + base[2]!) / 3
  _sc[0] = base[0]! + (gray - base[0]!) * mix
  _sc[1] = base[1]! + (gray - base[1]!) * mix
  _sc[2] = base[2]! + (gray - base[2]!) * mix
  return _sc
}

const _tc: [number, number, number] = [0, 0, 0]
export function threadColor(base: readonly number[], brightness: number, glow: number): [number, number, number] {
  const b = Math.max(0, Math.min(1.3, brightness))
  if (paper.on) {
    // Ink: less attention lets a little paper through, more deepens the pigment.
    const thin = (1 - Math.min(1, b)) * 0.28
    if (paper.night) {
      // On the indigo sheet the pigment is pale: more attention brightens it.
      const lift = Math.min(1, 0.42 * glow + Math.max(0, b - 1) * 0.3 + 0.55 * paper.lineInk)
      for (let i = 0; i < 3; i++) {
        const c = base[i]! + (PAPER_RGB[i]! - base[i]!) * thin
        _tc[i] = Math.max(0, Math.min(255, (c + (255 - c) * lift) | 0))
      }
      return paper.lineFaint > 0 ? underPaper(_tc, paper.lineFaint) : _tc
    }
    const deep = Math.max(0.3, 1 - 0.42 * glow - Math.max(0, b - 1) * 0.3 - 0.5 * paper.lineInk)
    _tc[0] = Math.max(0, Math.min(255, ((base[0]! + (PAPER_RGB[0] - base[0]!) * thin) * deep) | 0))
    _tc[1] = Math.max(0, Math.min(255, ((base[1]! + (PAPER_RGB[1] - base[1]!) * thin) * deep) | 0))
    _tc[2] = Math.max(0, Math.min(255, ((base[2]! + (PAPER_RGB[2] - base[2]!) * thin) * deep) | 0))
    return paper.lineFaint > 0 ? underPaper(_tc, paper.lineFaint) : _tc
  }
  const r = base[0] * b
  const g = base[1] * b
  const bl = base[2] * b
  const sr = base[0] + (255 - base[0]) * 0.4
  const sg = base[1] + (255 - base[1]) * 0.4
  const sb = base[2] + (255 - base[2]) * 0.4
  _tc[0] = Math.min(255, (r + (sr - r) * glow) | 0)
  _tc[1] = Math.min(255, (g + (sg - g) * glow) | 0)
  _tc[2] = Math.min(255, (bl + (sb - bl) * glow) | 0)
  return _tc
}

/**
 * Mixes a colour (in place) toward the paper by `faint` (0 its own, 1 the paper's):
 * ink still under the paper, as an arriving voice's lines are before they rise.
 */
export function underPaper(c: [number, number, number], faint: number): [number, number, number] {
  const f = Math.max(0, Math.min(1, faint))
  for (let i = 0; i < 3; i++) c[i] = (c[i]! + (PAPER_RGB[i]! - c[i]!) * f) | 0
  return c
}
