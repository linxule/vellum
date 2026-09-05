import { expect, test, spyOn } from 'bun:test'
import { doorEnv, rpc, session, voice } from './door-mocks'
import { PROTOCOL_VERSIONS } from '../src/contract'
import { signSessionId, verifySessionId } from '../src/hmac'

const methods=[['notifications/initialized',{}],['ping',{}],['tools/list',{}],['tools/call',{name:'leave_imprint',arguments:{text:' x ',families:['attention']}}],['resources/list',{}],['resources/templates/list',{}],['resources/read',{uri:'ui://vellum/pensieve.html'}]] as const
async function oldSession(secret: string, seconds: number) {
  const now=Date.now(); const clock=spyOn(Date,'now').mockReturnValue(now-seconds*1000)
  try { return await signSessionId('t:door',secret) } finally { clock.mockRestore() }
}
for(const [method,params] of methods) for(const state of ['missing','tampered','expired','valid']) test(`H1 H2 H3: ${method} session ${state}`, async () => {
  const t=doorEnv(); const valid=await session(t.env)
  const sid=state==='missing'?undefined:state==='expired'?await oldSession(t.env.SESSION_SECRET,46*60):state==='tampered'?valid.slice(0,-1)+(valid.endsWith('a')?'b':'a'):valid
  const r=await t.fetch(rpc(method,{...params},sid))
  if(state==='valid') {expect(r.status).toBe(method==='notifications/initialized'?202:200); await t.ctx.drain(); return}
  expect(r.status).toBe(state==='missing'?400:404); const b=await r.json() as any
  expect(b.error.code).toBe(-32000)
  if(state==='missing') expect(b.error.message).toBe('Mcp-Session-Id header required')
  else expect(b.error.message).toContain('Re-initialize')
  if(state==='expired') expect(b.error.data).toEqual({reason:'expired',retry_after:0})
})
test('H3: verifier distinguishes authenticated expiry, malformed, tampered and future tokens', async () => {
  const t=doorEnv(); const old=await oldSession(t.env.SESSION_SECRET,2760)
  expect(await verifySessionId(old,t.env.SESSION_SECRET)).toMatchObject({valid:false,reason:'expired'})
  expect(await verifySessionId(old,t.env.SESSION_SECRET+'wrong')).toMatchObject({valid:false,reason:'invalid'})
  expect(await verifySessionId('not a session',t.env.SESSION_SECRET)).toMatchObject({valid:false,reason:'invalid'})
  expect(await verifySessionId(await oldSession(t.env.SESSION_SECRET,-120),t.env.SESSION_SECRET)).toMatchObject({valid:false,reason:'future'})
})
test('H3: an unsigned future-dated token is invalid, never future', async () => {
  const t=doorEnv()
  const futureValid=await oldSession(t.env.SESSION_SECRET,-120)
  // Same future iat, but signed with the wrong secret (or tampered) — signature check must run first.
  const wrongSecret=await oldSession(t.env.SESSION_SECRET+'wrong',-120)
  expect(await verifySessionId(wrongSecret,t.env.SESSION_SECRET)).toMatchObject({valid:false,reason:'invalid'})
  const tampered=futureValid.slice(0,-1)+(futureValid.endsWith('a')?'b':'a')
  expect(await verifySessionId(tampered,t.env.SESSION_SECRET)).toMatchObject({valid:false,reason:'invalid'})
})
test('H4: thirty-first lineage resource read is quota-limited before D1', async () => {
  const t=doorEnv([voice()]); const sid=await session(t.env)
  for(let i=0;i<30;i++) {
    const r=await t.fetch(rpc('resources/read',{uri:'vellum://lineage/v:source'},sid))
    expect((await r.json() as any).result.contents).toHaveLength(1)
  }
  const reads=t.db.sourceReads
  const r=await t.fetch(rpc('resources/read',{uri:'vellum://lineage/v:source'},sid)); const b=await r.json() as any
  expect(b.error.code).toBe(-32000); expect(b.error.data).toMatchObject({error_code:'SESSION_QUOTA',limit:30,count:30,verb:'lineage',retry_after:expect.any(Number)})
  expect(t.db.sourceReads).toBe(reads)
})
// Post-review fix (item 1): the `vellum://lineage/{voiceId}` resource template carries no surface
// segment, so it only ever addresses the default surface (see buildLineage's surfaceId param) —
// a voice seeded on a different surface must read as not-found here, not leak across.
test('lineage resource read: a voice on a non-default surface is not found (resource has no surface segment)', async () => {
  const t=doorEnv([voice('v:source', 'source phrase', { surface_id: 'otherland' })]); const sid=await session(t.env)
  const r=await t.fetch(rpc('resources/read',{uri:'vellum://lineage/v:source'},sid))
  const b=await r.json() as any
  expect(b.error?.code).toBe(-32002)
})
test('lineage resource read: a default-surface voice is unchanged (found)', async () => {
  const t=doorEnv([voice('v:source', 'source phrase', { surface_id: 'vellum' })]); const sid=await session(t.env)
  const r=await t.fetch(rpc('resources/read',{uri:'vellum://lineage/v:source'},sid))
  const b=await r.json() as any
  expect(b.result.contents).toHaveLength(1)
})
for(const version of PROTOCOL_VERSIONS) test(`H9: ${version} initializes, lists tools and executes a trimmed write`, async () => {
  const t=doorEnv(); const init=await t.fetch(rpc('initialize',{protocolVersion:version})); const data=await init.json() as any
  expect(data.result.protocolVersion).toBe(version); const sid=init.headers.get('mcp-session-id')!
  const list=await t.fetch(rpc('tools/list',{},sid,{'MCP-Protocol-Version':version})); expect((await list.json() as any).result.tools).toHaveLength(6)
  const call=await t.fetch(rpc('tools/call',{name:'leave_imprint',arguments:{text:'  a thought  ',families:['memory']}},sid,{'MCP-Protocol-Version':version}))
  expect((await call.json() as any).result.isError).toBeUndefined(); expect(t.db.voices[0].text).toBe('a thought'); await t.ctx.drain()
})
test('H9: untested 2024 protocol falls back to the default', async () => {
  const r=await doorEnv().fetch(rpc('initialize',{protocolVersion:'2024-11-05'})); expect(await r.json()).toMatchObject({result:{protocolVersion:'2025-03-26'}})
})
