import { expect, test } from 'bun:test'
import { lerp, smoothstep, depthLerp, fontSizeForScale, fontRatioForScale } from '../../src/loom/math.js'

test('lerp interpolates midpoint', () => {
  expect(lerp(0, 10, 0.5)).toBe(5)
})

test('smoothstep handles edges and midpoint', () => {
  expect(smoothstep(-1)).toBe(0)
  expect(smoothstep(0)).toBe(0)
  expect(smoothstep(0.5)).toBe(0.5)
  expect(smoothstep(1)).toBe(1)
  expect(smoothstep(2)).toBe(1)
})

test('depthLerp interpolates continuous depth tiers', () => {
  expect(depthLerp([10, 20, 40], 0)).toBe(10)
  expect(depthLerp([10, 20, 40], 0.5)).toBe(15)
  expect(depthLerp([10, 20, 40], 1.5)).toBe(30)
})

test('font helpers stay stable at small scales', () => {
  expect(fontSizeForScale(0.2)).toBeGreaterThanOrEqual(1)
  expect(fontRatioForScale(0.2)).toBeCloseTo(fontSizeForScale(0.2) / 15, 6)
  expect(fontSizeForScale(0.45)).toBe(7)
})
