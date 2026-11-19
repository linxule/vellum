import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cancelDrops, configureDrops, dropsPending, notesFor, playVoice, recentlyPlayed, resetDropsForTest, tickDrops, type DropVoice } from '../../src/audio/drops'

// The schedule runs without sound (no AudioContext here, as in the ext-app):
// each note that falls is reported to the listener, which draws its ring.

const voices: DropVoice[] = [
  { id: 'v:a', text: 'One thing, then another, then a third; and a rest.', family: 'attention', depth: 0, weaveFrom: null, weaveCount: 0, afterglow: false },
  { id: 'v:b', text: 'A second voice, with its own shape, and its own end.', family: 'memory', depth: 0, weaveFrom: null, weaveCount: 0, afterglow: false },
]
const lookup = (id: string) => voices.find(v => v.id === id) ?? null

let clock = 0
let fallen: Array<{ family: string, at: number }> = []
const realNow = performance.now
const point = () => ({ x: 100, y: 100 })
const noIdle = () => null

function run(ms: number, lens: { id: string, x: number, y: number } | null = null, stepMs = 16): void {
  const end = clock + ms
  while (clock < end) {
    clock += stepMs
    tickDrops({ lens, viewportWidth: 800, proximity: 0, idle: noIdle })
  }
}

beforeEach(() => {
  clock = 1000
  fallen = []
  performance.now = () => clock
  resetDropsForTest()
  configureDrops({ lookup, onDrop: (family) => { fallen.push({ family, at: clock }) } })
  resetDropsForTest()
})
afterEach(() => { performance.now = realNow })

describe('the note schedule', () => {
  test('a phrase falls one note at a time, in order, at its own times', () => {
    const notes = notesFor(voices[0]!, lookup)
    const started = clock
    const length = playVoice('v:a', { point, group: 'passage' })
    expect(length).toBeCloseTo(notes[notes.length - 1]!.at, 6)
    run(length * 1000 + 600)
    expect(fallen).toHaveLength(notes.length)
    for (let i = 0; i < notes.length; i++) {
      const due = started + 200 + notes[i]!.at * 1000
      expect(fallen[i]!.at).toBeGreaterThanOrEqual(due)
      expect(fallen[i]!.at).toBeLessThan(due + 40)
    }
    expect(dropsPending()).toBe(false)
  })

  test('an unknown voice plays nothing', () => {
    expect(playVoice('v:missing', { point })).toBe(0)
    expect(dropsPending()).toBe(false)
  })

  test('cancelling a group stops its remaining notes and leaves other groups alone', () => {
    playVoice('v:a', { point, group: 'lineage' })
    playVoice('v:b', { point, group: 'passage', delay: 0.1 })
    run(260)
    const before = fallen.length
    expect(before).toBeGreaterThan(0)
    cancelDrops('lineage')
    expect(dropsPending('lineage')).toBe(false)
    expect(dropsPending('passage')).toBe(true)
    run(8000)
    expect(fallen.slice(before).every(f => f.family === 'memory')).toBe(true)
  })

  test('a voice cut short may be heard again; one that finished may not, for a while', () => {
    playVoice('v:a', { point, group: 'lens' })
    run(260)
    cancelDrops('lens')
    expect(recentlyPlayed('v:a', 9000)).toBe(false)
    playVoice('v:b', { point, group: 'lens' })
    run(8000)
    expect(recentlyPlayed('v:b', 9000)).toBe(true)
  })

  test('after the page was away, late notes are dropped instead of falling in a bunch', () => {
    const notes = notesFor(voices[0]!, lookup)
    playVoice('v:a', { point, group: 'passage' })
    run(260)
    const before = fallen.length
    clock += 20000
    run(200)
    expect(fallen.length).toBe(before)
    expect(before).toBeLessThan(notes.length)
    expect(dropsPending()).toBe(false)
  })
})

describe('the lens as playhead', () => {
  const lensA = { id: 'v:a', x: 50, y: 60 }
  const lensB = { id: 'v:b', x: 70, y: 80 }

  test('a voice sounds only after the lens has rested on it', () => {
    run(200, lensA)
    expect(dropsPending('lens')).toBe(false)
    run(200, lensA)
    expect(dropsPending('lens')).toBe(true)
  })

  test('moving to another voice stops the first; only one phrase plays at a time', () => {
    run(700, lensA)
    expect(fallen.length).toBeGreaterThan(0)
    const moved = clock
    run(6000, lensB)
    // The first phrase runs on until the second begins (the rest on the new
    // voice, plus the notes already handed to the audio clock), then stops.
    const handover = moved + 300 + 200 + 32
    expect(fallen.filter(f => f.at > handover).every(f => f.family === 'memory')).toBe(true)
    expect(fallen.filter(f => f.family === 'memory').length).toBe(notesFor(voices[1]!, lookup).length)
    expect(fallen.filter(f => f.family === 'attention').length).toBeLessThan(notesFor(voices[0]!, lookup).length)
  })

  test('a flicker between two voices under the lens does not keep the first from sounding', () => {
    // While the lens opens, the voice under it can change every frame.
    for (let i = 0; i < 40; i++) {
      clock += 16
      tickDrops({ lens: i % 2 === 0 ? lensA : lensB, viewportWidth: 800, proximity: 0, idle: noIdle })
    }
    expect(dropsPending('lens')).toBe(true)
    run(6000, lensA)
    expect(fallen.every(f => f.family === 'attention')).toBe(true)
    expect(fallen.length).toBe(notesFor(voices[0]!, lookup).length)
  })

  test('a voice glimpsed for a moment does not cut the phrase that is playing', () => {
    run(700, lensA)
    run(100, lensB)
    run(6000, lensA)
    expect(fallen.every(f => f.family === 'attention')).toBe(true)
    expect(fallen.length).toBe(notesFor(voices[0]!, lookup).length)
  })

  test('a moment without a voice under the lens does not stop the phrase; leaving does', () => {
    run(600, lensA)
    run(200, null)
    expect(dropsPending('lens')).toBe(true)
    run(700, null)
    expect(dropsPending('lens')).toBe(false)
  })

  test('the same voice is not repeated while the lens stays on it', () => {
    const notes = notesFor(voices[0]!, lookup).length
    run(12000, lensA)
    expect(fallen.length).toBe(notes)
  })

  test('an arrival passage is not talked over by the lens', () => {
    playVoice('v:b', { point, group: 'passage' })
    run(600, lensA)
    expect(dropsPending('lens')).toBe(false)
    run(8000, lensA)
    expect(fallen.some(f => f.family === 'attention')).toBe(true)
  })

  test('a phrase started by the lens replaces a lineage that was playing', () => {
    playVoice('v:b', { point, group: 'lineage' })
    run(600, lensA)
    expect(dropsPending('lineage')).toBe(false)
  })
})
