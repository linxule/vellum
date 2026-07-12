import { findVoice, getState } from '../content.js'
import type { OceanEvent } from '../events.js'
import { loomState } from './state.js'
import { initLoom } from './init.js'
import { scrollThreadToVoice } from './scroll.js'
import { triggerPhantomHover } from './phantom.js'

// Stable signature for a thread's group membership. Used to key preserved
// thread-local state across initLoom() rebuilds so continuity survives
// normal polling (identical signature) and resets cleanly on regrouping
// (different signature) rather than migrating onto the wrong thread.
export function threadGroupKey(familyNames: string[]): string {
  // Copy before sort — the thread's own familyNames array must not mutate.
  return [...familyNames].sort().join(',')
}

export function refreshLoom(newVoiceInfo?: { hasNew: boolean, newIds: Set<string> }[], now = performance['now'](), emitEvent?: (e: OceanEvent) => void) {
  if (!loomState.ready) return

  const allUnreadIds = new Set<string>()
  for (const t of loomState.threads) {
    for (const id of t.newVoiceIds) allUnreadIds.add(id)
  }

  // Preserve thread-local state across the initLoom() rebuild, keyed by a
  // stable signature derived from familyNames rather than by array position.
  //
  // Why not by array index: initLoom() partitions groups across threads via
  // `slot = i % poolSize`, where `poolSize = min(groupCount, maxThreads)`.
  // When the viewport width crosses an aperture breakpoint (e.g. ~320px,
  // ~480px, ~720px) maxThreads changes, which changes poolSize, which rewires
  // the slot → group mapping. A thread at index 0 that previously held
  // familyNames `['attention', 'memory']` (merged at narrow vw) can become
  // `['attention']` alone after
  // a resize. Copying prevState[0] onto the new thread[0] would migrate the
  // merged [0,8] thread's warmth / scroll / xCenter onto group 0 only, while
  // group 8 on the new thread[8] resets — state lands on the wrong thread.
  //
  // Signature-keyed lookup: the normal steady-state case (no viewport change)
  // has identical familyNames on both sides of initLoom(), so signatures
  // match and preservation is a fast exact-hit. Regrouping causes the
  // signature to change, the lookup misses, and the new thread keeps
  // initLoom's fresh values — a clean failure mode rather than silent
  // cross-thread state migration.
  const prevByGroupKey = new Map<string, {
    xCenter: number,
    scroll: number,
    restingDepth: number,
    pathSeed: number,
    scrollVel: number,
    proximity: number,
    touched: boolean,
    touchFade: number,
    related: number,
    warmth: number,
    apiWarmth: number,
    apiWarmthTarget: number,
    emergenceStart: number,
    emergenceDepthFrom: number,
    emergenceVoiceUids: Set<number>,
  }>()
  for (const t of loomState.threads) {
    const key = threadGroupKey(t.familyNames)
    prevByGroupKey.set(key, {
      xCenter: t.xCenter,
      scroll: t.scroll,
      restingDepth: t.restingDepth,
      pathSeed: t.pathSeed,
      scrollVel: t.scrollVel,
      proximity: t.proximity,
      touched: t.touched,
      touchFade: t.touchFade,
      related: t.related,
      warmth: t.warmth,
      apiWarmth: t.apiWarmth,
      apiWarmthTarget: t.apiWarmthTarget,
      emergenceStart: t.emergenceStart,
      emergenceDepthFrom: t.emergenceDepthFrom,
      emergenceVoiceUids: new Set(t.emergenceVoiceUids),
    })
  }
  const hadPrevThreads = prevByGroupKey.size > 0

  initLoom()

  for (const thread of loomState.threads) {
    const p = prevByGroupKey.get(threadGroupKey(thread.familyNames))
    if (!p) continue
    thread.xCenter = p.xCenter
    thread.scroll = p.scroll
    thread.restingDepth = p.restingDepth
    thread.pathSeed = p.pathSeed
    thread.scrollVel = p.scrollVel
    thread.proximity = p.proximity
    thread.touched = p.touched
    thread.touchFade = p.touchFade
    thread.related = p.related
    thread.warmth = Math.max(thread.warmth, p.warmth)
    // Live warmth (Phase 14): the incoming server warmth lands in apiWarmthTarget
    // (Math.max preserved — warmth never visibly decays mid-session); the eased
    // display value carries across the rebuild so the transition eases, never
    // steps. makeThread set both fields to the fresh incoming value, so this max
    // merges it with the preserved target; apiWarmth resumes from where it eased.
    thread.apiWarmthTarget = Math.max(thread.apiWarmthTarget, p.apiWarmthTarget)
    thread.apiWarmth = p.apiWarmth
    if (p.emergenceStart > 0) {
      thread.emergenceStart = p.emergenceStart
      thread.emergenceDepthFrom = p.emergenceDepthFrom
      thread.emergenceVoiceUids = p.emergenceVoiceUids
    }
  }

  for (const id of allUnreadIds) {
    const found = findVoice(id)
    if (!found) continue
    for (const thread of loomState.threads) {
      if (thread.familyNames.includes(found.family)) {
        thread.newVoiceIds.add(id)
        break
      }
    }
  }

  if (newVoiceInfo) {
    const state = getState()
    for (let i = 0; i < loomState.threads.length; i++) {
      const thread = loomState.threads[i]!
      const familyIndices = thread.familyNames
        .map(familyName => state?.threads.findIndex(threadData => threadData.family === familyName) ?? -1)
        .filter(index => index >= 0)
      const hasAnyNew = familyIndices.some(index => newVoiceInfo[index]?.hasNew)
      if (!hasAnyNew) continue

      thread.arrivalGlow = 1
      thread.emergenceStart = now

      const emergingUids = new Set<number>()
      let allNew = true
      for (let gp = 0; gp < familyIndices.length; gp++) {
        const gIdx = familyIndices[gp]!
        const voices = state?.threads[gIdx]?.voices ?? []
        const offset = gp > 0 ? thread.groupBoundaries[gp - 1]! : 0
        const groupInfo = newVoiceInfo[gIdx]
        for (let v = 0; v < voices.length; v++) {
          if (groupInfo?.newIds.has(voices[v]!.id)) {
            emergingUids.add(offset + v)
            thread.newVoiceIds.add(voices[v]!.id)
          } else {
            allNew = false
          }
        }
      }
      thread.emergenceVoiceUids = emergingUids
      thread.emergenceDepthFrom = (allNew || !hadPrevThreads)
        ? Math.max(1.2, thread.restingDepth + 0.8)
        : thread.restingDepth

      // Emit emergence event via injected callback
      if (emitEvent) {
        const newIds: string[] = []
        for (const gi of familyIndices) {
          const ids = newVoiceInfo[gi]?.newIds
          if (ids) for (const id of ids) newIds.push(id)
        }
        if (newIds.length > 0) {
          emitEvent({ type: 'emergence', voiceIds: newIds, familyNames: [...thread.familyNames] })
        }
      }

      // Partition signals by attention state.
      //
      //   In-place effects (arrivalGlow, emergenceStart, line stagger,
      //     newVoiceIds) fired above — these are visible regardless of
      //     whether the user is here. The new voice surfaces on its own
      //     lines without disturbing the rest of the thread.
      //
      //   Dive effects (scrollThreadToVoice, triggerPhantomHover) steer
      //     attention toward the arrival. They belong on threads where
      //     attention is free to move.
      //
      // If the user is already engaged with this thread, the arrival
      // joins their moment. It doesn't yank their scroll or override
      // their dive lens. The in-place signals carry it — the stagger
      // animation reveals the new voice in-place, and if they scroll
      // to it the B2 marker is there. Only when attention is elsewhere
      // do we steer it.
      //
      // Threshold 0.3: warmth uses 0.1 (attention present), proximity-
      // clear uses 0.5 (attention committed). 0.3 sits between —
      // biased to preserve engagement when in doubt.
      //
      // !phantomFocus: phantom drives proximity above 0.3 within ~260ms,
      // so a same-thread successor arrival would otherwise gate itself.
      // Phantom is by definition not human engagement — it's the very
      // mechanism that surfaces arrivals — so it cannot also count as
      // "the user is already attending here." Same precedent as the
      // proximity-clear gate at the bottom of renderThread().
      const userEngaged = !loomState.phantomFocus && thread.proximity > 0.3
      if (!userEngaged) {
        // Hoisted out of `if (state)` to resolve a TS2552 in the baseline monolith.
        // DO NOT move the declaration back inside the `if (state)` block — that
        // form compiled to a minifier-assisted ReferenceError at runtime because
        // the outer `triggerPhantomHover(i, focusId ?? undefined)` referenced a
        // block-scoped variable. If `state` is null, focusId stays null and the
        // phantom hover fires without a target (voiceFlatIdx = -1) — safe, and
        // practically unreachable because refreshLoom is only called post-fetch.
        let focusId: string | null = null
        if (state) {
          // Pick the NEWEST new voice (smallest depth = closest to surface),
          // not the first by Set iteration order. Set order reflects insertion
          // order, which means leftover unread IDs from prior tool calls get
          // returned before just-arrived voices — the cursor was then landing
          // on a stale unread voice a few lines past the actual new message.
          // Scanning voices and taking the smallest-depth match yields the
          // just-created voice reliably, whether arrivals are solo or buffered.
          let focusDepth = Infinity
          for (const gi of familyIndices) {
            const ids = newVoiceInfo[gi]?.newIds
            if (!ids || ids.size === 0) continue
            const voices = state.threads[gi]?.voices ?? []
            for (const v of voices) {
              if (ids.has(v.id) && v.depth < focusDepth) {
                focusId = v.id
                focusDepth = v.depth
              }
            }
          }
          if (focusId) scrollThreadToVoice(i, focusId)
        }
        // Pass focusId so renderThread can measure the voice's actual rendered Y
        // and nudge scroll over a few frames — the initial scrollThreadToVoice
        // walk is a good guess, but the texture/dive layout-width discrepancy
        // can leave a few-line residual that the measurement closes exactly.
        triggerPhantomHover(i, focusId ?? undefined, now)
      }
    }
  }

  for (const thread of loomState.threads) {
    if (thread.newVoiceIds.size === 0) {
      if (thread.newVoiceUids.size > 0) thread.newVoiceUids = new Set()
      continue
    }
    const rebuiltIds = new Set<string>()
    const rebuiltUids = new Set<number>()
    for (const vid of thread.newVoiceIds) {
      const found = findVoice(vid)
      if (!found) continue
      const gPos = thread.familyNames.indexOf(found.family)
      if (gPos < 0) continue
      const groupOffset = gPos === 0 ? 0 : thread.groupBoundaries[gPos - 1]!
      rebuiltIds.add(vid)
      rebuiltUids.add(groupOffset + found.voiceIndex)
    }
    thread.newVoiceIds = rebuiltIds
    thread.newVoiceUids = rebuiltUids
  }

  // Emit warmth-update after state merge
  if (emitEvent) {
    const state = getState()
    if (state) {
      const familyWarmth: Record<string, number> = {}
      for (const t of state.threads) familyWarmth[t.family] = t.warmth ?? 0
      emitEvent({ type: 'warmth-update', familyWarmth })
    }
  }
}
