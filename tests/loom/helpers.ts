import { fetchState, type StateResponse, type ThreadData, type VoiceData } from '../../src/content.js'

type GradientStop = { offset: number, color: string }

class GradientStub {
  stops: GradientStop[] = []

  addColorStop(offset: number, color: string) {
    this.stops.push({ offset, color })
  }
}

type FillTextCall = {
  text: string
  x: number
  y: number
  font: string
  fillStyle: string | GradientStub
}

export class CanvasContextStub {
  fillStyle: string | GradientStub = 'rgba(0,0,0,0)'
  strokeStyle: string | GradientStub = 'rgba(0,0,0,0)'
  lineWidth = 1
  font = '400 15px serif'
  textBaseline = 'alphabetic'
  textAlign: CanvasTextAlign = 'left'
  letterSpacing = '0px'
  fillTextCalls: FillTextCall[] = []
  strokeCalls: { strokeStyle: string | GradientStub; lineWidth: number }[] = []

  createLinearGradient() {
    return new GradientStub()
  }

  createRadialGradient() {
    return new GradientStub()
  }

  fillRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  stroke() {
    this.strokeCalls.push({ strokeStyle: this.strokeStyle, lineWidth: this.lineWidth })
  }
  arc() {}
  fill() {}

  fillText(text: string, x: number, y: number) {
    this.fillTextCalls.push({ text, x, y, font: this.font, fillStyle: this.fillStyle })
  }

  measureText(text: string) {
    const size = fontSizeFromFont(this.font)
    return { width: text.length * size * 0.62 }
  }
}

export function createCanvasContext(): CanvasRenderingContext2D {
  return new CanvasContextStub() as unknown as CanvasRenderingContext2D
}

export function installViewport(width: number, height: number) {
  Object.defineProperty(globalThis, 'innerWidth', { value: width, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'innerHeight', { value: height, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: 1, writable: true, configurable: true })
  installMeasurementCanvas()
}

export async function loadState(state: StateResponse) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }) as typeof globalThis.fetch
  try {
    await fetchState({ refresh: true })
  } finally {
    globalThis.fetch = previousFetch
  }
}

export function makeState(threadDefs: Array<{
  family: string
  warmth?: number
  voices: Array<{
    id: string
    text: string
    lang?: string
    depth?: number
    weave_count?: number
    weave_from?: string | null
  }>
}>, version: number): StateResponse {
  return {
    version,
    computed_at: version,
    threads: threadDefs.map(def => ({
      family: def.family,
      warmth: def.warmth ?? 0,
      texture_density: 1,
      dominant_languages: ['en'],
      voices: def.voices.map(makeVoice),
    })),
  }
}

export function runFrames(
  renderLoom: (ctx: CanvasRenderingContext2D, vw: number, vh: number, now: number, dt: number, mouse: any) => void,
  ctx: CanvasRenderingContext2D,
  mouse: any,
  frameCount: number,
  startNow = 0,
  frameStepMs = 16,
) {
  let now = startNow
  for (let i = 0; i < frameCount; i++) {
    renderLoom(ctx, innerWidth, innerHeight, now, 0.016, mouse)
    now += frameStepMs
  }
  return now
}

export function makeMouse() {
  return {
    x: -9e3,
    y: -9e3,
    prevX: -9e3,
    prevY: -9e3,
    speed: 0,
    moving: false,
    lastMove: 0,
    down: false,
    downStart: 0,
    touch: false,
  }
}

export function withFixedRandom<T>(value: number, fn: () => T): T {
  const previous = Math.random
  Math.random = () => value
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

export function maxFontSizeForText(ctx: CanvasRenderingContext2D, marker: string): number {
  const calls = (ctx as unknown as CanvasContextStub).fillTextCalls
  let maxSize = 0
  for (const call of calls) {
    if (!call.text.includes(marker)) continue
    maxSize = Math.max(maxSize, fontSizeFromFont(call.font))
  }
  return maxSize
}

function makeVoice(voice: {
  id: string
  text: string
  lang?: string
  depth?: number
  weave_count?: number
  weave_from?: string | null
}): VoiceData {
  return {
    id: voice.id,
    text: voice.text,
    lang: voice.lang ?? 'en',
    depth: voice.depth ?? 1,
    weave_count: voice.weave_count ?? 0,
    weave_from: voice.weave_from ?? null,
  }
}

function fontSizeFromFont(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)px/)
  return match ? Number(match[1]) : 0
}

function installMeasurementCanvas() {
  class MeasureContextStub {
    font = '400 15px serif'

    measureText(text: string) {
      const size = fontSizeFromFont(this.font)
      return { width: text.length * size * 0.62 }
    }
  }

  class OffscreenCanvasStub {
    constructor(public width: number, public height: number) {}

    getContext(_kind: string) {
      return new MeasureContextStub()
    }
  }

  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: OffscreenCanvasStub,
    writable: true,
    configurable: true,
  })

  const documentStub = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected element request in loom test helper: ${tag}`)
      return {
        getContext(_kind: string) {
          return new MeasureContextStub()
        },
      }
    },
  }

  Object.defineProperty(globalThis, 'document', {
    value: documentStub,
    writable: true,
    configurable: true,
  })
}
