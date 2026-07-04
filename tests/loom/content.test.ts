import { expect, test } from 'bun:test'
import { fetchState } from '../../src/content.js'

test('fetchState returns null quickly for an already-aborted signal', async () => {
  const previousFetch = globalThis.fetch
  const controller = new AbortController()
  controller.abort()

  let sawAbortedSignal = false
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    sawAbortedSignal = init?.signal?.aborted === true
    throw new DOMException('Aborted', 'AbortError')
  }

  try {
    expect(await fetchState({ refresh: true, signal: controller.signal })).toBeNull()
    expect(sawAbortedSignal).toBe(true)
  } finally {
    globalThis.fetch = previousFetch
  }
})
