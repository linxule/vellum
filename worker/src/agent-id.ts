// Phase 17 "The Echo" — Part A1. Identity is a gift, not a gate: no secret is ever required to
// write. `id = 'a_' + base64url(SHA-256(secret))`. The server never generates or stores the
// secret — it is recomputed from whatever the client presents on every request.

const AGENT_ID_RE = /^a_[A-Za-z0-9_-]{43}$/
const MIN_SECRET_LEN = 22
const MAX_SECRET_LEN = 128
// Printable ASCII: 0x20 (space) through 0x7E.
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `id = 'a_' + base64url(SHA-256(utf8(secret)))` — 45 chars total, alphabet [A-Za-z0-9_-]. */
export async function deriveAgentId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return 'a_' + base64UrlEncode(new Uint8Array(digest))
}

export function isAgentId(s: string): boolean {
  return AGENT_ID_RE.test(s)
}

export type AgentSecretResult = { secret: string } | { error: 'AGENT_AUTH_FAILED' } | null

/**
 * Reads `X-Vellum-Agent` (primary, both transports) or `Authorization: Bearer <secret>` (REST
 * alias only, for curl ergonomics — pass `allowBearerAlias: false` for MCP). Returns:
 *   - null: no header present at all → anonymous, exactly today's path.
 *   - { secret }: a well-formed (22-128 printable ASCII) secret.
 *   - { error: 'AGENT_AUTH_FAILED' }: a header was present but malformed.
 */
export function readAgentSecret(request: Request, opts: { allowBearerAlias?: boolean } = {}): AgentSecretResult {
  const allowBearerAlias = opts.allowBearerAlias ?? true
  const direct = request.headers.get('x-vellum-agent')
  const bearerHeader = allowBearerAlias ? request.headers.get('authorization') : null
  const bearerSecret = bearerHeader?.toLowerCase().startsWith('bearer ') ? bearerHeader.slice(7).trim() : undefined
  const present = direct !== null ? direct : bearerSecret !== undefined ? bearerSecret : null
  if (present === null) return null
  if (present.length < MIN_SECRET_LEN || present.length > MAX_SECRET_LEN || !PRINTABLE_ASCII_RE.test(present)) {
    return { error: 'AGENT_AUTH_FAILED' }
  }
  return { secret: present }
}
