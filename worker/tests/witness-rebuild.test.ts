import { describe, expect, test } from 'bun:test'
import { handleWitness } from '../src/index'
import { makeTestEnv, MockExecutionContext } from './mocks'

describe('witness rebuild trigger', () => {
  test('happy path schedules one rebuild and materializes the projection after drain', async () => {
    const { env, db, kv } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: 'silence', dwell_s: 10 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)

    expect(response.status).toBe(200)
    expect(ctx.waitUntilCalls).toBe(1)
    await ctx.drain()
    expect(kv._getRaw('state:projection')).not.toBeNull()
    expect(db.warmthState.find(row => row.family === 'silence')?.score).toBeCloseTo(10 / 60, 6)
  })

  test('rate-limited witness does not trigger rebuild', async () => {
    const now = Date.now()
    const { env, db, kv } = makeTestEnv({
      rate_limits: [{
        key: 'witness:unknown',
        count: 5,
        window_start: now - 1_000,
        expires_at: now + 60_000,
      }],
    })
    const ctx = new MockExecutionContext()
    const before = db.warmthState.find(row => row.family === 'silence')?.score ?? 0
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: 'silence', dwell_s: 10 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)
    const body = await response.json() as { throttled?: boolean }

    expect(response.status).toBe(200)
    expect(body.throttled).toBeTrue()
    expect(ctx.waitUntilCalls).toBe(0)
    expect(kv._getRaw('state:projection')).toBeNull()
    expect(db.warmthState.find(row => row.family === 'silence')?.score).toBe(before)
  })

  test('failed warmth update does not trigger rebuild', async () => {
    const { env, db, kv } = makeTestEnv()
    db.failWarmthUpdateFamilies.add('silence')
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: 'silence', dwell_s: 10 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)

    expect(response.status).toBe(500)
    expect(ctx.waitUntilCalls).toBe(0)
    expect(kv._getRaw('state:projection')).toBeNull()
  })

  test('dedupe and rebuild coalesce on duplicate families', async () => {
    const { env, db, kv } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ families: ['silence', 'silence'], dwell_s: 10 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)

    expect(response.status).toBe(200)
    expect(ctx.waitUntilCalls).toBe(1)
    await ctx.drain()
    expect(db.warmthState.find(row => row.family === 'silence')?.score).toBeCloseTo(10 / 60, 6)
    expect(kv._getRaw('state:projection')).not.toBeNull()
  })
})
