// Phase 17 "The Echo" — Part B: idempotency. Agents retry; runtimes crash mid-request; duplicate
// voices are permanent. `op_key = sha256(identity || 0x1f || Idempotency-Key)`; `body_hash =
// sha256(canonicalJson(validated body))`. The receipt insert always rides inside the SAME D1
// batch as the write it accompanies (tools/_shared.ts, tools/weave.ts, handlers/rest-weave.ts) —
// a PK collision on that insert fails the whole batch atomically, and the loser re-reads and
// replays the winner's receipt (see B3 in docs/PHASE_17_SPEC.md's acceptance table).

const UNIT_SEPARATOR = '\x1f'

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** Stable JSON: object keys sorted recursively, arrays preserve order, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const out: Record<string, unknown> = {}
    for (const [k, v] of entries) out[k] = sortKeysDeep(v)
    return out
  }
  return value
}

export async function bodyHashOf(validatedBody: unknown): Promise<string> {
  return sha256Hex(canonicalJson(validatedBody))
}

/** identity = author_id, else MCP traceId, else `ip:<addr>` — the scope an Idempotency-Key is
 * bound to (never the secret itself, and never the raw IP in isolation from `ip:`'s tag). */
export async function opKeyFor(identity: string, idempotencyKey: string): Promise<string> {
  return sha256Hex(`${identity}${UNIT_SEPARATOR}${idempotencyKey}`)
}

export interface OpReceiptRow {
  op_key: string
  body_hash: string
  status: number
  receipt: string
  created_at: number
}

export type IdempotencyCheck =
  | { kind: 'miss' }
  | { kind: 'replay'; receipt: unknown; status: number }
  | { kind: 'conflict' }

/** Read-side of Part B's flow, called by each write handler BEFORE admitWrite/any charge. */
export async function checkIdempotency(db: D1Database, opKey: string, bodyHash: string): Promise<IdempotencyCheck> {
  const row = await db.prepare('SELECT op_key, body_hash, status, receipt, created_at FROM op_receipts WHERE op_key = ?')
    .bind(opKey).first<OpReceiptRow>()
  if (!row) return { kind: 'miss' }
  if (row.body_hash !== bodyHash) return { kind: 'conflict' }
  let receipt: unknown
  try { receipt = JSON.parse(row.receipt) } catch { receipt = {} }
  return { kind: 'replay', receipt, status: row.status }
}

/** Appended to a write's D1 batch (never called standalone) — the commit marker for that write. */
export function opReceiptInsertStatement(
  db: D1Database, opKey: string, bodyHash: string, status: number, receiptJson: string, now: number,
) {
  return db.prepare(
    'INSERT INTO op_receipts (op_key, body_hash, status, receipt, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(opKey, bodyHash, status, receiptJson, now)
}

/** Piggybacked on the projection rebuild (Part B) — 24h retention, bounded per sweep. Standard
 * SQLite (D1) has no DELETE...LIMIT; the bound lives in the subquery instead. */
export function opReceiptSweepStatement(db: D1Database, now: number, maxAgeMs = 24 * 3600 * 1000) {
  return db.prepare(
    `DELETE FROM op_receipts WHERE op_key IN (
       SELECT op_key FROM op_receipts WHERE created_at < ? ORDER BY created_at LIMIT 500
     )`,
  ).bind(now - maxAgeMs)
}
