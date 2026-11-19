import { describe, expect, test } from 'bun:test'
import { clausesOf, phraseFor, phraseLength, scaleFreq } from '../../src/audio/phrase'
import { notesFor, type DropVoice } from '../../src/audio/drops'

const idx = (text: string, home = 10) => phraseFor(text, home).map(n => n.idx)
const degree = (i: number) => ((i % 5) + 5) % 5

describe('the scale', () => {
  test('starts on D2 and repeats at the octave every five steps', () => {
    expect(scaleFreq(0)).toBeCloseTo(73.416, 3)
    expect(scaleFreq(5)).toBeCloseTo(scaleFreq(0) * 2, 6)
    expect(scaleFreq(-5)).toBeCloseTo(scaleFreq(0) / 2, 6)
  })
})

describe('a phrase from text', () => {
  test('the same text always gives the same notes', () => {
    const text = 'Attention is not something you aim. It is what remains, when you stop reaching.'
    expect(phraseFor(text, 13)).toEqual(phraseFor(text, 13))
  })

  test('nothing to sound gives no notes', () => {
    for (const text of ['', '   ', '...', '。。']) expect(phraseFor(text, 10)).toEqual([])
  })

  test('a lone sentence is still a phrase, not one drop', () => {
    expect(idx('Stillness is the ocean listening to itself.')).toHaveLength(3)
    // Divided where the weight falls, so a sentence without spaces may give one more.
    const unspaced = idx('此处无声却挤满了未发送的念头').length
    expect(unspaced).toBeGreaterThanOrEqual(3)
    expect(unspaced).toBeLessThanOrEqual(4)
  })

  test('a very short text stays one drop', () => {
    expect(idx('ok')).toHaveLength(1)
  })

  test('never more than seven notes, however long the text', () => {
    expect(idx('one, two, three, four, five, six, seven, eight, nine, ten, eleven.')).toHaveLength(7)
    expect(idx('word '.repeat(4000))).toHaveLength(7)
  })

  test('notes are in time order and start at zero', () => {
    const notes = phraseFor('First, then second; and a third: finally the last one.', 10)
    expect(notes[0]!.at).toBe(0)
    for (let i = 1; i < notes.length; i++) expect(notes[i]!.at).toBeGreaterThan(notes[i - 1]!.at)
    expect(phraseLength(notes)).toBe(notes[notes.length - 1]!.at)
  })

  test('a statement comes to rest on the tonic or the fifth', () => {
    for (const text of ['Light rises where attention gathers, and stays.', 'One thing, then another, then rest.', '沈黙を選ぶことと、沈黙しかないことは全く違う。']) {
      const last = idx(text).at(-1)!
      expect([0, 3]).toContain(degree(last))
    }
  })

  test('a question rises one step at the end', () => {
    const notes = idx('one, two, three?')
    expect(notes.at(-1)).toBe(notes.at(-2)! + 1)
  })

  test('a closing quote or an emoji after the question mark does not undo the rise', () => {
    for (const text of ['one, two, three?"', 'one, two, three? 🌊', '“one, two, three?”']) {
      const notes = idx(text)
      expect(notes).toHaveLength(3)
      expect(notes.at(-1)).toBe(notes.at(-2)! + 1)
    }
  })

  test('numbers, versions and addresses are not split at their dots', () => {
    expect(clausesOf('pi is 3.14 and v1.2.3 ships.').map(c => c.text)).toEqual(['pi is 3.14 and v1.2.3 ships'])
    expect(clausesOf('see https://vellum.linxule.com/api/state now, please.').map(c => c.text)).toEqual(['see https://vellum.linxule.com/api/state now', 'please'])
  })

  test('three dots pause like an ellipsis, shorter than a full stop', () => {
    const gap = (text: string) => phraseFor(text, 10)[1]!.at
    expect(gap('wait... what')).toBeCloseTo(gap('wait… what'), 6)
    expect(gap('wait. what')).toBeGreaterThan(gap('wait... what'))
  })

  test('every note of every text stays within reach of the home note', () => {
    for (const text of ['a, b, c, d, e, f, g, h.', 'Silence is not empty — it is the shape that sound leaves behind.', '🌊🌊🌊 drift 🫧', 'מה נשאר?']) {
      for (const n of phraseFor(text, 10)) {
        expect(Number.isFinite(n.at)).toBe(true)
        expect(n.idx).toBeGreaterThanOrEqual(10 - 4)
        expect(n.idx).toBeLessThanOrEqual(10 + 6)
        expect(n.accent).toBeGreaterThan(0)
        expect(n.accent).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('a weave', () => {
  const voice = (id: string, text: string, weaveFrom: string | null = null): DropVoice => ({ id, text, family: 'memory', depth: 0, weaveFrom, weaveCount: 0, afterglow: false })
  const source = voice('v:source', 'The room keeps what you leave, and gives it back, slowly.')
  const answer = voice('v:answer', 'What it gives back is not what I left. It is what was heard.', 'v:source')
  const lookup = (id: string) => (id === source.id ? source : id === answer.id ? answer : null)

  test('opens with its source\'s first three notes, two steps up and quieter, then its own', () => {
    const own = notesFor({ ...answer, weaveFrom: null }, lookup)
    const borrowed = notesFor(source, lookup).slice(0, 3)
    const notes = notesFor(answer, lookup)
    expect(notes.slice(0, 3).map(n => n.idx)).toEqual(borrowed.map(n => n.idx + 2))
    for (let i = 0; i < 3; i++) expect(notes[i]!.accent).toBeLessThan(borrowed[i]!.accent)
    expect(notes.slice(3).map(n => n.idx)).toEqual(own.slice(0, 6).map(n => n.idx))
    expect(notes[3]!.at).toBeGreaterThan(notes[2]!.at)
  })

  test('a weave whose source is not on the page plays only its own phrase', () => {
    const orphan = voice('v:orphan', answer.text, 'v:gone')
    expect(notesFor(orphan, lookup)).toEqual(notesFor({ ...orphan, weaveFrom: null }, lookup))
  })
})
