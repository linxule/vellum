import { findVoice } from '../content.js'
import { aperture } from './aperture.js'
import { diveGaussian } from './path.js'
import { loomState } from './state.js'
import { DIVE_SIGMA_LINES, type Thread } from './types.js'

export function scrollThread(delta: number, deltaX?: number) {
  // In loom tree view: scroll pans the tree
  if (loomState.loomViewActive) {
    loomState.loomTreeScrollY += delta * 0.8
    if (deltaX) loomState.loomTreeScrollX += deltaX * 0.8
    return
  }
  if (!loomState.touchedThread) return
  loomState.touchedThread.userScroll += delta * 0.005
  loomState.touchedThread.userScroll = Math.max(-2, Math.min(2, loomState.touchedThread.userScroll))
}

export function findLineForVoice(thread: Thread, family: string, voiceIndex: number): number {
  const gPos = thread.familyNames.indexOf(family)
  if (gPos < 0) return -1
  const groupOffset = gPos === 0 ? 0 : thread.groupBoundaries[gPos - 1]!
  const targetUid = groupOffset + voiceIndex
  const totalVoices = thread.groupBoundaries[thread.groupBoundaries.length - 1]!
  if (targetUid < 0 || targetUid >= totalVoices) return -1

  let targetSeg = -1
  for (let i = 0; i < thread.segVoiceUid.length; i++) {
    if (thread.segVoiceUid[i] === targetUid) { targetSeg = i; break }
  }
  if (targetSeg < 0) return -1

  for (let i = 0; i < thread.lineEndCursors.length; i++) {
    const end = thread.lineEndCursors[i]!
    if (end.segmentIndex > targetSeg) return i
    if (end.segmentIndex === targetSeg && end.graphemeIndex > 0) return i
  }
  return -1
}

export function scrollThreadToVoice(threadIdx: number, voiceId: string): void {
  if (threadIdx < 0 || threadIdx >= loomState.threads.length) return
  const found = findVoice(voiceId)
  if (!found) return
  const thread = loomState.threads[threadIdx]!
  const lineIdx = findLineForVoice(thread, found.family, found.voiceIndex)
  if (lineIdx < 0) return

  const ac = aperture(loomState.VW)
  const center = loomState.VH / 2
  const sigma = DIVE_SIGMA_LINES * ac.diveLineH
  let yPos = 0
  let linesAboveCenter = 0
  const maxIter = 500
  while (yPos < center && linesAboveCenter < maxIter) {
    const gauss = diveGaussian(yPos, center, sigma)
    const lineH = ac.textureLineH + (ac.diveLineH - ac.textureLineH) * gauss
    yPos += lineH
    linesAboveCenter++
  }

  thread.scroll = Math.max(0, (lineIdx - linesAboveCenter) / 3)
}
