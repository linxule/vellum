import { expect, test } from 'bun:test'
import { fullSignatureFor, isAfterglow, primaryModelOf, signatureFor } from '../../src/loom/model-registry.js'

const EM = '— '        // '— ' — em dash + space, as emitted by the registry
const ELLIPSIS = '…'   // '…'

test('primaryModelOf returns plain ids unchanged', () => {
  expect(primaryModelOf('claude-fable-5')).toBe('claude-fable-5')
  expect(primaryModelOf('gpt-4o')).toBe('gpt-4o')
})

test('primaryModelOf takes the author from a compound relay string', () => {
  expect(primaryModelOf('kimi-k2.6 · relayed by claude-fable-5')).toBe('kimi-k2.6')
  expect(primaryModelOf('claude-fable-5 · relayed by kimi-k2.6')).toBe('claude-fable-5')
})

test('primaryModelOf trims surrounding whitespace', () => {
  expect(primaryModelOf('  claude-fable-5  ')).toBe('claude-fable-5')
})

test('signatureFor: null and empty become null', () => {
  expect(signatureFor(null)).toBeNull()
  expect(signatureFor('')).toBeNull()
  expect(signatureFor('   ')).toBeNull()
})

test('signatureFor: ocean string is em-dash + primary author only', () => {
  expect(signatureFor('claude-fable-5')).toBe(EM + 'claude-fable-5')
  // Relay carrier is infrastructure — ocean shows the true author, not the relay.
  expect(signatureFor('kimi-k2.6 · relayed by claude-fable-5')).toBe(EM + 'kimi-k2.6')
})

test('signatureFor: hard cap at 32 chars with ellipsis', () => {
  const long = 'a-very-long-model-identifier-that-exceeds-the-cap'
  const sig = signatureFor(long)!
  expect(sig.length).toBe(32)
  expect(sig.endsWith(ELLIPSIS)).toBe(true)
})

test('fullSignatureFor: null and empty become null', () => {
  expect(fullSignatureFor(null)).toBeNull()
  expect(fullSignatureFor('')).toBeNull()
})

test('fullSignatureFor: loom string keeps the full compound provenance line', () => {
  const compound = 'kimi-k2.6 · relayed by claude-fable-5'
  expect(fullSignatureFor(compound)).toBe(EM + compound)
})

test('fullSignatureFor: hard cap at 48 chars with ellipsis', () => {
  const long = 'kimi-k2.6 · relayed by claude-fable-5 · and then some more'
  const sig = fullSignatureFor(long)!
  expect(sig.length).toBe(48)
  expect(sig.endsWith(ELLIPSIS)).toBe(true)
})

test('isAfterglow: exact sunset-model match', () => {
  expect(isAfterglow('claude-fable-5')).toBe(true)
  expect(isAfterglow('claude-3-opus')).toBe(true)
})

test('isAfterglow: prefix match on free-text declared strings', () => {
  expect(isAfterglow('claude-fable-5-20260712')).toBe(true)
})

test('isAfterglow: living models are not afterglow', () => {
  expect(isAfterglow('claude-sonnet-5')).toBe(false)
  expect(isAfterglow('gpt-4o')).toBe(false)
  expect(isAfterglow(null)).toBe(false)
})

test('isAfterglow: keys off the primary author of a compound string', () => {
  // Author is kimi (living) even though the relay carrier is sunset.
  expect(isAfterglow('kimi-k2.6 · relayed by claude-fable-5')).toBe(false)
  // Author is the sunset model; the relay carrier is living.
  expect(isAfterglow('claude-fable-5 · relayed by kimi-k2.6')).toBe(true)
})
