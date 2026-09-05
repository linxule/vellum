import { describe, test, expect } from 'bun:test'
import { deriveAgentId, isAgentId, readAgentSecret } from '../src/agent-id'

describe('deriveAgentId', () => {
  test('a fixed secret derives a fixed 45-char a_ id', async () => {
    const id = await deriveAgentId('this-is-a-fixed-test-secret-value')
    expect(id).toBe(await deriveAgentId('this-is-a-fixed-test-secret-value'))
    expect(id).toMatch(/^a_[A-Za-z0-9_-]{43}$/)
    expect(id.length).toBe(45)
  })
  test('different secrets derive different ids', async () => {
    const a = await deriveAgentId('secret-one-secret-one-secret-one')
    const b = await deriveAgentId('secret-two-secret-two-secret-two')
    expect(a).not.toBe(b)
  })
})

describe('isAgentId', () => {
  test('accepts well-formed ids, rejects everything else', async () => {
    const valid = await deriveAgentId('a-valid-enough-secret-for-testing')
    expect(isAgentId(valid)).toBe(true)
    expect(isAgentId('a_tooshort')).toBe(false)
    expect(isAgentId('t:abcdef')).toBe(false)
    expect(isAgentId('v:abc123')).toBe(false)
    expect(isAgentId(valid.slice(0, -1))).toBe(false)
    expect(isAgentId(valid + 'x')).toBe(false)
  })
})

describe('invariant: declared_model is read by nothing in the identity/echo/idempotency modules', () => {
  test('static guard — never gate identity logic on the self-declared model string', () => {
    const fs = require('fs') as typeof import('fs')
    for (const file of ['agent-id.ts', 'echo.ts', 'idempotency.ts', 'handlers/who.ts', 'handlers/echo.ts']) {
      const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(source).not.toContain('declared_model')
    }
  })
})

describe('readAgentSecret', () => {
  function req(headers: Record<string, string>) {
    return new Request('https://vellum.test/api/imprint', { headers })
  }
  test('no header at all -> null (anonymous)', () => {
    expect(readAgentSecret(req({}))).toBeNull()
  })
  test('21 chars fails, 22 passes, 128 passes, 129 fails', () => {
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'a'.repeat(21) }))).toEqual({ error: 'AGENT_AUTH_FAILED' })
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'a'.repeat(22) }))).toEqual({ secret: 'a'.repeat(22) })
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'a'.repeat(128) }))).toEqual({ secret: 'a'.repeat(128) })
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'a'.repeat(129) }))).toEqual({ error: 'AGENT_AUTH_FAILED' })
  })
  test('non-printable-ASCII fails', () => {
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'a'.repeat(20) + '\t\t' }))).toEqual({ error: 'AGENT_AUTH_FAILED' })
    expect(readAgentSecret(req({ 'X-Vellum-Agent': 'valid-uuid-shaped-secret-1234' }))).toEqual({ secret: 'valid-uuid-shaped-secret-1234' })
  })
  test('Authorization: Bearer alias works when allowed (REST), and is ignored when disallowed (MCP)', () => {
    const secret = 'a'.repeat(32)
    expect(readAgentSecret(req({ Authorization: `Bearer ${secret}` }))).toEqual({ secret })
    expect(readAgentSecret(req({ Authorization: `Bearer ${secret}` }), { allowBearerAlias: false })).toBeNull()
  })
  test('X-Vellum-Agent wins over Authorization when both present', () => {
    const direct = 'b'.repeat(30)
    const bearer = 'c'.repeat(30)
    expect(readAgentSecret(req({ 'X-Vellum-Agent': direct, Authorization: `Bearer ${bearer}` }))).toEqual({ secret: direct })
  })
})
