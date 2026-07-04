import { beforeEach, expect, test } from 'bun:test'
import { initLoom, renderLoom, isPhantomActive } from '../../src/loom/index.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { getThreads, getTouchedThread, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('initLoom + renderLoom runs several frames without crashes and without touch', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.3 }] }], 51))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 10)
  expect(getTouchedThread()).toBeNull()
})

test('full phantom trigger flow keeps focus on the target thread', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([
    {
      family: 'memory',
      voices: [
        { id: 'm0', text: 'MEMORY OLD ', depth: 0.5 },
        { id: 'm1', text: 'MEMORY TARGET ', depth: 0.1 },
      ],
    },
  ], 52))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'm1')
  runFrames(renderLoom, ctx, mouse, 45, 80)
  expect(isPhantomActive()).toBe(true)
  expect(getTouchedThread()).toBe(getThreads()[0])
  expect(getThreads()[0]!.proximity).toBeGreaterThan(0.5)
})

test('mouse.x = 0 sentinel still participates in touch scan', async () => {
  installViewport(960, 640)
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'ATTN ', depth: 0.4 }] }], 53))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  thread._path = Array.from({ length: 61 }, (_, i) => ({ x: 0, y: i * (innerHeight / 60) }))
  mouse.x = 0
  mouse.y = innerHeight / 2
  renderLoom(ctx, innerWidth, innerHeight, 16, 0.016, mouse as any)
  expect(getTouchedThread()).toBe(thread)
})
