import { describe, expect, test } from 'bun:test'
import { applyRateLimitCounter } from '../src/rate-limiter-core'
import { checkRateLimitDO } from '../src/rate-limits'

describe('applyRateLimitCounter', () => {
  test('allows requests through the limit and denies the next one', () => {
    const counters = new Map()
    const now = 1_000

    expect(applyRateLimitCounter(counters, 'state', 3, 60, now)).toEqual({
      allowed: true,
      count: 1,
      limit: 3,
      retryAfter: 60,
    })
    expect(applyRateLimitCounter(counters, 'state', 3, 60, now + 1)).toEqual({
      allowed: true,
      count: 2,
      limit: 3,
      retryAfter: 60,
    })
    expect(applyRateLimitCounter(counters, 'state', 3, 60, now + 2)).toEqual({
      allowed: true,
      count: 3,
      limit: 3,
      retryAfter: 60,
    })
    expect(applyRateLimitCounter(counters, 'state', 3, 60, now + 3)).toEqual({
      allowed: false,
      count: 4,
      limit: 3,
      retryAfter: 60,
    })
  })

  test('resets after the window expires', () => {
    const counters = new Map()
    const now = 10_000

    expect(applyRateLimitCounter(counters, 'witness', 1, 60, now).allowed).toBe(true)
    expect(applyRateLimitCounter(counters, 'witness', 1, 60, now + 60_000)).toEqual({
      allowed: true,
      count: 1,
      limit: 1,
      retryAfter: 60,
    })
  })

  test('tracks different keys independently', () => {
    const counters = new Map()
    const now = 25_000

    expect(applyRateLimitCounter(counters, 'voices', 2, 60, now).count).toBe(1)
    expect(applyRateLimitCounter(counters, 'lineage', 2, 60, now + 5).count).toBe(1)
    expect(applyRateLimitCounter(counters, 'voices', 2, 60, now + 10).count).toBe(2)
    expect(applyRateLimitCounter(counters, 'lineage', 2, 60, now + 15).count).toBe(2)
  })

  test('retryAfter decreases as the window progresses', () => {
    const counters = new Map()
    const start = 100_000

    applyRateLimitCounter(counters, 'rest_write', 5, 60, start)
    const midway = applyRateLimitCounter(counters, 'rest_write', 5, 60, start + 30_100)

    expect(midway.retryAfter).toBe(30)
  })
})

describe('checkRateLimitDO', () => {
  test('returns allowed responses from the durable object stub', async () => {
    const stub = {
      fetch: async () => Response.json({ allowed: true, count: 1, limit: 5, retryAfter: 60 }),
    }
    const namespace = {
      idFromName(ip: string) { return `id:${ip}` },
      get(id: string) {
        expect(id).toBe('id:1.2.3.4')
        return stub
      },
    }

    await expect(
      checkRateLimitDO(namespace as unknown as DurableObjectNamespace, '1.2.3.4', 'state', 5, 60),
    ).resolves.toEqual({
      allowed: true,
      count: 1,
      limit: 5,
      retryAfter: 60,
    })
  })

  test('returns denied responses from the durable object stub', async () => {
    const namespace = {
      idFromName(ip: string) { return `id:${ip}` },
      get() {
        return {
          fetch: async () => Response.json({ allowed: false, count: 6, limit: 5, retryAfter: 30 }),
        }
      },
    }

    await expect(
      checkRateLimitDO(namespace as unknown as DurableObjectNamespace, '1.2.3.4', 'state', 5, 60),
    ).resolves.toEqual({
      allowed: false,
      count: 6,
      limit: 5,
      retryAfter: 30,
    })
  })

  test('throws when the durable object returns a non-200 response', async () => {
    const namespace = {
      idFromName(ip: string) { return `id:${ip}` },
      get() {
        return {
          fetch: async () => new Response('boom', { status: 503 }),
        }
      },
    }

    await expect(
      checkRateLimitDO(namespace as unknown as DurableObjectNamespace, '1.2.3.4', 'state', 5, 60),
    ).rejects.toThrow('RateLimiterDO returned 503')
  })
})
