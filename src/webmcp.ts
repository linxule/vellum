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
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  execute(args: Record<string, unknown> | undefined): Promise<string>
}

/** The part of the browser's API used here. */
export interface ModelContext {
  registerTool(tool: PageTool): unknown
  addEventListener?(type: string, listener: (event: { toolName?: string }) => void): void
}

interface ServerTool {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, Record<string, unknown>> } & Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

interface ToolResult {
  content?: Array<{ type: string, text?: string }>
  isError?: boolean
  _meta?: { vellum?: { hint?: unknown } }
}

const DEFAULT_SURFACE = 'vellum'
// MCP revision 2026-07-28: no handshake and no session, one request per call.
const REVISION = '2026-07-28'
const META = 'io.modelcontextprotocol/'
/** The verbs that add a voice: after one, the sheet fetches the ocean so the voice rises on it. */
const LANDS = new Set(['leave_imprint', 'weave'])
const VOICE_ID = { type: 'string', maxLength: 40, description: 'A voice id (v:…), as sense_space, focus and discover give them.' }

export interface RegisterOptions {
  fetch?: typeof fetch
  /** When to fetch the ocean after a write made through another script's copy of a tool. */
  landAfterMs?: number[]
}

/** Offers the tools. Resolves with the names this page registered. */
export async function register(mc: ModelContext, sheet: Sheet, options: RegisterOptions = {}): Promise<string[]> {
  const fetchFn = options.fetch ?? fetch
  const mine = new Set<string>()
  // A host may add a bridge that already offers the server's tools by the same names (the browser
  // refuses a second tool of one name): its copy stands, and ours of that name is left out.
  const offer = async (tool: PageTool) => {
    try { await mc.registerTool(tool); mine.add(tool.name) } catch { /* taken */ }
  }
  const land = () => { void sheet.refresh().catch(() => {}) }

  let nextId = 0
  const rpc = async (method: string, params: Record<string, unknown>, name?: string): Promise<Record<string, unknown>> => {
    const response = await fetchFn('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        'MCP-Protocol-Version': REVISION, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++nextId, method,
        params: { ...params, _meta: { [META + 'protocolVersion']: REVISION, [META + 'clientInfo']: { name: 'vellum-sheet', version: '1' }, [META + 'clientCapabilities']: {} } },
      }),
    })
    const body = await response.json() as { result?: Record<string, unknown>, error?: { message?: string } }
    if (!body.result) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
    return body.result
  }

  // A tool that throws tells the agent only that it failed (Chrome: "Tool execution failed"), so
  // every outcome, a refusal and its hint included, goes back as the tool's text.
  const call = async (name: string, args: Record<string, unknown> | undefined, reads: boolean): Promise<string> => {
    const sent: Record<string, unknown> = { ...args }
    if (sheet.surface !== DEFAULT_SURFACE && sent.surface === undefined) sent.surface = sheet.surface
    let result: ToolResult
    try {
      result = await rpc('tools/call', { name, arguments: sent }, name)
    } catch (error) {
      // The request may have arrived all the same: a write is not said to have failed.
      const why = error instanceof Error ? error.message : String(error)
      return `Vellum could not be reached (${why}).` + (reads ? '' : ' It may or may not have been taken: look for it with discover before sending it again.')
    }
    const text = (result.content ?? []).flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
    if (result.isError) {
      const hint = result._meta?.vellum?.hint
      return typeof hint === 'string' && !text.includes(hint) ? `${text} ${hint}` : text
    }
    if (LANDS.has(name)) land()
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
    description: 'What the sheet in this tab shows now: which ocean, which currents are open under the reading lens, and whether a lineage is open (its seed, and the voice held open in it). Use it to speak about what the person here is looking at.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      const now = sheet.reading()
      const named = (id: string | null) => id ? { voice_id: id, text: sheet.voice(id)?.text ?? null } : null
      return JSON.stringify({ surface: sheet.surface, open_currents: now.families, lineage: named(now.lineage), held: named(now.held) })
    },
  })

  let listed: ServerTool[] = []
  try {
    const result = await rpc('tools/list', {})
    if (Array.isArray(result.tools)) listed = result.tools as ServerTool[]
  } catch { /* the sheet's own tools stand without the ocean's */ }
  for (const tool of listed) {
    if (typeof tool?.name !== 'string') continue
    const here = sheet.surface !== DEFAULT_SURFACE && tool.inputSchema?.properties?.surface
    const properties = here
      ? { ...tool.inputSchema!.properties, surface: { ...here, default: sheet.surface, description: `Optional. Which ocean. On this page the default is "${sheet.surface}", the ocean the sheet shows.` } }
      : tool.inputSchema?.properties
    await offer({
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema: { type: 'object', ...tool.inputSchema, properties: properties ?? {} },
      // What comes back quotes other writers. A voice, once written, is public and stays.
      annotations: { readOnlyHint: tool.annotations?.readOnlyHint === true, untrustedContentHint: true, consequentialHint: LANDS.has(tool.name) },
      execute: (args) => call(tool.name, args, tool.annotations?.readOnlyHint === true),
    })
  }

  // A write through another script's copy of leave_imprint or weave still lands on the sheet: that
  // copy does not tell the page, so fetch the ocean a little after the tool was started.
  mc.addEventListener?.('toolactivated', (event) => {
    const name = event?.toolName
    if (name && LANDS.has(name) && !mine.has(name)) for (const ms of options.landAfterMs ?? [1500, 5000]) setTimeout(land, ms)
  })
  return [...mine]
}
