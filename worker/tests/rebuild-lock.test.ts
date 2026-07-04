import { describe, expect, test } from 'bun:test'
import { rebuildStateProjectionIfNotLocked } from '../src/cache'
import { makeTestEnv } from './mocks'

describe('rebuild lock and dirty marker', () => {
  test("single rebuild returns 'rebuilt'", async () => {
    const { db, kv } = makeTestEnv()

    const status = await rebuildStateProjectionIfNotLocked(db as never, kv as never)

    expect(status).toBe('rebuilt')
    expect(kv._getRaw('state:rebuild:lock')).toBeNull()
    expect(kv._getRaw('state:rebuild:dirty')).toBeNull()
    expect(kv._getRaw('state:projection')).not.toBeNull()
  })

  test("concurrent rebuilds with a dirty signal return 'locked' and 'rebuilt-twice'", async () => {
    const { db, kv } = makeTestEnv()
    kv.injectDelay('state:projection', 20)

    const first = rebuildStateProjectionIfNotLocked(db as never, kv as never)
    await Bun.sleep(5)
    const second = rebuildStateProjectionIfNotLocked(db as never, kv as never)

    expect(await second).toBe('locked')
    expect(await first).toBe('rebuilt-twice')
    expect(db.projectionRebuildCount).toBe(2)
    expect(kv._getRaw('state:rebuild:dirty')).toBeNull()
    expect(kv._getRaw('state:rebuild:lock')).toBeNull()
  })

  test('multiple queued dirty signals collapse to one follow-up rebuild', async () => {
    const { db, kv } = makeTestEnv()
    kv.injectDelay('state:projection', 20)

    const first = rebuildStateProjectionIfNotLocked(db as never, kv as never)
    await Bun.sleep(5)
    const lockedStatuses = await Promise.all([
      rebuildStateProjectionIfNotLocked(db as never, kv as never),
      rebuildStateProjectionIfNotLocked(db as never, kv as never),
      rebuildStateProjectionIfNotLocked(db as never, kv as never),
    ])

    expect(lockedStatuses).toEqual(['locked', 'locked', 'locked'])
    expect(await first).toBe('rebuilt-twice')
    expect(db.projectionRebuildCount).toBe(2)
    expect(kv._getRaw('state:rebuild:dirty')).toBeNull()
    expect(kv._getRaw('state:rebuild:lock')).toBeNull()
  })

  test("rebuild clears a pre-existing stale dirty marker without forcing a second pass", async () => {
    const { db, kv } = makeTestEnv()
    await kv.put('state:rebuild:dirty', '1', { expirationTtl: 300 })

    const status = await rebuildStateProjectionIfNotLocked(db as never, kv as never)

    expect(status).toBe('rebuilt')
    expect(db.projectionRebuildCount).toBe(1)
    expect(kv._getRaw('state:rebuild:dirty')).toBeNull()
  })
})
