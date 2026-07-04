import { findVoice } from '../content.js'
import { loomState } from './state.js'
import type { Thread } from './types.js'

export function setHighlight(voiceId: string, _now = performance['now']()) {
  const found = findVoice(voiceId)
  if (!found) return
  loomState.highlightFamily = found.family
  loomState.highlightVoiceIndex = found.voiceIndex
}

export function clearHighlight() {
  loomState.highlightFamily = null
  loomState.highlightVoiceIndex = -1
}

export function highlightUidForThread(thread: Thread): number {
  if (!loomState.highlightFamily || loomState.highlightVoiceIndex < 0) return -1
  const gPos = thread.familyNames.indexOf(loomState.highlightFamily)
  if (gPos < 0) return -1
  const offset = gPos > 0 ? thread.groupBoundaries[gPos - 1]! : 0
  return offset + loomState.highlightVoiceIndex
}
