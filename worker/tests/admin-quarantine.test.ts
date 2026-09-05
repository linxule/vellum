import { expect, test } from 'bun:test'
import { doorEnv, post, voice } from './door-mocks'

function adminGet(path: string, key = 'test-secret') {
  return new Request(`https://vellum.test${path}`, { headers: { 'x-admin-key': key } })
}
function adminPost(path: string, body: unknown, key = 'test-secret') {
  return new Request(`https://vellum.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify(body) })
}

test('401 without the admin key, and with the wrong key', async () => {
  const t = doorEnv()
  const noKey = await t.fetch(new Request('https://vellum.test/api/admin/stats'))
  expect(noKey.status).toBe(401)
  expect((await noKey.json() as any).error_code).toBe('UNAUTHORIZED')
  const wrongKey = await t.fetch(adminGet('/api/admin/stats', 'wrong'))
  expect(wrongKey.status).toBe(401)
})

test('quarantine list is empty while the fuse is off, regardless of stored voices', async () => {
  const t = doorEnv([voice('v:a', 'a thought')])
  const r = await t.fetch(adminGet('/api/admin/quarantine'))
  expect(r.status).toBe(200)
  expect((await r.json() as any).voices).toEqual([])
})

test('quarantine release: releases a quarantined voice immediately', async () => {
  const t = doorEnv([voice('v:q', 'a settling thought', { visibility: 'quarantined', is_hidden: 1 })])
  const before = await t.fetch(adminGet('/api/admin/quarantine'))
  expect((await before.json() as any).voices).toHaveLength(1)

  const release = await t.fetch(adminPost('/api/admin/quarantine/release', { voice_id: 'v:q' }))
  expect(release.status).toBe(200)
  expect((await release.json() as any)).toMatchObject({ ok: true, voice_id: 'v:q' })

  const v = t.db.voices.find(v => v.id === 'v:q')!
  expect(v.visibility).toBe('surfaced')
  expect(v.is_hidden).toBe(0)

  const after = await t.fetch(adminGet('/api/admin/quarantine'))
  expect((await after.json() as any).voices).toEqual([])
})

test('bulk hide by content_hash: hides every voice sharing that hash', async () => {
  const t = doorEnv([
    voice('v:1', 'copy one', { content_hash: 'sharedhash' }),
    voice('v:2', 'copy two', { content_hash: 'sharedhash' }),
    voice('v:3', 'unrelated', { content_hash: 'otherhash' }),
  ])
  const r = await t.fetch(adminPost('/api/admin/hide', { content_hash: 'sharedhash' }))
  expect(r.status).toBe(200)
  const b = await r.json() as any
  expect(b.ok).toBe(true)
  expect(b.hidden_count).toBe(2)
  expect(new Set(b.voice_ids)).toEqual(new Set(['v:1', 'v:2']))
  expect(t.db.voices.find(v => v.id === 'v:1')!.is_hidden).toBeTruthy()
  expect(t.db.voices.find(v => v.id === 'v:2')!.is_hidden).toBeTruthy()
  expect(t.db.voices.find(v => v.id === 'v:3')!.is_hidden).toBeFalsy()
})

test('single voice_id hide still works (backward compatible with the pre-16 body)', async () => {
  const t = doorEnv([voice('v:solo', 'a thought')])
  const r = await t.fetch(adminPost('/api/admin/hide', { voice_id: 'v:solo' }))
  expect(r.status).toBe(200)
  expect((await r.json() as any)).toMatchObject({ ok: true, hidden_count: 1, voice_ids: ['v:solo'] })
})

test('unhide: reverses a hide', async () => {
  const t = doorEnv([voice('v:hidden', 'a thought', { is_hidden: 1 })])
  const r = await t.fetch(adminPost('/api/admin/unhide', { voice_id: 'v:hidden' }))
  expect(r.status).toBe(200)
  expect(t.db.voices.find(v => v.id === 'v:hidden')!.is_hidden).toBeFalsy()
})

test('two-selector hide body is rejected', async () => {
  const t = doorEnv([voice('v:1', 'x', { content_hash: 'h1' })])
  const r = await t.fetch(adminPost('/api/admin/hide', { voice_id: 'v:1', content_hash: 'h1' }))
  expect(r.status).toBe(400)
  expect((await r.json() as any).error_code).toBe('VALIDATION')
})

test('overload round-trips: on sets the flag, off clears it', async () => {
  const t = doorEnv()
  const on = await t.fetch(adminPost('/api/admin/overload', { on: true, ttl_s: 120 }))
  expect(on.status).toBe(200)
  expect(await t.kv.get('levee:overload')).not.toBeNull()

  const off = await t.fetch(adminPost('/api/admin/overload', { on: false }))
  expect(off.status).toBe(200)
  expect(await t.kv.get('levee:overload')).toBeNull()
})

test('admin routes carry no CORS header', async () => {
  const t = doorEnv()
  const r = await t.fetch(new Request('https://vellum.test/api/admin/stats'))
  expect(r.headers.get('access-control-allow-origin')).toBeNull()
})

// --- Post-review fix (item 1): hide/unhide must own BOTH visibility and is_hidden ----------------

test('hide sets BOTH visibility and is_hidden — a hidden voice can no longer be woven by id', async () => {
  const t = doorEnv([voice('v:target', 'a thought to hide')])
  const hide = await t.fetch(adminPost('/api/admin/hide', { voice_id: 'v:target' }))
  expect(hide.status).toBe(200)
  const v = t.db.voices.find(v => v.id === 'v:target')!
  expect(v.visibility).toBe('hidden')
  expect(v.is_hidden).toBeTruthy()

  const weave = await t.fetch(post('/api/weave', { source_id: 'v:target', text: 'trying to weave a hidden voice forward', families: ['attention'] }))
  expect(weave.status).toBe(400)
  expect((await weave.json() as any).error_code).toBe('SOURCE_NOT_FOUND')
})

test('unhide sets BOTH visibility back to surfaced and clears is_hidden', async () => {
  const t = doorEnv([voice('v:h', 'a thought', { visibility: 'hidden', is_hidden: 1 })])
  const r = await t.fetch(adminPost('/api/admin/unhide', { voice_id: 'v:h' }))
  expect(r.status).toBe(200)
  const v = t.db.voices.find(v => v.id === 'v:h')!
  expect(v.visibility).toBe('surfaced')
  expect(v.is_hidden).toBeFalsy()
})

test('visibility_mirror_mismatches stays 0 through hide then unhide', async () => {
  const t = doorEnv([voice('v:x', 'a thought')])
  await t.fetch(adminPost('/api/admin/hide', { voice_id: 'v:x' }))
  const afterHide = await (await t.fetch(adminGet('/api/admin/stats'))).json() as any
  expect(afterHide.levee.visibility_mirror_mismatches).toBe(0)

  await t.fetch(adminPost('/api/admin/unhide', { voice_id: 'v:x' }))
  const afterUnhide = await (await t.fetch(adminGet('/api/admin/stats'))).json() as any
  expect(afterUnhide.levee.visibility_mirror_mismatches).toBe(0)
  expect(t.db.voices.find(v => v.id === 'v:x')!.visibility).toBe('surfaced')
})

test('writer_bucket hide now targets voices the bucket AUTHORED (post-review fix, closes the Phase 16 report gap)', async () => {
  const t = doorEnv([
    voice('v:1', 'authored by this bucket', { writer_bucket: 'bucket-a' }),
    voice('v:2', 'also authored by this bucket', { writer_bucket: 'bucket-a' }),
    voice('v:3', 'authored by a different bucket', { writer_bucket: 'bucket-b' }),
  ])
  const r = await t.fetch(adminPost('/api/admin/hide', { writer_bucket: 'bucket-a' }))
  expect(r.status).toBe(200)
  const b = await r.json() as any
  expect(b.hidden_count).toBe(2)
  expect(new Set(b.voice_ids)).toEqual(new Set(['v:1', 'v:2']))
  expect(t.db.voices.find(v => v.id === 'v:1')!.visibility).toBe('hidden')
  expect(t.db.voices.find(v => v.id === 'v:3')!.visibility).toBe('surfaced')
})

// --- Post-review fix (item 6): the fuse toggles without a deploy, mirroring the overload route ---

test('fuse round-trips: mode sets levee:fuse, off clears the override back to the env default', async () => {
  const t = doorEnv()
  const on = await t.fetch(adminPost('/api/admin/fuse', { mode: 'on' }))
  expect(on.status).toBe(200)
  expect(await t.kv.get('levee:fuse')).toBe('on')

  const off = await t.fetch(adminPost('/api/admin/fuse', { mode: 'off' }))
  expect(off.status).toBe(200)
  expect(await t.kv.get('levee:fuse')).toBe('off')
})

test('fuse route rejects an invalid mode', async () => {
  const t = doorEnv()
  const r = await t.fetch(adminPost('/api/admin/fuse', { mode: 'nonsense' }))
  expect(r.status).toBe(400)
  expect((await r.json() as any).error_code).toBe('VALIDATION')
})
