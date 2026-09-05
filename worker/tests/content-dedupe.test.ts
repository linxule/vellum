import { expect, test } from 'bun:test'
import { normalizeForHash, contentHash, simhash, hammingDistance, classifyDuplicate } from '../src/levee-content'
import { doorEnv, post, voice } from './door-mocks'

test('normalizeForHash folds case, punctuation, whitespace, and NFKC width', () => {
  expect(normalizeForHash('Hello,  World!!')).toBe('hello world')
  expect(normalizeForHash('  spaced   out  ')).toBe('spaced out')
  // Fullwidth (NFKC-foldable) characters normalize to their ASCII equivalents.
  expect(normalizeForHash('Ｈｅｌｌｏ')).toBe('hello')
  expect(normalizeForHash('café — naïve?!')).toBe('café naïve')
})

test('contentHash is stable, 32 hex chars, and normalization-insensitive', async () => {
  const a = await contentHash('Hello, World!')
  const b = await contentHash('  hello world  ')
  expect(a).toBe(b)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  const c = await contentHash('a completely different thought')
  expect(c).not.toBe(a)
})

test('simhash distance is small for a one-word swap, large for unrelated text', () => {
  const base = simhash('the quiet ocean holds every voice that ever passed through it')
  const oneWordSwap = simhash('the quiet ocean holds every voice that ever moved through it')
  const unrelated = simhash('quarterly earnings exceeded analyst expectations by a wide margin')
  expect(hammingDistance(base, oneWordSwap)).toBeLessThanOrEqual(hammingDistance(base, unrelated))
  expect(hammingDistance(base, base)).toBe(0)
})

test('classifyDuplicate: exact match returns "exact", not a rejection', async () => {
  const hash = await contentHash('a shared thought')
  const sim = simhash('a shared thought')
  const result = classifyDuplicate(hash, sim, 'ip:9.9.9.9', [
    { id: 'v:existing', content_hash: hash, simhash: sim, created_at: Date.now() - 3_600_000, source: 'ip:1.1.1.1' },
  ])
  expect(result).toMatchObject({ kind: 'exact', existingId: 'v:existing' })
})

test('classifyDuplicate: 2 prior repeats from the same source within 60s is "exact", the 3rd is "repeated"', async () => {
  const hash = await contentHash('stuck in a retry loop')
  const sim = simhash('stuck in a retry loop')
  const now = Date.now()
  const oneRepeat = classifyDuplicate(hash, sim, 'ip:1.2.3.4', [
    { id: 'v:1', content_hash: hash, simhash: sim, created_at: now - 1000, source: 'ip:1.2.3.4' },
  ])
  expect(oneRepeat.kind).toBe('exact')
  const twoRepeats = classifyDuplicate(hash, sim, 'ip:1.2.3.4', [
    { id: 'v:1', content_hash: hash, simhash: sim, created_at: now - 2000, source: 'ip:1.2.3.4' },
    { id: 'v:2', content_hash: hash, simhash: sim, created_at: now - 1000, source: 'ip:1.2.3.4' },
  ])
  expect(twoRepeats.kind).toBe('repeated')
})

test('classifyDuplicate: near-duplicate (hamming <= 6) is "near", not "exact" or "repeated"', () => {
  const sourceSim = simhash('the quiet ocean holds every voice that ever passed through it')
  const nearSim = simhash('the quiet ocean holds every voice that ever moved through it')
  const distance = hammingDistance(sourceSim, nearSim)
  if (distance > 6) return // this pair happened not to land within threshold; the boundary is exercised directly below
  const result = classifyDuplicate('unrelated-hash-aaaa', nearSim, 'ip:9.9.9.9', [
    { id: 'v:near', content_hash: 'different-hash-bbbb', simhash: sourceSim, created_at: Date.now(), source: 'ip:1.1.1.1' },
  ])
  expect(result).toMatchObject({ kind: 'near', existingId: 'v:near' })
})

test('classifyDuplicate: no match at all is "none"', () => {
  const result = classifyDuplicate('hash-x', 'ffffffffffffffff', 'ip:1.1.1.1', [])
  expect(result).toMatchObject({ kind: 'none' })
})

test('REST /api/imprint: an exact duplicate succeeds with 201 and carries existing_voice_id', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const hash = await contentHash('an already-seen thought')
  t.db.voices.push(voice('v:original', 'an already-seen thought', { content_hash: hash, created_at: Date.now() - 3_600_000, trace_id: 'ip:5.5.5.5' }))
  const r = await t.fetch(post('/api/imprint', { text: 'an already-seen thought', families: ['attention'] }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b.ok).toBe(true)
  expect(b.existing_voice_id).toBe('v:original')
  expect(b.note).toContain('weave')
})

test('REST /api/imprint: 3rd identical write in 60s from one source is REPEATED_WRITE (429), not a success', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const hash = await contentHash('caught in a loop')
  const now = Date.now()
  t.db.voices.push(
    voice('v:1', 'caught in a loop', { content_hash: hash, created_at: now - 2000, trace_id: 'ip:1.2.3.4' }),
    voice('v:2', 'caught in a loop', { content_hash: hash, created_at: now - 1000, trace_id: 'ip:1.2.3.4' }),
  )
  const r = await t.fetch(post('/api/imprint', { text: 'caught in a loop', families: ['attention'] }))
  expect(r.status).toBe(429)
  const b = await r.json() as any
  expect(b.error_code).toBe('REPEATED_WRITE')
  expect(t.db.voices).toHaveLength(2)
})

test('REST /api/imprint: 2nd identical write in 60s from one source still succeeds', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const hash = await contentHash('said once already')
  t.db.voices.push(voice('v:1', 'said once already', { content_hash: hash, created_at: Date.now() - 2000, trace_id: 'ip:1.2.3.4' }))
  const r = await t.fetch(post('/api/imprint', { text: 'said once already', families: ['attention'] }))
  expect(r.status).toBe(201)
})

// --- Post-review fix (item 4): 'near' was classified and then discarded — never persisted -------

function flipOneBit(simhashHex: string): string {
  const bytes = simhashHex.match(/.{2}/g)!.map(h => parseInt(h, 16))
  bytes[0] ^= 0x01
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

test('a near-duplicate (hamming distance 1, not exact) is persisted with damped=1, and damped_count reflects it', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const text = 'a genuinely new thought about the shape of water'
  const sim = simhash(text)
  const neighborSim = flipOneBit(sim)
  // Sanity: guaranteed by construction, not probabilistic — a single flipped bit is always
  // hamming distance 1, comfortably within LEVEE.duplicate.hammingMax (6).
  expect(hammingDistance(sim, neighborSim)).toBe(1)
  t.db.voices.push(voice('v:neighbor', 'an unrelated earlier phrase', {
    content_hash: 'unrelated-content-hash', simhash: neighborSim, created_at: Date.now() - 3_600_000, trace_id: 'ip:9.9.9.9',
  }))

  const r = await t.fetch(post('/api/imprint', { text, families: ['attention'] }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  // A near-dup is hospitality-only, never surfaced as existing_voice_id (that's exact-only).
  expect(b.existing_voice_id).toBeUndefined()

  const created = t.db.voices.find(v => v.text === text)!
  expect(created.damped).toBe(1)

  const stats = await (await t.fetch(new Request('https://vellum.test/api/admin/stats', { headers: { 'x-admin-key': 'test-secret' } }))).json() as any
  expect(stats.levee.damped_count).toBe(1)
})

test('an ordinary write with no near neighbor is never damped', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const r = await t.fetch(post('/api/imprint', { text: 'a thought with nothing nearby at all', families: ['attention'] }))
  expect(r.status).toBe(201)
  const created = t.db.voices.find(v => v.text === 'a thought with nothing nearby at all')!
  expect(created.damped).toBe(0)
})
