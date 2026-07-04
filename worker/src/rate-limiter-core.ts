export interface CounterEntry {
  count: number
  windowStart: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  count: number
  limit: number
  retryAfter: number
}

export function applyRateLimitCounter(
  counters: Map<string, CounterEntry>,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): RateLimitResult {
  const windowMs = windowSeconds * 1000
  const current = counters.get(key)
  const expired = !current || now >= current.windowStart + current.windowMs

  const entry: CounterEntry = expired
    ? { count: 1, windowStart: now, windowMs }
    : { count: current.count + 1, windowStart: current.windowStart, windowMs: current.windowMs }

  counters.set(key, entry)

  return {
    allowed: entry.count <= limit,
    count: entry.count,
    limit,
    retryAfter: Math.max(1, Math.ceil((entry.windowStart + entry.windowMs - now) / 1000)),
  }
}
