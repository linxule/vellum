import { beforeEach, expect, test } from 'bun:test'
import { pathXAtY, computePath, diveGaussian, widthAtY } from '../../src/loom/path.js'
import { aperture } from '../../src/loom/aperture.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { installViewport, makeMouse } from './helpers.js'

function stubThread(overrides: Record<string, unknown> = {}) {
  return {
    xCenter: 320,
    pathSeed: 1.2,
    restingDepth: 1,
    ampMult: 1,
    proximity: 0,
    related: 0,
    breathRate: 0.0002,
    currentResponse: 0.5,
    _path: Array.from({ length: 61 }, () => ({ x: 0, y: 0 })),
    ...overrides,
  } as any
}

beforeEach(() => {
  resetLoomState()
  installViewport(640, 480)
  loomState.VW = innerWidth
  loomState.VH = innerHeight
  loomState.current = 0.2
})

test('pathXAtY interpolates on a non-zero path', () => {
  expect(pathXAtY([{ x: 10, y: 0 }, { x: 30, y: 100 }], 50)).toBe(20)
})

test('pathXAtY returns 0 for the all-zero bootstrap trap', () => {
  expect(pathXAtY([{ x: 0, y: 0 }, { x: 0, y: 0 }], 60)).toBe(0)
})

test('computePath populates non-zero coordinates when xCenter > 0', () => {
  const thread = stubThread()
  computePath(thread, 32, makeMouse() as any, aperture(innerWidth))
  expect(thread._path.some((point: { x: number }) => point.x !== 0)).toBe(true)
})

test('diveGaussian peaks at cursor and decays outward', () => {
  expect(diveGaussian(100, 100, 20)).toBe(1)
  expect(diveGaussian(120, 100, 20)).toBeLessThan(1)
  expect(diveGaussian(140, 100, 20)).toBeLessThan(diveGaussian(120, 100, 20))
})

test('widthAtY widens near the hand and stays at rest far away', () => {
  const rest = widthAtY(0, 300, 1, 400, 60)
  const near = widthAtY(300, 300, 1, 400, 60)
  expect(rest).toBeLessThan(near)
  expect(widthAtY(120, 300, 0, 400, 60)).toBe(60)
})
