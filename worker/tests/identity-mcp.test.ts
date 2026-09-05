import { describe, test, expect } from 'bun:test'
import { doorEnv, rpc } from './door-mocks'
import { signSessionId, verifySessionId } from '../src/hmac'
import { deriveAgentId } from '../src/agent-id'
import { computeQualifiedWeavers, computeDistinctWeavers } from '../src/levee-permanence'

const SECRET_43 = 'b'.repeat(43)
const OTHER_SECRET_43 = 'c'.repeat(43)

describe('signSessionId / verifySessionId with authorId (Phase 17 Part A3)', () => {
  test('round-trips traceId and authorId together', async () => {
    const authorId = await deriveAgentId(SECRET_43)
    const signed = await signSessionId('t:abc123', 'secret', authorId)
    const verified = await verifySessionId(signed, 'secret')
    expect(verified).toMatchObject({ valid: true, traceId: 't:abc123', authorId })
  })
  test('a session with no authorId verifies exactly as before (no authorId key)', async () => {
    const signed = await signSessionId('t:abc123', 'secret')
    const verified = await verifySessionId(signed, 'secret')
    expect(verified.valid).toBe(true)
    expect(verified).not.toHaveProperty('authorId')
  })
  test('tampering still invalidates a session carrying an authorId', async () => {
    const authorId = await deriveAgentId(SECRET_43)
    const signed = await signSessionId('t:abc123', 'secret', authorId)
    const tampered = signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a')
    expect(await verifySessionId(tampered, 'secret')).toMatchObject({ valid: false, reason: 'invalid' })
  })
})

describe('A6-A8: MCP initialize binds author_id; tools/call requires the header again (post-review fix, item 3)', () => {
  test('A6: initialize with header -> leave_imprint WITHOUT a header on that call writes anonymously (a leaked/copied session id must not impersonate the bound agent)', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': SECRET_43 }))
    const sid = init.headers.get('mcp-session-id')!

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'a bound thought', families: ['memory'] } }, sid))
    const body = await call.json() as any
    expect(body.result.isError).toBeUndefined()
    expect(t.db.voices[0].author_id).toBeNull()
    expect(body.result._meta.vellum.identity).toBe('anonymous')
    await t.ctx.drain()
  })

  test('A6b: initialize with header -> leave_imprint WITH the SAME header on that call writes as the bound author_id', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': SECRET_43 }))
    const sid = init.headers.get('mcp-session-id')!
    const expectedId = await deriveAgentId(SECRET_43)

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'a bound thought', families: ['memory'] } }, sid, { 'X-Vellum-Agent': SECRET_43 }))
    const body = await call.json() as any
    expect(body.result.isError).toBeUndefined()
    expect(t.db.voices[0].author_id).toBe(expectedId)
    await t.ctx.drain()
  })

  test('A7: tools/call with a header deriving to a DIFFERENT id than the session -> AGENT_AUTH_FAILED', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': SECRET_43 }))
    const sid = init.headers.get('mcp-session-id')!

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'x', families: ['memory'] } }, sid, { 'X-Vellum-Agent': OTHER_SECRET_43 }))
    const body = await call.json() as any
    expect(body.error.code).toBe(-32000)
    expect(body.error.data.error_code).toBe('AGENT_AUTH_FAILED')
    expect(body.error.data.reason).toContain('re-initialize')
    expect(t.db.voices).toHaveLength(0)
  })

  test('A7b: tools/call with the SAME id header as the session proceeds normally, writing as that id', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': SECRET_43 }))
    const sid = init.headers.get('mcp-session-id')!
    const expectedId = await deriveAgentId(SECRET_43)

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'still me', families: ['memory'] } }, sid, { 'X-Vellum-Agent': SECRET_43 }))
    const body = await call.json() as any
    expect(body.result.isError).toBeUndefined()
    expect(t.db.voices[0].author_id).toBe(expectedId)
    await t.ctx.drain()
  })

  test('A7c: tools/call with a MALFORMED header on a bound session -> AGENT_AUTH_FAILED (never silently ignored, even though a missing header is anonymous)', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': SECRET_43 }))
    const sid = init.headers.get('mcp-session-id')!

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'x', families: ['memory'] } }, sid, { 'X-Vellum-Agent': 'too-short' }))
    const body = await call.json() as any
    expect(body.error.code).toBe(-32000)
    expect(body.error.data.error_code).toBe('AGENT_AUTH_FAILED')
    expect(t.db.voices).toHaveLength(0)
  })

  test('A7d: tools/call with a header on a session that never bound one is inert (no header on a later call can newly bind an id)', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize'))
    const sid = init.headers.get('mcp-session-id')!

    const call = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'x', families: ['memory'] } }, sid, { 'X-Vellum-Agent': SECRET_43 }))
    const body = await call.json() as any
    expect(body.result.isError).toBeUndefined()
    expect(t.db.voices[0].author_id).toBeNull()
    await t.ctx.drain()
  })

  test('A8: initialize with a malformed header -> AGENT_AUTH_FAILED; without header -> today\'s behavior', async () => {
    const t = doorEnv()
    const bad = await t.fetch(rpc('initialize', {}, undefined, { 'X-Vellum-Agent': 'too-short' }))
    const badBody = await bad.json() as any
    expect(badBody.error.code).toBe(-32000)
    expect(badBody.error.data.error_code).toBe('AGENT_AUTH_FAILED')

    const clean = await t.fetch(rpc('initialize'))
    const cleanBody = await clean.json() as any
    expect(cleanBody.result.protocolVersion).toBeTruthy()
    expect(clean.headers.get('mcp-session-id')).toBeTruthy()
  })

  test('A9: a named agent weaving the same source from 3 sessions/3 IPs — unique_weavers counts sessions, qualified/distinct counts the id once (Phase 16 COALESCE)', async () => {
    // weave_log's PRIMARY KEY is (source_voice_id, weaver_trace_id): 3 different sessions produce
    // 3 distinct rows (unique_weavers = COUNT(*) = 3), each carrying the SAME weaver_id since it's
    // the same named agent. computeDistinctWeavers/computeQualifiedWeavers read
    // COALESCE(weaver_id, weaver_bucket), so all 3 rows collapse to exactly 1 distinct weaver —
    // this is the entire permanence effect identity adds, per docs/PHASE_17_SPEC.md Part A4.
    const authorId = await deriveAgentId('d'.repeat(40))
    const rows = [
      { weaverKey: authorId, hourBucket: 0 },
      { weaverKey: authorId, hourBucket: 1 },
      { weaverKey: authorId, hourBucket: 2 },
    ]
    expect(computeDistinctWeavers(rows)).toBe(1)
    expect(computeQualifiedWeavers(rows)).toBe(0) // far short of the 10-distinct-weaver gate
  })

  test('instructions mention X-Vellum-Agent and stay under 2KB', async () => {
    const t = doorEnv()
    const init = await t.fetch(rpc('initialize'))
    const body = await init.json() as any
    expect(body.result.instructions).toContain('X-Vellum-Agent')
    expect(new TextEncoder().encode(body.result.instructions).length).toBeLessThan(2048)
  })
})
