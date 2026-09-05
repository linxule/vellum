// Phase 16 "The Levee" — infrastructure protection, never content judgment. See
// docs/PHASE_16_SPEC.md. Two entry points:
//
//   checkRequestAdmission() — steps 0-3, called at the very top of handleRestImprint,
//   handleRestWeave and handleMCP, BEFORE request.json(). Bounds the cost of *asking*.
//
//   admitWrite() — steps 4-8, called once the body is parsed and Zod-validated, and only for
//   an actual imprint/weave write. Bounds how fast the surface can *churn*. This is the single
//   place a write is accounted; no caller increments a counter itself.
//
// Deviations from the spec's literal signatures (documented in docs/PHASE_16_REPORT.md):
//   1. admitWrite() takes the write's `text` as an explicit argument — step 4 (duplicate
//      classification) cannot run without it, and the spec's AdmitContext interface omits it.
//   2. Both functions return a transport-neutral {code,message,extra,status} verdict rather than
//      a pre-built REST ErrorEnvelope, because step 7's SESSION_QUOTA is an MCP-only code (not a
//      member of CONTRACT.errorCodes — see errors.ts's McpErrorCode) and admitWrite is shared by
//      both REST and MCP callers. Each caller builds its own final shape: REST via
//      envelope()/errorResponse(), MCP via mcpToolError().

import type { Env, LeveeMode } from './types'
import { LEVEE, type EndpointExample } from './contract'
import { envelope, errorResponse, mcpToolError, type ErrorCode, type McpErrorCode } from './errors'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS, checkAndIncrementSession } from './rate-limits'
import { contentHash, simhash, classifyDuplicate } from './levee-content'
import { weaverBucket } from './levee-permanence'

export interface AdmitContext {
  ip: string
  sessionId?: string // MCP only: verified HMAC trace id
  authorId?: string // Phase 17 only — never set or read in Phase 16
  bodyBytes: number
  source: 'rest' | 'mcp'
  kind: 'imprint' | 'weave'
}

export interface AdmitDenial {
  code: 'SURFACE_SATURATED' | 'SURFACE_CLOSED' | 'REPEATED_WRITE' | 'RATE_LIMITED' | 'SESSION_QUOTA'
  message: string
  extra: Record<string, unknown>
  status: number
}

export type AdmitVerdict =
  | { ok: true; visibility: 'surfaced' | 'quarantined'; duplicateOf?: string; note?: string; damped?: boolean }
  | ({ ok: false } & AdmitDenial)

export type RequestAdmissionVerdict = { ok: true } | ({ ok: false } & AdmitDenial)

/** REST caller convenience: builds a Phase 15 envelope Response from a denial. SESSION_QUOTA
 * (MCP-only) never reaches this in practice — REST's admitWrite() branch never sets sessionId. */
export function denialToRestResponse(denial: AdmitDenial, endpoint?: EndpointExample): Response {
  const code: ErrorCode = denial.code === 'SESSION_QUOTA' ? 'RATE_LIMITED' : denial.code
  const retryAfter = denial.extra.retry_after
  // A legacy `error` string set on extra (e.g. step 7's pre-Levee "Rate limit exceeded") wins over
  // the new prose message, preserved for the one release Phase 15's A6 invariant still covers.
  const legacyError = typeof denial.extra.error === 'string' ? denial.extra.error : denial.message
  return errorResponse(
    envelope(code, denial.message, { ...denial.extra, example: endpoint?.example, error: legacyError }),
    denial.status,
    typeof retryAfter === 'number' ? { 'Retry-After': String(retryAfter) } : {},
  )
}

/** MCP caller convenience: builds an mcpToolError() result from a denial. */
export function denialToMcpError(denial: AdmitDenial) {
  return mcpToolError(denial.code as McpErrorCode, denial.message, denial.extra)
}

// ---------------------------------------------------------------------------
// Mode + overload + fuse reads — isolate-cached so a hot write path costs one KV read per ~10s,
// not one per request. A fresh isolate always reads through once.
// ---------------------------------------------------------------------------

let overloadCache: { until: number; reason: string } | null | undefined
let overloadCacheAt = 0

async function readOverload(kv: KVNamespace): Promise<{ until: number; reason: string } | null> {
  const now = Date.now()
  if (overloadCacheAt && now - overloadCacheAt < LEVEE.isolateCacheMs) return overloadCache ?? null
  const raw = await kv.get<{ until: number; reason: string }>('levee:overload', 'json')
  overloadCache = raw && raw.until > now ? raw : null
  overloadCacheAt = now
  return overloadCache
}

/** Test-only: clear the isolate-level overload/fuse caches between cases. */
export function _resetLeveeCaches(): void {
  overloadCache = undefined
  overloadCacheAt = 0
  fuseCache = undefined
  fuseCacheAt = 0
}

export async function setOverload(kv: KVNamespace, on: boolean, ttlS: number, reason: string): Promise<void> {
  if (on) {
    await kv.put('levee:overload', JSON.stringify({ until: Date.now() + ttlS * 1000, reason }), { expirationTtl: Math.max(60, ttlS) })
  } else {
    await kv.delete('levee:overload')
  }
  overloadCache = null
  overloadCacheAt = 0
}

let fuseCache: LeveeMode | undefined
let fuseCacheAt = 0

async function readFuseMode(env: Env): Promise<LeveeMode> {
  const now = Date.now()
  if (fuseCacheAt && now - fuseCacheAt < LEVEE.isolateCacheMs) return fuseCache ?? (env.LEVEE_FUSE ?? 'off')
  const raw = await env.KV.get('levee:fuse')
  fuseCache = (raw === 'off' || raw === 'shadow' || raw === 'on') ? raw : undefined
  fuseCacheAt = now
  return fuseCache ?? (env.LEVEE_FUSE ?? 'off')
}

/** Post-review fix (item 6): toggles the fuse without a deploy, mirroring setOverload(). Writes
 * `levee:fuse` (no TTL — a deliberate mode override, not a transient engagement state) and
 * refreshes the isolate cache immediately so the same request that set it also sees it. */
export async function setFuseMode(kv: KVNamespace, mode: LeveeMode): Promise<void> {
  await kv.put('levee:fuse', mode)
  fuseCache = mode
  fuseCacheAt = Date.now()
}

export function modeOf(env: Env, flag: keyof Pick<Env, 'LEVEE_ADMISSION' | 'LEVEE_REBUILD' | 'LEVEE_CEILING' | 'LEVEE_DEDUPE' | 'LEVEE_PERMANENCE'>): LeveeMode {
  return env[flag] ?? 'off'
}

// ---------------------------------------------------------------------------
// checkRequestAdmission — steps 0 (caller's admitBody), 1 (overload), 2 (per-IP), 3 (global)
// ---------------------------------------------------------------------------

export async function checkRequestAdmission(env: Env, ip: string, route: string): Promise<RequestAdmissionVerdict> {
  const mode = modeOf(env, 'LEVEE_ADMISSION')
  // Post-review fix (design law: shipped-off costs nothing): the attempts counter used to run
  // unconditionally, adding one D1 write to EVERY request regardless of the flag. Gated behind the
  // mode check now — LEVEE_ADMISSION=off adds zero D1 writes here.
  if (mode === 'off') return { ok: true }

  // Every attempt — accepted or rejected below — costs money; count it before deciding anything.
  try {
    await checkAndIncrementRateLimit(env.DB, 'levee:attempts:hour', Number.MAX_SAFE_INTEGER, 3600)
  } catch { /* attempts counter is best-effort observability, never blocking */ }

  // Step 1: overload mode. Fail-open for the overload READ itself — if KV throws, proceed to
  // the request-window checks rather than treating a transient KV error as "surface closed".
  let overload: { until: number; reason: string } | null = null
  try { overload = await readOverload(env.KV) } catch { overload = null }
  if (overload) {
    const retryAfter = Math.max(1, Math.ceil((overload.until - Date.now()) / 1000))
    if (mode === 'on') {
      return { ok: false, code: 'SURFACE_CLOSED', message: 'Writes are paused while the surface recovers; reads still work.', extra: { retry_after: retryAfter }, status: 503 }
    }
  }

  // Steps 2 + 3: request-window admission. Fail-CLOSED for writes — a broken check denies
  // rather than silently admitting an unbounded write.
  try {
    const perIp = env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'admit', LEVEE.requestAdmission.perIp.limit, LEVEE.requestAdmission.perIp.window)
      : await checkAndIncrementRateLimit(env.DB, `admit:${ip}`, LEVEE.requestAdmission.perIp.limit, LEVEE.requestAdmission.perIp.window)
    if (!perIp.allowed && mode === 'on') {
      return { ok: false, code: 'RATE_LIMITED', message: 'Too many requests from this address; see retry_after.', extra: { retry_after: perIp.retryAfter, limit: perIp.limit }, status: 429 }
    }
    const global = env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, '__global__', 'admit:global', LEVEE.requestAdmission.global.limit, LEVEE.requestAdmission.global.window)
      : await checkAndIncrementRateLimit(env.DB, 'admit:global', LEVEE.requestAdmission.global.limit, LEVEE.requestAdmission.global.window)
    if (!global.allowed && mode === 'on') {
      return { ok: false, code: 'SURFACE_SATURATED', message: 'More requests are arriving than the surface can admit right now. Nothing was lost — come back in a moment.', extra: { retry_after: global.retryAfter, limit: global.limit }, status: 429 }
    }
  } catch (e) {
    console.error(`[levee] request admission check failed (${route}):`, e)
    // Fail-closed: deny the write rather than admit it on a broken check.
    return { ok: false, code: 'SURFACE_CLOSED', message: 'A safety check failed; writes are paused for a moment while it recovers.', extra: { retry_after: 5 }, status: 503 }
  }

  return { ok: true }
}

/** A4 auto-trip: attempted writes (accepted + rejected) crossing 3x the hour ceiling. */
export async function maybeAutoTripOverload(env: Env): Promise<void> {
  if (modeOf(env, 'LEVEE_ADMISSION') === 'off') return
  try {
    const attempts = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:attempts:hour').first<{ count: number }>()
    if ((attempts?.count ?? 0) >= LEVEE.overload.attemptsPerHourTrip) {
      await setOverload(env.KV, true, LEVEE.overload.durationS, 'attempted writes crossed 3x the hourly ceiling')
    }
  } catch (e) { console.error('[levee] auto-trip check failed:', e) }
}

// ---------------------------------------------------------------------------
// Ceiling — pure decision + D1/DO-backed counters
// ---------------------------------------------------------------------------

type CounterResult = { allowed: boolean; count: number; limit: number; retryAfter: number }

/** Pure: combines the "all writes" and (for imprints) "imprint sub-limit" counter results. */
export function applyCeilingDecision(
  kind: 'imprint' | 'weave',
  hourAll: CounterResult,
  hourKind: CounterResult | undefined,
  minuteAll: CounterResult,
  minuteKind: CounterResult | undefined,
): { allowed: boolean; retryAfter: number; limit: number } {
  const checks = [hourAll, minuteAll, ...(kind === 'imprint' ? [hourKind, minuteKind].filter((c): c is CounterResult => Boolean(c)) : [])]
  const failing = checks.filter(c => !c.allowed)
  if (failing.length === 0) return { allowed: true, retryAfter: 0, limit: hourAll.limit }
  const worst = failing.reduce((a, b) => (b.retryAfter > a.retryAfter ? b : a))
  return { allowed: false, retryAfter: worst.retryAfter, limit: worst.limit }
}

async function checkCeiling(env: Env, kind: 'imprint' | 'weave'): Promise<{ allowed: boolean; retryAfter: number; limit: number }> {
  const hourAll = await checkAndIncrementRateLimit(env.DB, 'levee:hour:all', LEVEE.ceiling.hour.all, LEVEE.ceiling.hour.window)
  const hourKind = kind === 'imprint'
    ? await checkAndIncrementRateLimit(env.DB, 'levee:hour:imprint', LEVEE.ceiling.hour.imprint, LEVEE.ceiling.hour.window)
    : undefined
  const minuteAll = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, '__global__', 'levee:minute:all', LEVEE.ceiling.minute.all, LEVEE.ceiling.minute.window)
    : await checkAndIncrementRateLimit(env.DB, 'levee:minute:all', LEVEE.ceiling.minute.all, LEVEE.ceiling.minute.window)
  const minuteKind = kind === 'imprint'
    ? (env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, '__global__', 'levee:minute:imprint', LEVEE.ceiling.minute.imprint, LEVEE.ceiling.minute.window)
      : await checkAndIncrementRateLimit(env.DB, 'levee:minute:imprint', LEVEE.ceiling.minute.imprint, LEVEE.ceiling.minute.window))
    : undefined
  return applyCeilingDecision(kind, hourAll, hourKind, minuteAll, minuteKind)
}

// ---------------------------------------------------------------------------
// Fuse — pure engagement/visibility decision (Part E). Shipped OFF; see cache.ts release wiring.
// ---------------------------------------------------------------------------

/** Pure: both conditions must hold to engage; hysteresis (disengage < 30/hr) prevents flapping. */
export function nextFuseEngagement(currentlyEngaged: boolean, hourCount: number, minuteCount: number): boolean {
  if (currentlyEngaged) return hourCount >= LEVEE.fuse.disengageHour
  return hourCount >= LEVEE.fuse.engageHour && minuteCount >= LEVEE.fuse.engageMinute
}

/** Pure: quarantine only a new writer during genuine engagement, and only if flagged. */
export function decideVisibility(fuseEngaged: boolean, writerHasPriorSurfaced: boolean, damped: boolean, writerNewThisHour: boolean): 'surfaced' | 'quarantined' {
  if (fuseEngaged && !writerHasPriorSurfaced && (damped || writerNewThisHour)) return 'quarantined'
  return 'surfaced'
}

async function evaluateFuse(env: Env): Promise<{ engaged: boolean }> {
  const mode = await readFuseMode(env)
  if (mode === 'off') return { engaged: false }
  const hourRow = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:hour:all').first<{ count: number }>()
  const minuteRow = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:minute:all').first<{ count: number }>()
  const prevRaw = await env.KV.get('levee:fuse:engaged')
  const engaged = nextFuseEngagement(prevRaw === '1', hourRow?.count ?? 0, minuteRow?.count ?? 0)
  await env.KV.put('levee:fuse:engaged', engaged ? '1' : '0', { expirationTtl: 3600 })
  return { engaged }
}

// ---------------------------------------------------------------------------
// admitWrite — steps 4-8, the single place a write is accounted.
// ---------------------------------------------------------------------------

export async function admitWrite(env: Env, ctx: AdmitContext, text: string): Promise<AdmitVerdict> {
  const dedupeMode = modeOf(env, 'LEVEE_DEDUPE')
  const ceilingMode = modeOf(env, 'LEVEE_CEILING')

  // Step 4: duplicate classification (uncharged — a lookup, not a credit).
  let duplicateOf: string | undefined
  let note: string | undefined
  // Post-review fix (item 4): a 'near' classification was computed and then discarded — never
  // written anywhere, so voices.damped stayed 0 forever and decideVisibility below was fed
  // Boolean(duplicateOf) (an exact/repeated signal) in its place, not the real near-dup flag.
  let damped = false
  if (dedupeMode !== 'off') {
    try {
      const newHash = await contentHash(text)
      const newSimhash = simhash(text)
      const since = Date.now() - LEVEE.duplicate.recentWindowMs
      const source = ctx.sessionId ?? `ip:${ctx.ip}`
      const recentRows = await env.DB.prepare(
        `SELECT id, content_hash, simhash, created_at, COALESCE(trace_id, 'ip:' || ?) as source
         FROM voices WHERE created_at > ? AND content_hash IS NOT NULL AND is_hidden = FALSE
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(ctx.ip, since, LEVEE.duplicate.recentLimit).all<{ id: string; content_hash: string | null; simhash: string | null; created_at: number; source: string }>()
      const classification = classifyDuplicate(newHash, newSimhash, source, recentRows.results ?? [])
      if (classification.kind === 'repeated' && dedupeMode === 'on') {
        return { ok: false, code: 'REPEATED_WRITE', status: 429, message: 'The same text arrived repeatedly from one source. Nothing was lost — the earlier one is still here.', extra: { retry_after: LEVEE.duplicate.repeatedWindowS, source_id: classification.existingId } }
      }
      if (classification.kind === 'exact' || (classification.kind === 'repeated' && dedupeMode === 'shadow')) {
        duplicateOf = classification.existingId
        note = 'Someone already left this thought here. You can weave that one forward instead — it deepens a lineage rather than starting a parallel one.'
      }
      if (classification.kind === 'near') {
        damped = true
      }
    } catch (e) {
      console.error('[levee] duplicate classification failed (uncharged, fail-open):', e)
    }
  }

  // Steps 5-6: global ceilings.
  if (ceilingMode !== 'off') {
    try {
      const decision = await checkCeiling(env, ctx.kind)
      if (!decision.allowed && ceilingMode === 'on') {
        return { ok: false, code: 'SURFACE_SATURATED', status: 429, message: 'More voices are arriving than the surface can settle right now. Nothing was lost — come back in a moment and it will take yours.', extra: { retry_after: decision.retryAfter, limit: decision.limit } }
      }
    } catch (e) {
      console.error('[levee] ceiling check failed:', e)
      return { ok: false, code: 'SURFACE_CLOSED', status: 503, message: 'A safety check failed; writes are paused for a moment while it recovers.', extra: { retry_after: 5 } }
    }
  }

  // Step 7: exactly one write bucket.
  try {
    if (ctx.authorId) {
      // Phase 17 Part A5: per-id quota REPLACES the per-IP (REST) / per-session (MCP) bucket —
      // flat, generous, independent of IP, checked after the global ceiling like every other
      // bucket. Never stacks with rest_write or the session bucket for a named write.
      const limit = await checkAndIncrementRateLimit(env.DB, `agent:${ctx.authorId}:${ctx.kind}`, RATE_LIMITS.agent[ctx.kind], RATE_LIMITS.agent.window)
      if (!limit.allowed) {
        return { ok: false, code: 'RATE_LIMITED', status: 429, message: `The per-id ${ctx.kind} quota (${limit.limit}/hour) is exhausted.`, extra: { retry_after: limit.retryAfter, limit: limit.limit, scope: 'agent' } }
      }
    } else if (ctx.sessionId) {
      const limit = await checkAndIncrementSession(env.DB, ctx.sessionId, ctx.kind)
      if (!limit.allowed) {
        return { ok: false, code: 'SESSION_QUOTA', status: 429, message: `You have reached the limit of ${limit.limit} ${ctx.kind}s per session (${limit.count}/${limit.limit}).`, extra: { retry_after: limit.retryAfter, limit: limit.limit, count: limit.count, verb: ctx.kind } }
      }
    } else {
      const limit = await checkAndIncrementRateLimit(env.DB, `rest_write:${ctx.ip}`, RATE_LIMITS.rest_write.limit, RATE_LIMITS.rest_write.window)
      if (!limit.allowed) {
        return { ok: false, code: 'RATE_LIMITED', status: 429, message: 'The shared per-IP write quota is exhausted.', extra: { retry_after: limit.retryAfter, limit: limit.limit, error: 'Rate limit exceeded' } }
      }
    }
  } catch (e) {
    console.error('[levee] write bucket check failed:', e)
    return { ok: false, code: 'SURFACE_CLOSED', status: 503, message: 'A safety check failed; writes are paused for a moment while it recovers.', extra: { retry_after: 5 } }
  }

  // Step 8: fuse decision — pure, never fails, returns 'surfaced' whenever the fuse is off.
  let visibility: 'surfaced' | 'quarantined' = 'surfaced'
  try {
    const { engaged } = await evaluateFuse(env)
    if (engaged) {
      // Post-review fix (item 2): the old check bound trace_id to ctx.sessionId ?? ctx.ip — an
      // anonymous REST writer has no trace_id at all (REST always inserts trace_id = NULL), so
      // `trace_id = <their IP>` never matched and every anonymous REST write looked brand-new.
      // A returning writer is now recognized by ANY of: a named author id, an MCP session trace
      // id, or the coarse network bucket (the one signal that actually covers anonymous REST).
      const bucket = await weaverBucket(ctx.ip, env.SESSION_SECRET)
      const priorRow = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM voices WHERE visibility = 'surfaced' AND (author_id = ? OR trace_id = ? OR writer_bucket = ?)`,
      ).bind(ctx.authorId ?? '', ctx.sessionId ?? '', bucket).first<{ cnt: number }>().catch(() => null)
      const writerHasPriorSurfaced = (priorRow?.cnt ?? 0) > 0
      visibility = decideVisibility(true, writerHasPriorSurfaced, damped, !writerHasPriorSurfaced)
    }
  } catch (e) {
    console.error('[levee] fuse decision failed (defaulting to surfaced):', e)
  }

  return { ok: true, visibility, duplicateOf, note, damped }
}
