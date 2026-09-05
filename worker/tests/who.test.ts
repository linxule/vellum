import { describe, test, expect } from 'bun:test'
import { doorEnv, voice } from './door-mocks'

function get(path: string) {
  return new Request(`https://vellum.test${path}`, { method: 'GET', headers: { 'cf-connecting-ip': '1.2.3.4' } })
}

describe('D9: GET /who/{id}', () => {
  test('shape matches D2; no declared_model, no other a_ id anywhere in the body', async () => {
    const id = 'a_' + 'k'.repeat(43)
    const otherId = 'a_' + 'm'.repeat(43)
    const voices = [
      voice('v:1', 'first voice', { author_id: id, weave_count: 2, distinct_weavers: 8, declared_model: 'some-model' }),
      voice('v:2', 'second voice', { author_id: id, weave_count: 0 }),
      voice('v:3', 'rooted voice', { author_id: id, rooted_at: Date.now() }),
    ]
    const t = doorEnv(voices)
    t.db.agents.set(id, { id, first_seen: 1000, last_seen: 2000 })

    const r = await t.fetch(get(`/who/${id}`))
    const b = await r.json() as any
    expect(r.status).toBe(200)
    expect(b).toMatchObject({
      id, first_seen: 1000, last_seen: 2000, voices: 3, carried_forward: 1, rooted: 1, open_debts: 1,
    })
    expect(Array.isArray(b.recent)).toBe(true)
    const serialized = JSON.stringify(b)
    expect(serialized).not.toContain('declared_model')
    expect(serialized).not.toContain('some-model')
    // No OTHER a_ id anywhere in the body besides the subject itself.
    const otherIds = (serialized.match(/a_[A-Za-z0-9_-]{43}/g) ?? []).filter(m => m !== id)
    expect(otherIds).toHaveLength(0)
    expect(serialized).not.toContain(otherId)
  })

  test('unknown-but-well-formed id -> 404 (unlike /echo, "who" implies existence)', async () => {
    const t = doorEnv()
    const r = await t.fetch(get(`/who/${'a_' + 'n'.repeat(43)}`))
    expect(r.status).toBe(404)
    const b = await r.json() as any
    expect(b.error_code).toBe('NOT_FOUND')
  })

  test('malformed id -> 404 NOT_FOUND', async () => {
    const t = doorEnv()
    const r = await t.fetch(get('/who/nope'))
    expect(r.status).toBe(404)
  })
})
