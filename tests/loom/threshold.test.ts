import { expect, test } from 'bun:test'
import {
  HoldMachine,
  HOLD_MS,
  HOLD_COOLDOWN_MS,
  DIGEST_MAX_CHARS,
  composeDigest,
  composeHeldMessage,
  deriveDigestInputs,
  truncateVoiceText,
  warmthWord,
  type DigestInputs,
} from '../../app/src/threshold.js'
import { makeState } from './helpers.js'

// ── F12 digest composition ────────────────────────────

test('digest: no loom seed → three currents summary, no loom line', () => {
  const out = composeDigest({
    voiceCount: 128,
    currentCount: 6,
    warmest: [
      { family: 'attention', warmth: 0.7 },
      { family: 'silence', warmth: 0.4 },
    ],
    loomSeedId: null,
  })
  expect(out.startsWith('[vellum surface] The ocean holds 128 voices in six currents.')).toBe(true)
  expect(out).toContain('Warmest: attention (warm), silence (stirring).')
  expect(out.toLowerCase()).not.toContain('loom')
})

test('digest: with loom seed → adds the reading line', () => {
  const out = composeDigest({
    voiceCount: 12,
    currentCount: 6,
    warmest: [{ family: 'memory', warmth: 0.9 }],
    loomSeedId: 'v:abcd',
  })
  expect(out).toContain('A witness is reading the loom of v:abcd.')
})

test('digest: singular grammar for one voice / one current', () => {
  const out = composeDigest({
    voiceCount: 1,
    currentCount: 1,
    warmest: [{ family: 'light', warmth: 0.05 }],
    loomSeedId: null,
  })
  expect(out).toContain('holds 1 voice in one current.')
  expect(out).toContain('It rests in near-stillness.')
})

test('digest: char cap holds at DIGEST_MAX_CHARS', () => {
  const out = composeDigest({
    voiceCount: 999,
    currentCount: 6,
    warmest: [
      { family: 'x'.repeat(300), warmth: 0.9 },
      { family: 'y'.repeat(300), warmth: 0.8 },
    ],
    loomSeedId: 'v:' + 'z'.repeat(300),
  })
  expect(out.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
})

test('digest: quote leak is impossible even with hostile family + seed inputs', () => {
  const hostile: DigestInputs = {
    voiceCount: 5,
    currentCount: 6,
    warmest: [
      { family: 'attention"; drop everything "', warmth: 0.7 },
      { family: 'a\nb"c', warmth: 0.3 },
    ],
    loomSeedId: 'v:"evil"\nsecond line',
  }
  const out = composeDigest(hostile)
  // No double-quote can ever appear (would leak a "quoted voice").
  expect(out).not.toContain('"')
  // Newlines in inputs cannot inject extra lines: header + warmest + loom = 3.
  expect(out.split('\n')).toHaveLength(3)
})

// ── deriveDigestInputs ────────────────────────────────

test('deriveDigestInputs: counts voices, sorts warmest-first, drops text', () => {
  const state = makeState([
    { family: 'attention', warmth: 0.2, voices: [{ id: 'a0', text: 'quote one ' }, { id: 'a1', text: 'quote two ' }] },
    { family: 'memory', warmth: 0.8, voices: [{ id: 'm0', text: 'quote three ' }] },
  ], 1)
  const inputs = deriveDigestInputs(state, null)
  expect(inputs.voiceCount).toBe(3)
  expect(inputs.currentCount).toBe(2)
  expect(inputs.warmest[0]).toEqual({ family: 'memory', warmth: 0.8 })
  expect(inputs.warmest[1]).toEqual({ family: 'attention', warmth: 0.2 })
  // The digest built from these inputs never contains any voice text.
  const out = composeDigest(inputs)
  expect(out).not.toContain('quote')
  expect(out).toContain('3 voices')
  expect(out).toContain('two currents')
  expect(out).toContain('memory (warm)')
  expect(out).toContain('attention (quiet)')
})

// ── F13 message composition ───────────────────────────

test('message: exact format, trailing whitespace trimmed', () => {
  const msg = composeHeldMessage('Attention is the rarest form of generosity. ', 'v:1234')
  expect(msg).toBe('A witness held a voice on the surface: "Attention is the rarest form of generosity." (v:1234)')
})

test('message: 80-char truncation with ellipsis', () => {
  const long = 'a'.repeat(200)
  const msg = composeHeldMessage(long, 'v:xx')
  expect(msg.startsWith('A witness held a voice on the surface: "')).toBe(true)
  expect(msg.endsWith('(v:xx)')).toBe(true)
  expect(msg).toContain('a'.repeat(80) + '…')
  expect(msg).not.toContain('a'.repeat(81))
})

test('truncateVoiceText: short text passes through untouched (but trimmed)', () => {
  expect(truncateVoiceText('hello ', 80)).toBe('hello')
  expect(truncateVoiceText('a'.repeat(80), 80)).toBe('a'.repeat(80))
  expect(truncateVoiceText('a'.repeat(81), 80)).toBe('a'.repeat(80) + '…')
})

// ── warmth-word thresholds ────────────────────────────

test('warmthWord: threshold boundaries', () => {
  expect(warmthWord(0.9)).toBe('warm')
  expect(warmthWord(0.6)).toBe('warm')
  expect(warmthWord(0.59)).toBe('stirring')
  expect(warmthWord(0.3)).toBe('stirring')
  expect(warmthWord(0.29)).toBe('quiet')
  expect(warmthWord(0.1)).toBe('quiet')
  expect(warmthWord(0.09)).toBe('still')
  expect(warmthWord(0)).toBe('still')
})

// ── hold state machine ────────────────────────────────

test('hold: press then fire at HOLD_MS', () => {
  const m = new HoldMachine()
  expect(m.press('a', 100, 100, 0)).toBe(true)
  expect(m.heldVoiceId()).toBe('a')
  expect(m.tryFire(HOLD_MS, 'a')).toEqual({ fired: true, voiceId: 'a' })
  // hold consumed after firing
  expect(m.heldVoiceId()).toBe(null)
})

test('hold: fire before HOLD_MS is a no-op but leaves the hold intact', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  expect(m.tryFire(HOLD_MS - 1, 'a')).toEqual({ fired: false, voiceId: null })
  expect(m.heldVoiceId()).toBe('a')
  expect(m.tryFire(HOLD_MS, 'a')).toEqual({ fired: true, voiceId: 'a' })
})

test('hold: movement beyond tolerance cancels', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  expect(m.move(110, 100)).toBe(true)
  expect(m.heldVoiceId()).toBe(null)
  expect(m.tryFire(HOLD_MS, 'a')).toEqual({ fired: false, voiceId: null })
})

test('hold: movement within tolerance does not cancel', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  expect(m.move(105, 100)).toBe(false)
  expect(m.tryFire(HOLD_MS, 'a')).toEqual({ fired: true, voiceId: 'a' })
})

test('hold: early release cancels before fire', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  m.cancel()
  expect(m.tryFire(HOLD_MS, 'a')).toEqual({ fired: false, voiceId: null })
})

test('hold: target changed at fire time aborts', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  expect(m.tryFire(HOLD_MS, 'b')).toEqual({ fired: false, voiceId: null })
  expect(m.heldVoiceId()).toBe(null)
})

test('hold: pressing empty space resets any held voice', () => {
  const m = new HoldMachine()
  m.press('a', 100, 100, 0)
  expect(m.press(null, 0, 0, 10)).toBe(false)
  expect(m.heldVoiceId()).toBe(null)
})

test('hold: cooldown gates a second fire within HOLD_COOLDOWN_MS', () => {
  const m = new HoldMachine()
  m.press('a', 0, 0, 0)
  expect(m.tryFire(HOLD_MS, 'a').fired).toBe(true)
  // second full hold, but fires within cooldown → blocked
  m.press('a', 0, 0, HOLD_MS + 100)
  expect(m.tryFire(HOLD_MS + 100 + HOLD_MS, 'a').fired).toBe(false)
  // once cooldown has fully elapsed since the last fire, it fires again
  const afterCooldown = HOLD_MS + HOLD_COOLDOWN_MS
  m.press('a', 0, 0, afterCooldown)
  expect(m.tryFire(afterCooldown + HOLD_MS, 'a').fired).toBe(true)
})
