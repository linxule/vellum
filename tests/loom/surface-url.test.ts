import { expect, test } from 'bun:test'
import { surfaceFromPathname, surfacePathPrefix, highlightUrlFor, setSurface, getSurface } from '../../src/content.js'

// Phase 18 "The Archipelago" Part B5 (D2's S15) — pure functions only. No canvas tests change.

test('surfaceFromPathname: the default ocean for /, and for any non-/s/ path', () => {
  expect(surfaceFromPathname('/')).toBe('vellum')
  expect(surfaceFromPathname('/ext-app')).toBe('vellum')
  expect(surfaceFromPathname('')).toBe('vellum')
})

test('surfaceFromPathname: extracts the slug from /s/<slug> and /s/<slug>/...', () => {
  expect(surfaceFromPathname('/s/tidepool')).toBe('tidepool')
  expect(surfaceFromPathname('/s/tidepool/')).toBe('tidepool')
  expect(surfaceFromPathname('/s/tidepool/api/state')).toBe('tidepool')
})

test('surfaceFromPathname: rejects an invalid slug shape, falling back to the default', () => {
  expect(surfaceFromPathname('/s/AB')).toBe('vellum') // uppercase not allowed
  expect(surfaceFromPathname('/s/a')).toBe('vellum') // too short (min 3 for a bare 1-char match)
})

test('surfacePathPrefix: empty for the default surface, /s/<slug> otherwise', () => {
  expect(surfacePathPrefix('vellum')).toBe('')
  expect(surfacePathPrefix('tidepool')).toBe('/s/tidepool')
})

test('highlightUrlFor: preserves whatever path prefix the page is already on', () => {
  expect(highlightUrlFor('/', 'v:abc123')).toBe('/?highlight=v:abc123')
  expect(highlightUrlFor('/s/tidepool', 'v:abc123')).toBe('/s/tidepool?highlight=v:abc123')
})

test('setSurface/getSurface round-trip', () => {
  setSurface('tidepool')
  expect(getSurface()).toBe('tidepool')
  setSurface('vellum')
  expect(getSurface()).toBe('vellum')
})
