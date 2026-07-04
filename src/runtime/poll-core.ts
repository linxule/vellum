import type { StateResponse } from '../content.js'
import type { OceanEvent } from '../events.js'

export interface NewVoiceInfo {
  hasNew: boolean
  newIds: Set<string>
}

/** Compute emergence diff. Pure function. Used by both entry points. */
export function computeNewVoiceInfo(
  prevIdSets: Set<string>[],
  newIdSets: Set<string>[],
): NewVoiceInfo[] {
  return newIdSets.map((newSet, i) => {
    const oldSet = prevIdSets[i]
    const newIds = new Set<string>()
    if (!oldSet) {
      for (const id of newSet) newIds.add(id)
    } else {
      for (const id of newSet) {
        if (!oldSet.has(id)) newIds.add(id)
      }
    }
    return { hasNew: newIds.size > 0, newIds }
  })
}

/**
 * Apply resonance detection: walks new voices in each thread, fires
 * setResonance on any `weave_from` reference. Pure side-effect helper.
 */
export function applyResonanceFromNewVoices(opts: {
  newVoiceInfo: NewVoiceInfo[]
  state: StateResponse
  setResonance: (voiceId: string, now: number) => void
  emitEvent?: (event: OceanEvent) => void
  now: number
}): void {
  const { newVoiceInfo, state, setResonance, emitEvent, now } = opts
  for (let g = 0; g < newVoiceInfo.length; g++) {
    if (!newVoiceInfo[g].hasNew) continue
    const threadVoices = state.threads[g]?.voices ?? []
    for (const v of threadVoices) {
      if (newVoiceInfo[g].newIds.has(v.id) && v.weave_from) {
        setResonance(v.weave_from, now)
        emitEvent?.({
          type: 'weave',
          sourceId: v.weave_from,
          targetId: v.id,
          family: state.threads[g]?.family ?? '',
        })
      }
    }
  }
}

/**
 * Fetch with abort-based timeout. Wraps fetchState from content.ts.
 * Returns null on timeout or abort.
 */
export async function fetchStateWithTimeout(opts: {
  fetchState: (opts: { refresh?: boolean; signal?: AbortSignal }) => Promise<StateResponse | null>
  refresh?: boolean
  timeoutMs: number
}): Promise<StateResponse | null> {
  const { fetchState, refresh, timeoutMs } = opts
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchState({ refresh, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
