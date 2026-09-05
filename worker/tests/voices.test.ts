import { expect, test } from 'bun:test'
import { doorEnv, voice } from './door-mocks'
import { FAMILIES } from '../src/types'
import { SORT_VALUES } from '../src/contract'

test('E1: voices sort=warmth orders the selected page by family warmth then weaves', async () => {
  const t=doorEnv([voice('v:cold'),voice('v:warm'),voice('v:warmer','more woven',{weave_count:5})])
  t.db.voiceFamilies[1].family='memory'; t.db.voiceFamilies[2].family='memory'
  t.db.warmthState=t.db.warmthState.map(r=>({...r,last_updated:Date.now(),score:r.family==='memory'?10:0}))
  const r=await t.fetch(new Request('https://vellum.test/api/voices?sort=warmth')); const b=await r.json() as any
  expect(r.status).toBe(200); expect(b.voices.map((v:any)=>v.id)).toEqual(['v:warmer','v:warm','v:cold']); expect(b.pagination.total).toBe(3)
})
test('voices: enum query errors and quota migrate to envelopes', async () => {
  const t=doorEnv()
  for(const [query,field,values] of [['sort=joy','sort',SORT_VALUES],['family=joy','family',FAMILIES]] as const) {
    const r=await t.fetch(new Request('https://vellum.test/api/voices?'+query)); expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({error_code:'VALIDATION',field,valid_values:[...values],error:'Invalid parameters'})
  }
  t.db.rateLimits[0].count=30
  const r=await t.fetch(new Request('https://vellum.test/api/voices')); expect(r.status).toBe(429)
  expect(await r.json()).toMatchObject({error_code:'RATE_LIMITED',limit:30,retry_after:expect.any(Number),error:'Too many requests'})
})
