import { clearCache } from '@chenglou/pretext'
import { findVoice, getState } from '../content.js'
import type { OceanEvent } from '../events.js'
import { loomState } from './state.js'
import { ZERO_CURSOR, type Thread } from './types.js'
import { initLoom } from './init.js'
import { scrollThreadToVoice } from './scroll.js'
import { compareCursors, cursorAt, placeOf, scrollForTop } from './text.js'
import { paper } from './paper.js'
import { triggerPhantomHover } from './phantom.js'
import { remeasureLoomTree } from './loom-view.js'
import { clearNativeWidths } from './render/line.js'

// Stable signature for a thread's group membership. Used to key preserved
// thread-local state across initLoom() rebuilds so continuity survives
// normal polling (identical signature) and resets cleanly on regrouping
// (different signature) rather than migrating onto the wrong thread.
// Asked once per printed line since the water (render/water.ts, waterOver): a current's family
// list is set when it is built and never changed, so the key is worked out once per list.
const groupKeys = new WeakMap<string[], string>()
export function threadGroupKey(familyNames: string[]): string {
  let key = groupKeys.get(familyNames)
  if (key === undefined) {
    // Copy before sort — the thread's own familyNames array must not mutate.
    key = [...familyNames].sort().join(',')
    groupKeys.set(familyNames, key)
  }
  return key
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
    lag?: number,
    anchor: Thread['_anchor'],
    segments: number,
    thread: Thread,
  }>()
  for (const t of loomState.threads) {
    const key = threadGroupKey(t.familyNames)
    prevByGroupKey.set(key, {
      xCenter: t.xCenter,
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
      // The text being read stays where it is (render/thread.ts): its anchor goes
      // on if its text is unchanged, else the scroll takes over where the text lay.
      scroll: t._anchor ? scrollForTop(t, t._anchor.top) : t.scroll,
      lag: t._lag,
      anchor: t._anchor,
      segments: t.prepared.segments.length,
      thread: t,
    })
  }
  const hadPrevThreads = prevByGroupKey.size > 0

  initLoom()

  for (const thread of loomState.threads) {
    const p = prevByGroupKey.get(threadGroupKey(thread.familyNames))
    if (!p) continue
    thread.xCenter = p.xCenter
    thread.scroll = p.scroll
    thread._lag = p.lag
    thread._scrollBase = p.thread._scrollBase
    // The first frame after a rebuild finds the touched current by last frame's path
    // (render/frame.ts). A fresh path is all zeros, so the current being read was not
    // touched for that frame: its lens dipped and its column moved a few pixels, and
    // the dip's print stayed on the sheet. On paper the path carries over.
    // Its shape goes on too: these are worked out from the path seed when a current is
    // built, and a rebuild draws a new seed (restored above, but not these), so every
    // current changed its sway and its pace at each new state and its words moved.
    if (paper.on) {
      for (let k = 0; k < thread._path.length && k < p.thread._path.length; k++) {
        thread._path[k]!.x = p.thread._path[k]!.x
        thread._path[k]!.y = p.thread._path[k]!.y
      }
      thread.freqMult = p.thread.freqMult
      thread.ampMult = p.thread.ampMult
      thread.currentResponse = p.thread.currentResponse
      thread.breathRate = p.thread.breathRate
    }
    // The same text, not only as many pieces of it: a voice in and a voice out can leave the count as it was.
    const sameText = sameSegments(thread.prepared.segments, p.thread.prepared.segments)
    if (p.anchor && sameText) thread._anchor = { ...p.anchor, scroll: p.scroll }
    else if (paper.on && !thread.sparse && !sameText) keepWordsInPlace(thread, p.thread)
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
      // A wholly new current surfaces as one, from depth. A voice arriving in a
      // current that has others: in the old look the current glows and eases to its
      // depth; on paper only the voice's own lines rise (render/thread.ts) and every
      // line already there stays as it was (no glow, no depth change: -1).
      const journey = allNew || !hadPrevThreads
      thread.arrivalGlow = journey || !paper.on ? 1 : 0
      thread.emergenceDepthFrom = journey
        ? Math.max(1.2, thread.restingDepth + 0.8)
        : paper.on ? -1 : thread.restingDepth

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
      //
      // A current held open by touch (reading.ts) is attention committed, on
      // whichever current the arrival lands: the lens is not taken from it.
      const userEngaged = loomState.readingKey !== null || (!loomState.phantomFocus && thread.proximity > 0.3)
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
        triggerPhantomHover(i, focusId ?? undefined, now, loomState.arrivalHoldMs)
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

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The sheet's typeface arrived after the currents were measured (a slow font host,
 * or a part of a face first needed now): measure them again. Pretext keeps the
 * widths it measured, the fallback face's, until its cache is cleared. Every
 * current keeps its place and its text keeps its place in it (the line at its top
 * is found again in the new wrap); a read current keeps its anchored line, which
 * re-wraps around it as on a resize.
 */
export function remeasureLoom(): void {
  if (!loomState.ready) return
  clearCache()
  clearNativeWidths()
  remeasureLoomTree()
  const tops = new Map<string, Thread['lineEndCursors'][number]>()
  // How a current sways is drawn afresh when it is rebuilt (thread.ts): kept, so no current changes its shape.
  const sways = new Map<string, [number, number, number, number]>()
  for (const t of loomState.threads) {
    sways.set(threadGroupKey(t.familyNames), [t.freqMult, t.ampMult, t.currentResponse, t.breathRate])
    if (t.totalLines === 0) continue
    const offset = ((Math.floor(t.scroll * 3) % t.totalLines) + t.totalLines) % t.totalLines
    tops.set(threadGroupKey(t.familyNames), offset === 0 ? ZERO_CURSOR : t.lineEndCursors[offset - 1]!)
  }
  refreshLoom()
  for (const t of loomState.threads) {
    const sway = sways.get(threadGroupKey(t.familyNames))
    if (sway) [t.freqMult, t.ampMult, t.currentResponse, t.breathRate] = sway
    // A read line remembers its width so its words hold while the lens opens (render/thread.ts): not across a new face.
    if (t._anchor) { t._anchor.width = 0; t._anchor.prox = -1; continue }
    const top = tops.get(threadGroupKey(t.familyNames))
    if (!top) continue
    // Renumbered, not moved: the wash that rides with the text stays where it is (`_scrollBase`).
    const scroll = scrollForTop(t, top)
    t._scrollBase = (t._scrollBase ?? 0) + (scroll - t.scroll)
    t.scroll = scroll
  }
}

/**
 * A rebuild changed a current's text (a voice arrived, or one left): every index
 * after the change moved. On paper the words on the sheet stay where they are: the
 * line being read keeps its words (its anchor is found again by its words, not its
 * index), and a resting column keeps its top line. Only the text beyond the change
 * makes room for it. The scroll is renumbered, not moved, so the wash that rides
 * with the text does not move either (`_scrollBase`).
 */
function keepWordsInPlace(thread: Thread, old: Thread): void {
  const base = old._scrollBase ?? 0
  const renumber = (scroll: number) => {
    thread._scrollBase = base + (scroll - old.scroll)
    thread.scroll = scroll
  }
  if (old._anchor) {
    const at = placeOf(old, old._anchor.cursor)
    const cursor = at && cursorAt(thread, at)
    if (!cursor) return
    const topAt = placeOf(old, old._anchor.top)
    const top = (topAt && cursorAt(thread, topAt)) ?? cursor
    renumber(scrollForTop(thread, top))
    thread._anchor = { ...old._anchor, cursor, top, scroll: thread.scroll }
    return
  }
  if (old.totalLines === 0 || thread.totalLines === 0) return
  const lines = old.scroll * 3
  const off = ((Math.floor(lines) % old.totalLines) + old.totalLines) % old.totalLines
  const topAt = placeOf(old, off === 0 ? { segmentIndex: 0, graphemeIndex: 0 } : old.lineEndCursors[off - 1]!)
  const top = topAt && cursorAt(thread, topAt)
  if (!top) return
  const index = thread.lineEndCursors.findIndex(end => compareCursors(end, top) > 0)
  if (index >= 0) renumber((index + lines - Math.floor(lines)) / 3)
}
