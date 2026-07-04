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
export function setupCanvas(): CanvasBundle {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const DPR = Math.min(devicePixelRatio || 1, 2)
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
