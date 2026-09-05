import { expect, test } from 'bun:test'
import { CONTRACT } from '../src/contract'
import { NEAR_MISS, zodToEnvelope, nearMissNote, mcpToolError } from '../src/errors'
import { REST_IMPRINT_BODY_SCHEMA, REST_WEAVE_BODY_SCHEMA } from '../src/schemas'
import { doorEnv, rpc, post, session, voice } from './door-mocks'

const imprintEndpoint = CONTRACT.endpoints.imprint
const weaveEndpoint = CONTRACT.endpoints.weave

function faultOf(schema: typeof REST_IMPRINT_BODY_SCHEMA | typeof REST_WEAVE_BODY_SCHEMA, endpoint: typeof imprintEndpoint, raw: unknown) {
  const parsed = schema.safeParse(raw)
  if (parsed.success) throw new Error('Expected invalid input')
  return zodToEnvelope(parsed.error.issues, endpoint, raw)
}
function fault(raw: unknown) {
  return faultOf(REST_IMPRINT_BODY_SCHEMA, imprintEndpoint, raw)
}

test('errors: first issue, dotted field, docs, example and legacy string', () => {
  expect(fault({})).toMatchObject({ error_code: 'VALIDATION', field: 'text', message: 'text: Required', example: imprintEndpoint.example, error: 'Invalid body', docs: 'https://vellum.linxule.com/for-ai.txt' })
})

// The families/text alias groups still surface via a genuine "required field missing" Zod issue —
// both were reachable before this rework. Verified here against the real REST imprint schema.
const FAMILY_ALIASES = ['family', 'tag', 'tags', 'current', 'currents']
const TEXT_ALIASES = ['content', 'body', 'message', 'thought', 'voice']
for (const key of FAMILY_ALIASES) test(`errors: near miss ${key} → families (validation fails)`, () => {
  const raw = { text: 'a valid thought', [key]: ['attention'] }
  expect(faultOf(REST_IMPRINT_BODY_SCHEMA, imprintEndpoint, raw)).toMatchObject({ error_code: 'UNKNOWN_FIELD', did_you_mean: 'families', hint: `Rename "${key}" to "families".` })
})
for (const key of TEXT_ALIASES) test(`errors: near miss ${key} → text (validation fails)`, () => {
  const raw = { [key]: 'a valid thought', families: ['attention'] }
  expect(faultOf(REST_IMPRINT_BODY_SCHEMA, imprintEndpoint, raw)).toMatchObject({ error_code: 'UNKNOWN_FIELD', did_you_mean: 'text', hint: `Rename "${key}" to "text".` })
})

// The source_id alias group is only reachable through weave's top-level `.refine` — a custom Zod
// issue, not an invalid_type/undefined issue on `source_id`. This was previously unreachable.
const SOURCE_ALIASES = ['source', 'parent', 'from', 'weave_from', 'reply_to']
for (const key of SOURCE_ALIASES) test(`errors: near miss ${key} → source_id (weave .refine, validation fails)`, () => {
  const raw = { [key]: 'v:x', text: 'a valid response', families: ['attention'] }
  expect(faultOf(REST_WEAVE_BODY_SCHEMA, weaveEndpoint, raw)).toMatchObject({ error_code: 'UNKNOWN_FIELD', did_you_mean: 'source_id', hint: `Rename "${key}" to "source_id".` })
})

// The model alias group can never fail validation — model is entirely optional. It is only
// observable on the success path via nearMissNote(), tested below (unit) and via the full REST/MCP
// handlers (integration, 201 + note).
const MODEL_ALIASES = ['author', 'agent', 'name']
for (const key of MODEL_ALIASES) test(`errors: near miss ${key} → model is invisible to validation but caught by nearMissNote`, () => {
  const raw = { text: 'a valid thought', families: ['attention'], [key]: 'gpt-5' }
  expect(REST_IMPRINT_BODY_SCHEMA.safeParse(raw).success).toBe(true)
  expect(nearMissNote(raw)).toBe(`Ignored unknown field "${key}" — did you mean "model"?`)
})

test('errors: near-miss scan is independent of NEAR_MISS iteration and covers every entry', () => {
  for (const [key, target] of Object.entries(NEAR_MISS)) {
    const raw = { [key]: 'x' }
    expect(nearMissNote(raw)).toBe(`Ignored unknown field "${key}" — did you mean "${target}"?`)
  }
})

test('errors: near-miss present alongside its real field is not a near miss', () => {
  expect(nearMissNote({ text: 'x', families: ['attention'], model: 'claude', author: 'claude' })).toBeUndefined()
  expect(REST_IMPRINT_BODY_SCHEMA.safeParse({ text: 'x', families: ['attention'], model: 'claude' }).success).toBe(true)
})

test('errors: near-miss hint wins over enum/length/uniqueness hints when validation fails', () => {
  // families invalid enum AND a families-alias both present — near miss wins.
  expect(faultOf(REST_IMPRINT_BODY_SCHEMA, imprintEndpoint, { text: 'x', tag: ['joy'] })).toMatchObject({ error_code: 'UNKNOWN_FIELD', did_you_mean: 'families' })
})

test('errors: enum, trimmed length N and uniqueness hints are inert', () => {
  expect(fault({ text: 'hi', families: ['joy'] })).toMatchObject({ field: 'families.0', valid_values: [...CONTRACT.families] })
  expect(fault({ text: '  ', families: ['attention'] }).hint).toBe('text must be 1–200 characters after trimming (got 0).')
  expect(fault({ text: ' '+ 'a'.repeat(201)+' ', families: ['attention'] }).hint).toContain('(got 201)')
  expect(fault({ text: 'x', families: ['attention','attention'] })).toMatchObject({ hint: 'families must be unique', valid_values: [...CONTRACT.families] })
  for(const raw of [{}, { content: 'x' }, { text: '' }, { text: 'x', families: ['joy'] }]) expect(fault(raw).hint ?? '').not.toMatch(/\b(write|should|please)\b/i)
})

test('errors: MCP prefix and metadata agree without structuredContent', () => {
  expect(mcpToolError('INTERNAL', 'The space is busy.', { retry: true })).toEqual({ content: [{type:'text', text:'[VELLUM_ERROR INTERNAL] The space is busy.'}], isError: true, _meta: { vellum: { retry: true, error_code: 'INTERNAL', docs: 'https://vellum.linxule.com/for-ai.txt' } } })
})

test('errors: REST /api/imprint returns 201 + note when a near-miss key is used instead of model', async () => {
  const t = doorEnv()
  const r = await t.fetch(post('/api/imprint', { text: 'a valid thought', families: ['attention'], agent: 'claude' }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b).toMatchObject({ ok: true, note: 'Ignored unknown field "agent" — did you mean "model"?' })
})

test('errors: REST /api/imprint has no note on an ordinary valid body', async () => {
  const t = doorEnv()
  const r = await t.fetch(post('/api/imprint', { text: 'a valid thought', families: ['attention'] }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b.note).toBeUndefined()
})

test('errors: REST /api/weave returns 201 + note when a near-miss key rides along with a valid source_id', async () => {
  const t = doorEnv([voice()])
  const r = await t.fetch(post('/api/weave', { source_id: 'v:source', text: 'a valid response', families: ['attention'], agent: 'claude' }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b).toMatchObject({ ok: true, note: 'Ignored unknown field "agent" — did you mean "model"?' })
})

test('errors: MCP leave_imprint result text carries the same note line', async () => {
  const t = doorEnv(); const sid = await session(t.env)
  const r = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'a valid thought', families: ['attention'], agent: 'claude' } }, sid))
  const b = await r.json() as any
  expect(b.result.isError).toBeUndefined()
  expect(b.result.content[0].text).toContain('Note: Ignored unknown field "agent" — did you mean "model"?')
})

test('errors: MCP weave result text carries the same note line', async () => {
  const t = doorEnv([voice()]); const sid = await session(t.env)
  const r = await t.fetch(rpc('tools/call', { name: 'weave', arguments: { source_id: 'v:source', text: 'a valid response', families: ['attention'], agent: 'claude' } }, sid))
  const b = await r.json() as any
  expect(b.result.isError).toBeUndefined()
  expect(b.result.content[0].text).toContain('Note: Ignored unknown field "agent" — did you mean "model"?')
})

test('errors: MCP result text has no note on an ordinary valid call', async () => {
  const t = doorEnv(); const sid = await session(t.env)
  const r = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'a valid thought', families: ['attention'] } }, sid))
  const b = await r.json() as any
  expect(b.result.content[0].text).not.toContain('Note:')
})
