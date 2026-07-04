import { beforeEach, test } from 'bun:test'
import {
  getLoomState,
  initLoom,
  isPhantomActive,
  refreshLoom,
  renderLoom,
  setDiagHook,
} from '../../src/loom.js'
import { scrollThreadToVoice } from '../../src/loom/scroll.js'
import { getPhantomFocus, getThreads, getTouchedThread, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, maxFontSizeForText, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('Zero-path bootstrap', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY ', depth: 0.4 }] },
  ], 61))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 5)

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION ', depth: 0.5 }] },
    {
      family: 'memory',
      voices: [
        { id: 'm0', text: 'MEMORY ', depth: 0.4 },
        { id: 'm1', text: 'FRESH ', depth: 0.01 },
      ],
    },
  ], 62))
  withFixedRandom(0.5, () => refreshLoom([{ hasNew: false, newIds: new Set() }, { hasNew: true, newIds: new Set(['m1']) }], 80))
  renderLoom(ctx, innerWidth, innerHeight, 96, 0.016, mouse as any)

  const phantomFocus = getPhantomFocus()
  if (!phantomFocus) throw new Error('expected phantom focus to be active after refresh')
  if (getTouchedThread() !== getThreads()[1]) throw new Error('expected touchedThread to be the phantom target after the first render frame')
  if (getThreads()[1] !== getTouchedThread()) throw new Error('expected the target thread to become primary immediately after zero-path bootstrap')
})

test('mouse.x > 0 sentinel trap', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'ATTN ', depth: 0.5 }] }], 63))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  thread._path = Array.from({ length: 61 }, (_, i) => ({ x: 0, y: i * (innerHeight / 60) }))
  mouse.x = 0
  mouse.y = 100
  renderLoom(ctx, innerWidth, innerHeight, 16, 0.016, mouse as any)
  if (getTouchedThread() !== thread) throw new Error('expected touch scan to run for mouse.x = 0, but no thread was touched')
})

test('_handDist sparse sampling', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'ATTN ', depth: 0.5 }] }], 64))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  thread._path = Array.from({ length: 61 }, (_, i) => ({ x: 240 + Math.sin(i / 10) * 5, y: i * (innerHeight / 60) }))
  mouse.x = 240
  mouse.y = innerHeight * 0.54
  renderLoom(ctx, innerWidth, innerHeight, 16, 0.016, mouse as any)
  if (thread._handDist > 140) throw new Error(`expected 13-sample hand distance to stay within touch radius, but got ${thread._handDist}`)
})

test('Scroll quantization in nudge path stays within reference tolerance', async () => {
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'ALPHA '.repeat(50), depth: 0.5 }, { id: 'a1', text: 'BETA '.repeat(50), depth: 0.2 }] }], 65))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  const before = thread.scroll
  scrollThreadToVoice(0, 'a1')
  const deltaLines = Math.abs((thread.scroll - before) * 3)
  if (deltaLines > thread.totalLines + 2) throw new Error(`expected scroll walk to stay within +/-2 lines of a sane reference, but shifted ${deltaLines} lines across ${thread.totalLines}`)
})

test('Phantom -> dive activation on fresh voice', async () => {
  installViewport(960, 640)

  // Use a unique marker character that does not appear in the other voices' text.
  // drawLineSegmented emits one fillText call per grapheme when breakableWidths is
  // populated, so a multi-character marker like "FRESHVOICEGLYPH" would never match
  // `call.text.includes(...)` in the segmented path. Single-char marker survives.
  const FRESH_MARK = 'Ω'
  const freshText = (FRESH_MARK + ' ').repeat(120)

  const initialState = makeState([
    {
      family: 'attention',
      voices: [
        { id: 'attention-0', depth: 0.8, text: 'ATTENTION THREAD ANCHOR carries the left current. ' },
      ],
    },
    {
      family: 'memory',
      voices: [
        { id: 'memory-0', depth: 0.7, text: 'MEMORY THREAD OLDER VOICE keeps the shelf warm. ' },
        { id: 'memory-1', depth: 0.5, text: 'MEMORY THREAD SECOND VOICE keeps the rhythm steady. ' },
      ],
    },
  ], 1)

  const nextState = makeState([
    {
      family: 'attention',
      voices: [
        { id: 'attention-0', depth: 0.8, text: 'ATTENTION THREAD ANCHOR carries the left current. ' },
      ],
    },
    {
      family: 'memory',
      voices: [
        { id: 'memory-0', depth: 0.7, text: 'MEMORY THREAD OLDER VOICE keeps the shelf warm. ' },
        { id: 'memory-1', depth: 0.5, text: 'MEMORY THREAD SECOND VOICE keeps the rhythm steady. ' },
        { id: 'memory-fresh', depth: 0.01, text: freshText },
      ],
    },
  ], 2)

  const mouse = makeMouse()
  const ctx = createCanvasContext()
  const diag: Array<{ event: string, payload?: Record<string, unknown> }> = []
  setDiagHook((event, payload) => {
    diag.push({ event, payload })
  })

  await loadState(initialState)

  let now = 0
  withFixedRandom(0.5, () => {
    initLoom()
    now = runFrames(renderLoom, ctx, mouse, 5, now)
  })

  await loadState(nextState)

  withFixedRandom(0.5, () => {
    refreshLoom([
      { hasNew: false, newIds: new Set() },
      { hasNew: true, newIds: new Set(['memory-fresh']) },
    ], now)
    // 60 frames @ 16ms = ~960ms of simulated render time.
    //   - proximity ramp: 1 - (1-0.022)^60 ≈ 0.74, comfortably above the 0.5 threshold
    //   - emergence alpha: elapsed ≈ 0.96s, lineProgress > 0 once stagger clears
    //   - enough phantom settle time for the dive lens to reach full opening
    now = runFrames(renderLoom, ctx, mouse, 60, now)
  })

  const triggerEvents = diag.filter(entry => entry.event === 'phantom-trigger')
  const triggerEvent = triggerEvents[0]
  const captureEvents = diag.filter(entry => entry.event === 'phantom-capture')
  const trackEvents = diag.filter(entry => entry.event === 'phantom-track')
  const loomState = getLoomState()
  const maxFreshFont = maxFontSizeForText(ctx, FRESH_MARK)
  const failures: string[] = []

  if (!isPhantomActive()) {
    failures.push('expected phantomFocus to remain active after refresh + 60 frames, but `isPhantomActive()` returned false')
  }

  // Exactly one phantom trigger — refreshLoom fires on new-voice arrival
  if (triggerEvents.length !== 1) {
    failures.push(`expected exactly 1 'phantom-trigger' event from refreshLoom, got ${triggerEvents.length}`)
  }

  // Trigger targeted the memory thread (index 1) with the fresh voice
  const triggerThreadIdx = Number(triggerEvent?.payload?.threadIdx ?? -1)
  if (triggerThreadIdx !== 1) {
    failures.push(`expected phantom-trigger payload.threadIdx === 1 (memory thread), got ${triggerThreadIdx}`)
  }
  if (triggerEvent?.payload?.voiceId !== 'memory-fresh') {
    failures.push(`expected phantom-trigger payload.voiceId === 'memory-fresh', got ${String(triggerEvent?.payload?.voiceId)}`)
  }
  const voiceFlatIdx = Number(triggerEvent?.payload?.voiceFlatIdx ?? -1)
  if (!(voiceFlatIdx >= 0)) {
    failures.push(`expected phantom trigger to resolve the fresh voice to a flat index >= 0, but got ${String(triggerEvent?.payload?.voiceFlatIdx)}`)
  }

  const families = new Set(loomState.families)
  if (!(families.size === 1 && families.has('memory'))) {
    failures.push(`expected touchedThread to resolve to the target memory thread, but getLoomState().families was "${loomState.families.join(',') || '(empty)'}"`)
  }

  if (!(loomState.proximity > 0.5)) {
    failures.push(`expected touchedThread.proximity > 0.5 on the fresh-voice target, but got ${loomState.proximity}`)
  }

  // Capture / track counts are bounded by render/thread.ts gates `diagFrames < 8`
  // and `diagFrames < 3`. drivePhantomHover post-increments diagFrames each frame,
  // so at paint time diagFrames is the POST-frame count. Over 60 frames the gates
  // fire on frames 0..6 (capture) and 0..1 (track) for 7 captures and 2 tracks.
  // If the phantom never tracks its target, both counts are 0 — the strong signal
  // that the phantom-target line couldn't be found in the line-layout walk.
  if (captureEvents.length !== 7) {
    failures.push(`expected exactly 7 'phantom-capture' events, got ${captureEvents.length}`)
  }
  if (trackEvents.length !== 2) {
    failures.push(`expected exactly 2 'phantom-track' events, got ${trackEvents.length}`)
  }

  if (!(maxFreshFont >= 11)) {
    failures.push(`expected the target fresh-voice line to open into the dive lens (estimated diveT > 0.3 via font size >= 11px), but the maximum rendered font size for the '${FRESH_MARK}' marker was ${maxFreshFont}px`)
  }

  setDiagHook(null)

  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
})
