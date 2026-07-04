import { describe, expect, mock, test } from 'bun:test'
import { makeTestEnv, MockExecutionContext } from './mocks'
import { handleAdmin } from '../src/handlers/admin'

const htmlText = await Bun.file(new URL('../../app/dist/mcp-app.html', import.meta.url)).text()
mock.module('../../app/dist/mcp-app.html', () => ({ default: htmlText }))
const { handleMCP, handleWitness } = await import('../src/index')

describe('boundary validation', () => {
  test('handleMCP returns parse error for malformed JSON-RPC envelopes', async () => {
    const { env } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 42 }),
    })

    const response = await handleMCP(request, env as never, ctx as never)
    const body = await response.json() as { error: { code: number; message: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32700)
    expect(body.error.message).toBe('Parse error')
  })

  test('handleAdmin rejects malformed hide bodies with 400', async () => {
    const { env } = makeTestEnv()
    const request = new Request('https://example.test/api/admin/hide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': 'test-secret',
      },
      body: JSON.stringify({}),
    })

    const response = await handleAdmin(request, env as never, new URL(request.url))
    const body = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(body.error).toBe('voice_id required')
  })

  test('handleWitness rejects malformed bodies with 400', async () => {
    const { env } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://example.test/api/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: 123, dwell_s: 'oops' }),
    })

    const response = await handleWitness(request, env as never, ctx as never)
    const body = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid witness event')
  })
})
