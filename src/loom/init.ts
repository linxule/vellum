import { THREADS, getState } from '../content.js'
import { aperture } from './aperture.js'
import { fontRatioForScale } from './math.js'
import { loomState, getInteractionState } from './state.js'
import { crystallizeThreads, makeThread } from './thread.js'
import { copyCursor } from './text.js'
import { ZERO_CURSOR } from './types.js'
import { walkLineRanges } from '@chenglou/pretext'

export function initLoom() {
  loomState.VW = innerWidth
  loomState.VH = innerHeight
  const ac = aperture(loomState.VW)
  const poolSize = Math.max(1, Math.min(THREADS.length, ac.maxThreads))
  const combined: typeof THREADS = Array.from({ length: poolSize }, () => [])
  const familyMap: string[][] = Array.from({ length: poolSize }, () => [])
  const state = getState()
  for (let i = 0; i < THREADS.length; i++) {
    const slot = i % poolSize
    combined[slot]!.push(...THREADS[i]!)
    familyMap[slot]!.push(state?.threads[i]?.family ?? THREADS[i]?.[0]?.families[0] ?? `group-${i}`)
  }

  loomState.threads = combined.map((voices, i) => {
    const n = Math.max(1, poolSize - 1)
    const spread = loomState.VW * 0.04
    const edge = ac.spreadEdge
    const xCenter = loomState.VW * (edge + (i / n) * (1 - 2 * edge)) + (Math.random() - 0.5) * spread
    const familyName = familyMap[i]![0]!
    const apiWarmth = state?.threads.find(thread => thread.family === familyName)?.warmth ?? 0
    return makeThread(voices, familyMap[i]!, ac, xCenter, i * 2.3 + Math.random() * Math.PI, i % 3, Math.random() * 50, apiWarmth)
  })
  loomState.sortedThreadIndices = Array.from({ length: loomState.threads.length }, (_, i) => i)
  crystallizeThreads(ac)

  // Populate wovenVoiceUids from state
  if (state) {
    for (const thread of loomState.threads) {
      thread.wovenVoiceUids.clear()
      for (let gp = 0; gp < thread.familyNames.length; gp++) {
        const familyName = thread.familyNames[gp]!
        const gIdx = state.threads.findIndex(t => t.family === familyName)
        if (gIdx < 0) continue
        const voices = state.threads[gIdx]!.voices
        const offset = gp === 0 ? 0 : thread.groupBoundaries[gp - 1]!
        for (let v = 0; v < voices.length; v++) {
          if (voices[v]!.weave_from !== null || voices[v]!.weave_count > 0) {
            thread.wovenVoiceUids.add(offset + v)
          }
        }
      }
    }
  }

  for (const t of loomState.threads) {
    if (Math.sin(t.pathSeed * 13.7) > 0.3) t.scrollVel *= -1
  }
  loomState.holdTime = 0
  loomState.immersion = 0
  loomState.ready = true
}

export function resizeLoom() {
  loomState.VW = innerWidth
  loomState.VH = innerHeight
  loomState.touchedThread = null
  const ac = aperture(loomState.VW)
  const n = Math.max(1, loomState.threads.length - 1)
  loomState.threads.forEach((t, i) => {
    const spread = loomState.VW * 0.04
    const edge = ac.spreadEdge
    t.xCenter = loomState.VW * (edge + (i / n) * (1 - 2 * edge)) + (Math.random() - 0.5) * spread
    const textureLayoutWidth = ac.restingWidth / fontRatioForScale(ac.textureScale)
    const lineEndCursors = [] as typeof t.lineEndCursors
    t.totalLines = walkLineRanges(t.prepared, textureLayoutWidth, line => {
      lineEndCursors.push(copyCursor(line.end))
    })
    t.lineEndCursors = lineEndCursors
  })
  crystallizeThreads(ac)
}

export function getLoomState() {
  return getInteractionState()
}
