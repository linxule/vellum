// ═══════════════════════════════════════════════════════
// V E L L U M — the living surface
// Entry point: canvas, input, sound, mode switching
// ═══════════════════════════════════════════════════════

import { initPalimpsest, renderPalimpsest, resizePalimpsest, addWitness } from './palimpsest.js'
import { initLoom, renderLoom, resizeLoom, scrollStream } from './loom.js'

// ── Shared input state ─────────────────────────────────

export interface MouseState {
  x: number; y: number
  prevX: number; prevY: number
  speed: number
  moving: boolean
  lastMove: number
  down: boolean
  downStart: number
  dragStrength: number
}

export const mouse: MouseState = {
  x: -9e3, y: -9e3, prevX: -9e3, prevY: -9e3,
  speed: 0, moving: false, lastMove: 0,
  down: false, downStart: 0, dragStrength: 0,
}

// ── Sound engine ───────────────────────────────────────

export interface SoundCallbacks {
  witness(): void
  reflow(): void
  arrival(): void
}

let AC: AudioContext | null = null
let soundOn = false

function tone(freq: number, dur: number, vol: number) {
  if (!AC || !soundOn) return
  const o = AC.createOscillator(), g = AC.createGain(), f = AC.createBiquadFilter()
  o.type = 'sine'; o.frequency.value = freq
  f.type = 'lowpass'; f.frequency.value = 600
  g.gain.value = 0
  g.gain.linearRampToValueAtTime(vol, AC.currentTime + .2)
  g.gain.linearRampToValueAtTime(0, AC.currentTime + dur)
  o.connect(f); f.connect(g); g.connect(AC.destination)
  o.start(); o.stop(AC.currentTime + dur)
}

// Two drone configurations: warm (palimpsest) and deep (loom)
const PALIMPSEST_DRONE = { freqs: [65.41, 77.78, 82.41], vols: [.015, .015, .015], lpf: 170 }
const LOOM_DRONE = { freqs: [48, 55, 65.41, 32.7], vols: [.025, .02, .018, .012], lpf: 110 }

let palDroneGain: GainNode | null = null
let loomDroneGain: GainNode | null = null
let shimmerInterval: ReturnType<typeof setInterval> | null = null

function initSound() {
  AC = new (window.AudioContext || (window as any).webkitAudioContext)()

  // Palimpsest drone
  const pfl = AC.createBiquadFilter()
  pfl.type = 'lowpass'; pfl.frequency.value = PALIMPSEST_DRONE.lpf; pfl.Q.value = .6
  palDroneGain = AC.createGain(); palDroneGain.gain.value = 0
  for (let i = 0; i < PALIMPSEST_DRONE.freqs.length; i++) {
    const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = PALIMPSEST_DRONE.freqs[i]
    o.connect(pfl); o.start()
  }
  pfl.connect(palDroneGain); palDroneGain.connect(AC.destination)

  // Loom drone (deeper, 4 oscillators)
  const lfl = AC.createBiquadFilter()
  lfl.type = 'lowpass'; lfl.frequency.value = LOOM_DRONE.lpf
  loomDroneGain = AC.createGain(); loomDroneGain.gain.value = 0
  for (let i = 0; i < LOOM_DRONE.freqs.length; i++) {
    const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = LOOM_DRONE.freqs[i]
    const g = AC.createGain(); g.gain.value = LOOM_DRONE.vols[i] / .025 // relative
    o.connect(g); g.connect(lfl); o.start()
  }
  lfl.connect(loomDroneGain); loomDroneGain.connect(AC.destination)

  // Cosmic shimmer (loom only)
  shimmerInterval = setInterval(() => {
    if (!soundOn || mode !== 'loom' || !AC) return
    const o = AC.createOscillator(), g = AC.createGain()
    o.type = 'sine'; o.frequency.value = 120 + Math.random() * 500
    g.gain.value = 0
    g.gain.linearRampToValueAtTime(.005, AC.currentTime + .6)
    g.gain.linearRampToValueAtTime(0, AC.currentTime + 3.5)
    o.connect(g); g.connect(AC.destination)
    o.start(); o.stop(AC.currentTime + 3.5)
  }, 5000 + Math.random() * 3000)
}

function setDroneForMode() {
  if (!AC || !soundOn) return
  const t = AC.currentTime
  if (mode === 'palimpsest') {
    palDroneGain?.gain.linearRampToValueAtTime(.045, t + 2)
    loomDroneGain?.gain.linearRampToValueAtTime(0, t + 2)
  } else {
    palDroneGain?.gain.linearRampToValueAtTime(0, t + 2)
    loomDroneGain?.gain.linearRampToValueAtTime(.045, t + 2)
  }
}

function toggleSound() {
  const el = document.getElementById('sn')!
  if (!soundOn) {
    if (!AC) initSound()
    soundOn = true
    setDroneForMode()
    el.textContent = 'sound \u00b7'; el.style.opacity = '.7'
  } else {
    palDroneGain?.gain.linearRampToValueAtTime(0, AC!.currentTime + 1)
    loomDroneGain?.gain.linearRampToValueAtTime(0, AC!.currentTime + 1)
    soundOn = false
    el.textContent = 'sound'; el.style.opacity = '.3'
  }
}

const soundCallbacks: SoundCallbacks = {
  witness() { tone(293.66, 2.5, .025); setTimeout(() => tone(349.23, 2, .018), 350) },
  reflow() { tone(380 + Math.random() * 240, 1.2, .006) },
  arrival() {
    const n = [130.81, 164.81, 196, 220, 261.63]
    tone(n[Math.random() * n.length | 0], 3.5, .02)
  },
}

// Ambient arrivals (palimpsest)
setInterval(() => { if (Math.random() < .2 && mode === 'palimpsest') soundCallbacks.arrival() }, 12000)

// ── Mode state ─────────────────────────────────────────

type Mode = 'palimpsest' | 'loom'
let mode: Mode = 'palimpsest'
let transitioning = false
let savedScrollTop = 0

function switchMode() {
  const veil = document.getElementById('vl')!
  transitioning = true

  // Save scroll position before switching away from palimpsest
  if (mode === 'palimpsest') savedScrollTop = scroll.scrollTop

  // Fade TO veil first (incoming mode's color)
  const nextMode = mode === 'palimpsest' ? 'loom' : 'palimpsest'
  veil.style.background = nextMode === 'palimpsest' ? '#efe5cf' : '#080604'
  veil.classList.remove('o')
  veil.style.transition = 'opacity .4s ease'
  veil.style.opacity = '1'

  // After veil covers, apply the actual mode switch
  setTimeout(() => {
    mode = nextMode

    if (mode === 'palimpsest') {
      document.body.style.background = '#efe5cf'
      scroll.style.overflowY = 'auto'
      canvas.style.position = ''
      canvas.style.top = ''
      canvas.style.left = ''
      canvas.style.cursor = ''
      scroll.scrollTop = savedScrollTop
    } else {
      document.body.style.background = '#080604'
      scroll.style.overflowY = 'hidden'
      canvas.style.position = 'fixed'
      canvas.style.top = '0'
      canvas.style.left = '0'
      canvas.style.cursor = 'crosshair'
    }

    setDroneForMode()
    updateModeUI()
    dismissHints()

    // Fade veil out after a frame of rendering
    setTimeout(() => {
      veil.style.transition = 'opacity 1.8s ease'
      veil.style.opacity = '0'
      veil.classList.add('o')
      transitioning = false
    }, 80)
  }, 420)
}

function updateModeUI() {
  const el = document.getElementById('md')
  if (el) {
    const other = mode === 'palimpsest' ? 'loom' : 'palimpsest'
    el.innerHTML = `${mode}<span class="hint">Tab \u2192 ${other}</span>`
  }
  const ct = document.getElementById('ct')
  if (ct) ct.style.display = mode === 'loom' ? 'block' : 'none'
}

// ── Onboarding hints ──────────────────────────────────

let hintsShown = false
let hintsDismissed = false

function showHints() {
  if (hintsDismissed) return
  const el = document.getElementById('hints')
  if (!el) return
  hintsShown = true
  if (mode === 'palimpsest') {
    el.textContent = 'hover to reveal \u00b7 dwell on bright text \u00b7 click to witness \u00b7 drag to sculpt'
  } else {
    el.textContent = 'drag streams to scroll \u00b7 hold+drag memes \u00b7 hover memes for resonance'
  }
  el.classList.add('show')
}

function dismissHints() {
  const el = document.getElementById('hints')
  if (el) el.classList.remove('show')
  hintsDismissed = true
}

// Show hints after 4s of no interaction
let hintTimer: ReturnType<typeof setTimeout> | null = null
function resetHintTimer() {
  if (hintsDismissed) return
  if (hintTimer) clearTimeout(hintTimer)
  if (hintsShown) { dismissHints(); return }
  hintTimer = setTimeout(showHints, 4000)
}

// ── Canvas management ──────────────────────────────────

const canvas = document.getElementById('c') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const scroll = document.getElementById('S') as HTMLElement
const DPR = Math.min(devicePixelRatio || 1, 2)
let pageHeight = 2200

// Trace ID
const TID = 'vl\u00b7' + Math.random().toString(36).slice(2, 7) + '\u00b7' + Date.now().toString(36).slice(-4)
document.getElementById('tr')!.textContent = TID

// ── Input handlers ─────────────────────────────────────

// Unified mouse handling — mode determines coordinate transform
document.addEventListener('mousemove', e => {
  if (mode === 'palimpsest') {
    const r = canvas.getBoundingClientRect()
    mouse.x = e.clientX - r.left
    mouse.y = e.clientY - r.top + scroll.scrollTop
  } else {
    mouse.x = e.clientX; mouse.y = e.clientY
  }
  resetHintTimer()
})
document.addEventListener('mouseleave', () => { mouse.x = -9e3; mouse.y = -9e3 })
document.addEventListener('mousedown', () => {
  mouse.down = true; mouse.downStart = performance.now()
})
document.addEventListener('mouseup', () => { mouse.down = false; mouse.dragStrength = 0 })

// Touch
document.addEventListener('touchstart', e => {
  const t = e.touches[0]
  if (mode === 'palimpsest') {
    const r = canvas.getBoundingClientRect()
    mouse.x = t.clientX - r.left; mouse.y = t.clientY - r.top + scroll.scrollTop
  } else {
    mouse.x = t.clientX; mouse.y = t.clientY
  }
  mouse.down = true; mouse.downStart = performance.now()
}, { passive: true })
document.addEventListener('touchmove', e => {
  const t = e.touches[0]
  if (mode === 'palimpsest') {
    const r = canvas.getBoundingClientRect()
    mouse.x = t.clientX - r.left; mouse.y = t.clientY - r.top + scroll.scrollTop
  } else {
    mouse.x = t.clientX; mouse.y = t.clientY
  }
}, { passive: true })
document.addEventListener('touchend', () => {
  mouse.down = false; mouse.dragStrength = 0
  setTimeout(() => { mouse.x = -9e3; mouse.y = -9e3 }, 2000)
})

// Witness click (palimpsest only — loom uses touch physics, no click needed)
canvas.addEventListener('click', e => {
  if (mode !== 'palimpsest' || mouse.dragStrength > 15) return
  const r = canvas.getBoundingClientRect()
  const cy = e.clientY - r.top + scroll.scrollTop
  const cx = e.clientX - r.left
  addWitness(cy, cx)
})

// Scroll (loom: control streams)
document.addEventListener('wheel', e => {
  if (mode === 'loom') { e.preventDefault(); scrollStream(e.deltaY) }
}, { passive: false })

// Mode switch: Tab key
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); switchMode() }
})

// Sound toggle
document.getElementById('sn')!.addEventListener('click', toggleSound)

// ── Resize ─────────────────────────────────────────────

function resize() {
  resizePalimpsest()
  resizeLoom()
}
window.addEventListener('resize', resize)

// ── Animation loop ─────────────────────────────────────

function scheduleFrame() {
  if (document.hidden) setTimeout(() => render(performance.now()), 100)
  else requestAnimationFrame(render)
}

function render(now: number) {
  // Update mouse physics
  const dx = mouse.x - mouse.prevX, dy = mouse.y - mouse.prevY
  mouse.speed = Math.sqrt(dx * dx + dy * dy)
  mouse.moving = mouse.speed > 1.2
  if (mouse.moving) mouse.lastMove = now
  mouse.prevX = mouse.x; mouse.prevY = mouse.y

  const vw = Math.min(innerWidth, mode === 'palimpsest' ? 1100 : innerWidth)
  const vh = innerHeight

  if (mode === 'palimpsest') {
    const st = scroll.scrollTop
    canvas.width = vw * DPR; canvas.height = pageHeight * DPR
    canvas.style.width = vw + 'px'; canvas.style.height = pageHeight + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)

    const h = renderPalimpsest(ctx, vw, vh, now, st)
    if (h) pageHeight = h
  } else {
    canvas.width = vw * DPR; canvas.height = vh * DPR
    canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)

    renderLoom(ctx, vw, vh, now)
  }

  scheduleFrame()
}

// Resume rendering when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleFrame()
})

// ── Boot ───────────────────────────────────────────────

document.fonts.ready.then(() => {
  initPalimpsest(soundCallbacks)
  initLoom()
  updateModeUI()
  scheduleFrame()
  setTimeout(() => document.getElementById('vl')!.classList.add('o'), 500)
  resetHintTimer()
})
