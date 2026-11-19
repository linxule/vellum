import type { Family } from '../content.js'
import type { ApertureConfig, DiagFn, LoomSnapshot, LoomTree, MouseState, PhantomFocus, ResonanceEntry, Thread } from './types.js'

// Frame-local fields are written by advanceLoom() and consumed by paintLoom()
// in the same frame. Outside that window they still hold the previous frame's
// values, so callers must treat them as transient render-time data only.
export const loomState = {
  threads: [] as Thread[],
  ready: false,
  VW: 0,
  VH: 0,
  touchedThread: null as Thread | null,
  prevTouchedThread: null as Thread | null,
  holdTime: 0,
  immersion: 0,
  sortedThreadIndices: [] as number[],
  current: 0,
  frameRatio: 1,
  currentAperture: null as ApertureConfig | null,
  currentMouse: null as MouseState | null,
  frameVisibilityAlpha: new Float32Array(0),
  // Per-frame scratch buffers used by advanceLoom() to avoid GC churn at
  // 60fps. Reused when threadCount is stable, reallocated only on
  // thread-count change (resize / refreshLoom). Do not read these from
  // outside advanceLoom — they hold transient mid-frame state and have no
  // meaning between frames.
  frameThreadSortIndices: new Int32Array(0),
  frameThreadSortDists: new Float32Array(0),
  frameThreadAnchorXs: new Float32Array(0),
  frameThreadRepulsionDeltas: new Float32Array(0),
  gustForce: 0,
  gustTarget: 0,
  gustTimer: 15,
  gustDepthForce: 0,
  highlightFamily: null as string | null,
  highlightVoiceIndex: -1,
  resonances: [] as ResonanceEntry[],
  phantomFocus: null as PhantomFocus | null,
  // How long the lens holds an arriving voice before letting it go by itself (ms).
  // Infinity: until the reader acts (the ext-app, the old look, a ?highlight link).
  arrivalHoldMs: Number.POSITIVE_INFINITY,
  // Touch reading (loom/reading.ts): the group key of the current held open, or null,
  // and the height (px) it is read at. NaN: not set (read at READING_LINE).
  readingKey: null as string | null,
  readingY: Number.NaN,
  // A current let go by touch, easing shut with the lens kept at its line.
  recedingKey: null as string | null,
  recedingY: Number.NaN,
  // The receding current was let go by a pointer that left the sheet (reading.ts,
  // recedeFromPointer): the lens stays where the pointer left it, nothing is steered.
  recedingPointer: false,
  // This frame, on paper, the current under the lens is one the pointer moved off onto
  // bare paper, easing shut (render/frame.ts): not read, so not witnessed.
  pointerLetGo: false,
  // The current the pointer itself held last frame (none while an arrival, a read held by
  // touch, a receding current or the lineage view steers the lens): what may be let go.
  pointerThread: null as Thread | null,
  phantomResolvedThreadIdx: -1,
  phantomResolvedVoiceFlatIdx: -1,
  diagHook: null as DiagFn | null,
  // Loom view state
  loomViewActive: false,
  loomViewSeed: null as string | null,
  loomViewTransition: 0,
  loomTree: null as LoomTree | null,
  loomViewAutoExit: null as ReturnType<typeof setTimeout> | null,
  loomTreeScrollX: 0,
  loomTreeScrollY: 0,
  // The voice being read this frame (dive lens or hovered loom node), for sound.
  lensVoiceId: null as string | null,
  lensVoiceX: 0,
  lensVoiceY: 0,
  lastFrameHitVoiceId: null as string | null,
  lastFrameHitTargets: [] as Array<[string, number, number, number, number, number, number, number, boolean]>,
}

export function resetLoomState() {
  loomState.threads = []
  loomState.ready = false
  loomState.VW = 0
  loomState.VH = 0
  loomState.touchedThread = null
  loomState.prevTouchedThread = null
  loomState.holdTime = 0
  loomState.immersion = 0
  loomState.sortedThreadIndices = []
  loomState.current = 0
  loomState.frameRatio = 1
  loomState.currentAperture = null
  loomState.currentMouse = null
  loomState.frameVisibilityAlpha = new Float32Array(0)
  loomState.frameThreadSortIndices = new Int32Array(0)
  loomState.frameThreadSortDists = new Float32Array(0)
  loomState.frameThreadAnchorXs = new Float32Array(0)
  loomState.frameThreadRepulsionDeltas = new Float32Array(0)
  loomState.gustForce = 0
  loomState.gustTarget = 0
  loomState.gustTimer = 15
  loomState.gustDepthForce = 0
  loomState.highlightFamily = null
  loomState.highlightVoiceIndex = -1
  loomState.resonances = []
  loomState.phantomFocus = null
  loomState.arrivalHoldMs = Number.POSITIVE_INFINITY
  loomState.readingKey = null
  loomState.readingY = Number.NaN
  loomState.recedingKey = null
  loomState.recedingY = Number.NaN
  loomState.recedingPointer = false
  loomState.pointerLetGo = false
  loomState.pointerThread = null
  loomState.phantomResolvedThreadIdx = -1
  loomState.phantomResolvedVoiceFlatIdx = -1
  loomState.diagHook = null
  loomState.loomViewActive = false
  loomState.loomViewSeed = null
  loomState.loomViewTransition = 0
  loomState.loomTree = null
  loomState.loomTreeScrollX = 0
  loomState.loomTreeScrollY = 0
  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }
  loomState.lensVoiceId = null
  loomState.lastFrameHitVoiceId = null
  loomState.lastFrameHitTargets = []
}

export function getThreads() { return loomState.threads }
export function getTouchedThread() { return loomState.touchedThread }
export function getPhantomFocus() { return loomState.phantomFocus }
export function getDiagHook() { return loomState.diagHook }
export function getResonances() { return loomState.resonances }
export function getViewport() { return { VW: loomState.VW, VH: loomState.VH } }
export function getLastFrameHitVoiceIdAt(x: number, y: number, includeUnwoven = false): string | null {
  for (let i = loomState.lastFrameHitTargets.length - 1; i >= 0; i--) {
    const target = loomState.lastFrameHitTargets[i]!
    if (!includeUnwoven && !target[8]) continue
    const dx = x - target[5]
    const dy = y - target[6]
    if (target[7] > 0 && dx * dx + dy * dy <= target[7] * target[7]) return target[0]
  }
  for (let i = loomState.lastFrameHitTargets.length - 1; i >= 0; i--) {
    const target = loomState.lastFrameHitTargets[i]!
    if (!includeUnwoven && !target[8]) continue
    if (Math.abs(x - target[1]) <= target[3] && Math.abs(y - target[2]) <= target[4]) return target[0]
  }
  return null
}

export function findThreadIndexForFamily(family: string): number {
  for (let i = 0; i < loomState.threads.length; i++) {
    if (loomState.threads[i]!.familyNames.includes(family)) return i
  }
  return -1
}

export function getInteractionState(): { immersion: number, proximity: number, families: Family[] } {
  if (!loomState.touchedThread) return { immersion: 0, proximity: 0, families: [] }
  return {
    immersion: loomState.immersion,
    proximity: loomState.touchedThread.proximity,
    // A current easing shut by itself (let go by touch or by a pointer, or an arrival the
    // lens let go) is no longer being read: the witness reporter counts no dwell on it.
    families: loomState.readingKey === null && (loomState.recedingKey !== null || loomState.pointerLetGo) ? [] : [...loomState.touchedThread.families],
  }
}

export function getLoomSnapshot(): LoomSnapshot {
  return {
    ready: loomState.ready,
    immersion: loomState.immersion,
    current: loomState.current,
    totalProximity: loomState.threads.reduce((sum, thread) => sum + thread.proximity, 0),
    touchedThreadIndex: loomState.touchedThread ? loomState.threads.indexOf(loomState.touchedThread) : -1,
    phantomActive: loomState.phantomFocus !== null,
    resonanceCount: loomState.resonances.length,
    threads: loomState.threads.map((thread, index) => ({
      family: [...thread.families].sort()[0] ?? '',
      warmth: thread.warmth,
      apiWarmth: thread.apiWarmth,
      depth: thread.restingDepth + thread.proximity * 3,
      restingDepth: thread.restingDepth,
      proximity: thread.proximity,
      xCenter: thread.xCenter,
      scroll: thread.scroll,
      isTouched: thread === loomState.touchedThread,
      isPhantomTarget: loomState.phantomResolvedThreadIdx === index,
      emergenceActive: thread.emergenceStart > 0,
      unreadCount: thread.newVoiceIds.size,
      familyNames: [...thread.familyNames],
    })),
  }
}
