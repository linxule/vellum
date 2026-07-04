import { beforeEach, expect, test } from 'bun:test'
import { setHighlight, clearHighlight, highlightUidForThread } from '../../src/loom/highlight.js'
import { initLoom } from '../../src/loom/init.js'
import { getThreads, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('setHighlight resolves the correct thread-local UID', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.2 }] },
  ], 21))
  withFixedRandom(0.5, () => initLoom())
  setHighlight('m0')
  expect(highlightUidForThread(getThreads()[0]!)).toBe(-1)
  expect(highlightUidForThread(getThreads()[1]!)).toBe(0)
})

test('clearHighlight resets state', async () => {
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] }], 22))
  withFixedRandom(0.5, () => initLoom())
  setHighlight('a0')
  clearHighlight()
  expect(highlightUidForThread(getThreads()[0]!)).toBe(-1)
})
