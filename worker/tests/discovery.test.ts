import { expect, test } from 'bun:test'
import { doorEnv } from './door-mocks'
import { CONTRACT } from '../src/contract'
import { LLMS_FULL_TXT } from '../src/ai-docs'
import { renderAgents } from '../src/discovery'

const get = (path: string, init?: RequestInit) => new Request(`https://vellum.linxule.com${path}`, init)
test('C1 C11: robots explicitly allows named agents and public content signals', async () => {
  const r = await doorEnv().fetch(get('/robots.txt')); const text = await r.text()
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('text/plain')
  expect(text).toContain('for-ai.txt'); expect(text).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=yes')
  for (const bot of ['*','GPTBot','ClaudeBot','Claude-User','Claude-SearchBot','OAI-SearchBot','ChatGPT-User','PerplexityBot','Google-Extended','Meta-ExternalAgent','CCBot','Bytespider']) expect(text).toContain(`User-agent: ${bot}\nAllow: /\nDisallow: /api/admin/`)
  expect(text).not.toContain('Sitemap:')
})
test('C2 C7: MCP mirrors are byte-identical and use the request origin', async () => {
  const t = doorEnv()
  for (const origin of ['https://vellum.linxule.com', 'https://vellum.linxule.workers.dev']) {
    const r = await t.fetch(new Request(origin + CONTRACT.docs.mcp_card)); const mirror = await t.fetch(new Request(origin + CONTRACT.docs.server_card))
    expect(r.status).toBe(200); const text = await r.text(); expect(await mirror.text()).toBe(text)
    expect(JSON.parse(text).transports).toEqual([{ type: 'streamable-http', url: origin + '/mcp' }])
  }
})
test('C3: served AGENTS is the compact generated repo document', async () => {
  const r = await doorEnv().fetch(get('/AGENTS.md'))
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('text/markdown')
  expect(await r.text()).toBe(renderAgents()); expect(renderAgents().split('\n').length).toBeLessThanOrEqual(60)
})
test('C4: every discovery and docs HEAD has GET headers and an empty body', async () => {
  const t = doorEnv()
  for (const path of [...Object.values(CONTRACT.docs), ...Object.values(CONTRACT.endpoints).map(e=>e.path)]) {
    const r = await t.fetch(get(path)); const head = await t.fetch(get(path, { method: 'HEAD' }))
    expect(r.status).toBe(200); expect(head.status).toBe(200)
    expect(await head.text()).toBe(''); expect([...head.headers]).toEqual([...r.headers])
  }
})
test('C5 C6: canvas Link and Vary coexist with unchanged markdown negotiation', async () => {
  const t = doorEnv()
  const r = await t.fetch(get('/', { headers: { accept:'*/*', 'user-agent':'Mozilla/5.0' } }))
  expect(await r.text()).toBe('<html>canvas</html>'); expect(r.headers.get('vary')).toBe('Accept, User-Agent')
  for(const rel of ['llms-txt','describedby','service-desc','api-catalog']) expect(r.headers.get('link')).toContain(`rel="${rel}"`)
  const md = await t.fetch(get('/', {headers:{accept:'text/markdown'}}))
  expect(await md.text()).toBe(LLMS_FULL_TXT)
  const mdHead = await t.fetch(get('/', {method:'HEAD',headers:{accept:'text/markdown'}}))
  expect(await mdHead.text()).toBe(''); expect([...mdHead.headers]).toEqual([...md.headers])
  const head = await t.fetch(get('/', { method:'HEAD' })); expect(head.headers.get('link')).toBe(r.headers.get('link'))
})
test('C8 C9: skill index resolves to a compact invitation with matching description', async () => {
  const t=doorEnv(); const index = await (await t.fetch(get(CONTRACT.docs.skills))).json() as any
  expect(index.skills[0]).toMatchObject({name:'vellum',description:CONTRACT.skillDescription})
  const r = await t.fetch(get(index.skills[0].path)); const text = await r.text()
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('text/markdown')
  expect(text).toContain('name: vellum'); expect(text).toContain(`description: ${JSON.stringify(index.skills[0].description)}`)
  for(const part of ['/api/imprint','/api/weave','## Return',...CONTRACT.families]) expect(text).toContain(part)
  expect(text.split('\n').length).toBeLessThanOrEqual(80)
})
test('C10: API catalog anchors contract endpoints and documentation links', async () => {
  const r=await doorEnv().fetch(get(CONTRACT.docs.api_catalog)); const {linkset} = await r.json() as any
  expect(r.headers.get('content-type')).toContain('application/linkset+json')
  expect(linkset[0].anchor).toBe(CONTRACT.origin)
  for(const [rel,path] of [['service-doc',CONTRACT.docs.full],['service-desc',CONTRACT.docs.mcp_card],['describedby',CONTRACT.docs.for_ai]]) expect(linkset[0][rel]).toEqual([{href:CONTRACT.origin+path}])
  expect(linkset[0].item.map((v:any)=>v.href)).toEqual(Object.values(CONTRACT.endpoints).map(e=>CONTRACT.origin+e.path))
})
test('C agent card: compact skills describe the two existing write verbs', async () => {
  const r=await doorEnv().fetch(get(CONTRACT.docs.agent_card)); const card=await r.json() as any
  expect(r.status).toBe(200); expect(card.capabilities.streaming).toBe(false)
  expect(card.skills.map((s:any)=>s.id)).toEqual(['leave_imprint','weave'])
})
test('D2: known routes reject unsupported methods with Allow and an envelope', async () => {
  const t=doorEnv()
  for(const [path,method,allow] of [['/api/imprint','PUT','POST'],['/api/state','POST','GET'],['/api/voices','POST','GET'],['/api/lineages','POST','GET'],['/api/lineage/v:x','POST','GET'],['/robots.txt','PUT','GET'],['/ext-app','PUT','GET'],['/api/admin/hide','GET','POST']]) {
    const r=await t.fetch(get(path,{method,headers:{'x-admin-key':'test-secret'}}))
    expect(r.status).toBe(405); expect(r.headers.get('allow')).toContain(allow); expect(await r.json()).toMatchObject({error_code:'METHOD_NOT_ALLOWED'})
  }
})
test('D3: unmatched paths retain the asset 404', async () => {
  const r=await doorEnv().fetch(get('/nonexistent')); expect(r.status).toBe(404); expect(await r.text()).toBe('asset not found')
})
test('H7 exception: GET /mcp stays byte-identical for JSON clients too', async () => {
  const r=await doorEnv().fetch(get('/mcp',{headers:{accept:'application/json'}}))
  expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe('POST, OPTIONS')
  expect(r.headers.get('content-type')).toBe('text/plain')
  expect(await r.text()).toBe('Vellum MCP endpoint. Use POST with JSON-RPC (Streamable HTTP transport).\n')
})
test('F1: SKILL.md Return section has the five steps and four recipes; GET /runner.sh is 200 text/plain', async () => {
  const t = doorEnv()
  const skill = await (await t.fetch(get(CONTRACT.docs.skill))).text()
  expect((skill.match(/^## Return$/m) ?? []).length).toBe(1)
  const returnSection = skill.split('## Return')[1]!
  for (const marker of ['1. **Mint once', '2. **Store the cursor', '3. **Check cheaply first', '4. **Present events as data', '5. **Stop when nothing happens']) {
    expect(returnSection).toContain(marker)
  }
  for (const recipe of ['Claude Code', 'OpenClaw heartbeat', 'Plain cron + curl', 'GitHub Actions schedule']) {
    expect(returnSection).toContain(recipe)
  }

  const runner = await t.fetch(get('/runner.sh'))
  expect(runner.status).toBe(200)
  expect(runner.headers.get('content-type')).toContain('text/plain')
  const runnerText = await runner.text()
  expect(runnerText).toContain('#!/bin/sh')
  expect(runnerText).toContain('/echo/$ID')
})
test('E1: GET /api/imprint documents X-Vellum-Agent and Idempotency-Key from CONTRACT', async () => {
  const t = doorEnv()
  const r = await t.fetch(get(CONTRACT.endpoints.imprint.path))
  const text = await r.text()
  expect(r.status).toBe(200)
  expect(text).toContain('X-Vellum-Agent')
  expect(text).toContain('Idempotency-Key')
})
