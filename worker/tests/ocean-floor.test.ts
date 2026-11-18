import { expect, test } from 'bun:test'
import { selectProjectedVoices } from '../src/cache'
import { OCEAN } from '../src/contract'

type V = { id: string; depth: number; permanent?: boolean }
const isFoundation = (v: V) => v.permanent === true
const voices = (n: number, depthOf: (i: number) => number, prefix = 'v'): V[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, depth: depthOf(i) }))

test('a quiet current is topped up to the floor with its shallowest sunken voices', () => {
  // 4 unsunk, 90 sunken at increasing depth: the 2026-11-18 "attention" current.
  const all = [...voices(4, i => 0.1 * i, 'fresh'), ...voices(90, i => 0.75 + i * 0.002, 'old')]
  const out = selectProjectedVoices(all, isFoundation)
  expect(out.length).toBe(OCEAN.floorPerFamily)
  expect(out.filter(v => v.id.startsWith('fresh')).length).toBe(4)
  const sunken = out.filter(v => v.depth >= OCEAN.sunkenDepth)
  expect(sunken.length).toBe(OCEAN.floorPerFamily - 4)
  // The shallowest ones, not an arbitrary 36.
  expect(Math.max(...sunken.map(v => v.depth))).toBeCloseTo(0.75 + 35 * 0.002, 10)
})

test('a current with no unsunk voice at all still shows the floor', () => {
  const out = selectProjectedVoices(voices(53, i => 0.8 + i * 0.001), isFoundation)
  expect(out.length).toBe(OCEAN.floorPerFamily)
})

test('a busy current is unchanged: unsunk voices only, capped, no sunken ones', () => {
  const all = [...voices(70, i => i * 0.009), ...voices(30, i => 0.8 + i * 0.001, 'old')]
  const out = selectProjectedVoices(all, isFoundation)
  expect(out.length).toBe(OCEAN.surfaceCap)
  expect(out.every(v => v.depth < OCEAN.sunkenDepth)).toBe(true)
  const exactlyFloor = selectProjectedVoices([...voices(40, i => i * 0.01), ...voices(30, () => 0.9, 'old')], isFoundation)
  expect(exactlyFloor.length).toBe(40)
  expect(exactlyFloor.every(v => v.depth < OCEAN.sunkenDepth)).toBe(true)
})

test('foundation voices are always kept and count toward the floor', () => {
  const foundation: V[] = [{ id: 'root', depth: 0.1, permanent: true }]
  const out = selectProjectedVoices([...foundation, ...voices(60, i => 0.71 + i * 0.001)], isFoundation)
  expect(out.length).toBe(OCEAN.floorPerFamily)
  expect(out[0]!.id).toBe('root')
  // Many foundation voices: none dropped, no sunken filler added.
  const many: V[] = Array.from({ length: 45 }, (_, i) => ({ id: `f${i}`, depth: 0.1, permanent: true }))
  const full = selectProjectedVoices([...many, ...voices(20, () => 0.9)], isFoundation)
  expect(full.length).toBe(45)
})

test('a small current shows everything it has', () => {
  expect(selectProjectedVoices(voices(7, i => 0.5 + i * 0.07), isFoundation).length).toBe(7)
  expect(selectProjectedVoices([], isFoundation)).toEqual([])
})
