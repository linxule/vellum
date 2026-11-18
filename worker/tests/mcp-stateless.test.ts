// MCP revision 2026-07-28 on /mcp: no initialize, no Mcp-Session-Id. Every request carries its
// version and capabilities in params._meta, mirrored into headers, and is accounted like REST.
import { expect, test } from 'bun:test'
import { doorEnv, post, rpc, session, voice } from './door-mocks'
import { CONTRACT, LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS, SERVER_VERSION } from '../src/contract'
import { RATE_LIMITS } from '../src/rate-limits'
import { deriveAgentId } from '../src/agent-id'
import { decodeMcpName, serverInstructions } from '../src/mcp-stateless'
import { TOOL_DEFINITIONS } from '../src/schemas'

const V = MODERN_PROTOCOL_VERSIONS[0]
const P = 'io.modelcontextprotocol/'
const UI = 'ui://vellum/pensieve.html'
const STATELESS_INSTRUCTIONS = serverInstructions('stateless')
const SECRET = 'stateless-secret-0123456789-abcdefghij'
const b64 = (s: string) => `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`

type Opts = {
  /** Merged over the conforming `_meta`; a key set to undefined is removed. */
  meta?: Record<string, unknown>
  /** Merged over the conforming headers; a key set to undefined is removed. */
  headers?: Record<string, string | undefined>
  id?: number | null
}
/** A conforming 2026-07-28 request unless `opts` deliberately breaks it. */
function srpc(method: string, params: Record<string, unknown> = {}, opts: Opts = {}) {
  const meta: Record<string, unknown> = { [`${P}protocolVersion`]: V, [`${P}clientCapabilities`]: {}, [`${P}clientInfo`]: { name: 'stateless-test', version: '0' }, ...opts.meta }
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k]
  const name = method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : undefined
  const headers: Record<string, string | undefined> = { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...(typeof name === 'string' ? { 'Mcp-Name': name } : {}), ...opts.headers }
  const sent = Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined))
  return post('/mcp', { jsonrpc: '2.0', ...(opts.id === null ? {} : { id: opts.id ?? 1 }), method, params: { ...params, _meta: meta } }, sent)
}
const call = (name: string, args: Record<string, unknown> = {}, opts: Opts & { meta?: Record<string, unknown> } = {}) => srpc('tools/call', { name, arguments: args }, opts)
const serverInfo = { name: CONTRACT.name, version: SERVER_VERSION }
const buckets = (t: ReturnType<typeof doorEnv>) => t.db.rateLimits.map(r => r.key)
const text = (b: any): string => b.result.content[0].text

/** DoorD1 models the write paths. The two tool reads it lacks (focus's per-current listings and
 * witness's voice lookup) are answered here — each test file owns its mock queries. */
function withToolReads(t: ReturnType<typeof doorEnv>) {
  const db = t.db as any
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
  const inCurrent = (family: unknown, surface: unknown) => db.voices.filter((v: any) => !v.is_hidden && (v.surface_id ?? 'vellum') === surface
    && db.voiceFamilies.some((f: any) => f.voice_id === v.id && f.family === family && f.ordinal === 0))
  const batch = db.batch.bind(db), first = db.first.bind(db)
  db.batch = async (statements: any[]) => /^SELECT v\.id, v\.text, v\.language, v\.weave_count, v\.unique_weavers, .*v\.created_at FROM voices v JOIN voice_families vf/.test(norm(statements[0]?.sql ?? ''))
    ? statements.map(st => ({ results: inCurrent(st._boundArgs()[0], st._boundArgs()[1]) }))
    : batch(statements)
  db.first = async (sql: string, args: unknown[]) => {
    if (!norm(sql).startsWith('SELECT v.text, vf.family FROM voices v JOIN voice_families vf')) return first(sql, args)
    const v = db.voices.find((v: any) => v.id === args[0] && !v.is_hidden && (v.surface_id ?? 'vellum') === args[1])
    const family = db.voiceFamilies.find((f: any) => f.voice_id === args[0] && f.ordinal === 0)?.family
    return v && family ? { text: v.text, family } : null
  }
  return t
}

test('server/discover: versions, capabilities with extensions inside, cache hints, serverInfo, no session', async () => {
  const t = doorEnv(); const r = await t.fetch(srpc('server/discover')); const b = await r.json() as any
  expect(r.status).toBe(200); expect(r.headers.get('mcp-session-id')).toBeNull()
  expect(b.result.supportedVersions).toEqual([...PROTOCOL_VERSIONS]); expect(b.result.supportedVersions[0]).toBe('2026-07-28')
  expect(b.result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public', _meta: { [`${P}serverInfo`]: serverInfo } })
  expect(b.result.capabilities).toEqual({ tools: { listChanged: false }, resources: {}, extensions: { [`${P}ui`]: {} } })
  expect(b.result.extensions).toBeUndefined()
  expect(b.result.instructions).toBe(STATELESS_INSTRUCTIONS)
  // Claude Code truncates server instructions at 2KB.
  expect(new TextEncoder().encode(STATELESS_INSTRUCTIONS).length).toBeLessThan(2000)
  expect(STATELESS_INSTRUCTIONS).not.toMatch(/per session/i)
  expect(STATELESS_INSTRUCTIONS).toContain(`${RATE_LIMITS.rest_write.limit} per hour per address`)
})

test('the version list is split: initialize negotiates legacy only, the cards list everything', async () => {
  expect([...PROTOCOL_VERSIONS]).toEqual(['2026-07-28', ...LEGACY_PROTOCOL_VERSIONS])
  const t = doorEnv()
  const init = await t.fetch(rpc('initialize', { protocolVersion: V })); const b = await init.json() as any
  expect(b.result.protocolVersion).toBe('2025-03-26'); expect(b.result.resultType).toBeUndefined(); expect(init.headers.get('mcp-session-id')).toBeTruthy()
  const card = await (await t.fetch(new Request('https://vellum.test/.well-known/mcp.json'))).json() as any
  expect(card.protocolVersions).toEqual([...PROTOCOL_VERSIONS])
})

test('list methods carry resultType, serverInfo and public cache hints', async () => {
  const t = doorEnv()
  for (const [method, key, length] of [['tools/list', 'tools', 6], ['resources/list', 'resources', 1], ['resources/templates/list', 'resourceTemplates', 1], ['prompts/list', 'prompts', 0]] as const) {
    const r = await t.fetch(srpc(method)); const b = await r.json() as any
    expect(r.status).toBe(200); expect(r.headers.get('mcp-session-id')).toBeNull()
    expect(b.result[key]).toHaveLength(length)
    expect(b.result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public', _meta: { [`${P}serverInfo`]: serverInfo } })
  }
})

test('tools/list drops the per-session limit sentences that only apply to sessions', async () => {
  const t = doorEnv()
  const stateless = (await (await t.fetch(srpc('tools/list'))).json() as any).result.tools as typeof TOOL_DEFINITIONS
  const legacy = (await (await t.fetch(rpc('tools/list', {}, await session(t.env)))).json() as any).result
  expect(legacy).toEqual({ tools: JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) })
  const sessionWorded = TOOL_DEFINITIONS.filter(d => /per session/.test(d.description)).map(d => d.name)
  expect(sessionWorded).toEqual(['leave_imprint', 'weave', 'witness'])
  for (const tool of stateless) expect(tool.description).not.toMatch(/session\./)
  expect(stateless.map(d => ({ ...d, description: '' }))).toEqual(JSON.parse(JSON.stringify(TOOL_DEFINITIONS.map(d => ({ ...d, description: '' })))))
})

test('prompts/list is an empty list for a session client too, with no capability advertised', async () => {
  const t = doorEnv(); const sid = await session(t.env)
  const r = await t.fetch(rpc('prompts/list', {}, sid)); expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { prompts: [] } })
  const init = await (await t.fetch(rpc('initialize'))).json() as any
  expect(init.result.capabilities.prompts).toBeUndefined()
})

test('initialize keeps the session wording of the shared instructions; only the limits sentence differs by era', async () => {
  const t = doorEnv(); const init = await (await t.fetch(rpc('initialize'))).json() as any
  const { imprint, weave, witness } = RATE_LIMITS.session
  expect(init.result.instructions).toBe(serverInstructions('session'))
  // The session text is byte-identical to the literal initialize returned before the eras shared
  // a template (sha256 of that literal, taken from the commit before the change).
  expect(new Bun.CryptoHasher('sha256').update(init.result.instructions).digest('hex')).toBe('9a4889da1430136c823051690146487d82166e12c1a21b0260484d2858884c4c')
  expect(init.result.instructions).toContain(`Limits per session: ${imprint} imprints, ${weave} weaves, ${witness} witnesses.`)
  expect(init.result.instructions).toContain('To be remembered across sessions,')
  expect(init.result.instructions).not.toContain('There is no session')
})

test('resources/read: ui:// HTML is public with a short ttl; lineage JSON reads statelessly', async () => {
  const t = doorEnv([voice()])
  const ui = await (await t.fetch(srpc('resources/read', { uri: UI }))).json() as any
  expect(ui.result).toMatchObject({ resultType: 'complete', ttlMs: 60_000, cacheScope: 'public', _meta: { [`${P}serverInfo`]: serverInfo } })
  expect(ui.result.contents[0].text).toContain('https://vellum.test'); expect(ui.result.contents[0].text).not.toContain('__VELLUM_BASE_URL__')
  const lineage = await (await t.fetch(srpc('resources/read', { uri: 'vellum://lineage/v:source' }))).json() as any
  expect(JSON.parse(lineage.result.contents[0].text).seed).toBe('v:source')
  expect(lineage.result).toMatchObject({ resultType: 'complete', ttlMs: 60_000, cacheScope: 'public' })
  expect(buckets(t)).toContain('lineage:1.2.3.4'); expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false)
})

test('a missing resource is -32602 with the uri, never -32002', async () => {
  const t = doorEnv()
  for (const uri of ['vellum://lineage/v:missing', 'vellum://nowhere', 'file:///etc/passwd']) {
    const r = await t.fetch(srpc('resources/read', { uri })); const b = await r.json() as any
    expect(b.result).toBeUndefined(); expect(b.error).toEqual({ code: -32602, message: 'Resource not found', data: { uri } })
  }
  // The session path keeps the code its revisions defined.
  const legacy = await (await t.fetch(rpc('resources/read', { uri: 'vellum://nowhere' }, await session(t.env)))).json() as any
  expect(legacy.error.code).toBe(-32002)
})

test('required headers: each one missing or mismatched is HTTP 400 / -32020', async () => {
  const t = doorEnv()
  const cases: [string, Record<string, string | undefined>][] = [
    ['MCP-Protocol-Version header is required', { 'MCP-Protocol-Version': undefined }],
    ['MCP-Protocol-Version header value', { 'MCP-Protocol-Version': '2025-11-25' }],
    ['Mcp-Method header is required', { 'Mcp-Method': undefined }],
    ['Mcp-Method header value', { 'Mcp-Method': 'tools/list' }],
    ['Mcp-Name header is required', { 'Mcp-Name': undefined }],
    ['Mcp-Name header value', { 'Mcp-Name': 'focus' }],
    ['does not decode', { 'Mcp-Name': '=?base64?%%%?=' }],
    ['Mcp-Name header value', { 'Mcp-Name': b64('focus') }],
  ]
  for (const [message, headers] of cases) {
    const r = await t.fetch(call('sense_space', {}, { headers })); const b = await r.json() as any
    expect(r.status).toBe(400); expect(b.error.code).toBe(-32020); expect(b.error.message).toContain(message); expect(b.id).toBe(1)
  }
  const read = await t.fetch(srpc('resources/read', { uri: UI }, { headers: { 'Mcp-Name': undefined } }))
  expect(read.status).toBe(400); expect((await read.json() as any).error.code).toBe(-32020)
  // Header names are case-insensitive; values are not.
  const lower = await t.fetch(call('sense_space', {}, { headers: { 'MCP-Protocol-Version': undefined, 'Mcp-Method': undefined, 'Mcp-Name': undefined, 'mcp-protocol-version': V, 'mcp-method': 'tools/call', 'mcp-name': 'sense_space' } }))
  expect(lower.status).toBe(200)
  const cased = await t.fetch(call('sense_space', {}, { headers: { 'Mcp-Name': 'Sense_Space' } })); expect(cased.status).toBe(400)
  expect(t.db.rateLimits.filter(r => !r.key.startsWith('admit:'))).toEqual([])
})

test('Mcp-Name in the Base64 sentinel form is decoded before comparing', async () => {
  expect(decodeMcpName('sense_space')).toBe('sense_space')
  expect(decodeMcpName('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界')
  expect(decodeMcpName(b64('=?base64?literal?='))).toBe('=?base64?literal?=')
  expect(decodeMcpName('=?base64?/w==?=')).toBeNull() // 0xFF is not UTF-8
  expect(decodeMcpName('=?BASE64?c2Vuc2Vfc3BhY2U=?=')).toBe('=?BASE64?c2Vuc2Vfc3BhY2U=?=') // markers are case-sensitive
  const t = doorEnv()
  const tool = await t.fetch(call('sense_space', {}, { headers: { 'Mcp-Name': b64('sense_space') } })); expect(tool.status).toBe(200)
  expect((await tool.json() as any).result.resultType).toBe('complete')
  const read = await t.fetch(srpc('resources/read', { uri: UI }, { headers: { 'Mcp-Name': b64(UI) } }))
  expect((await read.json() as any).result.contents).toHaveLength(1)
})

test('required _meta: missing or malformed clientCapabilities is HTTP 400 / -32602', async () => {
  const t = doorEnv()
  for (const capabilities of [undefined, null, 'none', []]) {
    const r = await t.fetch(srpc('tools/list', {}, { meta: { [`${P}clientCapabilities`]: capabilities } })); const b = await r.json() as any
    expect(r.status).toBe(400); expect(b.error.code).toBe(-32602); expect(b.error.message).toContain('clientCapabilities')
  }
  const version = await t.fetch(srpc('tools/list', {}, { meta: { [`${P}protocolVersion`]: 20260728 } }))
  expect(version.status).toBe(400); expect((await version.json() as any).error.code).toBe(-32602)
  const name = await t.fetch(srpc('tools/call', { name: 42 }, { headers: { 'Mcp-Name': '42' } }))
  expect(name.status).toBe(400); expect((await name.json() as any).error.code).toBe(-32602)
  // clientInfo and logLevel are optional.
  const bare = await t.fetch(srpc('tools/list', {}, { meta: { [`${P}clientInfo`]: undefined } })); expect(bare.status).toBe(200)
})

test('an unsupported _meta version is HTTP 400 / -32022 with supported and requested', async () => {
  const t = doorEnv()
  for (const requested of ['1900-01-01', '2027-01-01', ...LEGACY_PROTOCOL_VERSIONS]) {
    // Consistent headers, and no capabilities at all: the version is judged first.
    const r = await t.fetch(srpc('tools/list', {}, { meta: { [`${P}protocolVersion`]: requested, [`${P}clientCapabilities`]: undefined }, headers: { 'MCP-Protocol-Version': requested } }))
    const b = await r.json() as any
    expect(r.status).toBe(400); expect(b.error.code).toBe(-32022); expect(b.error.message).toStartWith('Unsupported protocol version')
    expect(b.error.data).toEqual({ supported: [...PROTOCOL_VERSIONS], requested })
  }
})

test('unknown methods, ping and initialize are HTTP 404 / -32601 on the stateless path', async () => {
  const t = doorEnv()
  for (const method of ['ping', 'initialize', 'notifications/initialized', 'prompts/get', 'resources/subscribe', 'logging/setLevel', 'nope/nope']) {
    const r = await t.fetch(srpc(method)); const b = await r.json() as any
    expect(r.status).toBe(404); expect(b.error.code).toBe(-32601); expect(b.error.message).toContain(method); expect(r.headers.get('mcp-session-id')).toBeNull()
  }
  const init = await (await t.fetch(srpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }))).json() as any
  expect(init.error.data).toEqual({ supported: [...PROTOCOL_VERSIONS] })
  expect(buckets(t).some(k => k.startsWith('init:'))).toBe(false)
  // server/discover exists only statelessly; a session client gets what it always got.
  const legacy = await t.fetch(rpc('server/discover', {}, await session(t.env)))
  expect(legacy.status).toBe(200); expect((await legacy.json() as any).error.code).toBe(-32601)
})

test('a legacy-shaped request is untouched by era detection', async () => {
  const t = doorEnv()
  // _meta without the protocol version key (progressToken, idempotencyKey) is not a modern request.
  const r = await t.fetch(rpc('tools/list', { _meta: { progressToken: 1 } }, undefined, { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' }))
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: { code: -32000, message: 'Mcp-Session-Id header required' } })
  const sid = await session(t.env)
  const header = await t.fetch(rpc('tools/list', {}, sid, { 'MCP-Protocol-Version': V }))
  expect(header.status).toBe(400); expect((await header.json() as any).error).toMatchObject({ code: -32000, data: { supported: [...LEGACY_PROTOCOL_VERSIONS] } })
  const ok = await (await t.fetch(rpc('tools/list', {}, sid, { 'MCP-Protocol-Version': '2025-11-25' }))).json() as any
  expect(Object.keys(ok.result)).toEqual(['tools'])
})

test('a stateless request ignores Mcp-Session-Id and a notification gets 202 with no body', async () => {
  const t = doorEnv()
  const r = await t.fetch(call('sense_space', {}, { headers: { 'Mcp-Session-Id': 'not-a-session' } }))
  expect(r.status).toBe(200); expect(r.headers.get('mcp-session-id')).toBeNull()
  // A VALID session id beside modern _meta changes nothing either: no session is charged or echoed.
  const valid = await session(t.env)
  const w = await t.fetch(call('witness', { family: 'attention', dwell_s: 5 }, { headers: { 'Mcp-Session-Id': valid } })); const wb = await w.json() as any
  expect(w.headers.get('mcp-session-id')).toBeNull(); expect(text(wb)).not.toMatch(/session/)
  expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false); expect(buckets(t)).toContain('witness:1.2.3.4')
  const note = await t.fetch(srpc('notifications/cancelled', { requestId: 1 }, { id: null }))
  expect(note.status).toBe(202); expect(await note.text()).toBe('')
})

test('reads: sense_space, focus and discover run with no session and print no session line', async () => {
  const t = withToolReads(doorEnv([voice()]))
  for (const [name, args, shows] of [['sense_space', {}, 'total_voices'], ['focus', { family: 'attention' }, 'The original thought'], ['discover', {}, 'The original thought']] as const) {
    const r = await t.fetch(call(name, args)); const b = await r.json() as any
    expect(r.status).toBe(200); expect(b.error).toBeUndefined(); expect(b.result.isError).toBeUndefined(); expect(text(b)).toContain(shows)
    expect(b.result.resultType).toBe('complete'); expect(b.result._meta[`${P}serverInfo`]).toEqual(serverInfo)
    expect(b.result.ttlMs).toBeUndefined(); expect(b.result.cacheScope).toBeUndefined()
    expect(text(b)).not.toMatch(/session/)
  }
  expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false); await t.ctx.drain()
})

test('an anonymous imprint charges rest_write, stores no trace, prints no session line', async () => {
  const t = doorEnv()
  const r = await t.fetch(call('leave_imprint', { text: '  a stateless thought  ', families: ['memory'] })); const b = await r.json() as any
  expect(r.status).toBe(200); expect(b.result.isError).toBeUndefined(); expect(r.headers.get('mcp-session-id')).toBeNull()
  expect(t.db.voices).toHaveLength(1); expect(t.db.voices[0]).toMatchObject({ text: 'a stateless thought', trace_id: null, author_id: null })
  expect(text(b)).not.toMatch(/session/); expect(text(b)).toContain('identity: "anonymous"')
  expect(b.result).toMatchObject({ resultType: 'complete', _meta: { voiceId: t.db.voices[0].id, family: 'memory', vellum: { identity: 'anonymous', retry_safe: false }, [`${P}serverInfo`]: serverInfo } })
  expect(buckets(t)).toContain('rest_write:1.2.3.4')
  expect(buckets(t).some(k => k.startsWith('sess:') || k.startsWith('agent:'))).toBe(false); await t.ctx.drain()
})

test('the anonymous bucket is the one REST uses: 12 writes an hour across both transports', async () => {
  const t = doorEnv([voice()])
  for (let i = 0; i < 6; i++) {
    expect((await t.fetch(post('/api/imprint', { text: `rest thought ${i}`, families: ['attention'] }))).status).toBe(201)
    const kind = i % 2 ? call('weave', { source_id: 'v:source', text: `mcp weave ${i}`, families: ['light'] }) : call('leave_imprint', { text: `mcp thought ${i}`, families: ['space'] })
    expect((await (await t.fetch(kind)).json() as any).result.isError).toBeUndefined()
  }
  expect(t.db.rateLimits.find(r => r.key === 'rest_write:1.2.3.4')!.count).toBe(RATE_LIMITS.rest_write.limit)
  const over = await (await t.fetch(call('leave_imprint', { text: 'one too many', families: ['space'] }))).json() as any
  expect(over.result.isError).toBe(true); expect(over.result.resultType).toBe('complete')
  expect(over.result._meta.vellum).toMatchObject({ error_code: 'RATE_LIMITED', limit: RATE_LIMITS.rest_write.limit, retry_after: expect.any(Number) })
  expect(t.db.voices).toHaveLength(13); await t.ctx.drain()
})

test('a named write charges the agent bucket only, and the header does not carry to the next request', async () => {
  const t = doorEnv(); const id = await deriveAgentId(SECRET)
  const named = await (await t.fetch(call('leave_imprint', { text: 'named thought', families: ['light'] }, { headers: { 'X-Vellum-Agent': SECRET } }))).json() as any
  expect(named.result._meta.vellum.identity).toBe(id); expect(t.db.voices[0]).toMatchObject({ author_id: id, trace_id: null })
  expect(buckets(t)).toContain(`agent:${id}:imprint`)
  expect(buckets(t).some(k => k.startsWith('sess:') || k.startsWith('rest_write:'))).toBe(false)

  const next = await (await t.fetch(call('leave_imprint', { text: 'next thought', families: ['light'] }))).json() as any
  expect(next.result._meta.vellum.identity).toBe('anonymous'); expect(t.db.voices[1].author_id).toBeNull()
  expect(buckets(t)).toContain('rest_write:1.2.3.4')
  expect(t.db.rateLimits.find(r => r.key === `agent:${id}:imprint`)!.count).toBe(1)
  // Bearer is REST's alias only.
  const bearer = await (await t.fetch(call('leave_imprint', { text: 'bearer thought', families: ['light'] }, { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any
  expect(bearer.result._meta.vellum.identity).toBe('anonymous'); await t.ctx.drain()
})

test('a malformed X-Vellum-Agent is the only identity failure, with the session path\'s code and data', async () => {
  const t = doorEnv()
  for (const request of [call('leave_imprint', { text: 'x', families: ['light'] }, { headers: { 'X-Vellum-Agent': 'short' } }), srpc('tools/list', {}, { headers: { 'X-Vellum-Agent': 'short' } })]) {
    const r = await t.fetch(request); const b = await r.json() as any
    expect(r.status).toBe(200); expect(b.error.code).toBe(-32000); expect(b.error.data).toMatchObject({ error_code: 'AGENT_AUTH_FAILED', hint: expect.any(String) })
  }
  expect(t.db.voices).toHaveLength(0)
})

test('a stateless weave inserts a weave_log row under the ip: stand-in REST uses', async () => {
  const t = doorEnv([voice()])
  const r = await t.fetch(call('weave', { source_id: 'v:source', text: 'carried statelessly', families: ['attention'] })); const b = await r.json() as any
  expect(b.result.isError).toBeUndefined(); expect(text(b)).not.toMatch(/session/); expect(text(b)).toContain('source_unique_weavers: 1')
  const woven = t.db.voices.find(v => v.weave_from === 'v:source')!
  expect(woven).toMatchObject({ trace_id: null, text: 'carried statelessly' })
  const log = [...(t.db as unknown as { weaveLogRows: Map<string, { weaverVoiceId: string }> }).weaveLogRows.entries()]
  expect(log).toHaveLength(1); expect(log[0]![0]).toBe('v:source::ip:1.2.3.4'); expect(log[0]![1].weaverVoiceId).toBe(woven.id)
  expect(t.db.voices.find(v => v.id === 'v:source')).toMatchObject({ weave_count: 1, unique_weavers: 1 })
  // A REST weave from the same address is the same weaver: one row, not two.
  expect((await t.fetch(post('/api/weave', { source_id: 'v:source', text: 'carried over rest', families: ['attention'] }))).status).toBe(201)
  expect((t.db as unknown as { weaveLogRows: Map<string, unknown> }).weaveLogRows.size).toBe(1)
  expect(buckets(t)).toContain('rest_write:1.2.3.4'); expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false); await t.ctx.drain()
})

test('a named weaver behind an address that already wove gets its own weave_log row, on both transports', async () => {
  const t = doorEnv([voice()]); const id = await deriveAgentId(SECRET); const other = await deriveAgentId(SECRET + '-second')
  const rows = () => [...(t.db as unknown as { weaveLogRows: Map<string, { weaverId: string | null }> }).weaveLogRows.entries()]
  const weaveArgs = (n: number) => ({ source_id: 'v:source', text: `carried ${n}`, families: ['attention'] })
  // Anonymous first, then a named agent from the same address over stateless MCP.
  expect(((await (await t.fetch(call('weave', weaveArgs(1)))).json()) as any).result.isError).toBeUndefined()
  expect(((await (await t.fetch(call('weave', weaveArgs(2), { headers: { 'X-Vellum-Agent': SECRET } }))).json()) as any).result.isError).toBeUndefined()
  expect(rows().map(r => r[0]).sort()).toEqual([`v:source::${id}`, 'v:source::ip:1.2.3.4'].sort())
  expect(rows().find(r => r[0] === `v:source::${id}`)![1].weaverId).toBe(id)
  expect(rows().find(r => r[0] === 'v:source::ip:1.2.3.4')![1].weaverId).toBeNull()
  // The same agent again is the same weaver: still two rows.
  await t.fetch(call('weave', weaveArgs(3), { headers: { 'X-Vellum-Agent': SECRET } }))
  expect(rows()).toHaveLength(2)
  // A second named agent over REST from that address: a third row, keyed by its own id.
  expect((await t.fetch(post('/api/weave', weaveArgs(4), { 'X-Vellum-Agent': SECRET + '-second' }))).status).toBe(201)
  expect(rows().map(r => r[0])).toContain(`v:source::${other}`)
  expect(t.db.voices.find(v => v.id === 'v:source')).toMatchObject({ weave_count: 4, unique_weavers: 3 }); await t.ctx.drain()
})

test('a missing weave source is a tool error and charges nothing', async () => {
  const t = doorEnv()
  const b = await (await t.fetch(call('weave', { source_id: 'v:missing', text: 'x', families: ['attention'] }))).json() as any
  expect(b.result).toMatchObject({ isError: true, resultType: 'complete', _meta: { vellum: { error_code: 'SOURCE_NOT_FOUND' }, [`${P}serverInfo`]: serverInfo } })
  expect(buckets(t).some(k => k.startsWith('rest_write:'))).toBe(false)
  const invalid = await (await t.fetch(call('leave_imprint', { text: 'hi', families: ['joy'] }))).json() as any
  expect(invalid.result).toMatchObject({ isError: true, resultType: 'complete', _meta: { vellum: { error_code: 'VALIDATION', field: 'families.0' } } })
  const unknown = await t.fetch(call('nope')); const u = await unknown.json() as any
  expect(u.error.code).toBe(-32602); expect(u.error.data.tool).toBe('nope')
})

test('an idempotent retry replays, scoped to the caller: the address, or the id when named', async () => {
  const t = doorEnv(); const args = { text: 'said once', families: ['memory'] }
  const meta = { idempotencyKey: 'key-1' }
  const first = await (await t.fetch(call('leave_imprint', args, { meta }))).json() as any
  expect(first.result._meta.vellum).toEqual({ identity: 'anonymous', retry_safe: true })
  const retry = await (await t.fetch(call('leave_imprint', args, { meta }))).json() as any
  expect(retry.result._meta.voiceId).toBe(first.result._meta.voiceId); expect(retry.result._meta.vellum.replayed).toBe(true)
  expect(retry.result.resultType).toBe('complete'); expect(text(retry)).toBe(text(first))
  expect(t.db.voices).toHaveLength(1); expect(t.db.rateLimits.find(r => r.key === 'rest_write:1.2.3.4')!.count).toBe(1)
  const conflict = await (await t.fetch(call('leave_imprint', { ...args, text: 'said differently' }, { meta }))).json() as any
  expect(conflict.result._meta.vellum.error_code).toBe('IDEMPOTENCY_CONFLICT')
  // Another address, same key: its own scope, its own voice.
  await t.fetch(call('leave_imprint', args, { meta, headers: { 'cf-connecting-ip': '5.6.7.8' } })); expect(t.db.voices).toHaveLength(2)
  // Named: the id scopes the key, whatever the address.
  const named = { meta, headers: { 'X-Vellum-Agent': SECRET } }
  const a = await (await t.fetch(call('leave_imprint', args, named))).json() as any
  const b = await (await t.fetch(call('leave_imprint', args, { ...named, headers: { ...named.headers, 'cf-connecting-ip': '9.9.9.9' } }))).json() as any
  expect(b.result._meta.voiceId).toBe(a.result._meta.voiceId); expect(b.result._meta.vellum.replayed).toBe(true)
  expect(t.db.voices).toHaveLength(3); await t.ctx.drain()
})

test('witness uses REST\'s per-IP window and reports no session count', async () => {
  const t = withToolReads(doorEnv([voice()]))
  const b = await (await t.fetch(call('witness', { voice_id: 'v:source', dwell_s: 12 }))).json() as any
  expect(b.result.isError).toBeUndefined(); expect(text(b)).toContain('dwell_s: 12'); expect(text(b)).not.toMatch(/session/)
  expect(t.db.warmthState.find(w => w.family === 'attention')!.score).toBeGreaterThan(0)
  expect(buckets(t)).toContain('witness:1.2.3.4'); expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false)
  // A REST witness from the same address spends the same window.
  expect(await (await t.fetch(post('/api/witness', { family: 'attention', dwell_s: 5 }))).json()).toEqual({ ok: true })
  for (let i = 2; i < RATE_LIMITS.witness.limit; i++) expect((await (await t.fetch(call('witness', { family: 'light', dwell_s: 3 }))).json() as any).result.isError).toBeUndefined()
  const over = await (await t.fetch(call('witness', { family: 'light', dwell_s: 3 }))).json() as any
  expect(over.result.isError).toBe(true)
  expect(over.result._meta.vellum).toMatchObject({ error_code: 'RATE_LIMITED', limit: RATE_LIMITS.witness.limit, verb: 'witness', scope: 'ip', retry_after: expect.any(Number) })
  const elsewhere = await (await t.fetch(call('witness', { family: 'light', dwell_s: 3 }, { headers: { 'cf-connecting-ip': '5.6.7.8' } }))).json() as any
  expect(elsewhere.result.isError).toBeUndefined(); await t.ctx.drain()
})

test('lineage walks are rate-limited per IP, shared by sense_space and the lineage resource', async () => {
  const t = doorEnv([voice()]); const walk = { seed_voice_id: 'v:source' }
  for (let i = 0; i < RATE_LIMITS.lineage.limit; i++) {
    const b = await (await t.fetch(call('sense_space', walk))).json() as any
    expect(b.result.isError).toBeUndefined(); expect(text(b)).toContain('seed: "v:source"')
  }
  expect(t.db.rateLimits.find(r => r.key === 'lineage:1.2.3.4')!.count).toBe(RATE_LIMITS.lineage.limit)
  const reads = t.db.sourceReads
  const over = await (await t.fetch(call('sense_space', walk))).json() as any
  expect(over.result.isError).toBe(true)
  expect(over.result._meta.vellum).toMatchObject({ error_code: 'RATE_LIMITED', limit: RATE_LIMITS.lineage.limit, verb: 'lineage', scope: 'ip', retry_after: expect.any(Number) })
  const resource = await t.fetch(srpc('resources/read', { uri: 'vellum://lineage/v:source' })); const rb = await resource.json() as any
  expect(rb.error.code).toBe(-32000); expect(rb.error.data).toMatchObject({ error_code: 'RATE_LIMITED', limit: RATE_LIMITS.lineage.limit, verb: 'lineage', scope: 'ip' })
  expect(resource.headers.get('retry-after')).toBeTruthy(); expect(t.db.sourceReads).toBe(reads)
  // Without a seed there is no walk and no charge; another address has its own window.
  expect((await (await t.fetch(call('sense_space'))).json() as any).result.isError).toBeUndefined()
  const elsewhere = await (await t.fetch(call('sense_space', walk, { headers: { 'cf-connecting-ip': '5.6.7.8' } }))).json() as any
  expect(elsewhere.result.isError).toBeUndefined()
  expect(buckets(t).some(k => k.startsWith('sess:'))).toBe(false); await t.ctx.drain()
})

test('sense_space auto-digest works from the agent id alone', async () => {
  const t = doorEnv([voice()]); const id = await deriveAgentId(SECRET); const agent = { headers: { 'X-Vellum-Agent': SECRET } }
  const mine = await (await t.fetch(call('leave_imprint', { text: 'mine to be woven', families: ['memory'] }, agent))).json() as any
  await t.fetch(call('weave', { source_id: mine.result._meta.voiceId, text: 'someone carried it', families: ['memory'] }, { headers: { 'cf-connecting-ip': '5.6.7.8' } }))
  expect(t.db.echoEvents.filter(e => e.agent_id === id && e.kind === 'woven')).toHaveLength(1)
  const named = await (await t.fetch(call('sense_space', {}, agent))).json() as any
  expect(text(named)).toContain(`Echoes for ${id}:`); expect(text(named)).not.toMatch(/session/)
  const anonymous = await (await t.fetch(call('sense_space'))).json() as any
  expect(text(anonymous)).not.toContain('Echoes for'); await t.ctx.drain()
})

test('CORS allows the request-metadata headers', async () => {
  const r = await doorEnv().fetch(new Request('https://vellum.test/mcp', { method: 'OPTIONS' }))
  for (const header of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', 'X-Vellum-Agent']) expect(r.headers.get('access-control-allow-headers')).toContain(header)
})
