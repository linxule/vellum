import { SESSION_MAX_AGE_S } from './contract'

// Phase 17 Part A3: the session id optionally embeds an author id, bound at `initialize` and
// carried thereafter — `t:<trace>|<author_id>:<iat>.<sig>`. The author-id segment is fixed-format
// (agent-id.ts's alphabet, no colon), so it never collides with the `:iat.sig` suffix parse.
const SESSION_ID_RE = /^(t:[0-9a-z]+)(?:\|(a_[A-Za-z0-9_-]{43}))?:(\d+)\.([0-9a-f]+)$/

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signSessionId(traceId: string, secret: string, authorId?: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const idPart = authorId ? `${traceId}|${authorId}` : traceId
  const payload = `${idPart}:${iat}`
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${bytesToHex(new Uint8Array(sig))}`
}

export type SessionVerification =
  | { valid: true; traceId: string; authorId?: string }
  | { valid: false; reason: 'invalid' | 'future' | 'expired'; retry_after?: number }

export async function verifySessionId(sessionId: string, secret: string): Promise<SessionVerification> {
  const match = SESSION_ID_RE.exec(sessionId)
  if (!match) return { valid: false, reason: 'invalid' }
  const [, traceId, authorId, iatStr, sigHex] = match
  const iat = parseInt(iatStr, 10)
  const sig = hexToBytes(sigHex)
  if (!sig) return { valid: false, reason: 'invalid' }
  const idPart = authorId ? `${traceId}|${authorId}` : traceId
  const key = await importHmacKey(secret)
  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${idPart}:${iat}`))
  if (!valid) return { valid: false, reason: 'invalid' }
  // Signature verified — an unsigned/tampered token can never reach 'future' or 'expired' below.
  const now = Math.floor(Date.now() / 1000)
  if (iat > now + 60) return { valid: false, reason: 'future' } // reject future-dated tokens (60s clock skew tolerance)
  // Authenticate before exposing an expiry reason; re-initialization can happen immediately.
  if (now - iat > SESSION_MAX_AGE_S) return { valid: false, reason: 'expired', retry_after: 0 }
  return { valid: true, traceId, ...(authorId ? { authorId } : {}) }
}

/** Constant-time string comparison to prevent timing attacks on secret comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length)
  let result = a.length ^ b.length
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return result === 0
}
