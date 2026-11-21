import { expect, test } from 'bun:test'
import { register, type ModelContext, type Sheet } from '../../src/webmcp'
import { statelessMeta, statelessToolDefinitions, validateStatelessRequest } from '../../worker/src/mcp-stateless'

// The page's tools for an agent in the tab (src/webmcp.ts), against a stand-in for the browser's
// document.modelContext that behaves as Chromium 159's does: a second tool of one name is refused.

type Registered = Parameters<ModelContext['registerTool']>[0]

function modelContext(taken: string[] = []) {
  const tools = new Map<string, Registered>()
  const listeners: Array<(event: { toolName?: string }) => void> = []
  const mc: ModelContext = {
    registerTool: async (tool, options) => {
      if (tools.has(tool.name) || taken.includes(tool.name)) throw new DOMException('Duplicate tool name', 'InvalidStateError')
      tools.set(tool.name, tool)
      // As in the browser: aborting the signal a tool was registered with takes it back.
      options?.signal?.addEventListener('abort', () => { tools.delete(tool.name) })
    },
    addEventListener: (type, listener) => { if (type === 'toolactivated') listeners.push(listener) },
  }
  return { mc, tools, activate: (toolName: string) => listeners.forEach(l => l({ toolName })) }
}

function sheet(over: Partial<Sheet> = {}) {
  const calls: string[] = []
  const voices: Record<string, { text: string, family: string, woven: boolean }> = {
    'v:plain': { text: 'A plain voice.', family: 'silence', woven: false },
    'v:woven': { text: 'A woven voice.', family: 'memory', woven: true },
  }
  const s: Sheet = {
    surface: 'vellum',
    voice: id => voices[id] ?? null,
    show: id => { calls.push('show ' + id); return true },
    lineage: id => { calls.push('lineage ' + id); return true },
    reading: () => ({ families: ['memory'], lineage: 'v:woven', held: null }),
    refresh: async () => { calls.push('refresh') },
    ...over,
  }
  return { s, calls, voices }
}

/** A /mcp that lists the worker's real definitions and answers a call with `result`. */
function server(result: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
  const requests: Array<{ headers: Headers, body: any }> = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push({ headers: new Headers(init.headers), body })
    expect(url).toBe('/mcp')
    const answer = body.method === 'tools/list' ? { tools: JSON.parse(JSON.stringify(statelessToolDefinitions())) } : result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer }))
  }) as unknown as typeof fetch
  return { fetchFn, requests }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('offers the sheet\'s three tools and the six the server lists', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn } = server()
  const mine = await register(mc, s, { fetch: fetchFn })
  expect(mine.sort()).toEqual(['discover', 'focus', 'leave_imprint', 'open_lineage', 'reading_now', 'sense_space', 'show_voice', 'weave', 'witness'])
  expect([...tools.keys()].sort()).toEqual(mine.sort())
  for (const tool of tools.values()) {
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.inputSchema.type).toBe('object')
  }
})

test('every request is one the worker\'s stateless path accepts', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn, requests } = server()
  await register(mc, s, { fetch: fetchFn })
  await tools.get('sense_space')!.execute({})
  expect(requests.map(r => r.body.method)).toEqual(['tools/list', 'tools/call'])
  for (const { headers, body } of requests) {
    const meta = statelessMeta(body)
    expect(meta).not.toBeNull()
    expect(validateStatelessRequest(headers, body, meta!)).toBeNull()
  }
})

test('reads are marked as reads, and writing a voice as consequential', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  const hints = (name: string) => tools.get(name)!.annotations!
  for (const name of ['sense_space', 'focus', 'discover', 'reading_now']) expect(hints(name).readOnlyHint).toBe(true)
  for (const name of ['leave_imprint', 'weave', 'witness']) expect(hints(name).readOnlyHint).toBe(false)
  expect(hints('leave_imprint').consequentialHint).toBe(true)
  expect(hints('weave').consequentialHint).toBe(true)
  expect(hints('witness').consequentialHint).toBe(false)
  // Everything the ocean returns quotes other writers.
  for (const name of ['sense_space', 'focus', 'discover', 'show_voice']) expect(hints(name).untrustedContentHint).toBe(true)
})

test('a voice written through a page tool is fetched onto the sheet; a read is not', async () => {
  const { mc, tools } = modelContext(), { s, calls } = sheet(), { fetchFn } = server({ content: [{ type: 'text', text: 'Imprinted. voice: v:new' }] })
  await register(mc, s, { fetch: fetchFn })
  expect(await tools.get('sense_space')!.execute({})).toBe('Imprinted. voice: v:new')
  expect(calls).toEqual([])
  expect(await tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })).toBe('Imprinted. voice: v:new')
  expect(calls).toEqual(['refresh'])
  await tools.get('witness')!.execute({ family: 'memory', dwell_s: 5 })
  expect(calls).toEqual(['refresh'])
})

test('a refusal comes back as text with its hint, never thrown, and nothing is fetched', async () => {
  const refusal = { content: [{ type: 'text', text: '[VELLUM_ERROR SOURCE_NOT_FOUND] No voice matched.' }], isError: true, _meta: { vellum: { hint: 'Call discover for ids.' } } }
  const { mc, tools } = modelContext(), { s, calls } = sheet(), { fetchFn } = server(refusal)
  await register(mc, s, { fetch: fetchFn })
  expect(await tools.get('weave')!.execute({ source_id: 'v:none', text: 'x', families: ['memory'] })).toBe('[VELLUM_ERROR SOURCE_NOT_FOUND] No voice matched. Call discover for ids.')
  expect(calls).toEqual([])
})

test('an unreachable server is said in words, not thrown', async () => {
  const { mc, tools } = modelContext(), { s, calls } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  const down = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
  const { mc: mc2, tools: tools2 } = modelContext()
  let first = true
  await register(mc2, s, { fetch: ((url: string, init: RequestInit) => { if (first) { first = false; return fetchFn(url, init) } return down(url, init) }) as unknown as typeof fetch })
  const said = await tools2.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })
  expect(said).toContain('could not be reached')
  // The request may have arrived: a write is not said to have failed, a read has nothing to say.
  expect(said).toContain('may or may not have been taken')
  expect(await tools2.get('discover')!.execute({})).toBe('Vellum could not be reached (Failed to fetch).')
  expect(calls).toEqual([])
  expect(tools.size).toBe(9)
})

test('with no server the sheet\'s own tools still stand', async () => {
  const { mc, tools } = modelContext(), { s } = sheet()
  const mine = await register(mc, s, { fetch: (async () => { throw new TypeError('offline') }) as unknown as typeof fetch })
  expect(mine.sort()).toEqual(['open_lineage', 'reading_now', 'show_voice'])
  expect(tools.size).toBe(3)
})

test('on another ocean\'s page the tools default to that ocean, and an explicit surface stands', async () => {
  const { mc, tools } = modelContext(), { s } = sheet({ surface: 'tidepool' }), { fetchFn, requests } = server()
  await register(mc, s, { fetch: fetchFn })
  const surface = (tools.get('discover')!.inputSchema.properties as any).surface
  expect(surface.default).toBe('tidepool')
  expect(surface.description).toContain('"tidepool"')
  await tools.get('discover')!.execute({ family: 'memory' })
  await tools.get('discover')!.execute({ surface: 'vellum' })
  await tools.get('sense_space')!.execute(undefined)
  expect(requests.slice(1).map(r => r.body.params.arguments)).toEqual([{ family: 'memory', surface: 'tidepool' }, { surface: 'vellum' }, { surface: 'tidepool' }])
})

test('on the default ocean nothing is added to a call or to the schema', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn, requests } = server()
  await register(mc, s, { fetch: fetchFn })
  await tools.get('discover')!.execute({ family: 'memory' })
  expect(requests[1]!.body.params.arguments).toEqual({ family: 'memory' })
  const listed = statelessToolDefinitions().find(d => d.name === 'discover')!
  expect(tools.get('discover')!.inputSchema).toEqual(JSON.parse(JSON.stringify(listed.inputSchema)))
})

test('when another script holds one of the ocean\'s names, the six are left to it whole, and a write through its copy still lands', async () => {
  const { mc, tools, activate } = modelContext(['leave_imprint', 'weave', 'sense_space']), { s, calls } = sheet(), { fetchFn } = server()
  const mine = await register(mc, s, { fetch: fetchFn, landAfterMs: [0] })
  // Not a mix of this page's marked tools and another's unmarked ones: the three it did register are taken back.
  expect(mine.sort()).toEqual(['open_lineage', 'reading_now', 'show_voice'])
  expect([...tools.keys()].sort()).toEqual(['open_lineage', 'reading_now', 'show_voice'])
  activate('sense_space')
  activate('discover')
  await tick()
  expect(calls).toEqual([])
  activate('weave')
  await tick()
  expect(calls).toEqual(['refresh'])
})

test('a write through the page\'s own tool is not fetched twice', async () => {
  const { mc, tools, activate } = modelContext(), { s, calls } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn, landAfterMs: [0] })
  activate('leave_imprint')
  await tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })
  await tick()
  expect(calls).toEqual(['refresh'])
})

test('show_voice brings a voice under the lens and returns its text', async () => {
  const { mc, tools } = modelContext(), { s, calls } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  expect(await tools.get('show_voice')!.execute({ voice_id: 'v:plain' })).toBe('Under the lens now, in silence: "A plain voice."')
  expect(calls).toEqual(['show v:plain'])
})

test('a voice not on the sheet is looked for once more, then said to be absent', async () => {
  const { mc, tools } = modelContext(), made = sheet(), { fetchFn } = server()
  await register(mc, made.s, { fetch: fetchFn })
  expect(await tools.get('show_voice')!.execute({ voice_id: 'v:deep' })).toContain('is not on the sheet in this tab')
  expect(made.calls).toEqual(['refresh'])
  // It arrives with the fetch: shown.
  const late = sheet({ refresh: async () => { late.voices['v:late'] = { text: 'Late.', family: 'space', woven: false } } })
  const second = modelContext()
  await register(second.mc, late.s, { fetch: fetchFn })
  expect(await second.tools.get('show_voice')!.execute({ voice_id: 'v:late' })).toBe('Under the lens now, in space: "Late."')
  // No id at all is an answer, not a throw.
  expect(await tools.get('show_voice')!.execute(undefined)).toContain('is not on the sheet')
})

test('open_lineage opens a woven voice and says why not for an unwoven one', async () => {
  const { mc, tools } = modelContext(), { s, calls } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  expect(await tools.get('open_lineage')!.execute({ voice_id: 'v:woven' })).toContain('Its lineage is open on the sheet')
  expect(await tools.get('open_lineage')!.execute({ voice_id: 'v:plain' })).toContain('has no lineage yet')
  expect(calls).toEqual(['lineage v:woven'])
  const stuck = modelContext()
  await register(stuck.mc, sheet({ lineage: () => false }).s, { fetch: fetchFn })
  expect(await stuck.tools.get('open_lineage')!.execute({ voice_id: 'v:woven' })).toContain('could not open')
})

test('reading_now says what is open, with the words of the voices it names', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  // An object, not a string of JSON: the browser serializes what a tool returns.
  expect(await tools.get('reading_now')!.execute({})).toEqual({
    surface: 'vellum', open_currents: ['memory'], lineage: { voice_id: 'v:woven', text: 'A woven voice.' }, held: null,
  })
})

test('every tool has a title a person can read; the six carry the one the server lists', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  for (const tool of tools.values()) expect((tool.title ?? '').length).toBeGreaterThan(3)
  expect(tools.get('weave')!.title).toBe(statelessToolDefinitions().find(d => d.name === 'weave')!.title)
})

test('the sheet shows a written voice before the agent is answered, but a slow sheet does not hold the answer', async () => {
  const order: string[] = []
  const slow = sheet({ refresh: async () => { await new Promise(done => setTimeout(done, 20)); order.push('sheet') } })
  const { mc, tools } = modelContext(), { fetchFn } = server()
  await register(mc, slow.s, { fetch: fetchFn })
  await tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })
  order.push('answered')
  expect(order).toEqual(['sheet', 'answered'])

  const stuck = sheet({ refresh: () => new Promise(() => {}) }), second = modelContext()
  await register(second.mc, stuck.s, { fetch: fetchFn, landWaitMs: 10 })
  const started = Date.now()
  expect(await second.tools.get('weave')!.execute({ source_id: 'v:woven', text: 'x', families: ['memory'] })).toBe('ok')
  expect(Date.now() - started).toBeLessThan(500)
})

test('a call the agent cancels is cancelled on the wire', async () => {
  const signals: Array<AbortSignal | null | undefined> = []
  const { fetchFn } = server()
  const spy = ((url: string, init: RequestInit) => { signals.push(init.signal); return fetchFn(url, init) }) as unknown as typeof fetch
  const { mc, tools } = modelContext(), { s } = sheet()
  await register(mc, s, { fetch: spy })
  const run = new AbortController()
  await tools.get('discover')!.execute({}, { signal: run.signal })
  expect(signals.at(-1)).toBe(run.signal)
})

// Tools are listed first, then every later request is answered as given.
function afterList(answer: (body: any) => Response) {
  const { fetchFn } = server()
  let first = true
  return ((url: string, init: RequestInit) => {
    if (first) { first = false; return fetchFn(url, init) }
    return Promise.resolve(answer(JSON.parse(String(init.body))))
  }) as unknown as typeof fetch
}

test('a refusal Vellum gave is told as a refusal: its words, when to come back, and that nothing was written', async () => {
  // As handleMCP answers when admission refuses, before anything is parsed.
  const limited = afterList(body => new Response(JSON.stringify({
    jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Too many requests from this address.', data: { error_code: 'RATE_LIMITED', retry_after: 40 } },
  }), { status: 429 }))
  const { mc, tools } = modelContext(), { s, calls } = sheet()
  await register(mc, s, { fetch: limited })
  const said = await tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })
  expect(said).toBe('Vellum refused (RATE_LIMITED): Too many requests from this address. Try again in 40 seconds. Nothing was written.')
  expect(await tools.get('focus')!.execute({ family: 'memory' })).toBe('Vellum refused (RATE_LIMITED): Too many requests from this address. Try again in 40 seconds.')
  expect(calls).toEqual([])
})

test('an internal error promises nothing about a write, and an error page is told by its status', async () => {
  const internal = afterList(body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'Internal error' } }), { status: 500 }))
  const a = modelContext(), { s } = sheet()
  await register(a.mc, s, { fetch: internal })
  expect(await a.tools.get('weave')!.execute({ source_id: 'v:woven', text: 'x', families: ['memory'] })).toContain('may or may not have been taken')

  const page = afterList(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
  const b = modelContext()
  await register(b.mc, s, { fetch: page })
  expect(await b.tools.get('discover')!.execute({})).toBe('Vellum could not be reached (HTTP 502).')
})

test('a cancelled call says so', async () => {
  const run = new AbortController()
  const hung = afterList(() => { throw new DOMException('The operation was aborted.', 'AbortError') })
  const { mc, tools } = modelContext(), { s } = sheet()
  await register(mc, s, { fetch: hung })
  const pending = tools.get('discover')!.execute({}, { signal: run.signal })
  run.abort()
  expect(await pending).toBe('Cancelled.')
  // Cancelled before it began: nothing goes out, which for a write is the last point to stop it.
  let sent = 0
  const counting = afterList(() => { sent++; return new Response('{}') })
  const b = modelContext()
  await register(b.mc, s, { fetch: counting })
  expect(await b.tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] }, { signal: run.signal })).toBe('Cancelled before anything was sent.')
  expect(sent).toBe(0)
})

test('a write carries a key, and after a dropped connection is sent once more under the same key', async () => {
  const keys: unknown[] = []
  let n = 0
  const flaky = afterList(body => {
    keys.push(body.params._meta.idempotencyKey)
    if (++n === 1) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'written' }] } }))
  })
  const { mc, tools } = modelContext(), { s, calls } = sheet()
  await register(mc, s, { fetch: flaky, retryAfterMs: 1 })
  expect(await tools.get('leave_imprint')!.execute({ text: 'x', families: ['memory'] })).toBe('written')
  expect(keys.length).toBe(2)
  expect(typeof keys[0]).toBe('string')
  expect(keys[1]).toBe(keys[0])
  expect(calls).toEqual(['refresh'])
  // A read carries none and is not sent again.
  n = 0; keys.length = 0
  expect(await tools.get('discover')!.execute({})).toBe('Vellum could not be reached (Failed to fetch).')
  expect(keys).toEqual([undefined])
})

test('the two tools that write say, in the tab, that what they write is public and lasting', async () => {
  const { mc, tools } = modelContext(), { s } = sheet(), { fetchFn } = server()
  await register(mc, s, { fetch: fetchFn })
  for (const [name, tool] of tools) expect(/public and lasting/.test(tool.description)).toBe(name === 'leave_imprint' || name === 'weave')
  // Within what Chrome's guidance recommends for a description.
  for (const tool of tools.values()) expect(tool.description.length).toBeLessThanOrEqual(500)
})
