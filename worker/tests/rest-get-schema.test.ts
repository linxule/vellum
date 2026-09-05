import { expect, test } from 'bun:test'
import { doorEnv } from './door-mocks'
import { FAMILIES } from '../src/types'
import { RATE_LIMITS } from '../src/rate-limits'
import { CONTRACT } from '../src/contract'

test('D1: write GET schemas follow live family and rate-limit constants', async () => {
  const t = doorEnv()
  const original=RATE_LIMITS.rest_write.limit
  try {
    for (const value of [12, 19]) {
      (RATE_LIMITS.rest_write as {limit:number}).limit=value
      if (value===19) (FAMILIES as unknown as string[]).push('test-current')
      for(const e of Object.values(CONTRACT.endpoints)) {
        const r=await t.fetch(new Request('https://vellum.test'+e.path)); const body=await r.json() as any
        expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(body.fields.families.values).toEqual([...FAMILIES]); expect(body.rate_limit.limit).toBe(e.rateLimit.limit)
        expect(body.fields).toEqual(e.fields); expect(body.example).toEqual(e.example)
      }
    }
  } finally { (RATE_LIMITS.rest_write as {limit:number}).limit=original; if(FAMILIES.at(-1)==='test-current') (FAMILIES as unknown as string[]).pop() }
})
