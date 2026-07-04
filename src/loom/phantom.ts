import { findVoice } from '../content.js'
import { computePath, pathXAtY } from './path.js'
import { threadGroupKey } from './refresh.js'
import { loomState } from './state.js'
import type { ApertureConfig, DiagFn, MouseState, PhantomFocus, Thread } from './types.js'

export function setDiagHook(fn: DiagFn | null) { loomState.diagHook = fn }

function clearPhantomFocus() {
  loomState.phantomFocus = null
  loomState.phantomResolvedThreadIdx = -1
  loomState.phantomResolvedVoiceFlatIdx = -1
}

function voiceFlatIndexForThread(thread: Thread, family: string, voiceIndex: number): number {
  const familyPos = thread.familyNames.indexOf(family)
  if (familyPos < 0) return -1
  const familyOffset = familyPos === 0 ? 0 : thread.groupBoundaries[familyPos - 1]!
  return familyOffset + voiceIndex
}

export function resolvePhantomTarget(phantomFocus: PhantomFocus | null): { thread: Thread, threadIdx: number, voiceFlatIdx: number } | null {
  if (!phantomFocus) return null

  if (phantomFocus.voiceId) {
    const found = findVoice(phantomFocus.voiceId)
    if (!found) return null
    for (let threadIdx = 0; threadIdx < loomState.threads.length; threadIdx++) {
      const thread = loomState.threads[threadIdx]!
      const voiceFlatIdx = voiceFlatIndexForThread(thread, found.family, found.voiceIndex)
      if (voiceFlatIdx >= 0) return { thread, threadIdx, voiceFlatIdx }
    }
    return null
  }

  if (phantomFocus.groupKey) {
    for (let threadIdx = 0; threadIdx < loomState.threads.length; threadIdx++) {
      const thread = loomState.threads[threadIdx]!
      if (threadGroupKey(thread.familyNames) === phantomFocus.groupKey) {
        return { thread, threadIdx, voiceFlatIdx: -1 }
      }
    }
  }

  return null
}

export function triggerPhantomHover(threadIdx: number, voiceId?: string, now = performance['now']()) {
  if (threadIdx < 0 || threadIdx >= loomState.threads.length) return
  const targetThread = loomState.threads[threadIdx]!
  const phantomFocus: PhantomFocus = {
    voiceId: voiceId ?? null,
    groupKey: voiceId ? null : threadGroupKey(targetThread.familyNames),
    start: now,
    settledFrames: 0,
    diagFrames: 0,
    capturedY: -1,
  }
  loomState.phantomFocus = phantomFocus
  const resolved = resolvePhantomTarget(phantomFocus)
  loomState.phantomResolvedThreadIdx = resolved?.threadIdx ?? threadIdx
  loomState.phantomResolvedVoiceFlatIdx = resolved?.voiceFlatIdx ?? -1
  loomState.diagHook?.('phantom-trigger', {
    threadIdx: loomState.phantomResolvedThreadIdx,
    voiceId: voiceId ?? null,
    voiceFlatIdx: loomState.phantomResolvedVoiceFlatIdx,
    VW: loomState.VW,
    VH: loomState.VH,
  })
}

export function isPhantomActive(): boolean {
  return loomState.phantomFocus !== null
}

export function drivePhantomHover(now: number, mouse: MouseState, ac: ApertureConfig) {
  const phantomFocus = loomState.phantomFocus
  if (!phantomFocus) return

  const userTookOver = mouse.lastMove > phantomFocus.start
  if (userTookOver) {
    clearPhantomFocus()
    return
  }

  const resolved = resolvePhantomTarget(phantomFocus)
  if (!resolved) {
    clearPhantomFocus()
    return
  }
  loomState.phantomResolvedThreadIdx = resolved.threadIdx
  loomState.phantomResolvedVoiceFlatIdx = resolved.voiceFlatIdx

  const target = resolved.thread
  const targetPath = target._path
  const pathNeedsInit = targetPath.length < 2
    || (targetPath[0]!.x === 0 && targetPath[0]!.y === 0
      && targetPath[1]!.x === 0 && targetPath[1]!.y === 0)
  if (pathNeedsInit) computePath(target, now, mouse, ac)

  const path = target._path
  const mid = path.length > 1 ? path[Math.floor(path.length / 2)] : null
  let ny: number
  if (phantomFocus.capturedY >= 0) {
    const prevY = mouse.y > -1000 ? mouse.y : (mid ? mid.y : loomState.VH / 2)
    ny = prevY * 0.3 + phantomFocus.capturedY * 0.7
  } else if (mid && (mid.x !== 0 || mid.y !== 0)) {
    ny = mid.y
  } else {
    ny = loomState.VH / 2
  }
  mouse.y = ny
  mouse.x = path.length > 1 ? pathXAtY(path, ny) : target.xCenter
  mouse.prevX = mouse.x
  mouse.prevY = mouse.y
  phantomFocus.diagFrames++
}
