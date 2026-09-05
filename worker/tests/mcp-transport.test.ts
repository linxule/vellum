import { expect, test, spyOn } from 'bun:test'
import { doorEnv, rpc, session } from './door-mocks'
import { CONTRACT, PROTOCOL_VERSIONS } from '../src/contract'

test('H5 Q6: mismatched Origin logs behind the flag and never rejects', async () => {
  const t=doorEnv(); const warn=spyOn(console,'warn').mockImplementation(()=>{})
  try {
    for(const flag of [undefined,'false','true']) {
      t.env.MCP_ORIGIN_LOG_ONLY=flag
      const before=warn.mock.calls.length
      const r=await t.fetch(rpc('initialize',{},undefined,{Origin:'https://evil.example'})); expect(r.status).toBe(200)
      expect(warn.mock.calls.length-before).toBe(flag==='true'?1:0)
    }
    expect(warn.mock.calls[0]).toEqual(['[mcp] origin mismatch',{origin:'https://evil.example',mode:'log-only'}])
  } finally {warn.mockRestore()}
})
test('H6: all allowed Origins and absent Origin pass without mismatch logs', async () => {
  const t=doorEnv(); t.env.MCP_ORIGIN_LOG_ONLY='true'; const warn=spyOn(console,'warn').mockImplementation(()=>{})
  try {
    for(const origin of [...CONTRACT.origins,undefined]) expect((await t.fetch(rpc('initialize',{},undefined,origin===undefined?{}:{Origin:origin}))).status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
  } finally {warn.mockRestore()}
})
test('H7: unsupported protocol is rejected on every post-initialize method', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  for(const method of ['notifications/initialized','ping','tools/list','tools/call','resources/list','resources/templates/list','resources/read']) {
    const r=await t.fetch(rpc(method,{},sid,{'MCP-Protocol-Version':'1999-01-01'}))
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error:{code:-32000,message:'Unsupported protocol version',data:{supported:[...PROTOCOL_VERSIONS]}}})
  }
})
test('H8: resource templates have their own method and never leak into resources/list', async () => {
  const t=doorEnv(); const sid=await session(t.env)
  const r=await t.fetch(rpc('resources/templates/list',{},sid)); const b=await r.json() as any
  expect(r.status).toBe(200); expect(b.result.resourceTemplates).toHaveLength(1); expect(b.result.resourceTemplates[0].uriTemplate).toBe('vellum://lineage/{voiceId}')
  const list=await t.fetch(rpc('resources/list',{},sid)); expect((await list.json() as any).result.resourceTemplates).toBeUndefined()
})
test('H10 E4: CORS allows HEAD and protocol header, never DELETE', async () => {
  const t=doorEnv()
  for(const path of ['/mcp','/api/imprint']) {
    const r=await t.fetch(new Request('https://vellum.test'+path,{method:'OPTIONS'})); expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-methods')).toContain('HEAD'); expect(r.headers.get('access-control-allow-methods')).not.toContain('DELETE')
    expect(r.headers.get('access-control-allow-headers')).toContain('MCP-Protocol-Version')
  }
  const r=await t.fetch(rpc('ping',{},await session(t.env))); expect(r.headers.get('access-control-expose-headers')).toContain('MCP-Protocol-Version')
})
