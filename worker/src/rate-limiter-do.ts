import { applyRateLimitCounter, type CounterEntry } from './rate-limiter-core'

type RateLimiterRequestBody = {
  key?: unknown
  limit?: unknown
  windowSeconds?: unknown
}

type DurableObjectBaseCtor = abstract new (...args: never[]) => object

const DurableObjectBase = ((globalThis as { DurableObject?: DurableObjectBaseCtor }).DurableObject ?? class {}) as DurableObjectBaseCtor

export class RateLimiterDO extends DurableObjectBase {
  private counters: Map<string, CounterEntry> = new Map()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }
    if (url.pathname !== '/check') {
      return new Response('Not found', { status: 404 })
    }

    let body: RateLimiterRequestBody
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (
      typeof body.key !== 'string'
      || typeof body.limit !== 'number'
      || !Number.isFinite(body.limit)
      || typeof body.windowSeconds !== 'number'
      || !Number.isFinite(body.windowSeconds)
    ) {
      return Response.json({ error: 'Invalid payload' }, { status: 400 })
    }

    return Response.json(
      applyRateLimitCounter(this.counters, body.key, body.limit, body.windowSeconds),
    )
  }
}
