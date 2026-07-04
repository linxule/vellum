import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext'
import { THREADS, type Family, type Voice, getState } from '../content.js'
import { fontRatioForScale } from './math.js'
import { computeBalancedWidth } from './path.js'
import { loomState } from './state.js'
import { containsRTL, copyCursor, graphemeSegmenter, scriptClass } from './text.js'
import { DEFAULT_COLOR, FAMILY_COLOR, FONT, PATH_POINTS, type ApertureConfig, type Thread } from './types.js'

export function makeThread(
  voices: Voice[],
  familyNames: string[],
  ac: ApertureConfig,
  xCenter: number,
  pathSeed: number,
  depth: number,
  scroll: number,
  warmth: number,
): Thread {
  const baseText = voices.map(v => v.text).join('')
  const targetLength = 4000
  const repeatCount = Math.min(200, Math.max(3, Math.ceil(targetLength / Math.max(1, baseText.length))))
  const text = (baseText + ' ').repeat(repeatCount)
  const prepared = prepareWithSegments(text, FONT, { whiteSpace: 'pre-wrap' })
  const textureLayoutWidth = ac.restingWidth / fontRatioForScale(ac.textureScale)
  const lineEndCursors = [] as Thread['lineEndCursors']
  const totalLines = walkLineRanges(prepared, textureLayoutWidth, line => {
    lineEndCursors.push(copyCursor(line.end))
  })

  const voiceEnds: number[] = []
  let vOff = 0
  for (const v of voices) { vOff += v.text.length; voiceEnds.push(vOff) }
  const baseLen = vOff + 1

  const segVoiceUid: number[] = []
  let segCharPos = 0
  for (const segment of prepared.segments) {
    const cycle = Math.floor(segCharPos / baseLen)
    const posInCycle = segCharPos - cycle * baseLen
    let vIdx = voices.length - 1
    for (let v = 0; v < voices.length; v++) {
      if (posInCycle < voiceEnds[v]!) { vIdx = v; break }
    }
    segVoiceUid.push(cycle * voices.length + vIdx)
    segCharPos += segment.length
  }

  const families = new Set<Family>()
  for (const v of voices) {
    for (const f of v.families) families.add(f as Family)
  }

  let cr = 0
  let cg = 0
  let cb = 0
  let colorCount = 0
  for (const v of voices) {
    for (const f of v.families) {
      const fc = FAMILY_COLOR[f] ?? DEFAULT_COLOR
      cr += fc[0]
      cg += fc[1]
      cb += fc[2]
      colorCount++
    }
  }
  const baseColor: [number, number, number] = colorCount > 0
    ? [cr / colorCount, cg / colorCount, cb / colorCount]
    : [DEFAULT_COLOR[0], DEFAULT_COLOR[1], DEFAULT_COLOR[2]]

  const groupBoundaries: number[] = []
  let cum = 0
  for (const familyName of familyNames) {
    cum += getState()?.threads.find(thread => thread.family === familyName)?.voices.length
      ?? THREADS.find(voicesForFamily => voicesForFamily[0]?.families[0] === familyName)?.length
      ?? 0
    groupBoundaries.push(cum)
  }

  const s = pathSeed
  const freqMult = 0.7 + (Math.sin(s * 7.3) + 1) * 0.35
  const ampMult = 0.6 + (Math.sin(s * 11.1) + 1) * 0.35
  const currentResponse = 0.3 + (Math.sin(s * 3.7) + 1) * 0.35
  const breathRate = 0.0002 + (Math.sin(s * 5.9) + 1) * 0.0002

  const breakableWidths = (prepared as any).breakableWidths as (number[] | null)[]
  const segGraphemes = new Map<number, string[]>()
  const segScript = new Uint8Array(prepared.segments.length)
  for (let si = 0; si < prepared.segments.length; si++) {
    if (breakableWidths[si] && breakableWidths[si]!.length > 1) {
      segGraphemes.set(si, Array.from(graphemeSegmenter.segment(prepared.segments[si]!), gs => gs.segment))
    }
    if (prepared.segments[si]?.trim()) segScript[si] = scriptClass(prepared.segments[si]!)
  }

  return {
    prepared,
    families,
    xCenter,
    pathSeed,
    baseDepth: depth,
    restingDepth: depth,
    scroll,
    scrollVel: (0.0003 + depth * 0.0006) + Math.random() * (0.0004 + depth * 0.0006),
    freqMult,
    ampMult,
    currentResponse,
    breathRate,
    baseColor,
    userScroll: 0,
    touched: false,
    touchFade: 0,
    proximity: 0,
    related: 0,
    warmth: 0,
    apiWarmth: warmth,
    arrivalGlow: 0,
    emergenceStart: 0,
    emergenceDepthFrom: 0,
    resonatingVoiceUids: new Map(),
    wovenVoiceUids: new Set(),
    emergenceVoiceUids: new Set(),
    newVoiceIds: new Set(),
    newVoiceUids: new Set(),
    lineEndCursors,
    totalLines,
    _frameColor: [baseColor[0], baseColor[1], baseColor[2]],
    _handDist: Infinity,
    balancedWidth: computeBalancedWidth(baseText, FONT, ac.openWidth),
    _path: Array.from({ length: PATH_POINTS + 1 }, () => ({ x: 0, y: 0 })),
    hasRTL: containsRTL(baseText),
    segVoiceUid,
    familyNames,
    groupBoundaries,
    segGraphemes,
    segScript,
  }
}

export function crystallizeThreads(ac: ApertureConfig) {
  if (ac.voiceSeparation < 0.95) return

  const sepWidth = ac.restingWidth * 1.5
  const newThreads: Thread[] = []
  let changed = false

  for (const thread of loomState.threads) {
    if (thread.familyNames.length <= 1) {
      newThreads.push(thread)
      continue
    }

    changed = true
    const gc = thread.familyNames.length
    for (let g = 0; g < gc; g++) {
      const familyName = thread.familyNames[g]!
      const xDrift = (g - (gc - 1) / 2) * sepWidth
      const apiW = getState()?.threads.find(stateThread => stateThread.family === familyName)?.warmth ?? 0
      newThreads.push(makeThread(
        THREADS.find(voices => voices[0]?.families[0] === familyName) ?? [],
        [familyName],
        ac,
        thread.xCenter + xDrift,
        thread.pathSeed + g * 0.7,
        thread.restingDepth,
        thread.scroll,
        apiW,
      ))
    }
  }

  if (changed) {
    loomState.threads = newThreads
    loomState.sortedThreadIndices = Array.from({ length: newThreads.length }, (_, i) => i)
  }
}
