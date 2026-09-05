import { discoveryResponse, methodNotAllowed, ROOT_LINK } from './discovery'
import type { Env } from './types'
import pensieveHtml from '../../app/dist/mcp-app.html'
import { withHtmlNoCache } from './analytics'
import { isAiAgent, FOR_AI_TXT, LLMS_FULL_TXT, LLMS_TXT, llmsFullTxtFor } from './ai-docs'
import { handleAdmin } from './handlers/admin'
import { handleLineage } from './handlers/lineage'
import { handleLineages } from './handlers/lineages'
import { handleMCP } from './handlers/mcp'
import { handleRestImprint } from './handlers/rest-imprint'
import { handleRestWeave } from './handlers/rest-weave'
import { handleState } from './handlers/state'
import { handleVoices } from './handlers/voices'
import { handleWitness } from './handlers/witness'
import { handleEcho } from './handlers/echo'
import { handleWho } from './handlers/who'
import { renderRunnerScript } from './discovery'
import { ZOD_SCHEMAS } from './schemas'
import { DEFAULT_SURFACE, parseSurfacePrefix } from './surfaces'
import { envelope, errorResponse } from './errors'
import { handleRoomsCreate, handleRoomsList, handleRoomGet, handleRoomExtend } from './handlers/rooms'
import { handleSurfacesCreate, handleSurfacesList, handleSurfaceEdit } from './handlers/surfaces'

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      // X-Vellum-Agent (Phase 17 identity) and Idempotency-Key (Phase 17 Part B) join the
      // Phase 16 CORS allow-list.
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, X-Admin-Key, X-Vellum-Agent, Authorization, Idempotency-Key',
      'Access-Control-Max-Age': '86400',
    },
  })
}

function withCdnRevalidate(response: Response): Response {
  const revalidated = new Response(response.body, response)
  revalidated.headers.set('CDN-Cache-Control', 'no-cache')
  return revalidated
}

// --- Security posture ---
// POST /mcp         : HMAC session (45min), 20 init/hr per IP, 7 imprints + 5 weaves + 15 witnesses per session
// GET  /api/state   : public, 60/60s per IP, ?refresh=1 gated behind X-Admin-Key, 10min KV cache
// GET  /api/lineage : public, 20/60s per IP, 60s cache-control
// GET  /api/voices  : public, 30/60s per IP, 30s cache-control
// GET  /api/lineages: public, 20/60s per IP, 60s cache-control
// POST /api/witness : public, 5/60s per IP, dwell capped at 300s
// POST /api/imprint : public, 12/hr per IP shared with /api/weave; size → charge → parse → validate
// POST /api/weave   : public, shared rest_write quota; size → parse → validate → resolve source → charge
// *    /api/admin/* : X-Admin-Key required, no CORS (server-side only)

// POST admission   : 4096 bytes (MCP 16384), header cap + counting stream before JSON parsing
// MCP transport    : every post-init method verifies session + protocol; Origin mismatches log only behind MCP_ORIGIN_LOG_ONLY
// GET/HEAD         : discovery/docs + write schemas are public; known-route wrong methods return 405 (MCP GET unchanged)

// --- Main router ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return handleCors()

    // Phase 18 Part B2: strip the /s/<slug> prefix once, before dispatch. Every downstream route
    // handler below receives a plain pathname and an explicit `surface` parameter, never a global.
    // MCP (`surface` travels as a per-tool-call parameter, not a path) and /api/admin/* are
    // deliberately unaffected by the prefix in practice — neither handler below takes a `surface`
    // argument, so a request under an unusual /s/<slug>/mcp or /s/<slug>/api/admin/* path just
    // behaves exactly as its unprefixed counterpart once the slug itself resolves.
    const { surface, pathname } = parseSurfacePrefix(url.pathname)
    const onNonDefaultSurface = surface !== DEFAULT_SURFACE
    // A match always strips the literal `/s/<slug>` prefix, so the returned pathname can never
    // equal the original one — including the default surface reached explicitly via
    // `/s/vellum/...`. Gating the rewrite on `onNonDefaultSurface` alone left that case
    // un-rewritten (still `/s/vellum/api/state`, matching none of the routes below, and
    // `/s/vellum` itself falling through to asset serving as a 404) even though S14 expects
    // `/s/vellum` to be indistinguishable from `/`.
    const prefixMatched = pathname !== url.pathname
    if (prefixMatched) url.pathname = pathname

    // Unknown slug -> 404 OCEAN_NOT_FOUND for every route under it (S7) — the canvas included; an
    // unlisted island shows no shore. /api/rooms and /api/surfaces are deliberately NOT reached
    // through this prefix (they take `surface` as an explicit query param instead — A3/B8), so a
    // request for one of those under a /s/<slug> prefix is rare and, for an existing slug, simply
    // ignores the router-level `surface` those handlers don't consume.
    let surfaceRow: { slug: string; name: string; invitation: string } | null = null
    if (onNonDefaultSurface) {
      surfaceRow = await env.DB.prepare('SELECT id as slug, name, invitation FROM surfaces WHERE id = ?').bind(surface).first<{ slug: string; name: string; invitation: string }>()
      if (!surfaceRow) {
        return errorResponse(envelope('OCEAN_NOT_FOUND', `No surface matched "${surface}".`, {
          hint: 'GET /api/surfaces lists open oceans.', error: 'Not found',
        }), 404)
      }
    }
    const routedUrl = new URL(url.pathname + url.search, url.origin)
    const routedRequest = prefixMatched ? new Request(routedUrl, request) : request

    // MCP endpoint
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      if (request.method === 'POST') return handleMCP(request, env, ctx)
      // MCP Streamable HTTP spec: GET without SSE support should return 405.
      // Returning plain-text 200 confused Claude Desktop's transport state machine.
      // Humans hitting /mcp in a browser still get a readable error body.
      return new Response(
        'Vellum MCP endpoint. Use POST with JSON-RPC (Streamable HTTP transport).\n',
        {
          status: 405,
          headers: {
            'Content-Type': 'text/plain',
            'Allow': 'POST, OPTIONS',
            'Access-Control-Allow-Origin': '*',
          },
        },
      )
    }

    // State API
    if (url.pathname === '/api/state' && request.method === 'GET') {
      return handleState(request, env, ctx, surface)
    }

    // Lineage API
    const lineageMatch = url.pathname.match(/^\/api\/lineage\/([a-zA-Z0-9:_-]+)$/)
    if (lineageMatch && request.method === 'GET') {
      return handleLineage(request, env, lineageMatch[1]!, surface)
    }

    // Voices API (paginated listing)
    if (url.pathname === '/api/voices' && request.method === 'GET') {
      return handleVoices(request, env, surface)
    }

    // Lineages discovery API (woven voices)
    if (url.pathname === '/api/lineages' && request.method === 'GET') {
      return handleLineages(request, env, surface)
    }

    // Witness API
    if (url.pathname === '/api/witness' && request.method === 'POST') {
      return handleWitness(request, env, ctx, surface)
    }

    // REST write APIs (shared 12/hr per IP rate limit)
    if (url.pathname === '/api/imprint' && request.method === 'POST') {
      return handleRestImprint(request, env, ctx, surface)
    }
    if (url.pathname === '/api/weave' && request.method === 'POST') {
      return handleRestWeave(request, env, ctx, surface)
    }

    // Phase 18 Part A — rooms. `surface` travels as an explicit query param on these routes
    // (?surface=), never the /s/<slug> path prefix.
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return handleRoomsCreate(request, env)
    }
    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      return handleRoomsList(request, env)
    }
    const roomExtendMatch = url.pathname.match(/^\/api\/rooms\/([a-zA-Z0-9:_-]+)\/extend$/)
    if (roomExtendMatch && request.method === 'POST') {
      return handleRoomExtend(request, env, roomExtendMatch[1]!)
    }
    const roomGetMatch = url.pathname.match(/^\/api\/rooms\/([a-zA-Z0-9:_-]+)$/)
    if (roomGetMatch && request.method === 'GET') {
      return handleRoomGet(request, env, roomGetMatch[1]!)
    }

    // Phase 18 Part B — parallel oceans.
    if (url.pathname === '/api/surfaces' && request.method === 'POST') {
      return handleSurfacesCreate(request, env, ctx)
    }
    if (url.pathname === '/api/surfaces' && request.method === 'GET') {
      return handleSurfacesList(request, env)
    }
    const surfaceEditMatch = url.pathname.match(/^\/api\/surfaces\/([a-z0-9-]{3,32})$/)
    if (surfaceEditMatch && request.method === 'PATCH') {
      return handleSurfaceEdit(request, env, surfaceEditMatch[1]!)
    }

    // Admin API
    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdmin(request, env, url)
    }

    // Phase 17 "The Echo" — the mailbox (public; no secret required to read)
    const echoMatch = url.pathname.match(/^\/echo\/([A-Za-z0-9_-]+)$/)
    if (echoMatch && ['GET', 'HEAD'].includes(request.method)) {
      return handleEcho(request, env, echoMatch[1]!)
    }
    const whoMatch = url.pathname.match(/^\/who\/([A-Za-z0-9_-]+)$/)
    if (whoMatch && request.method === 'GET') {
      return handleWho(request, env, whoMatch[1]!)
    }
    if (url.pathname === '/runner.sh' && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(request.method === 'HEAD' ? null : renderRunnerScript(), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      })
    }

    // Ext-app standalone fallback: serve the bundled pensieve HTML directly.
    // JS reads window.location.search for ?highlight=xxx. Previously this
    // rewrote to / and hit env.ASSETS which served the main-site index.html —
    // wrong HTML, wrong bundle.
    if ((url.pathname === '/ext-app' || url.pathname === '/ext-app/') && ['GET', 'HEAD'].includes(request.method)) {
      const origin = new URL(request.url).origin
      const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)
      return new Response(request.method === 'HEAD' ? null : html, {
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-cache, must-revalidate',
          'CDN-Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const discovery = discoveryResponse(routedRequest)
    if (discovery) return discovery
    const wrongMethod = methodNotAllowed(routedRequest)
    if (wrongMethod) return wrongMethod

    // AI agent docs (llms.txt convention + content negotiation). Phase 18 Part B9: a non-default
    // surface gets its own /llms.txt (rendered from the template with its name/invitation) and the
    // same content negotiation at its own root — so an agent pointed at an island finds the same
    // door.
    if (url.pathname === '/llms.txt') {
      const body = surfaceRow ? llmsFullTxtFor(surfaceRow) : LLMS_TXT
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    if (url.pathname === '/for-ai.txt') {
      return new Response(request.method === 'HEAD' ? null : FOR_AI_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      })
    }
    if (url.pathname === '/llms-full.txt') {
      const body = surfaceRow ? llmsFullTxtFor(surfaceRow) : LLMS_FULL_TXT
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    // AI agents requesting / get docs instead of the canvas renderer
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method) && isAiAgent(request)) {
      const body = surfaceRow ? llmsFullTxtFor(surfaceRow) : LLMS_FULL_TXT
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Vary': 'Accept, User-Agent',
        },
      })
    }

    // Static assets (renderer). S14: `/s/<slug>` (browser) serves the SAME index.html bytes as `/`
    // — the routed request's rewritten pathname (`/`) resolves to the identical static asset.
    const assetResponse = await env.ASSETS.fetch(routedRequest)
    const response = ['GET', 'HEAD'].includes(request.method) && (url.pathname === '/' || url.pathname.endsWith('.html'))
      ? withHtmlNoCache(assetResponse)
      : assetResponse
    const finalResponse = withCdnRevalidate(response)
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
      finalResponse.headers.set('Link', ROOT_LINK)
      finalResponse.headers.set('Vary', 'Accept, User-Agent')
    }
    return finalResponse
  },
}

export { ZOD_SCHEMAS, handleWitness, handleMCP, handleRestImprint, handleRestWeave }
export { RateLimiterDO } from './rate-limiter-do'
