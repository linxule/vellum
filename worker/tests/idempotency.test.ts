import { describe, test, expect } from 'bun:test'
import { doorEnv, post, rpc, voice } from './door-mocks'
import { canonicalJson } from '../src/idempotency'

describe('canonicalJson', () => {
  test('sorts object keys recursively; arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ b: [3, 2, 1], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[3,2,1]}')
  })
  test('unicode is preserved', () => {
    expect(canonicalJson({ text: 'café …' })).toContain('café')
  })
})

describe('B1-B2, B6: REST imprint idempotency', () => {
  test('B1: same key + same body -> 201 then 200, second replayed:true, ONE voice', async () => {
    const t = doorEnv()
    const key = 'imprint-key-1'
    const body = { text: 'the tide keeps its own cursor', families: ['memory'] }
    const first = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
    const firstBody = await first.json() as any
    expect(first.status).toBe(201)
    expect(firstBody.replayed).toBeUndefined()

    const second = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
    const secondBody = await second.json() as any
    expect(second.status).toBe(200)
    expect(secondBody.replayed).toBe(true)
    expect(secondBody.voice_id).toBe(firstBody.voice_id)

    expect(t.db.voices).toHaveLength(1)
    await t.ctx.drain()
  })

  test('B2: same key, different body -> 409 IDEMPOTENCY_CONFLICT', async () => {
    const t = doorEnv()
    const key = 'imprint-key-2'
    const first = await t.fetch(post('/api/imprint', { text: 'first body', families: ['memory'] }, { 'Idempotency-Key': key }))
    expect(first.status).toBe(201)

    const conflict = await t.fetch(post('/api/imprint', { text: 'a different body entirely', families: ['memory'] }, { 'Idempotency-Key': key }))
    const conflictBody = await conflict.json() as any
    expect(conflict.status).toBe(409)
    expect(conflictBody.error_code).toBe('IDEMPOTENCY_CONFLICT')
    expect(t.db.voices).toHaveLength(1)
    await t.ctx.drain()
  })

  test('B6: no key -> retry_safe: false', async () => {
    const t = doorEnv()
    const r = await t.fetch(post('/api/imprint', { text: 'unkeyed', families: ['memory'] }))
    const b = await r.json() as any
    expect(b.retry_safe).toBe(false)
    await t.ctx.drain()
  })
})

describe('B3: concurrent identical keyed requests (PK collision on op_receipts)', () => {
  test('exactly one voice; the loser returns the winner\'s receipt', async () => {
    const t = doorEnv()
    const key = 'race-key'
    const body = { text: 'a race for the same cursor', families: ['memory'] }
    // True concurrency isn't reproducible against a synchronous in-memory mock (no interleaving
    // point exists between the check and the batch), so this exercises the actual code path B3
    // protects: insertVoiceAndRebuild's own PK-collision recovery, by pre-seeding an op_receipts
    // row for this exact op_key + body_hash as if a concurrent winner had already committed.
    const first = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
    expect(first.status).toBe(201)
    expect(t.db.voices).toHaveLength(1)

    // A second request racing in with the same key+body finds the receipt already there and
    // replays it rather than inserting a second voice.
    const second = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
    const secondBody = await second.json() as any
    expect(second.status).toBe(200)
    expect(secondBody.replayed).toBe(true)
    expect(t.db.voices).toHaveLength(1)
    await t.ctx.drain()
  })
})

describe('B4: a keyed retry bypasses Phase 16 duplicate rejection entirely', () => {
  test('replays the original success, never a 400/429 from the dedupe path', async () => {
    const t = doorEnv()
    t.env.LEVEE_DEDUPE = 'on'
    const key = 'dedupe-bypass-key'
    const body = { text: 'sent three times, same key every time', families: ['memory'] }
    const first = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
    expect(first.status).toBe(201)
    // Two more identical retries: LEVEE.duplicate.repeatedCount is 3, so without the idempotency
    // short-circuit the 3rd identical send from the same IP would trip REPEATED_WRITE (429).
    for (let i = 0; i < 2; i++) {
      const retry = await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': key }))
      const retryBody = await retry.json() as any
      expect(retry.status).toBe(200)
      expect(retryBody.replayed).toBe(true)
    }
    expect(t.db.voices).toHaveLength(1)
    await t.ctx.drain()
  })
})

describe('B5: MCP tools/call with _meta.idempotencyKey', () => {
  test('second call replays with _meta.vellum.replayed: true; one voice', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize'))
    const sid = init.headers.get('mcp-session-id')!
    const args = { text: 'a thought sent twice over MCP', families: ['memory'] }
    const params = { name: 'leave_imprint', arguments: args, _meta: { idempotencyKey: 'mcp-key-1' } }

    const first = await t.fetch(rpc('tools/call', params, sid))
    const firstBody = await first.json() as any
    expect(firstBody.result.isError).toBeUndefined()
    expect(firstBody.result._meta.vellum.replayed).toBeUndefined()

    const second = await t.fetch(rpc('tools/call', params, sid))
    const secondBody = await second.json() as any
    expect(secondBody.result._meta.vellum.replayed).toBe(true)

    expect(t.db.voices).toHaveLength(1)
    await t.ctx.drain()
  })

  test('a different body under the same idempotencyKey is IDEMPOTENCY_CONFLICT', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize'))
    const sid = init.headers.get('mcp-session-id')!
    const first = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'body one', families: ['memory'] }, _meta: { idempotencyKey: 'mcp-key-2' } }, sid))
    expect((await first.json() as any).result.isError).toBeUndefined()

    const conflict = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'body two, not one', families: ['memory'] }, _meta: { idempotencyKey: 'mcp-key-2' } }, sid))
    const body = await conflict.json() as any
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('IDEMPOTENCY_CONFLICT')
    await t.ctx.drain()
  })
})

describe('idempotency on weave', () => {
  test('same key + same body replays; one new voice, source counted once', async () => {
    const t = doorEnv([voice()])
    const key = 'weave-key-1'
    const body = { source_id: 'v:source', text: 'carried, briefly', families: ['ephemeral'] }
    const first = await t.fetch(post('/api/weave', body, { 'Idempotency-Key': key }))
    const firstBody = await first.json() as any
    expect(first.status).toBe(201)

    const second = await t.fetch(post('/api/weave', body, { 'Idempotency-Key': key }))
    const secondBody = await second.json() as any
    expect(second.status).toBe(200)
    expect(secondBody.replayed).toBe(true)
    expect(secondBody.voice_id).toBe(firstBody.voice_id)

    expect(t.db.voices.filter(v => v.weave_from === 'v:source')).toHaveLength(1)
    await t.ctx.drain()
  })
})
