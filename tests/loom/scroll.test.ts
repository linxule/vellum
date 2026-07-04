import { beforeEach, expect, test } from 'bun:test'
import { findLineForVoice, scrollThreadToVoice, scrollThread } from '../../src/loom/scroll.js'
import { initLoom } from '../../src/loom/init.js'
import { aperture } from '../../src/loom/aperture.js'
import { diveGaussian } from '../../src/loom/path.js'
import { getThreads, loomState, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

async function seedScrollFixture(height = 480) {
  resetLoomState()
  installViewport(900, height)
  await loadState(makeState([
    {
      family: 'attention',
      voices: [
        { id: 'a0', depth: 0.6, text: 'ALPHA current carries the first shelf. ' },
        { id: 'a1', depth: 0.4, text: 'BETA current carries the second shelf. ' },
      ],
    },
  ], height))
  withFixedRandom(0.5, () => initLoom())
  return getThreads()[0]!
}

beforeEach(() => {
  resetLoomState()
})

test('findLineForVoice returns the expected texture-line index', async () => {
  const thread = await seedScrollFixture()
  expect(findLineForVoice(thread, 'attention', 0)).toBeGreaterThanOrEqual(0)
  expect(findLineForVoice(thread, 'attention', 1)).toBeGreaterThan(findLineForVoice(thread, 'attention', 0))
})

test('scrollThreadToVoice uses the dive Gaussian walk count across viewport heights', async () => {
  for (const height of [320, 480, 900]) {
    const thread = await seedScrollFixture(height)
    loomState.VH = height
    const lineIdx = findLineForVoice(thread, 'attention', 1)
    scrollThreadToVoice(0, 'a1')

    const ac = aperture(loomState.VW)
    const sigma = ac.diveLineH * 4
    let yPos = 0
    let linesAboveCenter = 0
    while (yPos < height / 2 && linesAboveCenter < 500) {
      yPos += ac.textureLineH + (ac.diveLineH - ac.textureLineH) * diveGaussian(yPos, height / 2, sigma)
      linesAboveCenter++
    }
    const expected = Math.max(0, (lineIdx - linesAboveCenter) / 3)
    expect(thread.scroll).toBeCloseTo(expected, 6)
  }
})

test('scrollThread clamps userScroll to +/-2', async () => {
  const thread = await seedScrollFixture()
  loomState.touchedThread = thread
  scrollThread(9999)
  expect(thread.userScroll).toBe(2)
  scrollThread(-9999)
  expect(thread.userScroll).toBe(-2)
})
