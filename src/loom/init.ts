import { THREADS, getState } from '../content.js'
import { aperture } from './aperture.js'
import { fontRatioForScale } from './math.js'
import { loomState, getInteractionState } from './state.js'
import { crystallizeThreads, makeThread, mixInk } from './thread.js'
import { lineEndsWholeWords } from './text.js'
import { isAfterglow, signatureFor } from './model-registry.js'
import { readingThread } from './reading.js'
import { threadGroupKey } from './refresh.js'
import { ZERO_CURSOR } from './types.js'

export function initLoom() {
  loomState.VW = innerWidth
  loomState.VH = innerHeight
  const ac = aperture(loomState.VW, loomState.VH)
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

  // Populate wovenVoiceUids + per-voice model signatures from state
  if (state) {
    for (const thread of loomState.threads) {
      thread.wovenVoiceUids.clear()
      thread.voiceModels.clear()
      thread.afterglowUids.clear()
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
          const signature = signatureFor(voices[v]!.declared_model)
          if (signature !== null) {
            thread.voiceModels.set(offset + v, signature)
            if (isAfterglow(voices[v]!.declared_model)) thread.afterglowUids.add(offset + v)
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

/**
 * The page changed size. Only the height (a phone's bars moving, an ext-app host
 * resizing its frame): nothing a column's place or wrap depends on changed, so
 * every column stays where it is and the open current stays open; the water keeps
 * (render/water.ts). The width: the columns are placed afresh, but a current held
 * open for reading stays open, under its new grouping if it was split.
 */
export function resizeLoom() {
  const widthChanged = innerWidth !== loomState.VW
  loomState.VW = innerWidth
  loomState.VH = innerHeight
  if (!widthChanged) return
  const held = readingThread()
  loomState.touchedThread = null
  const ac = aperture(loomState.VW, loomState.VH)
  const n = Math.max(1, loomState.threads.length - 1)
  loomState.threads.forEach((t, i) => {
    const spread = loomState.VW * 0.04
    const edge = ac.spreadEdge
    t.xCenter = loomState.VW * (edge + (i / n) * (1 - 2 * edge)) + (Math.random() - 0.5) * spread
    const textureLayoutWidth = ac.restingWidth / fontRatioForScale(ac.textureScale)
    t.lineEndCursors = lineEndsWholeWords(t.prepared, textureLayoutWidth)
    t.totalLines = t.lineEndCursors.length
  })
  crystallizeThreads(ac)
  if (held && !loomState.threads.includes(held)) {
    const part = loomState.threads.find(t => t.familyNames.includes(held.familyNames[0]!))
    loomState.readingKey = part ? threadGroupKey(part.familyNames) : null
  }
}

/**
 * Remixes every current's colour from the family inks as they are now. The
 * paper look changes the inks in place when the sheet turns from day to night;
 * a current mixes its colour when it is built, so it has to be told.
 */
export function recolorLoom(): void {
  for (const t of loomState.threads) {
    mixInk(t.inkMix, t.baseColor)
    t._frameColor[0] = t.baseColor[0]; t._frameColor[1] = t.baseColor[1]; t._frameColor[2] = t.baseColor[2]
  }
}

export function getLoomState() {
  return getInteractionState()
}
