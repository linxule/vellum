import { beforeEach, expect, test } from 'bun:test'
import { initLoom } from '../../src/loom/init.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { getLoomSnapshot, loomState, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

async function seedSnapshotFixture() {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION VOICE ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY VOICE ', depth: 0.2 }] },
  ], 81))
  withFixedRandom(0.5, () => initLoom())
}

test('getLoomSnapshot returns the expected stable shape', async () => {
  await seedSnapshotFixture()
  const snapshot = getLoomSnapshot()

  expect(snapshot.ready).toBe(true)
  expect(typeof snapshot.immersion).toBe('number')
  expect(typeof snapshot.current).toBe('number')
  expect(typeof snapshot.totalProximity).toBe('number')
  expect(snapshot.touchedThreadIndex).toBe(-1)
  expect(snapshot.phantomActive).toBe(false)
  expect(snapshot.resonanceCount).toBe(0)
  expect(snapshot.threads).toHaveLength(2)
  for (const thread of snapshot.threads) {
    expect(typeof thread.family).toBe('string')
    expect(typeof thread.warmth).toBe('number')
    expect(typeof thread.apiWarmth).toBe('number')
    expect(typeof thread.depth).toBe('number')
    expect(typeof thread.restingDepth).toBe('number')
    expect(typeof thread.proximity).toBe('number')
    expect(typeof thread.xCenter).toBe('number')
    expect(typeof thread.scroll).toBe('number')
    expect(typeof thread.isTouched).toBe('boolean')
    expect(typeof thread.isPhantomTarget).toBe('boolean')
    expect(typeof thread.emergenceActive).toBe('boolean')
    expect(typeof thread.unreadCount).toBe('number')
    expect(Array.isArray(thread.familyNames)).toBe(true)
  }
})

test('snapshot warmth does not observe later mutations to loomState', async () => {
  await seedSnapshotFixture()
  loomState.threads[0]!.warmth = 0.25
  const snapshot = getLoomSnapshot()
  loomState.threads[0]!.warmth = 0.9

  expect(snapshot.threads[0]!.warmth).toBe(0.25)
})

test('mutating snapshot familyNames does not affect loomState', async () => {
  await seedSnapshotFixture()
  const snapshot = getLoomSnapshot()
  const originalLength = loomState.threads[0]!.familyNames.length
  snapshot.threads[0]!.familyNames.push('phantom')

  expect(loomState.threads[0]!.familyNames.length).toBe(originalLength)
  expect(loomState.threads[0]!.familyNames.includes('phantom')).toBe(false)
})

test('fresh initLoom snapshot shows no phantom target and no touched thread', async () => {
  await seedSnapshotFixture()
  const snapshot = getLoomSnapshot()

  expect(snapshot.phantomActive).toBe(false)
  expect(snapshot.touchedThreadIndex).toBe(-1)
  for (const thread of snapshot.threads) {
    expect(thread.isTouched).toBe(false)
    expect(thread.isPhantomTarget).toBe(false)
  }
})

test('triggerPhantomHover is reflected in snapshot phantom fields', async () => {
  await seedSnapshotFixture()
  triggerPhantomHover(0, 'a0', 100)
  const snapshot = getLoomSnapshot()

  expect(snapshot.phantomActive).toBe(true)
  expect(snapshot.threads[0]!.isPhantomTarget).toBe(true)
  expect(snapshot.threads[1]!.isPhantomTarget).toBe(false)
})
