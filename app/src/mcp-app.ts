// Vellum — Ext-App Entry Point
// Embeds the Pensieve renderer in AI conversations via ext-apps protocol.
// Dual-mode: iframe (SDK) or standalone (URL param highlight).

import { App } from '@modelcontextprotocol/ext-apps'
import { initLoom, renderLoom, resizeLoom, refreshLoom, scrollThread, getLoomState, setHighlight, clearHighlight, setResonance, isPhantomActive, aperture, enterLoomView, exitLoomView, isLoomViewActive, getCurrentLoomSeed, recenterLoomView, getLastFrameHitVoiceIdAt, type MouseState } from '../../src/loom.js'
import { fetchState, findVoice, getVersion, getVoiceIdSets, isLive, setBaseUrl, getState } from '../../src/content.js'
import { emitOceanEvent, onOceanEvent } from '../../src/events.js'
import { HoldMachine, HOLD_MS, composeHeldMessage, composeDigest, deriveDigestInputs } from './threshold.js'
import { attachInputHandlers } from '../../src/runtime/input'
import { setupCanvas } from '../../src/runtime/canvas'
import { createWitnessReporter } from '../../src/runtime/witness'
import { computeNewVoiceInfo, applyResonanceFromNewVoices, fetchStateWithTimeout } from '../../src/runtime/poll-core'
import { updateMouseVelocity, scheduleNextFrame, clearScheduledFrame } from '../../src/runtime/frame'

const BASE_URL = '__VELLUM_BASE_URL__'
setBaseUrl(BASE_URL)

// ── Shared input state ────────────────────────────────

export const mouse: MouseState = {
  x: -9e3, y: -9e3,
  prevX: -9e3, prevY: -9e3,
  speed: 0, moving: false, lastMove: 0,
  down: false, downStart: 0, touch: false,
}

// ── Canvas ────────────────────────────────────────────

const { ctx, syncCanvasSize } = setupCanvas()
let prevNow = 0
const frameHandle: {
  frameId: number | null
  frameTimeout: ReturnType<typeof setTimeout> | null
} = { frameId: null, frameTimeout: null }
let pollTimeout: ReturnType<typeof setTimeout> | null = null
let highlightRetryTimeout: ReturnType<typeof setTimeout> | null = null

const TID = 'vl\u00b7' + Math.random().toString(36).slice(2, 7) + '\u00b7' + Date.now().toString(36).slice(-4)
const trEl = document.getElementById('tr')
if (trEl) trEl.textContent = TID

const VISIBLE_POLL_MS = 15_000
const VISIBLE_POLL_JITTER_MS = 2_000
const RETRY_BASE_MS = 5_000
const FETCH_STATE_TIMEOUT_MS = 20_000
const HIGHLIGHT_RETRY_DELAYS_MS = [3_000, 10_000, 30_000]
let currentHighlightId: string | null = null
let highlightRetryIndex = 0
let pollInFlight = false
let pendingForcedRefresh = false
// Deferred loom source ID: when ontoolresult arrives with a sourceId (weave),
// stash it here instead of a .then() callback. poll() consumes it after fresh
// state lands — avoids losing resonance + loom-enter when pollInFlight is true.
let pendingLoomSourceId: string | null = null
// Force-voice ids carried across in-flight poll re-entry. If an ontoolresult
// force call lands while scheduleRegularPoll's poll is still awaiting fetch,
// we stash ids here so the next poll run picks them up via the finally hook.
// Set semantics dedupe repeated force requests for the same voice.
const pendingForceVoiceIds = new Set<string>()
// Per-voice retry budget for force IDs that aren't yet in fetched state
// (KV propagation race). After MAX_FORCE_RETRIES the ID is dropped from
// the immediate-retry queue; the next scheduled poll's diff path will
// still catch the voice if it eventually appears.
const forceRetryCount = new Map<string, number>()
const MAX_FORCE_RETRIES = 3
let consecutivePollFailures = 0

// Boot-race buffering for ontoolresult: refreshLoom is a no-op before
// initLoom(), and even once ready, poll's diff path misses the tool-result
// voice because initialFetch already pulled the post-write state. Buffer
// all arrivals during boot (array, not single slot — multiple tool results
// may arrive before fonts.ready resolves) and flush them together after
// initLoom so they emerge in one refreshLoom pass.
let bootComplete = false
const pendingBootArrivals: Array<{ voiceId: string; sourceId: string | null }> = []

// Tracks whether initLoom() has run. applyContainerDimensions may fire from
// `app.connect().then()` or `onhostcontextchanged` before fonts.ready has
// resolved (initLoom is gated on fonts.ready). resizeLoom() runs fine on
// empty threads, but skipping it pre-init makes the intent explicit.
let loomInitialized = false

// ── Helpers ──────────────────────────────────────────

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

attachInputHandlers({ mouse, scrollThread, aperture })

// ── Resize ────────────────────────────────────────────

window.addEventListener('resize', resizeLoom)

// ── Loom view interaction ────────────────────────────

// Double-tap gating for touch: first tap shows dive lens, second tap enters loom view
let pendingTouchLoomId: string | null = null
let pendingTouchLoomTimer: ReturnType<typeof setTimeout> | null = null

document.addEventListener('click', (e) => {
  // A completed hold already acted (sendMessage); swallow the trailing click so
  // it doesn't also enter/recenter the loom view.
  if (holdJustFired) { holdJustFired = false; return }
  if ((e.target as HTMLElement)?.id === 'fs') return
  const hitId = getLastFrameHitVoiceIdAt(e.clientX, e.clientY)
  if (isLoomViewActive()) {
    if (hitId && hitId !== getCurrentLoomSeed()) {
      recenterLoomView(hitId)
      history.replaceState(null, '', '?highlight=' + hitId)
    } else if (!hitId) {
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
    pendingTouchLoomId = null
    if (pendingTouchLoomTimer) { clearTimeout(pendingTouchLoomTimer); pendingTouchLoomTimer = null }
  }
})

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

// ── Phase 13 F13: hold-to-summon ──────────────────────

// Mouse-hold >= HOLD_MS on a voice steps it into the conversation via
// sendMessage. Own document listeners (do NOT touch src/runtime/input.ts).
// Touch long-press is out of v1 (conflicts with the 800ms double-tap loom gate).
const holdMachine = new HoldMachine()
let holdTimer: ReturnType<typeof setTimeout> | null = null
let holdX = 0
let holdY = 0
// Set when a hold fires so the trailing click (mouseup after a stationary hold)
// doesn't ALSO enter/recenter the loom view. Consumed by the click handler.
let holdJustFired = false

function clearHoldTimer() {
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null }
}

function endHold() {
  clearHoldTimer()
  holdMachine.cancel()
}

function resolveVoiceText(voiceId: string): string | null {
  const state = getState()
  if (!state) return null
  for (const thread of state.threads) {
    const voice = thread.voices.find(v => v.id === voiceId)
    if (voice) return voice.text
  }
  return null
}

function sendHeldVoice(voiceId: string) {
  let caps
  try { caps = app.getHostCapabilities() } catch { return }
  if (!caps?.message?.text) return
  const text = resolveVoiceText(voiceId)
  if (!text) return
  const message = composeHeldMessage(text, voiceId)
  void (async () => {
    try {
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: message }] })
      if (result?.isError) console.warn('Vellum ext-app: host rejected held-voice message')
    } catch (e) {
      console.warn('Vellum ext-app: sendMessage failed', e)
    }
  })()
}

document.addEventListener('mousedown', (e) => {
  holdJustFired = false
  if (mouse.touch) return
  if ((e.target as HTMLElement)?.id === 'fs') return
  if (e.button !== 0) return
  // includeUnwoven: the hold works on ANY voice under the lens, not just woven.
  const hitId = getLastFrameHitVoiceIdAt(e.clientX, e.clientY, true)
  if (!hitId) { endHold(); return }
  holdX = e.clientX
  holdY = e.clientY
  const now = performance.now()
  holdMachine.press(hitId, e.clientX, e.clientY, now)
  // Deepen the held voice's resonance glow — attention vocabulary, not chrome.
  // Let it decay naturally on cancel (setResonance auto-expires in ~6s).
  setResonance(hitId, now)
  clearHoldTimer()
  holdTimer = setTimeout(() => {
    holdTimer = null
    const res = holdMachine.tryFire(performance.now(), getLastFrameHitVoiceIdAt(holdX, holdY, true))
    if (res.fired && res.voiceId) {
      holdJustFired = true
      sendHeldVoice(res.voiceId)
    }
  }, HOLD_MS)
})

document.addEventListener('mousemove', (e) => {
  if (!holdMachine.heldVoiceId()) return
  holdX = e.clientX
  holdY = e.clientY
  if (holdMachine.move(e.clientX, e.clientY)) clearHoldTimer()
})

document.addEventListener('mouseup', endHold)
document.addEventListener('mouseleave', endHold)
window.addEventListener('blur', endHold)

// ── Phase 13 F12: the brief (ambient model context) ───

// Minimal digest pushed via updateModelContext (REPLACE semantics). Two
// triggers only: once after the first successful poll (connect-time), and on
// loom-enter / loom-exit. NO re-push on weave/emergence/warmth (panel).
let digestPushed = false

// Resolves true only when the host acknowledged the context update — so the
// connect-time latch never trips on a dispatch that later failed.
async function pushDigest(): Promise<boolean> {
  let caps
  try { caps = app.getHostCapabilities() } catch { return false }
  if (!caps?.updateModelContext?.text) return false
  const state = getState()
  if (!state) return false
  const inputs = deriveDigestInputs(state, isLoomViewActive() ? getCurrentLoomSeed() : null)
  const text = composeDigest(inputs)
  try {
    await app.updateModelContext({ content: [{ type: 'text', text }] })
    return true
  } catch (e) {
    console.warn('Vellum ext-app: updateModelContext failed', e)
    return false
  }
}

function maybePushConnectDigest() {
  if (digestPushed) return
  // Latch only once the host has actually acknowledged the update (connect may
  // resolve after the first poll; a not-yet-ready host just retries next poll
  // or at the boot-time call after initLoom).
  void pushDigest().then(ok => { if (ok) digestPushed = true })
}

// Loom transitions are the only other trigger. Registered once at boot; the
// callback runs at event time, well after `app` is constructed.
onOceanEvent((e) => {
  if (e.type === 'loom-enter' || e.type === 'loom-exit') void pushDigest()
})

// ── Witness reporting ─────────────────────────────────

const { checkWitness } = createWitnessReporter({
  endpoint: `${BASE_URL}/api/witness`,
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
  if (document.hidden || !currentHighlightId) return
  if (findVoice(currentHighlightId)) {
    highlightRetryIndex = HIGHLIGHT_RETRY_DELAYS_MS.length
    setHighlight(currentHighlightId)
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

async function poll(options: { refresh?: boolean; forceNewVoiceIds?: string[] } = {}) {
  // Merge incoming force voice ids into the pending set first, so an
  // in-flight re-entry doesn't drop them.
  if (options.forceNewVoiceIds) {
    for (const id of options.forceNewVoiceIds) pendingForceVoiceIds.add(id)
  }
  if (pollInFlight) {
    pendingForcedRefresh = pendingForcedRefresh || Boolean(options.refresh)
    return
  }
  pollInFlight = true

  // Consume any queued force voices for this run.
  const forceVoiceIds = Array.from(pendingForceVoiceIds)
  pendingForceVoiceIds.clear()

  const prevVersion = lastVersion
  const prevIdSets = getVoiceIdSets()
  // Track which voices fired emergence this run, so the finally block can
  // dedupe them out of pendingForceVoiceIds and avoid a re-fire from a
  // collision between the scheduled poll's diff and an in-flight force.
  const firedVoiceIds = new Set<string>()
  // Track force voice IDs that aren't yet in fetched state (KV propagation
  // race). The finally block re-queues them with a bounded retry budget so
  // Phase C eventually fires once the projection catches up.
  const unresolvedForceIds: string[] = []
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

    if (currentHighlightId && findVoice(currentHighlightId)) {
      setHighlight(currentHighlightId)
      highlightRetryIndex = HIGHLIGHT_RETRY_DELAYS_MS.length
    } else if (currentHighlightId) {
      clearHighlight()
      scheduleHighlightRetry()
    }

    const versionChanged = state.version !== prevVersion
    if (versionChanged || forceVoiceIds.length > 0) {
      lastVersion = state.version
      const newIdSets = getVoiceIdSets()
      const newVoiceInfo = computeNewVoiceInfo(prevIdSets, newIdSets)
      // Tool-result voices may already be in prevIdSets (initialFetch pulled
      // post-write state) so the diff above misses them. Fold them in so
      // Phase C fires for every voice the AI just landed. If findVoice fails,
      // the voice isn't yet in fetched state — track it for the finally
      // block's bounded retry.
      for (const voiceId of forceVoiceIds) {
        const found = findVoice(voiceId)
        const familyIndex = found ? state.threads.findIndex(thread => thread.family === found.family) : -1
        if (familyIndex >= 0 && newVoiceInfo[familyIndex]) {
          newVoiceInfo[familyIndex].newIds.add(voiceId)
          newVoiceInfo[familyIndex].hasNew = true
        } else {
          unresolvedForceIds.push(voiceId)
        }
      }
      // Capture every voice that's about to fire emergence, so the finally
      // block can drop them from any pending force queue. Otherwise a force
      // request that landed during this poll's fetch window — and got picked
      // up by the diff path — would re-fire emergence on the re-run.
      for (let g = 0; g < newVoiceInfo.length; g++) {
        if (newVoiceInfo[g].hasNew) {
          for (const id of newVoiceInfo[g].newIds) firedVoiceIds.add(id)
        }
      }
      const now = performance.now()
      refreshLoom(newVoiceInfo, now, emitOceanEvent)
      applyResonanceFromNewVoices({ newVoiceInfo, state, setResonance, emitEvent: emitOceanEvent, now })
    }

    // Deferred loom effects from ontoolresult: resonance glow + auto-enter.
    // Stashed as pendingLoomSourceId instead of .then() callbacks — poll()
    // returns immediately when pollInFlight, which fires .then() against
    // stale state, permanently losing resonance and loom-enter.
    if (pendingLoomSourceId && findVoice(pendingLoomSourceId)) {
      const sourceId = pendingLoomSourceId
      pendingLoomSourceId = null
      setResonance(sourceId, performance.now())
      enterLoomView(sourceId)
      history.replaceState(null, '', '?highlight=' + sourceId)
    }

    // Phase 13 F12: connect-time brief, once after the first successful poll.
    maybePushConnectDigest()

    if (!document.hidden) scheduleRegularPoll()
  } finally {
    pollInFlight = false
    // Drop voices that already fired emergence this run from the pending
    // force queue and clear their retry counters.
    for (const id of firedVoiceIds) {
      pendingForceVoiceIds.delete(id)
      forceRetryCount.delete(id)
    }
    // Re-queue unresolved force IDs (voice not yet in state) with a bounded
    // retry budget. Each retry burns one budget. After MAX_FORCE_RETRIES the
    // ID is dropped — the diff path on the next scheduled poll will still
    // catch the voice if it eventually appears in state.
    let hasUnresolvedRetries = false
    for (const id of unresolvedForceIds) {
      const count = (forceRetryCount.get(id) ?? 0) + 1
      if (count <= MAX_FORCE_RETRIES) {
        forceRetryCount.set(id, count)
        pendingForceVoiceIds.add(id)
        hasUnresolvedRetries = true
      } else {
        forceRetryCount.delete(id)
      }
    }
    // Re-run if another poll was requested during this one, or if force
    // voices are still queued in pendingForceVoiceIds (in-flight reentry
    // additions or unresolved retries). Retries need refresh:true to force
    // the worker's rebuildStateProjectionWithLock path and bust the edge
    // cache — otherwise we'd busy-loop against stale state.
    if (pendingForcedRefresh || pendingForceVoiceIds.size > 0) {
      const refresh = pendingForcedRefresh || hasUnresolvedRetries
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
    checkWitness()
  } catch (e) {
    console.error('[vellum] render error:', e)
  }
  scheduleFrame()
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    prevNow = 0
    clearScheduledFrame(frameHandle)
    scheduleFrame()
    void poll({ refresh: Boolean(currentHighlightId && !findVoice(currentHighlightId)) })
  } else {
    clearPollTimeouts()
  }
})

// ── Ext-apps SDK ──────────────────────────────────────

const app = new App({ name: 'Vellum Pensieve', version: '0.2.0' })

const fsBtn = document.getElementById('fs') as HTMLButtonElement | null
const szEl = document.getElementById('sz') as HTMLDivElement | null

// Inline-mode size clamps. Host may report 10000px maxHeight — we don't want
// the iframe to eat the whole chat pane.
const INLINE_MIN_HEIGHT = 280
const INLINE_MAX_HEIGHT = 480
const FULLSCREEN_MIN_HEIGHT = 480

function applyContainerDimensions() {
  if (!szEl) return
  try {
    const ctx = app.getHostContext() as {
      containerDimensions?: { height?: number; maxHeight?: number }
      displayMode?: string
    } | null | undefined
    const dims = ctx?.containerDimensions
    if (!dims) return
    const rawH = (typeof dims.height === 'number' && dims.height > 0)
      ? dims.height
      : (typeof dims.maxHeight === 'number' && dims.maxHeight > 0)
        ? dims.maxHeight
        : null
    if (rawH === null) return
    // Clamp based on display mode: keep inline compact, let fullscreen breathe.
    const isFullscreen = ctx?.displayMode === 'fullscreen'
    const lo = isFullscreen ? FULLSCREEN_MIN_HEIGHT : INLINE_MIN_HEIGHT
    const hi = isFullscreen ? rawH : INLINE_MAX_HEIGHT
    const h = Math.max(lo, Math.min(rawH, hi))
    // Only re-apply + resize when the value actually changed. Avoids
    // (a) needless resizeLoom() on theme/locale changes that also fire
    // onhostcontextchanged, and (b) any potential size-change ↔ host-context
    // oscillation if the host echoes dimensions back after a resize.
    const newHeight = `${h}px`
    if (szEl.style.height === newHeight) return
    szEl.style.height = newHeight
    // Skip resizeLoom pre-init — initLoom() will read the current innerWidth
    // /innerHeight (which reflects the spacer-driven iframe size) when it
    // runs later in the fonts.ready handler.
    if (loomInitialized) resizeLoom()
  } catch (e) {
    console.warn('Vellum ext-app: host context read failed', e)
  }
}

app.onhostcontextchanged = () => {
  applyContainerDimensions()
}

app.ontoolresult = (result: Record<string, unknown>) => {
  // Extract voiceId and sourceId from _meta on the tool result
  const meta = result._meta as Record<string, unknown> | undefined

  // Resonance: apply after refresh when projection is fresh (existing resonances auto-expire in 6s)
  const pendingSourceId = (meta?.sourceId && typeof meta.sourceId === 'string') ? meta.sourceId : null

  if (meta?.voiceId && typeof meta.voiceId === 'string') {
    const voiceId = meta.voiceId
    currentHighlightId = voiceId
    highlightRetryIndex = 0
    if (!bootComplete) {
      // Boot race: refreshLoom is a no-op before initLoom(). Buffer and let
      // the boot block flush via forceNewVoiceIds once threads exist.
      pendingBootArrivals.push({ voiceId, sourceId: pendingSourceId })
      return
    }
    if (pendingSourceId) pendingLoomSourceId = pendingSourceId
    void poll({ refresh: true, forceNewVoiceIds: [voiceId] })
    return
  }

  // Fallback: parse voice_id from text content
  const content = result.content
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const match = /voice_id:\s*"([^"]+)"/.exec((c as Record<string, unknown>).text as string)
        if (match) {
          const voiceId = match[1]
          currentHighlightId = voiceId
          highlightRetryIndex = 0
          if (!bootComplete) {
            pendingBootArrivals.push({ voiceId, sourceId: null })
            return
          }
          void poll({ refresh: true, forceNewVoiceIds: [voiceId] })
          return
        }
      }
    }
  }
}

app.onerror = (err: Error) => console.error('Vellum ext-app:', err)

if (fsBtn) {
  fsBtn.addEventListener('click', async () => {
    try {
      const ctx = app.getHostContext() as { displayMode?: string; availableDisplayModes?: string[] } | null | undefined
      const current = ctx?.displayMode ?? 'inline'
      const target: 'inline' | 'fullscreen' = current === 'fullscreen' ? 'inline' : 'fullscreen'
      if (!ctx?.availableDisplayModes?.includes(target)) {
        console.warn('Vellum ext-app: display mode not supported:', target)
        return
      }
      const result = await app.requestDisplayMode({ mode: target })
      console.info('Vellum ext-app: display mode →', result.mode)
    } catch (e) {
      console.warn('Vellum ext-app: display mode request failed', e)
    }
  })
}

// ── Boot ──────────────────────────────────────────────

// Start fetching state immediately (runs parallel to font loading)
const initialFetch = fetchStateWithTimeout({
  fetchState,
  refresh: true,
  timeoutMs: FETCH_STATE_TIMEOUT_MS,
})

const inIframe = window !== window.parent

// Connect to ext-apps host immediately (don't wait for fonts/data)
if (inIframe) {
  app.connect().then(() => {
    console.info('Vellum ext-app: connected')
    applyContainerDimensions()
    // Show the fullscreen toggle button only if the host actually supports
    // BOTH modes our click handler toggles between. A host that advertises
    // e.g. ['inline', 'pip'] would pass a naive `modes.length > 1` check but
    // then every click would bail in the handler (target=fullscreen not in
    // list), leaving a visible button that does nothing.
    if (fsBtn) {
      try {
        const ctx = app.getHostContext() as { availableDisplayModes?: string[] } | null | undefined
        const modes = ctx?.availableDisplayModes
        if (modes?.includes('inline') && modes?.includes('fullscreen')) {
          fsBtn.hidden = false
        }
      } catch {
        // ignore — button stays hidden
      }
    }
  }).catch((err: Error) => {
    console.error('Vellum ext-app: connection failed:', err)
  })
}

// Race fonts.ready against a 2-second timeout. Claude Desktop's iframe CSP
// sometimes blocks or delays Google Fonts loading by 30+ seconds, which was
// blocking the entire boot sequence (canvas rendering, ontoolresult handling,
// pendingBootArrivals drain). System fonts are an acceptable fallback — the
// loom layout re-measures on next poll anyway.
const fontsReadyOrTimeout = Promise.race([
  document.fonts.ready.then(() => 'fonts' as const),
  new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2000)),
])

fontsReadyOrTimeout.then(async (mode) => {
  if (mode === 'timeout') {
    console.warn('Vellum ext-app: fonts.ready timeout, booting with system fonts')
  }
  // fetchState may already be in flight from early boot — await it here
  await initialFetch
  lastVersion = getVersion()

  initLoom()
  loomInitialized = true
  scheduleFrame()
  setTimeout(() => document.getElementById('vl')!.classList.add('o'), 500)
  // Phase 13 F12: push the connect-time brief now — boot state is already
  // fetched, so we don't wait ~30s+ for the first scheduled poll. Harmless if
  // host capabilities aren't ready yet; the poll() hook is the retry path.
  maybePushConnectDigest()
  scheduleRegularPoll()

  // Boot done — any tool results that arrived during boot were buffered,
  // drain them through the normal poll path with forceNewVoiceIds so the
  // full Phase C pipeline (emergence + phantom + scroll) fires for every
  // buffered voice. refresh:true is required — /api/state is cached at the
  // edge for 10s, so a plain fetch could return a stale response that
  // doesn't yet contain the buffered voice.
  bootComplete = true
  if (pendingBootArrivals.length > 0) {
    const arrivals = pendingBootArrivals.slice()
    pendingBootArrivals.length = 0
    const voiceIds = arrivals.map(a => a.voiceId)
    const sourceIds = arrivals.map(a => a.sourceId).filter((s): s is string => s !== null)
    // Highlight the most recently arrived voice (visual focus goes to the
    // latest tool result, earlier ones still get emergence + phantom).
    // Last source wins — loom view shows the most recent weave's tree.
    // Highlight uses currentHighlightId (already set per-arrival in ontoolresult).
    if (sourceIds.length > 0) pendingLoomSourceId = sourceIds[sourceIds.length - 1]
    void poll({ refresh: true, forceNewVoiceIds: voiceIds })
  }

  if (!inIframe) {
    // Standalone mode: honor URL param highlight
    const highlightId = new URLSearchParams(location.search).get('highlight')
    if (highlightId) {
      currentHighlightId = highlightId
      setHighlight(highlightId)
      if (!findVoice(highlightId)) scheduleHighlightRetry()
    }
  }
})
