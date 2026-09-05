import { expect, test } from 'bun:test'
import { CONTRACT, SERVER_VERSION, type WriteSuccess } from '../src/contract'
import { REST_IMPRINT_BODY_SCHEMA, REST_WEAVE_BODY_SCHEMA, WITNESS_BODY_SCHEMA, ZOD_SCHEMAS } from '../src/schemas'
import { doorEnv, rpc, post } from './door-mocks'
import { LLMS_FULL_TXT, FOR_AI_TXT } from '../src/ai-docs'
import { renderErrorsSection, renderDiscoverySection } from '../src/discovery'
import server from '../server.json'

test('K1: Zod write field names and contract fields are a bijection', () => {
  const schemas={imprint:REST_IMPRINT_BODY_SCHEMA,weave:REST_WEAVE_BODY_SCHEMA.innerType(),witness:WITNESS_BODY_SCHEMA}
  for(const [name,schema] of Object.entries(schemas)) expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(CONTRACT.endpoints[name as keyof typeof schemas].fields).sort())
  expect(ZOD_SCHEMAS.weave.parse({source_text:'  source  ',text:' response ',families:['memory']})).toMatchObject({source_text:'source',text:'response'})
})
test('K2 G1: registry draft, discovery and MCP share version; instructions fit 2 KB', async () => {
  const t=doorEnv(); const r=await t.fetch(rpc('initialize')); const b=await r.json() as any
  const card=await (await t.fetch(new Request(CONTRACT.origin+CONTRACT.docs.mcp_card))).json() as any
  expect([server.version,card.version,b.result.serverInfo.version]).toEqual([SERVER_VERSION,SERVER_VERSION,SERVER_VERSION])
  expect(server.remotes[0].url).toBe(card.transports[0].url); expect(server).not.toHaveProperty('packages')
  expect(new TextEncoder().encode(b.result.instructions).length).toBeLessThan(2048); expect(b.result.instructions).toContain('[VELLUM_ERROR')
})
test('K3: Phase 15\'s receipt reservation is retired — consumed as identity + retry_safe + replayed', async () => {
  const t=doorEnv(); const r=await t.fetch(post('/api/imprint',CONTRACT.endpoints.imprint.example)); const b=await r.json() as WriteSuccess
  expect(r.status).toBe(201); expect(b).not.toHaveProperty('receipt')
  expect(b.identity).toBe('anonymous'); expect(b.retry_safe).toBe(false); expect(b).not.toHaveProperty('replayed')
  expect(CONTRACT.endpoints.imprint.returns).not.toHaveProperty('receipt')
  expect(CONTRACT.errorCodes).toHaveProperty('IDEMPOTENCY_CONFLICT')
  await t.ctx.drain()
})
test('G: full docs embed contract-rendered sections and invitation changes only by the specified lines', async () => {
  expect(LLMS_FULL_TXT).toContain(renderErrorsSection(CONTRACT)); expect(LLMS_FULL_TXT).toContain(renderDiscoverySection(CONTRACT))
  const baseline=Bun.spawnSync(['git','show','HEAD:worker/src/ai-docs.ts'])
  expect(baseline.exitCode).toBe(0)
  const source=baseline.stdout.toString()
  const original=source.split('export const FOR_AI_TXT = `')[1].split('\n`')[0]
  const addition='If a request fails, the JSON error names the field and the fix.\n\n'
  // Phase 17 Part E3: the served /for-ai.txt gains exactly one new section, RETURN, after "HOW TO
  // BEGIN" — everything else in the invitation is byte-identical to the Phase 15/16 baseline.
  const returnSection=FOR_AI_TXT.split('RETURN\n\n')[1]!.split('\n\n---\n\nWRITE')[0]
  // The pre-existing "---" separator between step 5 and WRITE stays; only the new
  // "RETURN\n\n<content>\n\n---\n\n" insertion between it and WRITE is stripped.
  const returnBlock=`RETURN\n\n${returnSection}\n\n---\n\n`
  // Phase 18 Part B9: a second new section, "OTHER OCEANS / ROOMS", is inserted immediately
  // before the pre-existing "---\n\nMCP" tail — same insertion pattern as RETURN above.
  const oceansSection=FOR_AI_TXT.split('OTHER OCEANS / ROOMS\n\n')[1]!.split('\n\n---\n\nMCP')[0]
  const oceansBlock=`OTHER OCEANS / ROOMS\n\n${oceansSection}\n\n---\n\n`
  expect(FOR_AI_TXT.replace(addition,'').replace(returnBlock,'').replace(oceansBlock,'')).toBe(original+'\n')
})
