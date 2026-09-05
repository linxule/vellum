// Phase 16 "The Levee" — Part B: duplicate detection as hospitality, never rejection.
// Pure functions, no D1/KV access. `contentHash` needs Web Crypto (available in Workers and in
// bun's test runtime) but touches no external state — "runtime-free" means no store, not no crypto.

/** NFKC → lowercase → strip Unicode punctuation/symbols → collapse whitespace → trim. */
export function normalizeForHash(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of the normalized text, truncated to 32 hex chars (16 bytes). */
export async function contentHash(text: string): Promise<string> {
  const normalized = normalizeForHash(text)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return bytesToHex(new Uint8Array(digest)).slice(0, 32)
}

/** Small synchronous string hash (FNV-1a, 32-bit) used to seed each shingle's 64-bit hash. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Expands a 32-bit seed into a 64-bit value (as a bigint) via two independent FNV rounds. */
function shingleHash64(shingle: string): bigint {
  const lo = BigInt(fnv1a(shingle))
  const hi = BigInt(fnv1a(shingle + ''))
  return (hi << 32n) | lo
}

/** 64-bit simhash over word 3-shingles of the normalized text, returned as 16 hex chars. */
export function simhash(text: string): string {
  const words = normalizeForHash(text).split(' ').filter(Boolean)
  const shingles: string[] = words.length >= 3
    ? words.slice(0, words.length - 2).map((_, i) => words.slice(i, i + 3).join(' '))
    : words.length > 0 ? [words.join(' ')] : ['']

  const weights = new Array(64).fill(0)
  for (const shingle of shingles) {
    const h = shingleHash64(shingle)
    for (let bit = 0; bit < 64; bit++) {
      const set = (h >> BigInt(bit)) & 1n
      weights[bit] += set === 1n ? 1 : -1
    }
  }
  let fingerprint = 0n
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) fingerprint |= (1n << BigInt(bit))
  }
  return fingerprint.toString(16).padStart(16, '0')
}

/** Hamming distance between two 64-bit simhashes given as hex strings. */
export function hammingDistance(a: string, b: string): number {
  const ai = BigInt('0x' + a)
  const bi = BigInt('0x' + b)
  let x = ai ^ bi
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

export type DuplicateClassification =
  | { kind: 'none' }
  | { kind: 'exact'; existingId: string }
  | { kind: 'repeated'; existingId: string }
  | { kind: 'near'; existingId: string; distance: number }

/**
 * Given the new write's normalized inputs and a bounded window of recent candidates, decides
 * exact / near / repeated / none. Callers supply the candidate rows (content_hash, simhash,
 * created_at, source) already scoped to "last 24h, limit 500" per docs/PHASE_16_SPEC.md Part B —
 * this function does no querying itself.
 */
export function classifyDuplicate(
  newHash: string,
  newSimhash: string,
  source: string,
  recent: { id: string; content_hash: string | null; simhash: string | null; created_at: number; source: string }[],
): DuplicateClassification {
  const exact = recent.filter(r => r.content_hash === newHash)
  if (exact.length > 0) {
    const now = Date.now()
    const repeatedRecently = exact.filter(r => r.source === source && now - r.created_at < 60_000)
    // classifyDuplicate observes the past; the caller's own insert is the write that would make
    // this the Nth repeat, so ">= 2 prior" means "this write would be the 3rd" — REPEATED_WRITE.
    if (repeatedRecently.length >= 2) return { kind: 'repeated', existingId: repeatedRecently[0].id }
    return { kind: 'exact', existingId: exact[0].id }
  }
  let nearest: { id: string; distance: number } | undefined
  for (const row of recent) {
    if (!row.simhash) continue
    const distance = hammingDistance(newSimhash, row.simhash)
    if (distance <= 6 && (!nearest || distance < nearest.distance)) nearest = { id: row.id, distance }
  }
  if (nearest) return { kind: 'near', existingId: nearest.id, distance: nearest.distance }
  return { kind: 'none' }
}
