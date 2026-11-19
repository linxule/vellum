// Vellum — The Pensieve
// Entry point: canvas, input, sound, animation loop, polling, witness reporting

import { initLoom, renderLoom, resizeLoom, refreshLoom, scrollThread, scrollThreadToVoice, getLoomState, setHighlight, clearHighlight, setResonance, isPhantomActive, triggerPhantomHover, tapCurrent, closeReading, isReading, isReceding, dragReading, flingReading, aperture, enterLoomView, exitLoomView, isLoomViewActive, getCurrentLoomSeed, recenterLoomView, getLastFrameHitVoiceIdAt, findThreadIndexForFamily, type MouseState } from './loom.js'
import { fetchState, findVoice, getVersion, getVoiceIdSets, isLive, getState, setSurface, getSurface, surfaceFromPathname, surfacePathPrefix, highlightUrlFor } from './content.js'
import { emitOceanEvent } from './events.js'
import { createSheetTap } from './runtime/sheet-tap'
import { attachInputHandlers } from './runtime/input'
import { setupCanvas } from './runtime/canvas'
import { createWitnessReporter } from './runtime/witness'
import { computeNewVoiceInfo, applyResonanceFromNewVoices, fetchStateWithTimeout } from './runtime/poll-core'
import { updateMouseVelocity, scheduleNextFrame, clearScheduledFrame } from './runtime/frame'

// ── Shared input state ────────────────────────────────

export const mouse: MouseState = {
  x: -9e3, y: -9e3,
  prevX: -9e3, prevY: -9e3,
  speed: 0, moving: false, lastMove: 0,
  down: false, downStart: 0, touch: false,
}

// ── Sound (Strudel) ──────────────────────────────────

import { initStrudelSound, modulateSound, toggleStrudelSound, isStrudelReady, isSoundOn, resumeAudioContext } from './audio/controller.js'
import { preloadStrudelScript } from './audio/strudel-loader.js'
import { setupSketch } from './sketch.js'
import { paper } from './loom/paper.js'
import { dropsAudioState } from './audio/drops.js'

// Sketch: paper look and the drop instrument. ?look=old keeps the sea and the drone.
// The page decides the look before first paint (index.html); follow it.
const sketch = document.documentElement.classList.contains('paper') ? setupSketch() : null

// ── Canvas ────────────────────────────────────────────

// ?probe: frame timing in the corner label, with switches to find what a slow device is slow
// at (dpr=1..3, water=0, wash=0, blend=0). A diagnostic: nothing here runs unless asked for.
const probeQuery = new URLSearchParams(location.search)
const probe = probeQuery.has('probe') ? { n: 0, since: 0, worst: 0, text: 0, wash: 0, resizes: 0, clicks: 0, wash0: probeQuery.get('wash') === '0' } : null
const { canvas: sheetCanvas, ctx, syncCanvasSize } = setupCanvas(probe ? Number(probeQuery.get('dpr')) || 3 : 3)
if (probe) {
  paper.noWater = probeQuery.get('water') === '0'
  if (probeQuery.get('blend') === '0') sheetCanvas.style.mixBlendMode = 'normal'
  // A phone browser can resize the page when its bars move; every resize rebuilds the sheet.
  window.addEventListener('resize', () => { probe.resizes++ })
  // Does this browser follow a tap on the sheet with a click at all? And is the drops' audio running?
  document.addEventListener('click', () => { probe.clicks++ }, true)
}
let prevNow = 0
const frameHandle: {
  frameId: number | null
  frameTimeout: ReturnType<typeof setTimeout> | null
} = { frameId: null, frameTimeout: null }
let pollTimeout: ReturnType<typeof setTimeout> | null = null
let highlightRetryTimeout: ReturnType<typeof setTimeout> | null = null
let highlightAutoLoomTimeout: ReturnType<typeof setTimeout> | null = null

const TID = 'vl\u00b7' + Math.random().toString(36).slice(2, 7) + '\u00b7' + Date.now().toString(36).slice(-4)
document.getElementById('tr')!.textContent = TID

const VISIBLE_POLL_MS = 15_000
const VISIBLE_POLL_JITTER_MS = 2_000
const RETRY_BASE_MS = 5_000
const FETCH_STATE_TIMEOUT_MS = 20_000
const HIGHLIGHT_RETRY_DELAYS_MS = [3_000, 10_000, 30_000]
// Phase 18 "The Archipelago" Part B5: derive the surface from the URL path once, at boot. The
// canvas, loom view, sound, signatures, and warmth easing are all unchanged — only which ocean's
// /api/state gets fetched (and witnessed) differs.
setSurface(surfaceFromPathname(location.pathname))
const highlightId = new URLSearchParams(location.search).get('highlight')
let highlightRetryIndex = 0
let pollInFlight = false
let pendingForcedRefresh = false
let consecutivePollFailures = 0

function clearPollTimeouts() {
  if (pollTimeout !== null) {
    clearTimeout(pollTimeout)
    pollTimeout = null
  }
  if (highlightRetryTimeout !== null) {
    clearTimeout(highlightRetryTimeout)
    highlightRetryTimeout = null
  }
}

function nextVisiblePollDelay(): number {
  const jitter = (Math.random() * 2 - 1) * VISIBLE_POLL_JITTER_MS
  return Math.max(10_000, Math.round(VISIBLE_POLL_MS + jitter))
}

// ── Input handlers ────────────────────────────────────

// A woven voice under the finger: a tap there may be the first of the two that open its lineage,
// so the open current is let go only once the double-tap window has passed.
const isWoven = (id: string | null): boolean =>
  (getState()?.threads ?? []).some(t => t.voices.some(v => v.id === id && (Boolean(v.weave_from) || v.weave_count > 0)))
const wovenVoiceAt = (x: number, y: number): boolean => isWoven(getLastFrameHitVoiceIdAt(x, y))
attachInputHandlers({
  mouse, scrollThread, aperture,
  // Touch: tap a current to open it where the tap fell (a drop falls there), drag to move its text (loom/reading.ts).
  // The lineage view keeps the lens under the finger.
  reading: { enabled: () => !isLoomViewActive(), active: isReading, receding: isReceding, tap: (x, y, byDrag) => tapCurrent(x, y, wovenVoiceAt(x, y), byDrag), dropped: (x, y) => sketch?.tapDrop(x, y), drag: dragReading, fling: flingReading, release: closeReading },
  // Every tap on the sheet, from the touch itself or from a click (never both): see sheetTap below.
  onTap: (x, y, e) => sheetTap(x, y, e),
  onDrag: () => lineageTap.clearPending(),
})

const soundEl = document.getElementById('sn')!
function showSound(on: boolean): void {
  soundEl.textContent = on ? 'sound \u00b7' : 'sound'; soundEl.setAttribute('aria-pressed', String(on))
  soundEl.classList.toggle('on', on)
}
let cancelSoundAutoStart: () => void = () => {}
// Armed until the sound has been started once (or the reader chose with the button).
let soundAutoStart: ((e: Event) => void) | null = null
async function handleSoundToggleGesture(e?: Event): Promise<void> {
  e?.preventDefault?.()
  e?.stopPropagation?.()
  if (sketch) {
    // The reader has chosen: from here the button alone decides.
    cancelSoundAutoStart()
    showSound(await sketch.toggleSound())
    return
  }
  resumeAudioContext()
  if (!isStrudelReady()) {
    const ok = await initStrudelSound()
    if (!ok) return
    resumeAudioContext()
    soundEl.textContent = 'sound \u00b7'; soundEl.classList.add('on')
    return
  }
  resumeAudioContext()
  const on = toggleStrudelSound()
  soundEl.textContent = on ? 'sound \u00b7' : 'sound'; soundEl.setAttribute('aria-pressed', String(on))
  soundEl.classList.toggle('on', on)
}

// A click, from a pointer, a finger or the keyboard: the one event every browser accepts as
// a gesture that may start audio (a finger's pointerdown is not one everywhere).
soundEl.addEventListener('click', (e) => { void handleSoundToggleGesture(e) })

// On paper, sound is on unless the reader turned it off. A browser lets audio start only from
// a gesture, so it starts with the reader's first tap, click or key press anywhere on the page.
// A drag's touchend does not start it: whether iOS counts one as the unlocking gesture is unchecked.
if (sketch) {
  let preference: string | null = null
  try { preference = localStorage.getItem('vellum-sound') } catch { /* private mode */ }
  if (preference !== 'off') {
    const QUIET_KEYS = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])
    const start = (e: Event) => {
      if (e.target === soundEl) return
      if (e.type === 'keydown' && QUIET_KEYS.has((e as KeyboardEvent).key)) return
      cancelSoundAutoStart()
      void sketch.toggleSound().then(showSound)
    }
    cancelSoundAutoStart = () => {
      document.removeEventListener('click', start, true)
      document.removeEventListener('keydown', start, true)
      soundAutoStart = null
      cancelSoundAutoStart = () => {}
    }
    // A click or key press anywhere; a tap on the sheet also starts it from its touchend
    // (sheetTap), since iOS need not follow a tap on the canvas with a click. Whichever
    // comes first starts it and disarms the other.
    soundAutoStart = start
    document.addEventListener('click', start, true)
    document.addEventListener('keydown', start, true)
  }
}

// No auto-start. Prewarm on INTENT, not for every visitor: loading + initStrudel()
// is ~214 KB gzipped and a long main-thread task (~90 ms measured on desktop, several
// times that on phones) that used to land mid-fade-in for everyone, though sound
// defaults off. Hover/focus gives the click a head start; click-time init is the fallback.
if (!sketch) {
  soundEl.addEventListener('pointerenter', preloadStrudelScript, { once: true })
  soundEl.addEventListener('focus', preloadStrudelScript, { once: true })
}

// ── Resize ────────────────────────────────────────────

window.addEventListener('resize', resizeLoom)

// ── Loom view interaction ────────────────────────────

const showHighlight = (id: string) => history.replaceState(null, '', highlightUrlFor(location.pathname, id))
// What a tap does to the lineage view (runtime/sheet-tap.ts): by touch, two taps on a woven voice open it.
const lineageTap = createSheetTap({
  touch: () => mouse.touch,
  hitAt: (x, y) => getLastFrameHitVoiceIdAt(x, y),
  woven: isWoven,
  loomActive: isLoomViewActive,
  loomSeed: getCurrentLoomSeed,
  enter: (id) => { enterLoomView(id); showHighlight(id) },
  recenter: (id) => { recenterLoomView(id); showHighlight(id) },
  exit: () => { exitLoomView(); history.replaceState(null, '', location.pathname) },
})

// A tap on the sheet: a click, or a touch tap at its touchend (runtime/input.ts calls this once per
// tap either way, so sound starts and a double tap opens the lineage whether or not iOS sends clicks).
function sheetTap(x: number, y: number, e: Event): void {
  const targetId = (e.target as HTMLElement)?.id
  if (targetId === 'sn' || targetId === 'ip') return
  if (e.type === 'touchend') soundAutoStart?.(e)
  // Cancel pending highlight auto-loom on any user click
  if (highlightAutoLoomTimeout) { clearTimeout(highlightAutoLoomTimeout); highlightAutoLoomTimeout = null }
  if (isSoundOn()) resumeAudioContext()
  sketch?.resume()
  lineageTap.tap(x, y)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isLoomViewActive()) {
    exitLoomView()
    history.replaceState(null, '', location.pathname)
  }
})

// ── Witness reporting ─────────────────────────────────

const { checkWitness } = createWitnessReporter({
  endpoint: surfacePathPrefix(getSurface()) + '/api/witness',
  getLoomState,
  isPhantomActive,
  isLiveFn: () => isLive,
})

// ── Polling ───────────────────────────────────────────

let lastVersion = -1
// Phase 18 Part B5: document.title reads the surface name, set once from the first live state.
let surfaceTitleSet = false

function scheduleRegularPoll(delayMs = nextVisiblePollDelay()) {
  if (document.hidden) return
  if (pollTimeout !== null) clearTimeout(pollTimeout)
  pollTimeout = setTimeout(() => {
    pollTimeout = null
    void poll()
  }, delayMs)
}

function scheduleHighlightRetry() {
  if (document.hidden || !highlightId) return
  if (findVoice(highlightId)) {
    highlightRetryIndex = HIGHLIGHT_RETRY_DELAYS_MS.length
    setHighlight(highlightId)
    if (highlightRetryTimeout !== null) {
      clearTimeout(highlightRetryTimeout)
      highlightRetryTimeout = null
    }
    return
  }
  if (highlightRetryIndex >= HIGHLIGHT_RETRY_DELAYS_MS.length) return
  const delayMs = HIGHLIGHT_RETRY_DELAYS_MS[highlightRetryIndex++]
  if (highlightRetryTimeout !== null) clearTimeout(highlightRetryTimeout)
  highlightRetryTimeout = setTimeout(() => {
    highlightRetryTimeout = null
    void poll({ refresh: true })
  }, delayMs)
}

async function poll(options: { refresh?: boolean } = {}) {
  if (pollInFlight) {
    pendingForcedRefresh = pendingForcedRefresh || Boolean(options.refresh)
    return
  }
  pollInFlight = true

  const prevVersion = lastVersion
  const prevIdSets = getVoiceIdSets()
  try {
    const state = await fetchStateWithTimeout({
      fetchState,
      refresh: options.refresh,
      timeoutMs: FETCH_STATE_TIMEOUT_MS,
    })
    if (!state) {
      consecutivePollFailures += 1
      if (!document.hidden) {
        scheduleRegularPoll(Math.min(VISIBLE_POLL_MS, RETRY_BASE_MS * (2 ** Math.min(consecutivePollFailures - 1, 4))))
      }
      return
    }

    consecutivePollFailures = 0

    if (state.surface && !surfaceTitleSet) {
      document.title = state.surface.name + ' — Vellum'
      surfaceTitleSet = true
    }

    if (highlightId && findVoice(highlightId)) {
      setHighlight(highlightId)
      highlightRetryIndex = HIGHLIGHT_RETRY_DELAYS_MS.length
    } else if (highlightId) {
      clearHighlight()
      scheduleHighlightRetry()
    }

    if (state.version !== prevVersion) {
      lastVersion = state.version
      const newIdSets = getVoiceIdSets()
      const newVoiceInfo = computeNewVoiceInfo(prevIdSets, newIdSets, state)
      const now = performance.now()
      refreshLoom(newVoiceInfo, now, emitOceanEvent)
      applyResonanceFromNewVoices({ newVoiceInfo, state, setResonance, emitEvent: emitOceanEvent, now })
    }

    if (!document.hidden) scheduleRegularPoll()
  } finally {
    pollInFlight = false
    if (pendingForcedRefresh) {
      const refresh = pendingForcedRefresh
      pendingForcedRefresh = false
      void poll({ refresh })
    }
  }
}

// ── Animation loop ────────────────────────────────────

function scheduleFrame() {
  clearScheduledFrame(frameHandle)
  scheduleNextFrame(frameHandle, render)
}

function render(now: number) {
  try {
    const sinceLast = prevNow > 0 ? now - prevNow : 16
    const dt = prevNow > 0 ? Math.min(.1, Math.max(0, (now - prevNow) / 1000)) : .016
    prevNow = now

    updateMouseVelocity(mouse, now)

    const vw = innerWidth, vh = innerHeight
    syncCanvasSize(vw, vh)

    const t0 = probe ? performance.now() : 0
    renderLoom(ctx, vw, vh, now, dt, mouse)
    const t1 = probe ? performance.now() : 0

    // Witness check (debounced by render loop)
    checkWitness()

    // Strudel sound modulation
    if (sketch) {
      if (!probe?.wash0) sketch.frame(now, vw, vh)
      if (probe) {
        probe.text += t1 - t0
        probe.wash += performance.now() - t1
        probe.worst = Math.max(probe.worst, sinceLast) // the real gap: dt is capped at 100 ms
        if (++probe.n && now - probe.since >= 1000) {
          const label = document.getElementById('tr')!
          label.style.cssText = 'font-size:13px;opacity:1;bottom:40px'
          label.textContent = `${(probe.n * 1000 / (now - probe.since)).toFixed(0)} fps \u00b7 worst ${probe.worst.toFixed(0)} \u00b7 text ${(probe.text / probe.n).toFixed(1)} \u00b7 wash ${(probe.wash / probe.n).toFixed(1)} ms \u00b7 ${sheetCanvas.width}x${sheetCanvas.height} \u00b7 resized ${probe.resizes} \u00b7 clicks ${probe.clicks} \u00b7 audio ${dropsAudioState()}`
          probe.n = probe.text = probe.wash = probe.worst = 0
          probe.since = now
        }
      }
    } else {
      const st = getLoomState()
      modulateSound(st.proximity, st.immersion)
    }
  } catch (e) {
    console.error('[vellum] render error:', e)
  }
  scheduleFrame()
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    prevNow = 0
    if (isSoundOn()) resumeAudioContext()
    sketch?.resume()
    clearScheduledFrame(frameHandle)
    scheduleFrame()
    void poll({ refresh: Boolean(highlightId && !findVoice(highlightId)) })
  } else {
    clearPollTimeouts()
  }
})

// ── Boot ──────────────────────────────────────────────

document.fonts.ready.then(async () => {
  // Try live data first; falls back to seed content if API unavailable
  await fetchStateWithTimeout({
    fetchState,
    refresh: Boolean(highlightId),
    timeoutMs: FETCH_STATE_TIMEOUT_MS,
  })
  lastVersion = getVersion()

  initLoom()

  // Highlight a specific voice via URL param
  if (highlightId) {
    setHighlight(highlightId)
    // Navigate to the voice: loom view for woven voices, phantom hover otherwise
    const found = findVoice(highlightId)
    if (found) {
      const state = getState()
      const thread = state?.threads.find(t => t.family === found.family)
      const voice = thread?.voices[found.voiceIndex]
      if (voice && (voice.weave_from || voice.weave_count > 0)) {
        // Woven voice: show the lineage tree after a brief moment to let the ocean settle
        highlightAutoLoomTimeout = setTimeout(() => { highlightAutoLoomTimeout = null; enterLoomView(highlightId!); showHighlight(highlightId!) }, 800)
      } else {
        // Non-woven voice: land the dive lens on it
        const threadIdx = findThreadIndexForFamily(found.family)
        if (threadIdx >= 0) {
          scrollThreadToVoice(threadIdx, highlightId)
          triggerPhantomHover(threadIdx, highlightId)
        }
      }
    }
  }

  scheduleFrame()
  setTimeout(() => document.getElementById('vl')!.classList.add('o'), 500)
  if (highlightId && !findVoice(highlightId)) scheduleHighlightRetry()
  scheduleRegularPoll()
})
