export function depthLerp(arr: number[] | readonly number[], d: number): number {
  const clamped = Math.max(0, Math.min(1.999, d))
  const lo = Math.floor(clamped)
  return arr[lo]! + (arr[lo + 1]! - arr[lo]!) * (clamped - lo)
}

export function fontSizeForScale(scale: number): number {
  return Math.max(1, Math.round(15 * scale))
}

export function fontRatioForScale(scale: number): number {
  return fontSizeForScale(scale) / 15
}

export function frameMix(rate: number, frameRatio: number): number {
  return 1 - Math.pow(1 - rate, frameRatio)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}
