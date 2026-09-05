import { expect, test } from 'bun:test'
import { doorEnv, rpc, post, session, voice } from './door-mocks'
import { CONTRACT } from '../src/contract'

test('B1: invalid tool arguments are VALIDATION tool results with field metadata', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  for(const [args,field] of [[{},'text'],[{text:'hi',families:['joy']},'families.0']] as const) {
    const r=await t.fetch(rpc('tools/call',{name:'leave_imprint',arguments:args},sid)); const b=await r.json() as any
    expect(r.status).toBe(200); expect(b.error).toBeUndefined(); expect(b.result.isError).toBe(true)
    expect(b.result.content[0].text).toStartWith('[VELLUM_ERROR VALIDATION]')
    expect(b.result._meta.vellum).toMatchObject({error_code:'VALIDATION',field})
    if(field==='families.0') expect(b.result._meta.vellum.valid_values).toEqual([...CONTRACT.families])
    expect(b.result.structuredContent).toBeUndefined()
  }
})
test('B2: eighth imprint exposes session quota and remaining window', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  for(let i=0;i<7;i++) {
    const r=await t.fetch(rpc('tools/call',{name:'leave_imprint',arguments:{text:'x',families:['attention']}},sid))
    expect((await r.json() as any).result.isError).toBeUndefined()
  }
  // Phase 16: session credits live in t.db.rateLimits (D1), keyed sess:<traceId>:<type>, not KV.
  const row=t.db.rateLimits.find(r=>r.key==='sess:t:door:imprint')!; row.expires_at=Date.now()+3588_000
  const r=await t.fetch(rpc('tools/call',{name:'leave_imprint',arguments:{text:'x',families:['attention']}},sid)); const b=await r.json() as any
  expect(r.status).toBe(200); expect(b.result.content[0].text).toStartWith('[VELLUM_ERROR SESSION_QUOTA]')
  expect(b.result._meta.vellum).toMatchObject({error_code:'SESSION_QUOTA',limit:7,count:7,verb:'imprint'})
  expect(b.result._meta.vellum.retry_after).toBeGreaterThan(3585); expect(b.result._meta.vellum.retry_after).toBeLessThanOrEqual(3590)
  expect(t.db.voices).toHaveLength(7); await t.ctx.drain()
})
test('B3: unknown tool is Invalid params with six known tools, not isError', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  for(const name of ['nope','toString','__proto__', {toString:null}, 42]) {
    const r=await t.fetch(rpc('tools/call',{name},sid)); const b=await r.json() as any
    expect(r.status).toBe(200); expect(b.result).toBeUndefined(); expect(b.error.code).toBe(-32602)
    expect(b.error.data.tool).toEqual(name); expect(b.error.data.known).toEqual(['sense_space','focus','leave_imprint','weave','witness','discover'])
  }
})
test('B4 B5: parse errors and invalid envelopes use distinct JSON-RPC codes', async () => {
  const t=doorEnv()
  const parse=await t.fetch(new Request('https://vellum.test/mcp',{method:'POST',body:'not json'})); expect(parse.status).toBe(400)
  expect(await parse.json()).toMatchObject({error:{code:-32700,message:'Parse error'}})
  for(const invalid of [{foo:1},{method:42},null,[],{jsonrpc:'2.0',method:'tools/list',params:[]}]) {
    const r=await t.fetch(post('/mcp',invalid)); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error:{code:-32600,message:'Invalid Request'}})
  }
})
test('B6: unknown method remains Method not found after session validation', async () => {
  const t=doorEnv(); const r=await t.fetch(rpc('nope',{},await session(t.env)))
  expect(r.status).toBe(200); expect(await r.json()).toMatchObject({error:{code:-32601}})
})
test('B execution: missing source never writes and thrown tools never expose internals', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  const r=await t.fetch(rpc('tools/call',{name:'weave',arguments:{source_id:'v:missing',text:'x',families:['attention']}},sid)); const b=await r.json() as any
  expect(b.result.isError).toBe(true); expect(b.result._meta.vellum.error_code).toBe('SOURCE_NOT_FOUND'); expect(t.db.voices).toHaveLength(0)
  t.db.failReads=true
  const failure=await t.fetch(rpc('tools/call',{name:'weave',arguments:{source_id:'v:x',text:'x',families:['attention']}},sid)); const body=await failure.json() as any
  expect(body.result._meta.vellum).toMatchObject({error_code:'INTERNAL',retry:true})
  expect(JSON.stringify(body)).not.toContain('private database failure'); expect(body.result.content[0].text).toStartWith('[VELLUM_ERROR INTERNAL]')
})

test('B3 I3: weave resolves source before charging the session quota', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  for (let i=0;i<5;i++) {
    const r=await t.fetch(rpc('tools/call',{name:'weave',arguments:{source_id:'v:missing',text:'x',families:['attention']}},sid)); const b=await r.json() as any
    expect(b.result.isError).toBe(true); expect(b.result._meta.vellum.error_code).toBe('SOURCE_NOT_FOUND')
  }
  expect(await t.kv.get('session:t:door')).toBeNull()
  expect(t.db.voices).toHaveLength(0)
})

test('B quota metadata: weave, witness and sense_space use the same session error shape', async () => {
  const t=doorEnv([voice('v:x')]); const sid=await session(t.env)
  // Build a genuine cached atmosphere through a successful write first.
  await t.fetch(rpc('tools/call',{name:'leave_imprint',arguments:{text:'seed',families:['attention']}},sid)); await t.ctx.drain()
  // Phase 16: session credits live in t.db.rateLimits (D1), keyed sess:<traceId>:<type>.
  const now=Date.now()
  for(const [type,count] of [['weave',5],['witness',15],['lineage',30]] as const) t.db.rateLimits.push({key:`sess:t:door:${type}`,count,window_start:now,expires_at:now+3600_000})
  for(const [name,args,verb,limit] of [['weave',{source_id:'v:x',text:'x',families:['attention']},'weave',5],['witness',{family:'attention',dwell_s:5},'witness',15],['sense_space',{seed_voice_id:'v:x'},'lineage',30]] as const) {
    const r=await t.fetch(rpc('tools/call',{name,arguments:args},sid)); const b=await r.json() as any
    expect(b.result.isError).toBe(true); expect(b.result.content[0].text).toStartWith('[VELLUM_ERROR SESSION_QUOTA]')
    expect(b.result._meta.vellum).toMatchObject({error_code:'SESSION_QUOTA',verb,limit,count:limit,retry_after:expect.any(Number)})
  }
})
