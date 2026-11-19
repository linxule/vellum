export interface CanvasBundle {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  DPR: number
  syncCanvasSize(vw: number, vh: number): void
}

/**
 * Reads `#c` from DOM, sets up 2D context, returns helpers.
 * `syncCanvasSize` sets width/height + style + DPR transform when vw/vh
 * differ from the last call. Entry points call it each frame.
 */
export function setupCanvas(maxDpr = 3): CanvasBundle {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  // Phones are 3x: at 2x the small resting type is scaled up and goes soft. A phone at 3x is
  // still fewer pixels than a laptop at 2x.
  const DPR = Math.min(devicePixelRatio || 1, maxDpr)
  let prevVw = -1
  let prevVh = -1

  function syncCanvasSize(vw: number, vh: number) {
    if (vw !== prevVw || vh !== prevVh) {
      canvas.width = vw * DPR
      canvas.height = vh * DPR
      canvas.style.width = vw + 'px'
      canvas.style.height = vh + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      prevVw = vw
      prevVh = vh
    }
  }

  return { canvas, ctx, DPR, syncCanvasSize }
}
