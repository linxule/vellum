// A 2D context that records every call, with the styles in force at the time.
// Enough of a context for the wash painter, which only draws paths and gradients.

export type PaintCall = { op: string, args: unknown[], fill: unknown, stroke: unknown, comp: string }

export function paintRecorder() {
  const calls: PaintCall[] = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', font: '400 15px serif', textAlign: 'left', textBaseline: 'alphabetic' }
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: key, args, fill: target.fillStyle, stroke: target.strokeStyle, comp: String(target.globalCompositeOperation) })
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return { addColorStop() {} }
        if (key === 'measureText') return { width: String(args[0]).length * 6 }
        return undefined
      }
    },
    set(target, key: string, value) {
      target[key] = value
      calls.push({ op: 'set:' + key, args: [value], fill: target.fillStyle, stroke: target.strokeStyle, comp: String(target.globalCompositeOperation) })
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

/**
 * The paths that were filled or stroked, each with the points it was built from.
 * A path runs from beginPath to the fill or stroke that ends it.
 */
export function paintedPaths(calls: PaintCall[]): Array<{ op: 'fill' | 'stroke', style: unknown, points: Array<[number, number]>, comp: string }> {
  const out: Array<{ op: 'fill' | 'stroke', style: unknown, points: Array<[number, number]>, comp: string }> = []
  let points: Array<[number, number]> = []
  for (const c of calls) {
    if (c.op === 'beginPath') points = []
    else if (c.op === 'moveTo' || c.op === 'lineTo') points.push([c.args[0] as number, c.args[1] as number])
    else if (c.op === 'fill' || c.op === 'stroke') out.push({ op: c.op, style: c.op === 'fill' ? c.fill : c.stroke, points: [...points], comp: c.comp })
  }
  return out
}

export function rgbaAlpha(style: unknown): number {
  if (typeof style !== 'string') return NaN
  const m = style.match(/rgba\([^)]*,\s*(-?[\d.e-]+)\s*\)$/)
  return m ? Number(m[1]) : NaN
}
