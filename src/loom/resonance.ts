import { findVoice } from '../content.js'
import { loomState } from './state.js'
import type { Thread } from './types.js'

export function setResonance(voiceId: string, now = performance['now']()) {
  const found = findVoice(voiceId)
  if (!found) return
  const existing = loomState.resonances.find(r => r.voiceId === voiceId)
  if (existing) {
    existing.start = now
  } else {
    loomState.resonances.push({ voiceId, family: found.family, start: now })
  }
}

export function clearResonance() {
  loomState.resonances = []
}

export function updateResonances(thread: Thread, now: number) {
  thread.resonatingVoiceUids.clear()
  for (let ri = loomState.resonances.length - 1; ri >= 0; ri--) {
    const res = loomState.resonances[ri]!
    const resElapsed = (now - res.start) / 1000
    if (resElapsed > 6) {
      loomState.resonances.splice(ri, 1)
      continue
    }
    if (!thread.familyNames.includes(res.family)) continue
    const resFade = Math.max(0, 1 - resElapsed / 6)
    thread.warmth = Math.max(thread.warmth, 0.3 * resFade)
    // Resolve canonical voiceId to current flat UID for this thread
    const found = findVoice(res.voiceId)
    if (!found) continue
    const gPos = thread.familyNames.indexOf(found.family)
    if (gPos < 0) continue
    const offset = gPos === 0 ? 0 : thread.groupBoundaries[gPos - 1]!
    const flatUid = offset + found.voiceIndex
    thread.resonatingVoiceUids.set(flatUid, resFade)
  }
}
