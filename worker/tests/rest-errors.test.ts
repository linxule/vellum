import { expect, test } from 'bun:test'
import { doorEnv, post, voice } from './door-mocks'
import { CONTRACT } from '../src/contract'

for (const [row, input, expected] of [
  ['A1', {}, {error_code:'VALIDATION',field:'text'}],
  ['A2', {content:'hi',families:['attention']}, {error_code:'UNKNOWN_FIELD',did_you_mean:'text'}],
  ['A3', {text:'hi',families:['joy']}, {field:'families.0',valid_values:[...CONTRACT.families]}],
] as const) test(`${row}: imprint gives a self-correcting endpoint-specific error`, async () => {
  const r=await doorEnv().fetch(post('/api/imprint',input)); const body=await r.json() as any
  expect(r.status).toBe(400); expect(body).toMatchObject(expected)
  expect(body.example).toEqual(CONTRACT.endpoints.imprint.example); expect(body.docs).toBe('https://vellum.linxule.com/for-ai.txt'); expect(body.error).toBe('Invalid body')
})
test('A4: thirteenth imprint returns quota and Retry-After', async () => {
  const t=doorEnv()
  for(let i=0;i<12;i++) expect((await t.fetch(post('/api/imprint',{text:'x',families:['attention']}))).status).toBe(201)
  const r=await t.fetch(post('/api/imprint',{text:'x',families:['attention']})); const b=await r.json() as any
  expect(r.status).toBe(429); expect(b).toMatchObject({error_code:'RATE_LIMITED',limit:12,error:'Rate limit exceeded'})
  expect(b.retry_after).toBeGreaterThan(0); expect(r.headers.get('retry-after')).toBe(String(b.retry_after)); await t.ctx.drain()
})
test('A5: invalid JSON retains its legacy error and endpoint example', async () => {
  for(const path of ['/api/imprint','/api/weave','/api/witness']) {
    const r=await doorEnv().fetch(new Request('https://vellum.test'+path,{method:'POST',body:'not json'}))
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error_code:'INVALID_JSON',error:'Invalid JSON',example:expect.any(Object)})
  }
})
test('A6: REST validation, quota, source, method, admission and internal faults retain error strings', async () => {
  const t=doorEnv(); t.db.failWarmthUpdateFamilies.add('attention')
  const requests=[post('/api/imprint',{}),post('/api/weave',{source_id:'v:missing',text:'x',families:['attention']}),post('/api/witness',{family:'attention',dwell_s:5}), new Request('https://vellum.test/api/imprint',{method:'PUT'}),new Request('https://vellum.test/api/imprint',{method:'POST',headers:{'content-length':'5000'}})]
  for(const request of requests) {
    const r=await t.fetch(request); const b=await r.json() as any
    expect(r.status).toBeGreaterThanOrEqual(400); expect(b.error).toBeString(); expect(b.docs).toBe('https://vellum.linxule.com/for-ai.txt')
    expect(JSON.stringify(b)).not.toContain('private database failure')
  }
  t.db.failReads=true
  // Phase 16 Part A2: a broken write-bucket check fails CLOSED (503 SURFACE_CLOSED), not the old
  // generic 500 — "a broken check must never blank the canvas" by silently admitting the write.
  // Weave's D1 outage surfaces earlier (resolveSource, before admitWrite even runs) and is still
  // caught by the generic 500 handler — a different failure point, still an internal fault.
  {
    const r=await t.fetch(post('/api/imprint',{text:'x',families:['attention']})); expect(r.status).toBe(503); expect(await r.json()).toMatchObject({error_code:'SURFACE_CLOSED'})
  }
  for(const request of [post('/api/weave',{source_id:'v:x',text:'x',families:['attention']}),new Request('https://vellum.test/api/voices')]) {
    const r=await t.fetch(request); expect(r.status).toBe(500); expect(await r.json()).toMatchObject({error_code:'INTERNAL',message:'The space is busy; retry with backoff.',error:'Internal error'})
  }
  await t.ctx.drain()
})
for(const [text,kind] of [['The original thought','exact'],['the original thought.','normalized'],['original','substring']] as const) test(`E2: REST source_text resolves ${kind} before writing`, async () => {
  const t=doorEnv([voice()]); const r=await t.fetch(post('/api/weave',{source_text:text,text:' response ',families:['memory']}))
  expect(r.status).toBe(201); expect(await r.json()).toMatchObject({resolved_by:kind,source_id:'v:source'})
  expect(t.db.voices.at(-1)).toMatchObject({text:'response',weave_from:'v:source'}); await t.ctx.drain()
})
test('E2: source_id has precedence and hidden sources never resolve', async () => {
  const t=doorEnv([voice(),voice('v:hidden','Hidden',{is_hidden:1})])
  for(const input of [{source_id:'v:missing',source_text:'The original thought'}, {source_text:'Hidden'}]) {
    const r=await t.fetch(post('/api/weave',{...input,text:'x',families:['memory']}))
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error_code:'SOURCE_NOT_FOUND'})
  }
  expect(t.db.voices).toHaveLength(2)
})
test('E3: empty weave body explains both source alternatives', async () => {
  const r=await doorEnv().fetch(post('/api/weave',{})); const b=await r.json() as any
  expect(r.status).toBe(400); expect(b.hint).toContain('source_id'); expect(b.hint).toContain('source_text'); expect(b.example).toEqual(CONTRACT.endpoints.weave.example)
})
test('E5: witness family Zod errors include enum values and preserve analytics keys', async () => {
  const t=doorEnv(); const r=await t.fetch(post('/api/witness',{family:'joy',dwell_s:5}))
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error_code:'VALIDATION',field:'family',valid_values:[...CONTRACT.families],error:'Invalid family'})
  expect(t.analytics.points.at(-1)?.blobs[2]).toBe('invalid_family')
  for(const [input,field] of [[{family:'attention'},'dwell_s'],[{dwell_s:5},'families']]) {
    const res=await t.fetch(post('/api/witness',input)); expect(res.status).toBe(400); expect(await res.json()).toMatchObject({error_code:'VALIDATION',field})
  }
})
