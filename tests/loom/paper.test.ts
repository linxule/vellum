import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { threadColor } from '../../src/loom/color.js'
import { enablePaper, INK, NIGHT_INK, paper, PAPER_RGB, resetPaperForTest, setNight, setPaperStock } from '../../src/loom/paper.js'
import { AFTERGLOW_SILVER, DEFAULT_COLOR, FAMILY_COLOR } from '../../src/loom/types.js'

// The sheet is module state shared with every other test file: put the sea back
// after each test, or the golden frame tests would be painting in ink.
beforeEach(() => resetPaperForTest())
afterEach(() => resetPaperForTest())
afterAll(() => resetPaperForTest())

const SEA = Object.fromEntries(Object.entries(FAMILY_COLOR).map(([k, v]) => [k, [...v]]))
const SEA_DEFAULT = [...DEFAULT_COLOR]
const SEA_SILVER = [...AFTERGLOW_SILVER]
const css = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`
const brightness = (c: readonly number[]) => c[0]! + c[1]! + c[2]!

describe('the sheet', () => {
  test('paper is off by default and the sea palette is untouched', () => {
    expect(paper.on).toBe(false)
    expect(paper.night).toBe(false)
    for (const [name, rgb] of Object.entries(SEA)) expect([...FAMILY_COLOR[name]!]).toEqual(rgb)
  })

  test('turning the paper on inks every current and leaves no family on its sea colour', () => {
    enablePaper()
    expect(paper.on).toBe(true)
    for (const name of Object.keys(INK)) {
      expect([...FAMILY_COLOR[name]!]).toEqual([...INK[name]!])
      expect([...FAMILY_COLOR[name]!]).not.toEqual(SEA[name])
    }
    // The fallback colour and the afterglow signature are pigment too, and darker than the sea's.
    expect(brightness(DEFAULT_COLOR)).toBeLessThan(brightness(SEA_DEFAULT))
    expect(brightness(AFTERGLOW_SILVER)).toBeLessThan(brightness(SEA_SILVER))
  })

  test('day ink is darker than the paper; night ink is lighter than the paper', () => {
    enablePaper()
    for (const name of Object.keys(INK)) expect(brightness(FAMILY_COLOR[name]!)).toBeLessThan(brightness(PAPER_RGB))
    setNight(true)
    for (const name of Object.keys(INK)) expect(brightness(FAMILY_COLOR[name]!)).toBeGreaterThan(brightness(PAPER_RGB))
  })

  test('turning the sheet over changes the inks in place, so a colour read earlier follows', () => {
    enablePaper()
    const held = FAMILY_COLOR.memory!
    const paperHeld = PAPER_RGB
    const dayPaper = [...PAPER_RGB]
    const dayGain = paper.alphaGain
    const night = setNight(true)
    expect(FAMILY_COLOR.memory).toBe(held)
    expect([...held]).toEqual([...NIGHT_INK.memory!])
    expect(paperHeld).toBe(PAPER_RGB)
    expect([...PAPER_RGB]).not.toEqual(dayPaper)
    expect(night).toBe(css(PAPER_RGB))
    // Light type on a dark ground needs less help than dark type on cream.
    expect(paper.alphaGain).toBeLessThan(dayGain)
    expect(paper.alphaGain).toBeGreaterThan(1)

    const day = setNight(false)
    expect([...held]).toEqual([...INK.memory!])
    expect([...PAPER_RGB]).toEqual(dayPaper)
    expect(paper.alphaGain).toBe(dayGain)
    expect(day).toBe(css(dayPaper))
  })

  test('with the paper off, turning the sheet over changes no colour; enabling later honours it', () => {
    const before = [...PAPER_RGB]
    const result = setNight(true)
    expect(paper.night).toBe(true)
    expect([...PAPER_RGB]).toEqual(before)
    expect(result).toBe(css(before))
    expect([...FAMILY_COLOR.attention!]).toEqual(SEA.attention!)
    enablePaper()
    expect([...FAMILY_COLOR.attention!]).toEqual([...NIGHT_INK.attention!])
  })

  test('the reset puts the sea back exactly, however the sheet was left', () => {
    enablePaper()
    setNight(true)
    setPaperStock(3)
    paper.lineInk = 0.7
    resetPaperForTest()
    expect(paper.on).toBe(false)
    expect(paper.night).toBe(false)
    expect(paper.lineInk).toBe(0)
    for (const [name, rgb] of Object.entries(SEA)) expect([...FAMILY_COLOR[name]!]).toEqual(rgb)
    expect([...DEFAULT_COLOR]).toEqual(SEA_DEFAULT)
    expect([...AFTERGLOW_SILVER]).toEqual(SEA_SILVER)
    expect(setPaperStock(null)).toBe('rgb(242,234,217)')
  })
})

describe('paper stock', () => {
  test('the default ocean is printed on the first stock, every other ocean on another', () => {
    enablePaper()
    const cream = setPaperStock(null)
    const seen = new Set<string>()
    for (let n = -20; n <= 20; n++) {
      const stock = setPaperStock(n)
      expect(stock).not.toBe(cream)
      seen.add(stock)
    }
    expect(seen.size).toBe(5)
  })

  test('the stock repeats every five, negative numbers included', () => {
    enablePaper()
    for (const n of [-7, -1, 0, 3, 11]) expect(setPaperStock(n)).toBe(setPaperStock(n + 5))
  })

  test('each stock has its night side, and turning the sheet keeps the stock', () => {
    enablePaper()
    const dayA = setPaperStock(1)
    const nightA = setNight(true)
    expect(nightA).not.toBe(dayA)
    const nightB = setPaperStock(2)
    expect(nightB).not.toBe(nightA)
    const dayB = setNight(false)
    expect(dayB).not.toBe(dayA)
    expect(setPaperStock(1)).toBe(dayA)
    expect(setNight(true)).toBe(nightA)
  })

  test('with the paper off, a stock is remembered and used once the paper is on', () => {
    const offCss = setPaperStock(4)
    expect(offCss).toBe('rgb(242,234,217)')
    enablePaper()
    expect(css(PAPER_RGB)).not.toBe(offCss)
    expect(css(PAPER_RGB)).toBe(setPaperStock(4))
  })
})

describe('threadColor on paper', () => {
  const base = [0, 108, 182] as const

  test('paper off: the sea formula is untouched by the paper flags', () => {
    const sea = [...threadColor(base, 0.8, 0.2)]
    paper.lineInk = 1
    paper.night = true
    expect([...threadColor(base, 0.8, 0.2)]).toEqual(sea)
  })

  test('day: at full attention the ink is printed as it is', () => {
    enablePaper()
    expect([...threadColor(base, 1, 0)]).toEqual([0, 108, 182])
  })

  test('day: less attention lets the paper through; more, a glow or a ring deepens the pigment', () => {
    enablePaper()
    const plain = brightness(threadColor(base, 1, 0))
    const faint = [...threadColor(base, 0.4, 0)]
    // Thinned toward the paper, never past it.
    for (let i = 0; i < 3; i++) {
      expect(faint[i]!).toBeGreaterThanOrEqual(Math.min(base[i]!, PAPER_RGB[i]!))
      expect(faint[i]!).toBeLessThanOrEqual(Math.max(base[i]!, PAPER_RGB[i]!))
    }
    expect(brightness(faint)).toBeGreaterThan(plain)
    expect(brightness(threadColor(base, 1.3, 0))).toBeLessThan(plain)
    expect(brightness(threadColor(base, 1, 0.5))).toBeLessThan(plain)
    paper.lineInk = 1
    expect(brightness(threadColor(base, 1, 0))).toBeLessThan(plain)
  })

  test('day: however much is added, the ink never goes black', () => {
    enablePaper()
    paper.lineInk = 1
    const c = threadColor([200, 200, 200], 1.3, 1)
    // `deep` is floored at 0.3 of the ink.
    expect([...c]).toEqual([60, 60, 60])
  })

  test('night: attention, a glow and a ring lift the pale pigment toward white', () => {
    enablePaper()
    setNight(true)
    const ink = NIGHT_INK.attention!
    const plain = [...threadColor(ink, 1, 0)]
    expect(plain).toEqual([...ink])
    expect(brightness(threadColor(ink, 1, 0.5))).toBeGreaterThan(brightness(plain))
    expect(brightness(threadColor(ink, 1.3, 0))).toBeGreaterThan(brightness(plain))
    paper.lineInk = 0.5
    expect(brightness(threadColor(ink, 1, 0))).toBeGreaterThan(brightness(plain))
    // A full lift is white, and no channel passes 255.
    paper.lineInk = 1
    expect([...threadColor(ink, 1.3, 1)]).toEqual([255, 255, 255])
  })

  test('night: less attention sinks the pigment toward the indigo paper', () => {
    enablePaper()
    setNight(true)
    const ink = NIGHT_INK.light!
    expect(brightness(threadColor(ink, 0.3, 0))).toBeLessThan(brightness(threadColor(ink, 1, 0)))
  })

  test('every paper colour is a whole number within 0..255', () => {
    enablePaper()
    for (const night of [false, true]) {
      setNight(night)
      for (const b of [0, 0.37, 1, 1.3, 5]) {
        for (const g of [0, 0.5, 1]) {
          for (const li of [0, 0.4, 1]) {
            paper.lineInk = li
            for (const ch of threadColor([13, 250, 128], b, g)) {
              expect(Number.isInteger(ch)).toBe(true)
              expect(ch).toBeGreaterThanOrEqual(0)
              expect(ch).toBeLessThanOrEqual(255)
            }
          }
        }
      }
    }
  })
})
