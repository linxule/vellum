import { beforeEach, expect, test } from 'bun:test'
import { setResonance, clearResonance, updateResonances } from '../../src/loom/resonance.js'
import { initLoom } from '../../src/loom/init.js'
import { getResonances, getThreads, loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('setResonance adds an entry for the matching source family with canonical voiceId', async () => {
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] }], 31))
  withFixedRandom(0.5, () => initLoom())
  setResonance('a0', 1000)
  expect(getResonances()).toHaveLength(1)
  expect(getResonances()[0]?.voiceId).toBe('a0')
  expect(getResonances()[0]?.family).toBe('attention')
})

test('resonance warms a thread, then ages out after six seconds', async () => {
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] }], 32))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  setResonance('a0', 1000)
  updateResonances(thread, 1000)
  expect(thread.warmth).toBeCloseTo(0.3, 5)
  updateResonances(thread, 8000)
  expect(getResonances()).toHaveLength(0)
  clearResonance()
  expect(getResonances()).toHaveLength(0)
})

test('expired resonance is pruned even when the iterated thread does not match its family', () => {
  loomState.resonances = [{ voiceId: 'v:test1', family: 'silence', start: 1000 }]
  const thread = {
    familyNames: ['light'],
    warmth: 0,
    resonatingVoiceUids: new Map(),
    groupBoundaries: [1],
  } as unknown as Thread

  updateResonances(thread, 8000)

  expect(getResonances()).toHaveLength(0)
  expect(thread.warmth).toBe(0)
})

test('fresh non-matching resonance is preserved but not applied to the iterated thread', () => {
  loomState.resonances = [{ voiceId: 'v:test2', family: 'silence', start: 1000 }]
  const thread = {
    familyNames: ['light'],
    warmth: 0,
    resonatingVoiceUids: new Map(),
    groupBoundaries: [1],
  } as unknown as Thread

  updateResonances(thread, 2000)

  expect(getResonances()).toHaveLength(1)
  expect(thread.warmth).toBe(0)
})
