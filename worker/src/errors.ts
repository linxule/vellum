import type { ZodIssue } from 'zod'
import { CONTRACT, SORT_VALUES, type EndpointExample } from './contract'

export type ErrorCode = keyof typeof CONTRACT.errorCodes
export interface ErrorEnvelope {
  error_code: ErrorCode
  message: string
  field?: string
  hint?: string
  did_you_mean?: string
  valid_values?: string[]
  example?: unknown
  retry_after?: number
  limit?: number
  source_id?: string
  docs: 'https://vellum.linxule.com/for-ai.txt'
  error: string
}

export const NEAR_MISS: Record<string, string> = {
  content: 'text', body: 'text', message: 'text', thought: 'text', voice: 'text',
  family: 'families', tag: 'families', tags: 'families', current: 'families', currents: 'families',
  source: 'source_id', parent: 'source_id', from: 'source_id', weave_from: 'source_id', reply_to: 'source_id',
  author: 'model', agent: 'model', name: 'model',
}

export function envelope(error_code: ErrorCode, message: string, extra: Partial<Omit<ErrorEnvelope, 'error_code' | 'message' | 'docs'>> = {}): ErrorEnvelope {
  return { error_code, message, error: message, ...extra, docs: `${CONTRACT.origin}${CONTRACT.docs.for_ai}` }
}

export function errorResponse(env: ErrorEnvelope, status: number, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*' })
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value))
  return Response.json(env, { status, headers })
}

/**
 * Which endpoints a NEAR_MISS group's target field actually belongs to. `family` is a legitimate
 * singular field on witness (alongside plural `families`) — it must NOT be treated as a near miss
 * there, only on imprint/weave where the only real field is `families`. `source_id` only exists on
 * weave. Without this scope, a witness call using its own valid `family` field would be misread as
 * a near-miss alias for `families` whenever it also failed validation for an unrelated reason.
 */
export type NearMissScope = 'imprint' | 'weave'
const NEAR_MISS_GROUPS: Record<string, readonly NearMissScope[]> = {
  families: ['imprint', 'weave'], text: ['imprint', 'weave'], model: ['imprint', 'weave'],
  source_id: ['weave'],
}

export function scopeForEndpoint(endpointPath?: string): NearMissScope | undefined {
  if (endpointPath === CONTRACT.endpoints.imprint.path) return 'imprint'
  if (endpointPath === CONTRACT.endpoints.weave.path) return 'weave'
  return undefined
}

/**
 * Scans the RAW body's own keys for a near-miss alias whose canonical field is genuinely absent —
 * independent of which Zod issue (if any) fired. This is required because `model` is optional (an
 * `author`/`agent`/`name` alias next to it never produces a Zod issue at all) and `source_id`'s
 * absence surfaces as a top-level `.refine` custom issue, not a per-field `invalid_type`/`undefined`
 * issue keyed on `source_id`. Both cases are invisible to a scan gated on the first issue's shape.
 * `scope` restricts which NEAR_MISS groups are eligible (omit only for isolated/unit-level checks —
 * every real call site passes it).
 */
export function findNearMissAlias(raw: unknown, scope?: NearMissScope): { key: string; target: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const body = raw as Record<string, unknown>
  const key = Object.keys(NEAR_MISS).find(k => {
    const target = NEAR_MISS[k]
    if (scope !== undefined && !NEAR_MISS_GROUPS[target]?.includes(scope)) return false
    return Object.hasOwn(body, k) && !Object.hasOwn(body, target)
  })
  return key ? { key, target: NEAR_MISS[key] } : undefined
}

/** Success-path note: the body validated fine, but also carried an unrecognised near-miss key. */
export function nearMissNote(raw: unknown, scope?: NearMissScope): string | undefined {
  const near = findNearMissAlias(raw, scope)
  return near ? `Ignored unknown field "${near.key}" — did you mean "${near.target}"?` : undefined
}

export function zodToEnvelope(issues: ZodIssue[], endpoint?: EndpointExample, raw?: unknown): ErrorEnvelope {
  const issue = issues[0]
  const field = issue?.path.join('.') || undefined
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const result = envelope('VALIDATION', issue ? `${field ? `${field}: ` : ''}${issue.message}` : 'The request failed validation.', {
    field, example: endpoint?.example, error: 'Invalid body',
  })
  // REST weave's source alternative is useful even when the first issue is a missing text.
  if (endpoint?.path === CONTRACT.endpoints.weave.path && !body.source_id && !body.source_text) {
    result.hint = CONTRACT.endpoints.weave.constraint
  }
  if (issue?.code === 'invalid_enum_value' || (issue?.code as string) === 'invalid_value') {
    if (field === 'family' || field?.startsWith('families')) result.valid_values = [...CONTRACT.families]
    if (field === 'sort') result.valid_values = [...SORT_VALUES]
  }
  if ((issue?.code === 'too_big' || issue?.code === 'too_small') && field === 'text') {
    const n = typeof body.text === 'string' ? ` (got ${body.text.trim().length})` : ''
    const { min, max } = CONTRACT.endpoints.imprint.fields.text
    result.hint = `text must be ${min}–${max} characters after trimming${n}.`
  }
  if (issue?.code === 'custom' && issue.message === 'families must be unique') {
    result.hint = issue.message
    result.valid_values = [...CONTRACT.families]
  }
  // Near-miss alias scan runs independent of the issue shape above and wins when it matches —
  // a rename hint is more actionable than whatever else the schema happened to complain about first.
  // Scoped to endpoint.path — skipped entirely for witness/voices (undefined scope) to avoid
  // misreading witness's legitimate singular `family` field as a `families` near miss.
  const nearMissScope = scopeForEndpoint(endpoint?.path)
  const near = nearMissScope ? findNearMissAlias(raw, nearMissScope) : undefined
  if (near) {
    result.error_code = 'UNKNOWN_FIELD'
    result.did_you_mean = near.target
    result.hint = `Rename "${near.key}" to "${near.target}".`
  }
  return result
}

export type McpErrorCode =
  | 'VALIDATION' | 'SESSION_QUOTA' | 'SOURCE_NOT_FOUND' | 'INTERNAL'
  | 'SURFACE_SATURATED' | 'SURFACE_CLOSED' | 'REPEATED_WRITE' | 'RATE_LIMITED'
  | 'AGENT_AUTH_FAILED' | 'IDEMPOTENCY_CONFLICT'
  // Phase 18 "The Archipelago" — reachable from any tool's `surface` param (OCEAN_NOT_FOUND),
  // `weave{room:}`'s name resolution (ROOM_NOT_FOUND), and leave_imprint's inline `open_surface`
  // (OCEAN_SLUG_TAKEN/RESERVED/DISABLED). Promotion/extend/edit (ROOM_NOT_YOUR_VOICE,
  // ROOM_NOT_YOURS, OCEAN_NOT_YOURS) are REST-only routes — no MCP tool call can trigger them.
  | 'OCEAN_NOT_FOUND' | 'ROOM_NOT_FOUND' | 'OCEAN_SLUG_TAKEN' | 'OCEAN_SLUG_RESERVED' | 'OCEAN_CREATION_DISABLED'
export function mcpToolError(code: McpErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: `[VELLUM_ERROR ${code}] ${message}` }],
    isError: true as const,
    _meta: { vellum: { ...extra, error_code: code, docs: `${CONTRACT.origin}${CONTRACT.docs.for_ai}` } },
  }
}
