// src/audio/controller.ts

import type { OceanEvent } from '../events.js'
import { onOceanEvent } from '../events.js'
import { loadAndInitStrudel, isStrudelReady } from './strudel-loader.js'
import { basePattern, weavePattern, emergencePattern, loomPattern, type PatternParams } from './patterns.js'

export { isStrudelReady }
export function isSoundOn(): boolean { return soundEnabled }

let soundEnabled = false
let currentPatternName: string = 'base'
let lastWarmth: Record<string, number> = {}
let eventSubscribed = false

let pendingWeaves = 0
let pendingEmergences = 0
let debounceTimeout: ReturnType<typeof setTimeout> | null = null
let returnPatternTimeout: ReturnType<typeof setTimeout> | null = null

export function resumeAudioContext(): void {
  try {
    const ac: AudioContext | undefined = (window as any).strudel?.getAudioContext?.() ?? (window as any).getAudioContext?.()
    if (ac?.state === 'suspended') ac.resume()
  } catch { /* silent */ }
}

export async function initStrudelSound(): Promise<boolean> {
  try {
    await loadAndInitStrudel()
    resumeAudioContext()
    console.log('[vellum] sound initialized, ac:', (window as any).strudel?.getAudioContext?.()?.state, 'evaluate:', typeof (window as any).strudel?.evaluate)
  } catch (e) {
    console.error('Strudel init failed (silent fallback):', e)
    return false
  }

  soundEnabled = true
  localStorage.setItem('vellum-sound', 'on')

  setTimeout(() => evaluatePattern(basePattern(currentParams())), 0)

  if (!eventSubscribed) {
    onOceanEvent(handleOceanEvent)
    eventSubscribed = true
  }
  return true
}

function evaluatePattern(code: string): void {
  if (!soundEnabled) return
  try {
    const evaluate = (window as any).strudel?.evaluate ?? (window as any).evaluate
    if (!evaluate) {
      console.warn('[vellum] evaluate not found')
      return
    }
    evaluate(code, true)
  } catch (e) {
    console.error('[vellum] pattern evaluation failed:', e)
  }
}

function stopSound(): void {
  cancelReturnTimer()
  try {
    const hush = (window as any).strudel?.hush ?? (window as any).hush
    if (hush) hush()
  } catch { /* silent */ }
}

function currentParams(): PatternParams {
  return { familyGains: lastWarmth }
}

function handleOceanEvent(event: OceanEvent): void {
  if (event.type === 'weave') {
    pendingWeaves++
    if (!debounceTimeout) debounceTimeout = setTimeout(flushBatchedEvents, 100)
    return
  }
  if (event.type === 'emergence') {
    pendingEmergences++
    if (!debounceTimeout) debounceTimeout = setTimeout(flushBatchedEvents, 100)
    return
  }
  handleImmediateEvent(event)
}

function currentReturnPattern(): string {
  return currentPatternName === 'loom' ? loomPattern(currentParams()) : basePattern(currentParams())
}

function cancelReturnTimer(): void {
  if (returnPatternTimeout) { clearTimeout(returnPatternTimeout); returnPatternTimeout = null }
}

function flushBatchedEvents(): void {
  debounceTimeout = null
  cancelReturnTimer()
  if (pendingWeaves > 0) {
    setTimeout(() => evaluatePattern(weavePattern(currentParams())), 0)
    returnPatternTimeout = setTimeout(() => evaluatePattern(currentReturnPattern()), 3000)
  } else if (pendingEmergences > 0) {
    setTimeout(() => evaluatePattern(emergencePattern(currentParams())), 0)
    returnPatternTimeout = setTimeout(() => evaluatePattern(currentReturnPattern()), 4000)
  }
  pendingWeaves = 0
  pendingEmergences = 0
}

function handleImmediateEvent(event: OceanEvent): void {
  cancelReturnTimer()
  switch (event.type) {
    case 'loom-enter':
      currentPatternName = 'loom'
      setTimeout(() => evaluatePattern(loomPattern(currentParams())), 0)
      break
    case 'loom-exit':
      currentPatternName = 'base'
      setTimeout(() => evaluatePattern(basePattern(currentParams())), 0)
      break
    case 'warmth-update':
      lastWarmth = event.familyWarmth
      if (currentPatternName === 'base') setTimeout(() => evaluatePattern(basePattern(currentParams())), 0)
      break
  }
}

export function modulateSound(proximity: number, immersion: number): void {
  if (!soundEnabled) return
  try {
    const ac: AudioContext | undefined = (window as any).strudel?.getAudioContext?.() ?? (window as any).getAudioContext?.()
    const controller = (window as any).strudel?.getSuperdoughAudioController?.() ?? (window as any).getSuperdoughAudioController?.()
    const masterGain: GainNode | undefined = controller?.output?.destinationGain
    if (!ac || !masterGain) return

    const targetGain = 0.22 + proximity * 0.30 + immersion * 0.13
    masterGain.gain.setTargetAtTime(targetGain, ac.currentTime, 0.1)
  } catch { /* silent */ }
}

export function toggleStrudelSound(): boolean {
  if (soundEnabled) {
    stopSound()
    soundEnabled = false
    localStorage.setItem('vellum-sound', 'off')
  } else {
    soundEnabled = true
    localStorage.setItem('vellum-sound', 'on')
    setTimeout(() => evaluatePattern(basePattern(currentParams())), 0)
  }
  return soundEnabled
}
