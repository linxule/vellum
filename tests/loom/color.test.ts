import { expect, test } from 'bun:test'
import { depthColor, threadColor } from '../../src/loom/color.js'

test('depthColor shifts warm to cool across depth', () => {
  const base: [number, number, number] = [100, 120, 140]
  const near = [...depthColor(base, 0)]
  const mid = [...depthColor(base, 1)]
  const deep = [...depthColor(base, 2)]
  expect(near[0]).toBeGreaterThan(base[0])
  expect(mid[2]).toBeGreaterThan(base[2] * 0.99)
  expect(deep[2]).toBeGreaterThan(near[2])
  expect(deep[0]).toBeLessThan(near[0])
})

test('threadColor clamps channels to 255', () => {
  const color = threadColor([250, 250, 250], 1.3, 1)
  expect(color.every(channel => channel <= 255)).toBe(true)
  expect(color).toEqual([252, 252, 252])
})

test('threadColor reuses scratch storage by convention', () => {
  const first = threadColor([120, 130, 140], 0.8, 0.1)
  const snapshot = [...first]
  const second = threadColor([180, 190, 200], 1, 0.2)
  expect(first).toBe(second)
  expect(snapshot).not.toEqual(second)
})
