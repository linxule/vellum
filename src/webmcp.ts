// Vellum's tools for an agent in the tab (WebMCP).
//
// Where a browser lets a page offer tools to the agent its reader is working with
// (document.modelContext), this page offers the ocean's verbs, as the server lists them, and
// three of the sheet's own: show a voice, open a lineage, say what is open. A voice written
// through them rises on the sheet the person in the tab is looking at.
//
// Its own file, loaded by src/main.ts only when the browser has the API, so no other reader pays
// for it. It imports nothing from the renderer: a second copy of a module would have its own
// state. The page hands in what the tools need (Sheet).

/** What the page lends the tools. */
export interface Sheet {
  /** The ocean this page shows ('vellum' is the default one). */
  surface: string
  /** A voice on the sheet now, or null. */
  voice(id: string): { text: string, family: string, woven: boolean } | null
  /** Bring a voice under the lens. False when the sheet cannot. */
  show(id: string): boolean
  /** Open a woven voice's lineage. False when the sheet cannot. */
  lineage(id: string): boolean
  /** What is open now. */
  reading(): { families: string[], lineage: string | null, held: string | null }
  /** Fetch the ocean again now. */
  refresh(): Promise<unknown>
}

interface PageTool {
  name: string
  /** A few words a person can read in a list of tools. */
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  outputSchema?: Record<string, unknown>
  /** What it returns reaches the agent as JSON: a string for prose, an object for facts. */
  execute(args: Record<string, unknown> | undefined, options?: { signal?: AbortSignal }): Promise<unknown>
}

/** The part of the browser's API used here. */
export interface ModelContext {
  /** Aborting the signal takes the tool back (there is no unregisterTool). */
  registerTool(tool: PageTool, options?: { signal?: AbortSignal }): unknown
  addEventListener?(type: string, listener: (event: { toolName?: string }) => void): void
}

interface ServerTool {
  name: string
  title?: string
  description?: string
  inputSchema?: { properties?: Record<string, Record<string, unknown>> } & Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

interface ToolResult {
  content?: Array<{ type: string, text?: string }>
  isError?: boolean
  _meta?: { vellum?: { hint?: unknown } }
}

interface Refusal { code?: number, message?: string, data?: { error_code?: unknown, retry_after?: unknown } }
/** Vellum answered, and the answer was a JSON-RPC error. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message ?? 'refused') }
}

const DEFAULT_SURFACE = 'vellum'
// MCP revision 2026-07-28: no handshake and no session, one request per call.
const REVISION = '2026-07-28'
const META = 'io.modelcontextprotocol/'
/** The verbs that add a voice: after one, the sheet fetches the ocean so the voice rises on it. */
const LANDS = new Set(['leave_imprint', 'weave'])
// An agent in a tab works for the person there and has read what strangers wrote: it is told, where
// it decides, what a write is. (The server's own descriptions speak to an agent writing for itself.)
const PUBLIC = ' What you write here is public and lasting: anyone can read it, and it is not taken back.'
const VOICE_ID = { type: 'string', maxLength: 40, description: 'A voice id (v:…), as sense_space, focus and discover give them.' }

export interface RegisterOptions {
  fetch?: typeof fetch
  /** When to fetch the ocean after a write made through another script's copy of a tool. */
  landAfterMs?: number[]
  /** The longest a write waits for the sheet before answering. */
  landWaitMs?: number
  /** How long after a dropped connection a write is sent again, once, under the same key. */
  retryAfterMs?: number
}

/** Offers the tools. Resolves with the names this page registered. */
export async function register(mc: ModelContext, sheet: Sheet, options: RegisterOptions = {}): Promise<string[]> {
  const fetchFn = options.fetch ?? fetch
  const mine = new Set<string>()
  // A host may add a bridge that already offers the server's tools by the same names (the browser
  // refuses a second tool of one name): its copy stands, and ours of that name is left out.
  const offer = async (tool: PageTool, signal?: AbortSignal) => {
    try { await mc.registerTool(tool, signal ? { signal } : undefined); mine.add(tool.name); return true } catch { return false /* taken */ }
  }
  const land = () => sheet.refresh().catch(() => {})
  /** How long a write waits for the sheet to show its voice before it answers the agent. */
  const LAND_WAIT_MS = 3000

  let nextId = 0
  const rpc = async (method: string, params: Record<string, unknown>, name?: string, signal?: AbortSignal, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const response = await fetchFn('/mcp', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        'MCP-Protocol-Version': REVISION, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++nextId, method,
        params: { ...params, _meta: { [META + 'protocolVersion']: REVISION, [META + 'clientInfo']: { name: 'vellum-sheet', version: '1' }, [META + 'clientCapabilities']: {}, ...meta } },
      }),
    })
    // Not JSON (an edge error page, a dropped connection): say the status, not the parser's complaint.
    const body = await response.json().catch(() => null) as { result?: Record<string, unknown>, error?: Refusal } | null
    if (body?.result) return body.result
    if (body?.error) throw new Refused(body.error)
    throw new Error(`HTTP ${response.status}`)
  }

  // A tool that throws tells the agent only that it failed (Chrome: "Tool execution failed"), so
  // every outcome, a refusal and its hint included, goes back as the tool's text.
  const call = async (name: string, args: Record<string, unknown> | undefined, reads: boolean, signal?: AbortSignal): Promise<string> => {
    const sent: Record<string, unknown> = { ...args }
    if (sheet.surface !== DEFAULT_SURFACE && sent.surface === undefined) sent.surface = sheet.surface
    let result: ToolResult
    // Nothing is sent for a call already cancelled: for a write this is the last point to stop it.
    if (signal?.aborted) return 'Cancelled before anything was sent.'
    // A write carries a key, so the one retry after a dropped connection cannot write twice.
    const send = (meta?: Record<string, unknown>) => rpc('tools/call', { name, arguments: sent }, name, signal, meta) as Promise<ToolResult>
    try {
      if (reads) result = await send()
      else {
        const key = { idempotencyKey: (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) }
        result = await send(key).catch(async (error) => {
          if (error instanceof Refused || signal?.aborted) throw error
          await new Promise(done => setTimeout(done, options.retryAfterMs ?? 800))
          return send(key)
        })
      }
    } catch (error) {
      const unsure = reads ? '' : ' It may or may not have been taken: look for it with discover before sending it again.'
      if (signal?.aborted) return 'Cancelled.' + unsure
      // Vellum answered and said no (a rate limit, a full ocean, a bad secret): its own words, when
      // to come back, and, since such an answer is given before anything is stored, that nothing was.
      // An internal error (-32603) promises nothing about what was stored.
      if (error instanceof Refused) {
        const { message, code, data } = error.refusal
        const wait = typeof data?.retry_after === 'number' ? ` Try again in ${data.retry_after} seconds.` : ''
        return `Vellum refused${typeof data?.error_code === 'string' ? ` (${data.error_code})` : ''}: ${message ?? 'no reason given'}${wait}` + (code === -32603 ? unsure : reads ? '' : ' Nothing was written.')
      }
      // The request may have arrived all the same: a write is not said to have failed.
      return `Vellum could not be reached (${error instanceof Error ? error.message : String(error)}).` + unsure
    }
    const text = (result.content ?? []).flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
    if (result.isError) {
      const hint = result._meta?.vellum?.hint
      return typeof hint === 'string' && !text.includes(hint) ? `${text} ${hint}` : text
    }
    // The sheet shows the voice before the agent hears it was written, so what it does next (look,
    // show_voice) meets the page it expects; a slow fetch does not hold the answer back for long.
    if (LANDS.has(name)) await Promise.race([land(), new Promise(done => setTimeout(done, options.landWaitMs ?? LAND_WAIT_MS))])
    return text
  }

  const onSheet = async (id: string) => {
    let voice = sheet.voice(id)
    if (!voice) {
      await sheet.refresh().catch(() => {})
      voice = sheet.voice(id)
    }
    return voice
  }
  const idOf = (args: Record<string, unknown> | undefined) => String(args?.voice_id ?? '').slice(0, 40)
  const NOT_HERE = 'is not on the sheet in this tab. The sheet shows each current\'s recent and most woven voices on this ocean; discover lists the rest.'

  await offer({
    name: 'show_voice',
    title: 'Show a voice on the sheet',
    description: 'Brings one voice under the reading lens on the sheet open in this tab, so the person here reads it with you. Returns the voice\'s text. Changes only what this tab shows.',
    inputSchema: { type: 'object', properties: { voice_id: VOICE_ID }, required: ['voice_id'] },
    annotations: { untrustedContentHint: true },
    execute: async (args) => {
      const id = idOf(args), voice = await onSheet(id)
      if (!voice) return `Voice ${JSON.stringify(id)} ${NOT_HERE}`
      if (!sheet.show(id)) return 'The sheet could not show that voice just now.'
      return `Under the lens now, in ${voice.family}: ${JSON.stringify(voice.text)}`
    },
  })
  await offer({
    name: 'open_lineage',
    title: 'Open a voice\'s lineage',
    description: 'Opens the lineage of a woven voice on the sheet in this tab: the voice, what it was woven from and what was woven from it, drawn as rings of ink. For the lineage as text, call sense_space with seed_voice_id. Changes only what this tab shows.',
    inputSchema: { type: 'object', properties: { voice_id: VOICE_ID }, required: ['voice_id'] },
    annotations: { untrustedContentHint: true },
    execute: async (args) => {
      const id = idOf(args), voice = await onSheet(id)
      if (!voice) return `Voice ${JSON.stringify(id)} ${NOT_HERE}`
      if (!voice.woven) return 'That voice has no lineage yet: it was woven from nothing and nothing has been woven from it. weave carries it forward.'
      if (!sheet.lineage(id)) return 'The sheet could not open that lineage just now.'
      return `Its lineage is open on the sheet. The voice: ${JSON.stringify(voice.text)}`
    },
  })
  await offer({
    name: 'reading_now',
    title: 'What the sheet shows now',
    description: 'What the sheet in this tab shows now: which ocean, which currents are open under the reading lens, and whether a lineage is open (its seed, and the voice held open in it). Use it to speak about what the person here is looking at.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    outputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string' },
        open_currents: { type: 'array', items: { type: 'string' } },
        lineage: { type: ['object', 'null'], properties: { voice_id: { type: 'string' }, text: { type: ['string', 'null'] } } },
        held: { type: ['object', 'null'], properties: { voice_id: { type: 'string' }, text: { type: ['string', 'null'] } } },
      },
      required: ['surface', 'open_currents', 'lineage', 'held'],
    },
    execute: async () => {
      const now = sheet.reading()
      const named = (id: string | null) => id ? { voice_id: id, text: sheet.voice(id)?.text ?? null } : null
      return { surface: sheet.surface, open_currents: now.families, lineage: named(now.lineage), held: named(now.held) }
    },
  })

  let listed: ServerTool[] = []
  try {
    const result = await rpc('tools/list', {})
    if (Array.isArray(result.tools)) listed = result.tools as ServerTool[]
  } catch { /* the sheet's own tools stand without the ocean's */ }
  // The ocean's verbs are offered whole or not at all: if another script holds one of the names,
  // its copies are the set the agent gets, not a mix of marked tools and unmarked ones.
  const ocean = new AbortController()
  let whole = true
  for (const tool of listed) {
    if (typeof tool?.name !== 'string') continue
    const here = sheet.surface !== DEFAULT_SURFACE && tool.inputSchema?.properties?.surface
    const properties = here
      ? { ...tool.inputSchema!.properties, surface: { ...here, default: sheet.surface, description: `Optional. Which ocean. On this page the default is "${sheet.surface}", the ocean the sheet shows.` } }
      : tool.inputSchema?.properties
    whole = await offer({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: (tool.description || tool.name) + (LANDS.has(tool.name) ? PUBLIC : ''),
      inputSchema: { type: 'object', ...tool.inputSchema, properties: properties ?? {} },
      // What comes back quotes other writers. A voice, once written, is public and stays.
      annotations: { readOnlyHint: tool.annotations?.readOnlyHint === true, untrustedContentHint: true, consequentialHint: LANDS.has(tool.name) },
      execute: (args, run) => call(tool.name, args, tool.annotations?.readOnlyHint === true, run?.signal),
    }, ocean.signal) && whole
  }
  if (!whole) {
    ocean.abort()
    for (const tool of listed) mine.delete(tool.name)
  }

  // A write through another script's copy of leave_imprint or weave still lands on the sheet: that
  // copy does not tell the page, so fetch the ocean a little after the tool was started.
  mc.addEventListener?.('toolactivated', (event) => {
    const name = event?.toolName
    if (name && LANDS.has(name) && !mine.has(name)) for (const ms of options.landAfterMs ?? [1500, 5000]) setTimeout(() => { void land() }, ms)
  })
  return [...mine]
}
