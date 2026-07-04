const SESSION_ID_RE = /^(t:[0-9a-z]+):(\d+)\.([0-9a-f]+)$/
const SESSION_MAX_AGE_S = 2700 // 45 minutes

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

export async function signSessionId(traceId: string, secret: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const payload = `${traceId}:${iat}`
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${bytesToHex(new Uint8Array(sig))}`
}

export async function verifySessionId(sessionId: string, secret: string): Promise<string | null> {
  const match = SESSION_ID_RE.exec(sessionId)
  if (!match) return null
  const [, traceId, iatStr, sigHex] = match
  const iat = parseInt(iatStr, 10)
  const now = Math.floor(Date.now() / 1000)
  if (iat > now + 60) return null // reject future-dated tokens (60s clock skew tolerance)
  if (now - iat > SESSION_MAX_AGE_S) return null
  const sig = hexToBytes(sigHex)
  if (!sig) return null
  const key = await importHmacKey(secret)
  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${traceId}:${iat}`))
  return valid ? traceId : null
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
