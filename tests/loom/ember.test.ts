import { beforeEach, expect, test } from 'bun:test'
import { initLoom, refreshLoom, renderLoom } from '../../src/loom/index.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { fontSizeForScale } from '../../src/loom/math.js'
import { SPARSE_REPEAT_CAP, TEXTURE_SCALE, WARM_BASE_ALPHA } from '../../src/loom/types.js'
import {
  CanvasContextStub,
  createCanvasContext,
  installViewport,
  loadState,
  makeMouse,
  makeState,
  maxBodyAlpha,
  maxFontSizeForText,
  runFrames,
  withFixedRandom,
} from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

const BODY = 'A WARM CURRENT DRIFTS THROUGH THE OPEN OCEAN AND IS READ BY WHOEVER HOLDS STILL '

// Drive the dive lens onto an `attention` current at the given server warmth,
// converging `frames` frames. Two voices → non-sparse, so the column tiles a full
// dive band (this isolates Part A warmth from the Part B one-copy gate). Layout is
// deterministic (withFixedRandom) so warm and cold runs differ only in apiWarmth.
async function diveOnWarmth(warmth: number, frames: number): Promise<CanvasRenderingContext2D> {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', warmth, voices: [
      { id: 'a0', text: BODY, depth: 0.2 },
      { id: 'a1', text: BODY, depth: 0.3 },
    ] },
  ], 1400 + Math.round(warmth * 1000) + frames))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'a0')          // steer the dive lens onto the current
  runFrames(renderLoom, ctx, mouse, frames, 80)
  return ctx
}

// ── Part A: the ember reads easier when touched ──────────────────────────────

test('warm-reads-easier: a warm current magnifies more under the lens than a cold one', async () => {
  // Mid-proximity (partial dive): the warm current reaches reading scale over a
  // taller band, so its peak body glyph is strictly larger. Marker '' matches
  // every body fillText (voice is unsigned + unwoven → no signature/dot).
  const cold = await diveOnWarmth(0, 45)
  const warm = await diveOnWarmth(1, 45)

  const coldPeak = maxFontSizeForText(cold, '')
  const warmPeak = maxFontSizeForText(warm, '')
  expect(coldPeak).toBeGreaterThan(fontSizeForScale(TEXTURE_SCALE))  // a dive actually happened
  expect(warmPeak).toBeGreaterThan(coldPeak)                          // strictly easier to read
})

test('warm-reads-easier: warmth never shrinks the lens (>= at full convergence)', async () => {
  // Fully converged, both peak at diveScale — warmth may equal but never undercut.
  const cold = await diveOnWarmth(0, 200)
  const warm = await diveOnWarmth(1, 200)
  expect(maxFontSizeForText(warm, '')).toBeGreaterThanOrEqual(maxFontSizeForText(cold, ''))
})

// ── Part A: rest brightness lifts mildly, and is bounded ──────────────────────

async function restBrightness(warmth: number): Promise<number> {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', warmth, voices: [
      { id: 'a0', text: BODY, depth: 0.2 },
      { id: 'a1', text: BODY, depth: 0.3 },
    ] },
  ], 1500 + Math.round(warmth * 1000)))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const mouse = makeMouse()               // off-screen: rest, no dive
  runFrames(renderLoom, ctx, mouse, 6)
  return maxBodyAlpha(ctx)
}

test('rest-brightness: a warm current rests brighter, but below the comparison threshold', async () => {
  const cold = await restBrightness(0)
  const warm = await restBrightness(1)
  expect(warm).toBeGreaterThan(cold)               // warm rests brighter
  expect(warm - cold).toBeLessThanOrEqual(WARM_BASE_ALPHA)  // ...but only mildly (bounded by the constant)
})

test('rest-brightness: apiWarmth is clamped — warmth 2.0 lifts no more than 1.0', async () => {
  const one = await restBrightness(1)
  const two = await restBrightness(2)           // unclamped accumulator can exceed 1
  expect(two).toBeCloseTo(one, 6)               // clamp01 pins the contribution at 1
})

// ── Decoupling law: warmth must not touch texture / repeat / position ─────────

test('no-rank: warmth changes neither line count, repeat, nor x-position', async () => {
  async function build(warmth: number) {
    installViewport(960, 640)
    await loadState(makeState([
      { family: 'attention', warmth, voices: [
        { id: 'a0', text: BODY, depth: 0.2 },
        { id: 'a1', text: BODY, depth: 0.3 },
      ] },
    ], 1600 + Math.round(warmth * 1000)))
    withFixedRandom(0.5, () => initLoom())
    const t = loomState.threads[0]!
    return { totalLines: t.totalLines, textLen: t.prepared.segments.join('').length, xCenter: t.xCenter }
  }
  const cold = await build(0)
  const warm = await build(1)
  expect(warm.totalLines).toBe(cold.totalLines)   // texture unchanged
  expect(warm.textLen).toBe(cold.textLen)         // repeat unchanged
  expect(warm.xCenter).toBe(cold.xCenter)         // position unchanged
})

// ── Part B: sparse texture honesty ────────────────────────────────────────────

// Distinct painted body-line y-positions at rest. At rest each line is drawn once
// (drawLine, not the per-grapheme dive path), so this counts painted lines.
function paintedBodyLines(ctx: CanvasRenderingContext2D): number {
  const ys = new Set<number>()
  for (const c of (ctx as unknown as CanvasContextStub).fillTextCalls) {
    if (c.text.trim() !== '') ys.add(Math.round(c.y))
  }
  return ys.size
}

async function renderFamilyAtRest(def: Parameters<typeof makeState>[0][number], version: number) {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([def], version))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const mouse = makeMouse()             // off-screen: rest, no dive
  runFrames(renderLoom, ctx, mouse, 6)
  return { thread: loomState.threads[0]!, painted: paintedBodyLines(ctx) }
}

test('sparse-whisper: a 1-voice family paints one whisper; a multi-voice control fills', async () => {
  const capacity = Math.ceil(640 / 8.5)   // ~76 texture lines fit the viewport height

  const solo = 'A LONE VOICE SPEAKS ONCE AND WAITS '
  const s = await renderFamilyAtRest({ family: 'attention', voices: [{ id: 's0', text: solo, depth: 0.2 }] }, 1700)
  expect(s.thread.sparse).toBe(true)
  // Data honesty: the prepared texture is capped to a whisper (small totalLines).
  expect(s.thread.prepared.segments.join('').length).toBeLessThanOrEqual((solo.length + 1) * SPARSE_REPEAT_CAP)
  expect(s.thread.totalLines).toBeLessThan(12)
  // Visual: the renderer paints exactly one contiguous copy — not wall-to-wall.
  // (+1 tolerates the wrap seam when the scroll offset starts us mid-text.)
  expect(s.painted).toBeGreaterThan(0)
  expect(s.painted).toBeLessThanOrEqual(s.thread.totalLines + 1)
  expect(s.painted).toBeLessThan(capacity / 2)   // strictly fewer than viewport capacity

  const word = 'FIRST '
  const c = await renderFamilyAtRest({ family: 'silence', voices: [
    { id: 'p0', text: word, depth: 0.2 },
    { id: 'p1', text: word, depth: 0.3 },
    { id: 'p2', text: word, depth: 0.4 },
  ] }, 1701)
  expect(c.thread.sparse).toBe(false)
  // Multi-voice keeps the fill formula (prepared text well past the cap bound)…
  expect(c.thread.prepared.segments.join('').length).toBeGreaterThan((word.length * 3 + 1) * SPARSE_REPEAT_CAP)
  // …and still tiles to fill the viewport at render time.
  expect(c.painted).toBeGreaterThan(capacity / 2)
})

test('sparse-legible: a 1-2 char solo voice paints (never blanker than the glitch it replaced)', async () => {
  // Regression: a top-aligned 1-line sparse block sat with its only line pinned to
  // the clipped viewport edge (y≈0), where edge fade zeroed it — a "Hi" voice
  // vanished entirely. Voice schema is 1-200 chars, so 1-line solos are normal on
  // the live surface. It must paint at rest AND under the dive lens. Marker 'H'
  // survives both the whole-line rest path and the per-grapheme dive path.
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 's0', text: 'Hi', depth: 0.2 }] },
  ], 1750))
  withFixedRandom(0.5, () => initLoom())
  expect(loomState.threads[0]!.sparse).toBe(true)
  expect(loomState.threads[0]!.totalLines).toBe(1)   // truly a single-line whisper

  const rest = createCanvasContext()
  runFrames(renderLoom, rest, makeMouse(), 6)
  const restFills = (rest as unknown as CanvasContextStub).fillTextCalls.filter(c => c.text.includes('H'))
  expect(restFills.length).toBeGreaterThan(0)        // paints at rest

  const dive = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, dive, mouse, 5)
  triggerPhantomHover(0, 's0')
  runFrames(renderLoom, dive, mouse, 60, 80)
  const diveFills = (dive as unknown as CanvasContextStub).fillTextCalls.filter(c => c.text.includes('H'))
  expect(diveFills.length).toBeGreaterThan(0)         // still paints under the lens
})

test('zero-voice-blank: an empty family invents no trace', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [] },
  ], 1800))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 8)
  const drawn = (ctx as unknown as CanvasContextStub).fillTextCalls.filter(c => c.text.trim() !== '')
  expect(drawn.length).toBe(0)   // nothing readable — stays blank
})

// ── Part C: live warmth eases, never steps ────────────────────────────────────

test('ease: a warmth rise converges over frames rather than stepping', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', warmth: 0, voices: [{ id: 'a0', text: BODY, depth: 0.2 }] },
  ], 1900))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)

  const thread = loomState.threads[0]!
  expect(thread.apiWarmth).toBe(0)

  // A fresh poll reports the current running warm.
  await loadState(makeState([
    { family: 'attention', warmth: 0.9, voices: [{ id: 'a0', text: BODY, depth: 0.2 }] },
  ], 1901))
  refreshLoom(undefined, 5 * 80)

  const t = loomState.threads[0]!
  expect(t.apiWarmthTarget).toBeCloseTo(0.9, 6)   // target jumps
  expect(t.apiWarmth).toBeCloseTo(0, 6)           // display value has not

  const after1 = runFrames(renderLoom, ctx, mouse, 1, 6 * 80)
  const a1 = t.apiWarmth
  runFrames(renderLoom, ctx, mouse, 49, after1)
  const a50 = t.apiWarmth
  runFrames(renderLoom, ctx, mouse, 150, after1 + 49 * 16)
  const a200 = t.apiWarmth

  expect(a1).toBeGreaterThan(0)          // it moves
  expect(a1).toBeLessThan(0.09)          // ...but does not step (nowhere near 0.9 in one frame)
  expect(a50).toBeGreaterThan(a1)        // monotonic climb
  expect(a200).toBeGreaterThan(a50)
  expect(a200).toBeLessThan(0.9)         // still easing, not yet arrived
})
