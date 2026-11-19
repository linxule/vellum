import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { keyOf } from '../../src/audio/phrase.js'
import { enablePaper, paper, resetPaperForTest, setPaperStock } from '../../src/loom/paper.js'
import { initialSheet, stockFor } from '../../src/sketch.js'

// The parts of the sketch's start-up that need no page: day or night, and
// which paper an ocean is printed on.

beforeEach(() => resetPaperForTest())
afterEach(() => resetPaperForTest())
afterAll(() => resetPaperForTest())

describe('day or night at start', () => {
  test('without ?paper the sheet follows the system setting', () => {
    expect(initialSheet(null, true)).toEqual({ following: true, night: true })
    expect(initialSheet(null, false)).toEqual({ following: true, night: false })
  })

  test('?paper=day or ?paper=night fixes the sheet whatever the system says', () => {
    expect(initialSheet('day', true)).toEqual({ following: false, night: false })
    expect(initialSheet('night', false)).toEqual({ following: false, night: true })
  })

  test('an unknown ?paper value is ignored', () => {
    expect(initialSheet('sepia', true)).toEqual({ following: true, night: true })
  })
})

describe('an ocean\'s paper', () => {
  const slugs = ['harbour', 'tide-pool', 'a', 'night-garden', 'kelp', 'lagoon', 'reef-7', 'estuary', 'salt', 'fathom']

  test('the default ocean is printed on the first stock', () => {
    expect(stockFor('vellum', 0)).toBeNull()
  })

  test('every other ocean is printed on a stock of its own, never the default\'s, and always the same one', () => {
    enablePaper()
    const cream = setPaperStock(null)
    for (const slug of slugs) {
      const first = setPaperStock(stockFor(slug, keyOf(slug)))
      expect(first).not.toBe(cream)
      expect(setPaperStock(stockFor(slug, keyOf(slug)))).toBe(first)
    }
  })

  test('oceans in different keys mostly differ in paper too', () => {
    enablePaper()
    const papers = new Set(slugs.map(slug => setPaperStock(stockFor(slug, keyOf(slug)))))
    expect(papers.size).toBeGreaterThan(2)
  })
})
