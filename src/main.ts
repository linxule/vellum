// Vellum — The Pensieve
// Entry point: canvas, input, sound, animation loop, polling, witness reporting

import { initLoom, renderLoom, resizeLoom, refreshLoom, scrollThread, scrollThreadToVoice, getLoomState, setHighlight, clearHighlight, setResonance, isPhantomActive, triggerPhantomHover, aperture, enterLoomView, exitLoomView, isLoomViewActive, getCurrentLoomSeed, recenterLoomView, getLastFrameHitVoiceIdAt, findThreadIndexForFamily, type MouseState } from './loom.js'
import { fetchState, findVoice, getVersion, getVoiceIdSets, isLive, getState } from './content.js'
import { emitOceanEvent } from './events.js'
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

// ── Canvas ────────────────────────────────────────────

const { ctx, syncCanvasSize } = setupCanvas()
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

const VISIBLE_POLL_MS = 120_000
const VISIBLE_POLL_JITTER_MS = 10_000
const RETRY_BASE_MS = 5_000
const FETCH_STATE_TIMEOUT_MS = 20_000
const HIGHLIGHT_RETRY_DELAYS_MS = [3_000, 10_000, 30_000]
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
  return Math.max(30_000, Math.round(VISIBLE_POLL_MS + jitter))
}

// ── Input handlers ────────────────────────────────────

attachInputHandlers({ mouse, scrollThread, aperture })

const soundEl = document.getElementById('sn')!
async function handleSoundToggleGesture(e?: Event): Promise<void> {
  e?.preventDefault?.()
  e?.stopPropagation?.()
  resumeAudioContext()
  if (!isStrudelReady()) {
    const ok = await initStrudelSound()
    if (!ok) return
    resumeAudioContext()
    soundEl.textContent = 'sound \u00b7'; soundEl.style.opacity = '.7'
    return
  }
  resumeAudioContext()
  const on = toggleStrudelSound()
  soundEl.textContent = on ? 'sound \u00b7' : 'sound'
  soundEl.style.opacity = on ? '.7' : '.3'
}

soundEl.addEventListener('pointerdown', (e) => { void handleSoundToggleGesture(e) })

// No auto-start — initStrudel() blocks the main thread for ~1s.
// Sound starts only on explicit sound button gesture.
setTimeout(preloadStrudelScript, 1500)

// ── Resize ────────────────────────────────────────────

window.addEventListener('resize', resizeLoom)

// ── Loom view interaction ────────────────────────────

// Double-tap gating for touch: first tap shows dive lens, second tap enters loom view
let pendingTouchLoomId: string | null = null
let pendingTouchLoomTimer: ReturnType<typeof setTimeout> | null = null

document.addEventListener('click', (e) => {
  const targetId = (e.target as HTMLElement)?.id
  if (targetId === 'sn' || targetId === 'ip') return
  // Cancel pending highlight auto-loom on any user click
  if (highlightAutoLoomTimeout) { clearTimeout(highlightAutoLoomTimeout); highlightAutoLoomTimeout = null }
  if (isSoundOn()) resumeAudioContext()
  const hitId = getLastFrameHitVoiceIdAt(e.clientX, e.clientY)
  if (isLoomViewActive()) {
    if (hitId && hitId !== getCurrentLoomSeed()) {
      recenterLoomView(hitId)
      history.replaceState(null, '', '?highlight=' + hitId)
    } else if (!hitId) {
      // Exit only on blank space tap — tapping the seed node does nothing
      exitLoomView()
      history.replaceState(null, '', location.pathname)
    }
    return
  }
  if (hitId) {
    const state = getState()
    if (state) {
      for (const thread of state.threads) {
        const voice = thread.voices.find(v => v.id === hitId)
        if (voice && (voice.weave_from || voice.weave_count > 0)) {
          // Touch: require double-tap (first tap = hover, second tap = enter)
          if (mouse.touch) {
            if (pendingTouchLoomId === hitId) {
              enterLoomView(hitId)
              history.replaceState(null, '', '?highlight=' + hitId)
              pendingTouchLoomId = null
              if (pendingTouchLoomTimer) { clearTimeout(pendingTouchLoomTimer); pendingTouchLoomTimer = null }
            } else {
              pendingTouchLoomId = hitId
              if (pendingTouchLoomTimer) clearTimeout(pendingTouchLoomTimer)
              pendingTouchLoomTimer = setTimeout(() => { pendingTouchLoomId = null; pendingTouchLoomTimer = null }, 800)
            }
          } else {
            enterLoomView(hitId)
            history.replaceState(null, '', '?highlight=' + hitId)
          }
          break
        }
      }
    }
  } else {
    // Tapped elsewhere — clear pending
    pendingTouchLoomId = null
    if (pendingTouchLoomTimer) { clearTimeout(pendingTouchLoomTimer); pendingTouchLoomTimer = null }
  }
})

// Scroll/drag cancels pending double-tap
document.addEventListener('touchmove', () => {
  if (pendingTouchLoomId !== null) {
    pendingTouchLoomId = null
    if (pendingTouchLoomTimer) { clearTimeout(pendingTouchLoomTimer); pendingTouchLoomTimer = null }
  }
}, { passive: true })

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isLoomViewActive()) {
    exitLoomView()
    history.replaceState(null, '', location.pathname)
  }
})

// ── Witness reporting ─────────────────────────────────

const { checkWitness } = createWitnessReporter({
  endpoint: '/api/witness',
  getLoomState,
  isPhantomActive,
  isLiveFn: () => isLive,
})

// ── Polling ───────────────────────────────────────────

let lastVersion = -1

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
      const newVoiceInfo = computeNewVoiceInfo(prevIdSets, newIdSets)
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
    const dt = prevNow > 0 ? Math.min(.1, Math.max(0, (now - prevNow) / 1000)) : .016
    prevNow = now

    updateMouseVelocity(mouse, now)

    const vw = innerWidth, vh = innerHeight
    syncCanvasSize(vw, vh)

    renderLoom(ctx, vw, vh, now, dt, mouse)

    // Witness check (debounced by render loop)
    checkWitness()

    // Strudel sound modulation
    const st = getLoomState()
    modulateSound(st.proximity, st.immersion)
  } catch (e) {
    console.error('[vellum] render error:', e)
  }
  scheduleFrame()
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    prevNow = 0
    if (isSoundOn()) resumeAudioContext()
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
        highlightAutoLoomTimeout = setTimeout(() => { highlightAutoLoomTimeout = null; enterLoomView(highlightId!); history.replaceState(null, '', '?highlight=' + highlightId) }, 800)
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
