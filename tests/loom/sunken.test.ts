import { beforeEach, expect, test } from 'bun:test'
import { getState, getVoiceIdSets, type Voice } from '../../src/content.js'
import { aperture } from '../../src/loom/aperture.js'
import { initLoom, refreshLoom, renderLoom, resizeLoom } from '../../src/loom/index.js'
import { fontSizeForScale, lerp, sunkenFade } from '../../src/loom/math.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { makeThread } from '../../src/loom/thread.js'
import { SUNKEN_DEPTH, SUNKEN_DIM, SUNKEN_SURFACE_DIVE_T } from '../../src/loom/types.js'
import { computeNewVoiceInfo } from '../../src/runtime/poll-core.js'
import {
  CanvasContextStub,
  createCanvasContext,
  installViewport,
  loadState,
  makeMouse,
  makeState,
  parseRgbaAlpha,
  runFrames,
  withFixedRandom,
} from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

type Call = CanvasContextStub['fillTextCalls'][number]

// Each voice is written in its own word so a painted line names the voices on it.
const FRESH = 'FRESH '.repeat(14)
const HALF = 'HALF '.repeat(16)
const DEEP = 'DEEP '.repeat(16)

let version = 7000

/** One `attention` current holding the three marker voices at the given depths.
 * Returns every paint call, and the calls of one further frame on their own. */
async function paint(
  depths: { fresh?: number, half?: number, deep?: number },
  opts: { lensOn?: string, signed?: boolean } = {},
): Promise<{ all: Call[], last: Call[] }> {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [
    { id: 'fresh', text: FRESH, depth: depths.fresh },
    { id: 'half', text: HALF, depth: depths.half },
    { id: 'deep', text: DEEP, depth: depths.deep, declared_model: opts.signed ? 'claude-opus-4' : null, weave_count: opts.signed ? 1 : 0 },
  ] }], ++version))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const stub = ctx as unknown as CanvasContextStub
  const mouse = makeMouse()
  let start = 0
  withFixedRandom(0.5, () => {
    let now = runFrames(renderLoom, ctx, mouse, 5)
    if (opts.lensOn) {
      triggerPhantomHover(0, opts.lensOn)
      now = runFrames(renderLoom, ctx, mouse, 240, now)
    }
    start = stub.fillTextCalls.length
    renderLoom(ctx, innerWidth, innerHeight, now, 0.016, mouse)
  })
  return { all: stub.fillTextCalls, last: stub.fillTextCalls.slice(start) }
}

const serialize = (calls: Call[]) => calls.map(c => `${c.text}|${c.x}|${c.y}|${c.font}|${String(c.fillStyle)}`).join('\n')
const fontPx = (call: Call) => Number(call.font.match(/(\d+(?:\.\d+)?)px/)![1])

/** The fade a resting line should take: the least sunken of the voices on it. */
function expectedLineFade(text: string, fades: { fresh: number, half: number, deep: number }): number {
  const present: number[] = []
  if (text.includes('FRESH')) present.push(fades.fresh)
  if (text.includes('HALF')) present.push(fades.half)
  if (text.includes('DEEP')) present.push(fades.deep)
  return present.length > 0 ? Math.min(...present) : 0
}

// ── Fade mapping ──────────────────────────────────────────────────────────────

test('sunkenFade maps depth onto 0..1 past the sunken line', () => {
  expect(sunkenFade(0.5)).toBe(0)
  expect(sunkenFade(SUNKEN_DEPTH)).toBe(0)
  expect(sunkenFade(0.85)).toBeCloseTo(0.5, 12)
  expect(sunkenFade(1)).toBe(1)
  expect(sunkenFade(1.6)).toBe(1)
  expect(sunkenFade(undefined)).toBe(0)
})

test('a thread stores only its sunken voices, keyed by base uid', async () => {
  await paint({ fresh: 0.2, half: 0.85, deep: 1.2 })
  const thread = loomState.threads[0]!
  expect([...thread.sunkenUids.keys()]).toEqual([1, 2])
  expect(thread.sunkenUids.get(1)).toBeCloseTo(0.5, 12)
  expect(thread.sunkenUids.get(2)).toBe(1)
})

test('a voice exactly at the sunken line is not stored', async () => {
  await paint({ fresh: 0.2, half: SUNKEN_DEPTH, deep: 0.69 })
  expect(loomState.threads[0]!.sunkenUids.size).toBe(0)
})

test('offline seed voices carry no depth, so nothing is sunken', () => {
  installViewport(960, 640)
  const seed: Voice[] = [
    { text: 'Attention is the rarest form of generosity. ', lang: 'en', families: ['attention'] },
    { text: 'The gap is the point. ', lang: 'en', families: ['space'] },
  ]
  const thread = makeThread(seed, ['attention'], aperture(960), 480, 1, 0, 0, 0)
  expect(thread.sunkenUids.size).toBe(0)
})

// ── Paint ─────────────────────────────────────────────────────────────────────

test('at rest a sunken line loses SUNKEN_DIM x fade of its alpha, in every tiled copy', async () => {
  const fades = { fresh: 0, half: sunkenFade(0.85), deep: 1 }
  const fresh = (await paint({ fresh: 0.2, half: 0.3, deep: 0.4 })).last
  const sunk = (await paint({ fresh: 0.2, half: 0.85, deep: 1.2 })).last

  expect(sunk.length).toBe(fresh.length)
  let dimmedRuns = 0
  let inRun = false
  let deepLines = 0
  let halfLines = 0
  let untouchedLines = 0
  for (let i = 0; i < sunk.length; i++) {
    const call = sunk[i]!
    const before = fresh[i]!
    expect(call.text).toBe(before.text)
    expect(call.x).toBe(before.x)
    expect(call.y).toBe(before.y)
    expect(call.font).toBe(before.font)
    const fade = expectedLineFade(call.text, fades)
    const ratio = parseRgbaAlpha(call.fillStyle) / parseRgbaAlpha(before.fillStyle)
    expect(ratio).toBeCloseTo(1 - SUNKEN_DIM * fade, 9)
    if (fade === 0) {
      // A line carrying any fresh voice is painted exactly as it was.
      expect(call.fillStyle).toBe(before.fillStyle)
      untouchedLines++
    }
    if (fade === 1) deepLines++
    else if (fade > 0) halfLines++
    if (fade > 0 && !inRun) dimmedRuns++
    inRun = fade > 0
  }
  expect(deepLines).toBeGreaterThan(0)
  expect(halfLines).toBeGreaterThan(0)
  expect(untouchedLines).toBeGreaterThan(0)
  // The column tiles the three voices several times; each copy has its own dim run.
  expect(dimmedRuns).toBeGreaterThanOrEqual(2)
})

test('under the open lens a sunken voice paints exactly as a fresh one, signature and woven dot included', async () => {
  const fresh = (await paint({ fresh: 0.2, half: 0.3, deep: 0.4 }, { lensOn: 'deep', signed: true })).last
  const sunk = (await paint({ fresh: 0.2, half: 0.85, deep: 1.2 }, { lensOn: 'deep', signed: true })).last
  expect(loomState.threads[0]!.proximity).toBeGreaterThan(0.9)
  expect(sunk.length).toBe(fresh.length)

  const ac = aperture(960)
  const surfacedFont = fontSizeForScale(lerp(ac.textureScale, ac.diveScale, SUNKEN_SURFACE_DIVE_T))
  let surfacedDeepGlyphs = 0
  let stillDimmed = 0
  let badges = 0
  for (let i = 0; i < sunk.length; i++) {
    const before = fresh[i]!
    const after = sunk[i]!
    expect(after.text).toBe(before.text)
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
    expect(after.font).toBe(before.font)
    if (after.text.startsWith('— ') || after.text === '·') {
      // Badges appear only past the reading gate, where the voice is back at full alpha.
      expect(after.fillStyle).toBe(before.fillStyle)
      badges++
    } else if (fontPx(after) > surfacedFont) {
      // Larger than the font at SUNKEN_SURFACE_DIVE_T means the line is past it.
      expect(after.fillStyle).toBe(before.fillStyle)
      if (/[DP]/.test(after.text)) surfacedDeepGlyphs++
    } else if (after.fillStyle !== before.fillStyle) {
      expect(parseRgbaAlpha(after.fillStyle)).toBeLessThan(parseRgbaAlpha(before.fillStyle))
      stillDimmed++
    }
  }
  expect(surfacedDeepGlyphs).toBeGreaterThan(0)
  expect(badges).toBeGreaterThan(1)
  // Away from the cursor the same current is still at texture size, and still dim.
  expect(stillDimmed).toBeGreaterThan(0)
})

test('a current with no sunken voices paints identically whatever its fresh depths are', async () => {
  for (const lensOn of [undefined, 'deep']) {
    const omitted = serialize((await paint({}, { lensOn, signed: true })).all)
    const explicit = serialize((await paint({ fresh: 0.3, half: 0.69, deep: SUNKEN_DEPTH }, { lensOn, signed: true })).all)
    expect(explicit.length).toBeGreaterThan(1000)
    expect(explicit === omitted).toBe(true)
  }
})

// ── Merged threads, refresh, resize ───────────────────────────────────────────

const TEN = ['attention', 'memory', 'history', 'dream', 'wound', 'gift', 'vision', 'witness', 'silence', 'breath']

function tenFamilies(sunken: Record<string, number[]>, v: number) {
  return makeState(TEN.map(family => ({
    family,
    voices: [0, 1].map(i => ({ id: `${family}-${i}`, text: `${family} voice ${i} `, depth: sunken[family]?.[i] ?? 0.2 })),
  })), v)
}

test('a merged thread keys sunken voices across ALL its families, and refresh rebuilds them', async () => {
  installViewport(240, 640)
  await loadState(tenFamilies({ silence: [0.2, 0.85] }, ++version))
  withFixedRandom(0.5, () => initLoom())

  // 10 families into 8 columns: `silence` (index 8) shares a column with `attention`.
  let merged = loomState.threads.find(t => t.familyNames.includes('silence'))!
  expect(merged.familyNames).toEqual(['attention', 'silence'])
  expect([...merged.sunkenUids.keys()]).toEqual([3])           // 2 attention voices, then silence-1
  expect(merged.sunkenUids.get(3)).toBeCloseTo(0.5, 12)

  await loadState(tenFamilies({ attention: [1, 0.2] }, ++version))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))
  merged = loomState.threads.find(t => t.familyNames.includes('silence'))!
  expect([...merged.sunkenUids]).toEqual([[0, 1]])
})

test('threads split apart by a resize keep their own sunken voices', async () => {
  installViewport(240, 640)
  await loadState(tenFamilies({ silence: [0.2, 1] }, ++version))
  withFixedRandom(0.5, () => initLoom())
  expect(loomState.threads.length).toBe(8)

  installViewport(1440, 900)
  withFixedRandom(0.5, () => resizeLoom())
  const silence = loomState.threads.find(t => t.familyNames.includes('silence'))!
  expect(silence.familyNames).toEqual(['silence'])
  expect([...silence.sunkenUids]).toEqual([[1, 1]])
  const attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
  expect(attention.sunkenUids.size).toBe(0)
})

// ── Arrivals ──────────────────────────────────────────────────────────────────

async function loadEntrants(sunkenEntrantDepth = 0.9) {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION OLD ', depth: 0.3 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY OLD ', depth: 0.3 }] },
  ], ++version))
  withFixedRandom(0.5, () => initLoom())
  const prevIdSets = getVoiceIdSets()
  await loadState(makeState([
    { family: 'attention', voices: [
      { id: 'a0', text: 'ATTENTION OLD ', depth: 0.3 },
      { id: 'a1', text: 'ATTENTION RESURFACED ', depth: sunkenEntrantDepth },
    ] },
    { family: 'memory', voices: [
      { id: 'm0', text: 'MEMORY OLD ', depth: 0.3 },
      { id: 'm1', text: 'MEMORY ARRIVAL ', depth: 0.05 },
    ] },
  ], ++version))
  return { prevIdSets, state: getState()! }
}

test('a sunken entrant is not an arrival; a fresh entrant is', async () => {
  const { prevIdSets, state } = await loadEntrants()
  const info = computeNewVoiceInfo(prevIdSets, getVoiceIdSets(), state)
  expect(info[0]).toEqual({ hasNew: false, newIds: new Set() })
  expect(info[1]).toEqual({ hasNew: true, newIds: new Set(['m1']) })
  // The ext-app cannot pass the state; the default (last fetched state) must agree.
  expect(computeNewVoiceInfo(prevIdSets, getVoiceIdSets())).toEqual(info)

  withFixedRandom(0.5, () => refreshLoom(info, 100))
  const attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
  const memory = loomState.threads.find(t => t.familyNames.includes('memory'))!
  expect(attention.arrivalGlow).toBe(0)
  expect(attention.emergenceStart).toBe(0)
  expect(attention.newVoiceIds.size).toBe(0)
  expect(attention.sunkenUids.has(1)).toBe(true)
  expect(memory.arrivalGlow).toBe(1)
  expect(memory.emergenceStart).toBe(100)
  expect([...memory.emergenceVoiceUids]).toEqual([1])
  expect(loomState.phantomFocus?.voiceId).toBe('m1')
})

test('the arrival cut-off is the sunken line itself', async () => {
  const at = await loadEntrants(SUNKEN_DEPTH)
  expect(computeNewVoiceInfo(at.prevIdSets, getVoiceIdSets(), at.state)[0]!.hasNew).toBe(false)
  resetLoomState()
  const below = await loadEntrants(0.69)
  expect(computeNewVoiceInfo(below.prevIdSets, getVoiceIdSets(), below.state)[0]!.newIds).toEqual(new Set(['a1']))
})

test('a first poll with no previous sets still leaves sunken voices out', async () => {
  const { state } = await loadEntrants()
  const info = computeNewVoiceInfo([], getVoiceIdSets(), state)
  expect(info[0]!.newIds).toEqual(new Set(['a0']))
  expect(info[1]!.newIds).toEqual(new Set(['m0', 'm1']))
})

test('an explicitly forced voice id still fires, even when sunken', async () => {
  const { prevIdSets, state } = await loadEntrants()
  const info = computeNewVoiceInfo(prevIdSets, getVoiceIdSets(), state)
  // What the ext-app's poll() does with forceNewVoiceIds, after the shared diff.
  info[0]!.newIds.add('a1')
  info[0]!.hasNew = true

  withFixedRandom(0.5, () => refreshLoom(info, 100))
  const attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
  expect(attention.arrivalGlow).toBe(1)
  expect(attention.emergenceStart).toBe(100)
  expect([...attention.emergenceVoiceUids]).toEqual([1])
  expect(attention.newVoiceIds.has('a1')).toBe(true)
})
