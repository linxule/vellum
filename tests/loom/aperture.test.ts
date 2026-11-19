import { expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'

test('small viewport aperture stays touch-friendly', () => {
  const ac = aperture(350)
  expect(ac.visibleThreads).toBeGreaterThanOrEqual(8)
  expect(ac.diveLineH).toBeCloseTo(29, 0)
  expect(ac.touchRadius).toBeGreaterThan(130)
  expect(ac.touchRadius).toBeLessThan(150)
})

test('medium viewport aperture sits between small and large', () => {
  const ac = aperture(900)
  expect(ac.visibleThreads).toBeGreaterThanOrEqual(9)
  expect(ac.visibleThreads).toBeLessThanOrEqual(11)
  expect(ac.diveLineH).toBeGreaterThan(30)
  expect(ac.diveLineH).toBeLessThan(35)
})

test('large viewport aperture reaches desktop target', () => {
  const ac = aperture(1440)
  expect(ac.visibleThreads).toBe(12)
  expect(ac.diveLineH).toBe(36)
  expect(ac.touchRadius).toBeCloseTo(202, -1)
})

test('extreme narrow viewport aperture clamps maxThreads to 8', () => {
  const ac = aperture(100)
  expect(ac.maxThreads).toBe(8)
  expect(ac.visibleThreads).toBe(8)
  expect(ac.baseDimming).toBeGreaterThan(0.25)
  expect(ac.baseDimming).toBeLessThan(0.31)
})

test('extreme wide viewport aperture saturates at desktop target', () => {
  const ac = aperture(3200)
  // smoothstep(3200/1440) >= 1 → all lerps return their right-hand bound
  expect(ac.maxThreads).toBe(12)
  expect(ac.visibleThreads).toBe(12)
  expect(ac.baseDimming).toBe(0)
  expect(ac.diveLineH).toBe(36)
})

test('aperture voiceSeparation activates only above t > 0.3', () => {
  // voiceSeparation uses smoothstep((t - 0.3) / 0.5), so t <= 0.3 yields 0
  const narrow = aperture(400)
  expect(narrow.voiceSeparation).toBe(0)
  const wide = aperture(1440)
  expect(wide.voiceSeparation).toBeGreaterThan(0.9)
})

test('a short window gets a smaller lens; from 600 px tall nothing changes', () => {
  const tall = aperture(720, 900)
  expect(aperture(720)).toEqual(tall)
  expect(aperture(720, 600)).toEqual(tall)
  const inline = aperture(720, 320)   // an inline ext-app
  expect(inline.diveScale).toBeLessThan(tall.diveScale * 0.82)
  expect(inline.diveScale).toBeGreaterThan(tall.diveScale * 0.77)
  expect(inline.diveLineH / inline.diveScale).toBeCloseTo(tall.diveLineH / tall.diveScale, 6)
  // Still type to read: 15 px base.
  expect(inline.diveScale * 15).toBeGreaterThan(16)
  // Only the lens changes.
  expect({ ...inline, diveScale: 0, diveLineH: 0 }).toEqual({ ...tall, diveScale: 0, diveLineH: 0 })
  expect(aperture(720, 100).diveScale).toBeCloseTo(aperture(720, 300).diveScale, 6)
})
