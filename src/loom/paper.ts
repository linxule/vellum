// Paper look (sketch): ink on a paper ground instead of light on a dark sea.
// Leaf module. `paper.on` is false by default, so every paint path is unchanged
// until an entry point calls enablePaper() before initLoom().
//
// Two sheets: by day, spot inks on cream paper; by night, pale pigment on
// indigo-dyed paper. The inks and the paper are swapped in place, so every
// colour read from FAMILY_COLOR or PAPER_RGB follows the sheet.

import { AFTERGLOW_SILVER, DEFAULT_COLOR, FAMILY_COLOR } from './types.js'

type RGB = readonly [number, number, number]

export const paper = {
  on: false,
  night: false,
  // Thin dark type on a light ground reads fainter than light type on dark.
  alphaGain: 1.3,
  // Extra pigment for the line being drawn (0..1), set around one draw call:
  // text stays on the sheet between frames, so a line shows more ink by its
  // colour, not by its opacity.
  lineInk: 0,
  // How far the line being drawn still lies under the paper (0..1), set around one
  // draw call: an arriving voice's lines rise into their ink from the paper's own
  // colour (render/thread.ts). By colour, not opacity, for the same reason as lineInk.
  lineFaint: 0,
  // Diagnostic (?probe&water=0): the sheet without its water, to measure what the water costs.
  noWater: false,
}
const ALPHA_GAIN_DAY = 1.3
const ALPHA_GAIN_NIGHT = 1.12

export const PAPER_RGB: [number, number, number] = [242, 234, 217]

// Six spot inks, one per current. Hues follow the sea palette they replace.
export const INK: Record<string, RGB> = {
  attention: [0, 108, 182],    // medium blue
  silence: [72, 60, 150],      // indigo
  space: [0, 132, 138],        // teal
  ephemeral: [214, 36, 132],   // fluorescent pink, deep enough to read
  memory: [16, 136, 88],       // green
  light: [212, 78, 20],        // persimmon
}
// The same six as pale pigment, for the indigo sheet.
export const NIGHT_INK: Record<string, RGB> = {
  attention: [116, 180, 240],
  silence: [164, 152, 238],
  space: [84, 204, 200],
  ephemeral: [255, 124, 192],
  memory: [104, 208, 156],
  light: [252, 160, 98],
}
const SUMI: RGB = [70, 74, 92]
const GOFUN: RGB = [198, 200, 216]       // shell white, the night's neutral
const GRAPHITE: RGB = [126, 128, 134]
const NIGHT_GRAPHITE: RGB = [138, 142, 162]

// Each ocean is printed on its own stock; the default ocean keeps the first.
const STOCKS: ReadonlyArray<RGB> = [
  [242, 234, 217], // cream
  [236, 236, 226], // rice
  [228, 233, 233], // rain
  [243, 230, 223], // shell
  [230, 236, 221], // tea
  [240, 232, 204], // straw
]
const NIGHT_STOCKS: ReadonlyArray<RGB> = [
  [26, 31, 58],    // indigo
  [31, 33, 50],    // slate
  [21, 35, 56],    // rain at night
  [38, 28, 55],    // plum
  [23, 38, 47],    // pine
  [37, 32, 45],    // dusk
]

let stock = 0
const live: Record<string, [number, number, number]> = {}

function copy(into: number[], from: RGB): void { into[0] = from[0]; into[1] = from[1]; into[2] = from[2] }

function apply(): string {
  const inks = paper.night ? NIGHT_INK : INK
  for (const name of Object.keys(INK)) copy(live[name]!, inks[name]!)
  copy(DEFAULT_COLOR as unknown as number[], paper.night ? GOFUN : SUMI)
  // Afterglow signatures were silver light; on paper they are pencil.
  copy(AFTERGLOW_SILVER as unknown as number[], paper.night ? NIGHT_GRAPHITE : GRAPHITE)
  copy(PAPER_RGB, (paper.night ? NIGHT_STOCKS : STOCKS)[stock]!)
  paper.alphaGain = paper.night ? ALPHA_GAIN_NIGHT : ALPHA_GAIN_DAY
  return `rgb(${PAPER_RGB[0]},${PAPER_RGB[1]},${PAPER_RGB[2]})`
}

export function enablePaper(): void {
  paper.on = true
  const families = FAMILY_COLOR as Record<string, RGB>
  for (const name of Object.keys(INK)) families[name] = live[name] ??= [0, 0, 0]
  apply()
}

/**
 * Picks the stock for a surface (a number worked out from its slug; null is
 * the default ocean) and returns the paper as a CSS colour.
 */
export function setPaperStock(n: number | null): string {
  const others = STOCKS.length - 1
  stock = n === null ? 0 : 1 + (((n % others) + others) % others)
  return paper.on ? apply() : `rgb(${PAPER_RGB[0]},${PAPER_RGB[1]},${PAPER_RGB[2]})`
}

// Test-only: the sea palette as it stood before enablePaper() touched it.
const SEA_FAMILY = { ...FAMILY_COLOR }
const SEA_DEFAULT: RGB = [DEFAULT_COLOR[0], DEFAULT_COLOR[1], DEFAULT_COLOR[2]]
const SEA_SILVER: RGB = [AFTERGLOW_SILVER[0], AFTERGLOW_SILVER[1], AFTERGLOW_SILVER[2]]
const FLAGS = { ...paper }

/** Test-only: paper off, flags at their defaults, the sea palette back in place. */
export function resetPaperForTest(): void {
  Object.assign(paper, FLAGS)
  stock = 0
  const families = FAMILY_COLOR as Record<string, RGB>
  for (const name of Object.keys(SEA_FAMILY)) families[name] = SEA_FAMILY[name]!
  copy(DEFAULT_COLOR as unknown as number[], SEA_DEFAULT)
  copy(AFTERGLOW_SILVER as unknown as number[], SEA_SILVER)
  copy(PAPER_RGB, STOCKS[0]!)
}

/**
 * Turns the sheet over: day or night. Returns the paper as a CSS colour.
 * Currents mixed their colour when they were built: call recolorLoom() after.
 */
export function setNight(night: boolean): string {
  paper.night = night
  return paper.on ? apply() : `rgb(${PAPER_RGB[0]},${PAPER_RGB[1]},${PAPER_RGB[2]})`
}
