import { describe, expect, test } from 'bun:test'
import { handleWitness, ZOD_SCHEMAS } from '../src/index'
import { makeTestEnv, MockExecutionContext } from './mocks'

describe('duplicate family handling', () => {
  test('leave_imprint zod rejects duplicate families', () => {
    const parsed = ZOD_SCHEMAS.leave_imprint.safeParse({
      text: 'x',
      families: ['silence', 'silence'],
    })
    expect(parsed.success).toBeFalse()
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message)).toContain('families must be unique')
    }
  })

  test('weave zod rejects duplicate families', () => {
    const parsed = ZOD_SCHEMAS.weave.safeParse({
      text: 'x',
      families: ['light', 'light', 'light'],
    })
    expect(parsed.success).toBeFalse()
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message)).toContain('families must be unique')
    }
  })

  test('valid unique families still parse', () => {
    const parsed = ZOD_SCHEMAS.leave_imprint.safeParse({
      text: 'x',
      families: ['silence', 'light'],
    })
    expect(parsed.success).toBeTrue()
  })

  test('handleWitness dedupes duplicate families', async () => {
    const { env, db, analytics } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ families: ['silence', 'silence'], dwell_s: 5 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)
    expect(response.status).toBe(200)
    await ctx.drain()

    expect(db.warmthState.find(row => row.family === 'silence')?.score).toBeCloseTo(5 / 60, 6)
    const accepted = analytics.points.find(point => point.blobs[2] === 'accepted')
    expect(accepted?.blobs[3]).toBe('silence')
  })

  test('handleWitness dedupes mixed duplicates', async () => {
    const { env, db, analytics } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ families: ['silence', 'light', 'silence'], dwell_s: 5 }),
    })

    const response = await handleWitness(request, env as never, ctx as never)
    expect(response.status).toBe(200)
    await ctx.drain()

    expect(db.warmthState.find(row => row.family === 'silence')?.score).toBeCloseTo(5 / 60, 6)
    expect(db.warmthState.find(row => row.family === 'light')?.score).toBeCloseTo(5 / 60, 6)
    const accepted = analytics.points.find(point => point.blobs[2] === 'accepted')
    expect(accepted?.blobs[3]).toBe('silence,light')
  })
})
