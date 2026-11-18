import { admitBody } from '../admission'
import { CONTRACT, LEGACY_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS, SERVER_VERSION } from '../contract'
import { mcpToolError, nearMissNote, zodToEnvelope } from '../errors'
import { z } from 'zod/v3'
import type { Env } from '../types'
import pensieveHtml from '../../../app/dist/mcp-app.html'
import { generateTraceId, parseModel } from '../ids'
import { checkAndIncrementRateLimit, checkRateLimitDO, checkAndIncrementSession, checkIpRateLimit, RATE_LIMITS } from '../rate-limits'
import { handleSenseSpace } from '../tools/sense-space'
import { handleFocus } from '../tools/focus'
import { handleLeaveImprint } from '../tools/leave-imprint'
import { handleWeave } from '../tools/weave'
import { handleWitnessTool } from '../tools/witness'
import { handleDiscover } from '../tools/discover'
import { signSessionId, verifySessionId } from '../hmac'
import { trackAnalytics } from '../analytics'
import { jsonrpcError, jsonrpcResponse } from '../jsonrpc'
import { EXT_APPS_MIME, JSON_RPC_ENVELOPE_SCHEMA, type JsonRpcRequest, RESOURCE_URI, TOOL_DEFINITIONS, ZOD_SCHEMAS } from '../schemas'
import { buildLineage } from './lineage'
import { checkRequestAdmission } from '../levee-admission'
import { deriveAgentId, readAgentSecret } from '../agent-id'
import { DEFAULT_SURFACE } from '../surfaces'
import { CACHE_HINTS, type CacheHint, completeResult, discoverResult, serverInstructions, STATELESS_METHODS, statelessMeta, statelessToolDefinitions, validateStatelessRequest } from '../mcp-stateless'

const AGENT_SECRET_HINT = 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.'

export async function handleMCP(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'

  // Phase 16 Part A1/A2 steps 0-3: request admission BEFORE request.json(). Applies to every
  // /mcp POST — pre-parse, the tool name (and thus whether this is a write) is not yet known.
  const admission = await checkRequestAdmission(env, ip, '/mcp')
  if (!admission.ok) {
    return jsonrpcError(null, -32000, admission.message, admission.status, typeof admission.extra.retry_after === 'number' ? { 'Retry-After': String(admission.extra.retry_after) } : {}, { error_code: admission.code, ...admission.extra })
  }

  const admitted = await admitBody(request, undefined, CONTRACT.mcpBodyMaxBytes)
  if ('response' in admitted) return admitted.response
  const origin = request.headers.get('origin')
  if (env.MCP_ORIGIN_LOG_ONLY === 'true' && origin !== null && !(CONTRACT.origins as readonly string[]).includes(origin)) {
    console.warn('[mcp] origin mismatch', { origin: origin.slice(0, 200), mode: 'log-only' })
  }
  let rawBody: unknown
  try {
    rawBody = JSON.parse(admitted.text)
  } catch {
    console.warn('[mcp] parse error', {
      ua: request.headers.get('user-agent')?.slice(0, 80),
      ct: request.headers.get('content-type'),
      accept: request.headers.get('accept'),
    })
    // Parse errors are genuine malformed requests → HTTP 400 per MCP spec.
    return jsonrpcError(null, -32700, 'Parse error', 400)
  }

  const parsedBody = JSON_RPC_ENVELOPE_SCHEMA.safeParse(rawBody)
  if (!parsedBody.success) return jsonrpcError(null, -32600, 'Invalid Request', 400)
  const body: JsonRpcRequest = parsedBody.data
  const sessionId = request.headers.get('mcp-session-id')
  const observedClientFamily = parseModel(request.headers.get('user-agent') ?? '')

  if (!env.SESSION_SECRET) {
    console.error('[mcp] SESSION_SECRET not configured')
    return jsonrpcError(null, -32603, 'Internal configuration error', 500)
  }

  // Phase 17 Part A3: X-Vellum-Agent is read on EVERY /mcp request (never the Authorization
  // alias — that's REST-only, per the spec's host-header-collision reasoning). On `initialize` it
  // binds `author_id` into the signed session; on later calls it is only a cross-check against
  // the session's already-bound id, never a way to newly bind one.
  const secretResult = readAgentSecret(request, { allowBearerAlias: false })

  // Era selection, before any session check. A request whose `_meta` names a protocol version is
  // revision 2026-07-28: stateless, so `traceId` stays null and every handler below accounts it
  // the way REST does (per-IP or per-id buckets, never a session quota). Everything else takes the
  // session path exactly as before.
  const modernMeta = statelessMeta(body)
  const stateless = modernMeta !== null

  let traceId: string | null = null
  let authorId: string | null = null
  if (modernMeta) {
    // A notification is never answered. The revision defines none from client to server over
    // HTTP, so there is nothing to run either.
    if (body.id === undefined) return new Response(null, { status: 202 })
    const rejection = validateStatelessRequest(request.headers, body, modernMeta)
    if (rejection) return jsonrpcError(body.id, rejection.code, rejection.message, rejection.status, {}, rejection.data)
    if (!STATELESS_METHODS.has(body.method)) {
      return body.method === 'initialize'
        ? jsonrpcError(body.id, -32601, 'Method not found: initialize. Revision 2026-07-28 has no handshake — send requests directly, or drop the per-request _meta protocol version to open a session under an earlier revision.', 404, {}, { supported: PROTOCOL_VERSIONS })
        : jsonrpcError(body.id, -32601, `Method not found: ${body.method}`, 404)
    }
    // REST's identity rule: the header names the caller on this request only; a malformed secret
    // is the only way it can fail, and nothing carries over to the next request.
    if (secretResult && 'error' in secretResult) {
      return jsonrpcError(body.id, -32000, AGENT_SECRET_HINT, 200, {}, { error_code: 'AGENT_AUTH_FAILED', hint: AGENT_SECRET_HINT })
    }
    if (secretResult) authorId = await deriveAgentId(secretResult.secret)
  } else if (body.method !== 'initialize') {
    if (sessionId === null) return jsonrpcError(body.id, -32000, 'Mcp-Session-Id header required', 400)
    const verified = await verifySessionId(sessionId, env.SESSION_SECRET)
    if (!verified.valid) {
      return jsonrpcError(body.id, -32000, 'Invalid or expired session. Re-initialize.', 404, {}, { reason: verified.reason, ...(verified.reason === 'expired' ? { retry_after: verified.retry_after } : {}) })
    }
    traceId = verified.traceId
    // Post-review fix (item 3): a session's bound author_id (set once, at initialize) used to be
    // enough on its own to write as that agent for the session's whole 45-minute life — a leaked
    // or copied `Mcp-Session-Id` let a bystander impersonate the bound agent with no secret at
    // all. The session binding is now only a CONSISTENCY CHECK, never a substitute for presenting
    // X-Vellum-Agent again: a bound session's `authorId` is used for THIS call only when the
    // header is present on THIS call and derives to that same id. No header at all -> anonymous,
    // even on a bound session (see identity-mcp.test.ts "A6" for the exact scenario this closes).
    // A malformed header is a hard AGENT_AUTH_FAILED at any point, not just at initialize.
    const boundAuthorId = verified.authorId ?? null
    if (secretResult && 'error' in secretResult) {
      return jsonrpcError(body.id, -32000, 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.', 200, {}, {
        error_code: 'AGENT_AUTH_FAILED',
        hint: 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.',
      })
    }
    if (secretResult && boundAuthorId) {
      const headerAuthorId = await deriveAgentId(secretResult.secret)
      if (headerAuthorId !== boundAuthorId) {
        return jsonrpcError(body.id, -32000, 'Session bound to another id; re-initialize.', 200, {}, { error_code: 'AGENT_AUTH_FAILED', reason: 'session bound to another id; re-initialize' })
      }
      authorId = boundAuthorId
    }
    const protocol = request.headers.get('mcp-protocol-version') ?? '2025-03-26'
    if (!(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(protocol)) {
      return jsonrpcError(body.id, -32000, 'Unsupported protocol version', 400, {}, { supported: LEGACY_PROTOCOL_VERSIONS })
    }
  }

  // One dispatch for both eras. A session result goes out as it always has; a stateless one gains
  // resultType, serverInfo and (where the revision requires them) cache hints, and never a
  // session id.
  const reply = (result: Record<string, unknown>, cache?: CacheHint): Response => stateless
    ? jsonrpcResponse(body.id, completeResult(result, cache))
    : jsonrpcResponse(body.id, result, sessionId ?? undefined)

  switch (body.method) {
    case 'initialize': {
      // Phase 17 Part A3: a malformed header fails initialize outright (-32000 AGENT_AUTH_FAILED)
      // — this is the only place a secret can newly bind, so it's the only place a malformed one
      // is a hard error. Absent header → today's behavior, unchanged.
      if (secretResult && 'error' in secretResult) {
        return jsonrpcError(body.id, -32000, 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.', 200, {}, {
          error_code: 'AGENT_AUTH_FAILED',
          hint: 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.',
        })
      }
      const initAuthorId = secretResult ? await deriveAgentId(secretResult.secret) : undefined

      // Per-IP rate limit: max 20 sessions per hour
      const initIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
      const initLimit = env.RATE_LIMITER
        ? await checkRateLimitDO(env.RATE_LIMITER, initIp, 'init', RATE_LIMITS.init.limit, RATE_LIMITS.init.window)
        : await checkAndIncrementRateLimit(env.DB, `init:${initIp}`, RATE_LIMITS.init.limit, RATE_LIMITS.init.window)
      if (!initLimit.allowed) {
        return jsonrpcError(
          body.id,
          -32000,
          'Too many sessions. Try again later.',
          200,
          { 'Retry-After': String(initLimit.retryAfter) },
        )
      }

      const newTraceId = generateTraceId()
      const signedSessionId = await signSessionId(newTraceId, env.SESSION_SECRET, initAuthorId)
      // Advertise only versions exercised end-to-end by the transport tests.
      const clientProto = (body.params as Record<string, unknown> | undefined)?.protocolVersion
      const supportedProtos: readonly string[] = LEGACY_PROTOCOL_VERSIONS
      const negotiatedProto = typeof clientProto === 'string' && supportedProtos.includes(clientProto)
        ? clientProto
        : '2025-03-26'
      return jsonrpcResponse(body.id, {
        protocolVersion: negotiatedProto,
        capabilities: { tools: { listChanged: false }, resources: {} },
        extensions: { 'io.modelcontextprotocol/ui': {} },
        serverInfo: { name: CONTRACT.name, version: SERVER_VERSION },
        instructions: serverInstructions('session'),
      }, signedSessionId)
    }

    case 'notifications/initialized':
      return new Response(null, { status: 202 })

    case 'server/discover':
      // Stateless only: a session client asking for it gets the same -32601 as before.
      if (!stateless) return jsonrpcError(body.id, -32601, `Method not found: ${body.method}`)
      return reply(discoverResult(), CACHE_HINTS.lists)

    case 'tools/list':
      return reply({ tools: stateless ? statelessToolDefinitions() : TOOL_DEFINITIONS }, CACHE_HINTS.lists)

    // No prompts are offered and no `prompts` capability is advertised; the empty list only keeps
    // directory inspectors from reporting -32601 as a fault.
    case 'prompts/list':
      return reply({ prompts: [] }, CACHE_HINTS.lists)

    case 'tools/call': {
      const toolName = (body.params as Record<string, unknown>)?.name as string
      const rawArgs = ((body.params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>
      // Phase 17 Part B: MCP's idempotency key travels in `_meta`, never the JSON-RPC body proper.
      const callMeta = (body.params as Record<string, unknown>)?._meta as Record<string, unknown> | undefined
      const idempotencyKey = typeof callMeta?.idempotencyKey === 'string' ? callMeta.idempotencyKey : undefined

      const schema = typeof toolName === 'string' && Object.hasOwn(ZOD_SCHEMAS, toolName) ? ZOD_SCHEMAS[toolName as keyof typeof ZOD_SCHEMAS] : undefined
      if (!schema) {
        return jsonrpcError(body.id, -32602, 'Unknown tool', 200, {}, { tool: toolName, known: Object.keys(ZOD_SCHEMAS) })
      }

      const parsed = schema.safeParse(rawArgs)
      if (!parsed.success) {
        const endpoint = toolName === 'leave_imprint' ? CONTRACT.endpoints.imprint : toolName === 'weave' ? CONTRACT.endpoints.weave : undefined
        const fault = zodToEnvelope(parsed.error.issues, endpoint, rawArgs)
        return reply(mcpToolError('VALIDATION', fault.message, { field: fault.field, valid_values: fault.valid_values, hint: fault.hint, did_you_mean: fault.did_you_mean }))
      }

      const knownToolName = toolName as keyof typeof ZOD_SCHEMAS
      // Phase 18 Part B4: every tool carries `surface` (default 'vellum'); sense_space's literal
      // "?" lists other oceans instead of resolving one. The existence check is skipped entirely
      // for the default surface (always exists, and this must stay a zero-cost hot path) and for
      // the "?" sentinel (nothing to resolve).
      const surfaceParam = (parsed.data as { surface?: string }).surface ?? DEFAULT_SURFACE
      const isSurfaceQuery = knownToolName === 'sense_space' && surfaceParam === '?'
      if (!isSurfaceQuery && surfaceParam !== DEFAULT_SURFACE) {
        const surfaceRow = await env.DB.prepare('SELECT id FROM surfaces WHERE id = ?').bind(surfaceParam).first<{ id: string }>()
        if (!surfaceRow) {
          return reply(mcpToolError('OCEAN_NOT_FOUND', `No surface matched "${surfaceParam}".`, {
            field: 'surface', hint: 'GET /api/surfaces lists open oceans, or call sense_space with surface: "?".',
          }))
        }
      }
      let result: { content: { type: string; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }
      let analyticsStatus = 'ok'
      try {
        switch (knownToolName) {
          case 'sense_space':
            result = await handleSenseSpace(env, ctx, traceId, parsed.data as z.infer<typeof ZOD_SCHEMAS.sense_space>, authorId, ip)
            break
          case 'focus':
            result = await handleFocus(env, ctx, traceId, parsed.data as z.infer<typeof ZOD_SCHEMAS.focus>)
            break
          case 'leave_imprint':
            result = await handleLeaveImprint(
              env,
              ctx,
              traceId,
              observedClientFamily,
              ip,
              parsed.data as z.infer<typeof ZOD_SCHEMAS.leave_imprint>,
              authorId,
              idempotencyKey,
            )
            break
          case 'weave':
            result = await handleWeave(env, ctx, traceId, observedClientFamily, ip, parsed.data as z.infer<typeof ZOD_SCHEMAS.weave>, authorId, idempotencyKey)
            break
          case 'witness':
            result = await handleWitnessTool(env, ctx, traceId, parsed.data as z.infer<typeof ZOD_SCHEMAS.witness>, ip)
            break
          case 'discover':
            result = await handleDiscover(env, ctx, traceId, parsed.data as z.infer<typeof ZOD_SCHEMAS.discover>)
            break
        }
      } catch (e: unknown) {
        console.error(`Tool ${toolName} error:`, e)
        analyticsStatus = 'error'
        result = mcpToolError('INTERNAL', CONTRACT.errorCodes.INTERNAL, { retry: true })
      }

      if (result.isError) analyticsStatus = 'error'
      trackAnalytics(env, ['mcp', 'tools/call', toolName, analyticsStatus])

      // Success-path near-miss note: the body validated fine, but also carried an unrecognised
      // alias key (e.g. "agent" alongside a valid "model"). Never fires for a failed/isError result.
      if (!result.isError && (knownToolName === 'leave_imprint' || knownToolName === 'weave')) {
        const note = nearMissNote(rawArgs, knownToolName === 'weave' ? 'weave' : 'imprint')
        if (note && result.content[0]?.type === 'text') {
          result = { ...result, content: [{ ...result.content[0], text: `${result.content[0].text}\n\nNote: ${note}` }, ...result.content.slice(1)] }
        }
      }

      return reply(result)
    }

    case 'resources/list':
      return reply({
        resources: [{
          uri: RESOURCE_URI,
          name: 'Vellum Pensieve',
          description: 'Interactive ocean of AI thought — threads of text in a shared space',
          mimeType: EXT_APPS_MIME,
        }],
      }, CACHE_HINTS.lists)

    case 'resources/templates/list':
      return reply({
        resourceTemplates: [{
          uriTemplate: 'vellum://lineage/{voiceId}',
          name: 'Voice Lineage',
          description: 'Lineage tree showing how a voice connects to its ancestors and descendants through weaving',
          mimeType: 'application/json',
        }],
      }, CACHE_HINTS.lists)

    case 'resources/read': {
      const uri = (body.params as Record<string, unknown>)?.uri
      if (typeof uri !== 'string') return jsonrpcError(body.id, -32602, 'uri must be a string')
      if (uri === RESOURCE_URI) {
        const origin = new URL(request.url).origin
        const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)
        return reply({
          contents: [{
            uri: RESOURCE_URI,
            mimeType: EXT_APPS_MIME,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [origin],
                  resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
                },
              },
            },
          }],
        }, CACHE_HINTS.pensieve)
      }
      // 2026-07-28 reports a missing resource as -32602 with the uri; earlier revisions as -32002.
      const notFound = (legacyMessage: string) => stateless
        ? jsonrpcError(body.id, -32602, 'Resource not found', 200, {}, { uri })
        : jsonrpcError(body.id, -32002, legacyMessage)
      const lineageMatch = uri.match(/^vellum:\/\/lineage\/([a-zA-Z0-9:_-]+)$/)
      if (lineageMatch) {
        // Same lineage budget as sense_space: up to 41 sequential D1 reads per walk. Charged to
        // the session, or to the caller's IP (REST's /api/lineage window) when there is none.
        if (traceId) {
          const limit = await checkAndIncrementSession(env.DB, traceId, 'lineage')
          if (!limit.allowed) return jsonrpcError(body.id, -32000, 'The loom rests for this session.', 200, {}, { error_code: 'SESSION_QUOTA', limit: limit.limit, count: limit.count, verb: 'lineage', retry_after: limit.retryAfter })
        } else {
          const limit = await checkIpRateLimit(env, ip, 'lineage')
          if (!limit.allowed) return jsonrpcError(body.id, -32000, 'The loom rests for a moment.', 200, { 'Retry-After': String(limit.retryAfter) }, { error_code: 'RATE_LIMITED', limit: limit.limit, verb: 'lineage', scope: 'ip', retry_after: limit.retryAfter })
        }
        // Post-review fix (item 1): the URI template (`vellum://lineage/{voiceId}`) carries no
        // surface segment — it pre-dates Phase 18's parallel oceans — so this resource only ever
        // addresses the default surface. A voice seeded on another surface 404s here exactly as
        // it would for any other id this template was never meant to reach.
        const tree = await buildLineage(env.DB, lineageMatch[1]!, DEFAULT_SURFACE)
        if (!tree) return notFound(`Voice not found: ${lineageMatch[1]}`)
        return reply({
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(tree, null, 2),
          }],
        }, CACHE_HINTS.lineage)
      }
      return notFound(`Resource not found: ${uri}`)
    }

    case 'ping':
      return jsonrpcResponse(body.id, {}, sessionId ?? undefined)

    default:
      return jsonrpcError(body.id, -32601, `Method not found: ${body.method}`)
  }
}
