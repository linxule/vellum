import { expect, test } from 'bun:test'
import { doorEnv, post } from './door-mocks'
import { CONTRACT } from '../src/contract'
import { admitBody } from '../src/admission'

for(const path of ['/api/imprint','/api/weave','/api/witness','/api/admin/hide','/api/admin/stats','/api/admin/unknown','/mcp']) test(`I1 I4: ${path} rejects declared oversized bodies before reading`, async () => {
  const cap=path==='/mcp'?CONTRACT.mcpBodyMaxBytes:CONTRACT.bodyMaxBytes
  const req=new Request('https://vellum.test'+path,{method:'POST',headers:{'content-length':String(cap+1024)},body:'x'.repeat(cap+1024)})
  const r=await doorEnv().fetch(req)
  expect(r.status).toBe(413); expect(req.bodyUsed).toBe(false)
  expect(await r.json()).toMatchObject({error_code:'PAYLOAD_TOO_LARGE',hint:`max ${cap} bytes`,error:expect.any(String)})
})
for(const path of ['/api/imprint','/api/weave','/api/witness','/api/admin/hide','/mcp']) test(`I1 I4: ${path} counts chunked UTF-8 bytes and cancels over-limit streams`, async () => {
  const cap=path==='/mcp'?CONTRACT.mcpBodyMaxBytes:CONTRACT.bodyMaxBytes
  let cancelled=false, pulls=0
  const stream=new ReadableStream<Uint8Array>({pull(c){pulls++; c.enqueue(new TextEncoder().encode('界'.repeat(512)))},cancel(){cancelled=true}})
  const req=new Request('https://vellum.test'+path,{method:'POST',body:stream})
  const r=await doorEnv().fetch(req); expect(r.status).toBe(413); expect((await r.json() as any).error_code).toBe('PAYLOAD_TOO_LARGE')
  await Bun.sleep(0); expect(cancelled).toBe(true); expect(pulls).toBeLessThan(Math.ceil(cap/1536)+4)
})
test('I admission: exact cap passes and a false small Content-Length cannot bypass counting', async () => {
  const exact=await admitBody(new Request('https://vellum.test',{method:'POST',body:'x'.repeat(4096)})); expect(exact).toEqual({text:'x'.repeat(4096)})
  const large=await admitBody(new Request('https://vellum.test',{method:'POST',headers:{'content-length':'1'},body:'x'.repeat(4097)})); expect('response' in large && large.response.status).toBe(413)
})
test('I2: garbage imprint is bounded by per-IP request admission, not the write-credit bucket', async () => {
  // Phase 16 Part A separates request admission (cheap, bounds the cost of asking) from
  // contribution credits (scarce, bounds churn) — conflating them, as the pre-Levee design did by
  // burning the 12/hr write bucket on unparseable JSON, "bounds neither" per the spec's design law.
  // A malformed body never reaches admitWrite's write-bucket step (JSON.parse fails first); it is
  // now bounded by the far looser per-IP request window (60/60s), enforced only with the flag on.
  const t=doorEnv(); t.env.LEVEE_ADMISSION='on'
  for(let i=0;i<61;i++) {
    const r=await t.fetch(new Request('https://vellum.test/api/imprint',{method:'POST',body:'not json'}))
    expect(r.status).toBe(i===60?429:400)
    if (i===60) expect((await r.json() as any).error_code).toBe('RATE_LIMITED')
  }
  expect(t.db.rateLimits.find(r=>r.key==='rest_write:1.2.3.4')).toBeUndefined()
})
test('I3: bad weave source is resolved before an exhausted quota', async () => {
  const t=doorEnv(); t.db.rateLimits.push({key:'rest_write:1.2.3.4',count:12,window_start:Date.now(),expires_at:Date.now()+3600000})
  const r=await t.fetch(post('/api/weave',{source_id:'v:missing',text:'x',families:['attention']}))
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error_code:'SOURCE_NOT_FOUND',source_id:'v:missing'})
  expect(t.db.rateLimits[0].count).toBe(12); expect(t.db.sourceReads).toBe(1)
})
