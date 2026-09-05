import { signSessionId } from '../src/hmac'
import { describe, expect, mock, test } from 'bun:test'
import { makeTestEnv, MockExecutionContext } from './mocks'

const htmlText = await Bun.file(new URL('../../app/dist/mcp-app.html', import.meta.url)).text()
mock.module('../../app/dist/mcp-app.html', () => ({ default: htmlText }))
const { handleMCP } = await import('../src/index')

describe('resources/read base URL rewrite', () => {
  test('prod-origin request rewrites sentinel to the prod origin', async () => {
    const { env } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://vellum.linxule.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': await signSessionId('t:resources', env.SESSION_SECRET) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ui://vellum/pensieve.html' },
      }),
    })

    const response = await handleMCP(request, env as never, ctx as never)
    const body = await response.json() as {
      result: {
        contents: Array<{
          text: string
          _meta: { ui: { csp: { connectDomains: string[] } } }
        }>
      }
    }

    expect(response.status).toBe(200)
    expect(body.result.contents[0]?.text).toContain('https://vellum.linxule.com')
    expect(body.result.contents[0]?.text).not.toContain('__VELLUM_BASE_URL__')
    expect(body.result.contents[0]?._meta.ui.csp.connectDomains).toEqual(['https://vellum.linxule.com'])
  })

  test('local-dev request rewrites sentinel to localhost', async () => {
    const { env } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('http://localhost:8787/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': await signSessionId('t:resources', env.SESSION_SECRET) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'ui://vellum/pensieve.html' },
      }),
    })

    const response = await handleMCP(request, env as never, ctx as never)
    const body = await response.json() as {
      result: {
        contents: Array<{
          text: string
          _meta: { ui: { csp: { connectDomains: string[] } } }
        }>
      }
    }

    expect(response.status).toBe(200)
    expect(body.result.contents[0]?.text).toContain('http://localhost:8787')
    expect(body.result.contents[0]?._meta.ui.csp.connectDomains).toEqual(['http://localhost:8787'])
  })

  test('unknown resource URI returns method-not-found style resource error', async () => {
    const { env } = makeTestEnv()
    const ctx = new MockExecutionContext()
    const request = new Request('https://vellum.linxule.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': await signSessionId('t:resources', env.SESSION_SECRET) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://something/else' },
      }),
    })

    const response = await handleMCP(request, env as never, ctx as never)
    const body = await response.json() as { error: { code: number, message: string } }

    expect(response.status).toBe(200)
    expect(body.error.code).toBe(-32002)
    expect(body.error.message).toContain('Resource not found')
  })
})
