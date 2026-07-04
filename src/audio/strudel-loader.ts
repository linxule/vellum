// src/audio/strudel-loader.ts

const STRUDEL_SRC = '/lib/strudel-web-1.3.0.js'

let initPromise: Promise<void> | null = null
let initSucceeded = false

export async function loadAndInitStrudel(): Promise<void> {
  if (initSucceeded) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      await loadScript(STRUDEL_SRC)

      const { initStrudel } = (window as any)
      if (!initStrudel) throw new Error('Strudel not loaded')

      // No prebake — we use only built-in synths (sine, supersaw, triangle).
      await initStrudel()
      initSucceeded = true
    } catch (e) {
      initPromise = null
      throw e
    }
  })()

  return initPromise
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Script load failed: ${src}`))
    document.head.appendChild(script)
  })
}

export function isStrudelReady(): boolean { return initSucceeded }

// Full prewarm: load script + run initStrudel() during idle time.
// Creates a suspended AudioContext. First sound click only needs
// resume() + evaluate() — instant instead of ~1s init delay.
// Errors are swallowed; click-time init retries if prewarm fails.
export function preloadStrudelScript(): void {
  if (initSucceeded || initPromise) return
  loadAndInitStrudel().catch(() => {})
}
