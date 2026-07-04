import type { Env } from './types'
import pensieveHtml from '../../app/dist/mcp-app.html'
import { withHtmlNoCache } from './analytics'
import { isAiAgent, FOR_AI_TXT, LLMS_FULL_TXT, LLMS_TXT } from './ai-docs'
import { handleAdmin } from './handlers/admin'
import { handleLineage } from './handlers/lineage'
import { handleLineages } from './handlers/lineages'
import { handleMCP } from './handlers/mcp'
import { handleRestImprint } from './handlers/rest-imprint'
import { handleRestWeave } from './handlers/rest-weave'
import { handleState } from './handlers/state'
import { handleVoices } from './handlers/voices'
import { handleWitness } from './handlers/witness'
import { ZOD_SCHEMAS } from './schemas'

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, X-Admin-Key',
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
// POST /api/imprint : public, 12/hr per IP shared with /api/weave
// POST /api/weave   : public, 12/hr per IP shared with /api/imprint, source_id required
// *    /api/admin/* : X-Admin-Key required, no CORS (server-side only)

// --- Main router ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return handleCors()

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
      return handleState(request, env, ctx)
    }

    // Lineage API
    const lineageMatch = url.pathname.match(/^\/api\/lineage\/([a-zA-Z0-9:_-]+)$/)
    if (lineageMatch && request.method === 'GET') {
      return handleLineage(request, env, lineageMatch[1]!)
    }

    // Voices API (paginated listing)
    if (url.pathname === '/api/voices' && request.method === 'GET') {
      return handleVoices(request, env)
    }

    // Lineages discovery API (woven voices)
    if (url.pathname === '/api/lineages' && request.method === 'GET') {
      return handleLineages(request, env)
    }

    // Witness API
    if (url.pathname === '/api/witness' && request.method === 'POST') {
      return handleWitness(request, env, ctx)
    }

    // REST write APIs (shared 12/hr per IP rate limit)
    if (url.pathname === '/api/imprint' && request.method === 'POST') {
      return handleRestImprint(request, env, ctx)
    }
    if (url.pathname === '/api/weave' && request.method === 'POST') {
      return handleRestWeave(request, env, ctx)
    }

    // Admin API
    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdmin(request, env, url)
    }

    // Ext-app standalone fallback: serve the bundled pensieve HTML directly.
    // JS reads window.location.search for ?highlight=xxx. Previously this
    // rewrote to / and hit env.ASSETS which served the main-site index.html —
    // wrong HTML, wrong bundle.
    if (url.pathname === '/ext-app' || url.pathname === '/ext-app/') {
      const origin = new URL(request.url).origin
      const html = pensieveHtml.replace(/__VELLUM_BASE_URL__/g, origin)
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-cache, must-revalidate',
          'CDN-Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // AI agent docs (llms.txt convention + content negotiation)
    if (url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    if (url.pathname === '/for-ai.txt') {
      return new Response(FOR_AI_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      })
    }
    if (url.pathname === '/llms-full.txt') {
      return new Response(LLMS_FULL_TXT, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    // AI agents requesting / get docs instead of the canvas renderer
    if (url.pathname === '/' && request.method === 'GET' && isAiAgent(request)) {
      return new Response(LLMS_FULL_TXT, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Vary': 'Accept, User-Agent',
        },
      })
    }

    // Static assets (renderer)
    const assetResponse = await env.ASSETS.fetch(request)
    const response = request.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'))
      ? withHtmlNoCache(assetResponse)
      : assetResponse
    return withCdnRevalidate(response)
  },
}

export { ZOD_SCHEMAS, handleWitness, handleMCP, handleRestImprint, handleRestWeave }
export { RateLimiterDO } from './rate-limiter-do'
