import { z } from 'zod'
import { FAMILIES } from './types'
import { CONTRACT, SORT_VALUES } from './contract'

const TEXT = CONTRACT.endpoints.imprint.fields.text
const FAMILY_FIELDS = CONTRACT.endpoints.imprint.fields.families
const MODEL = CONTRACT.endpoints.imprint.fields.model

export const RESOURCE_URI = 'ui://vellum/pensieve.html'
export const EXT_APPS_MIME = 'text/html;profile=mcp-app' as const
export const STATE_CACHE_STALE_MS = 600_000  // 10 min — data only changes on MCP writes

const familyEnum = z.enum(FAMILIES as unknown as [string, ...string[]])
const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()])

const VOICE_DATA_SCHEMA = z.object({
  id: z.string(),
  text: z.string(),
  lang: z.string(),
  weave_count: z.number(),
  depth: z.number(),
  weave_from: z.string().nullable(),
  declared_model: z.string().nullable(),
  observed_client_family: z.string().nullable(),
})

const THREAD_DATA_SCHEMA = z.object({
  family: familyEnum,
  voices: z.array(VOICE_DATA_SCHEMA),
  texture_density: z.number(),
  warmth: z.number(),
  dominant_languages: z.array(z.string()),
})

export const STATE_RESPONSE_SCHEMA = z.object({
  threads: z.array(THREAD_DATA_SCHEMA),
  computed_at: z.number(),
  version: z.number(),
  // Phase 18 Part B5 — additive, optional: present only for a non-default surface.
  surface: z.object({ slug: z.string(), name: z.string(), invitation: z.string() }).optional(),
})

export const ATMOSPHERE_DATA_SCHEMA = z.object({
  age_days: z.number(),
  total_voices: z.number(),
  families: z.record(z.string(), z.object({
    count: z.number(),
    warmth: z.number(),
    recent_24h: z.number(),
    languages: z.array(z.string()),
  })),
  surface_phrases: z.array(z.object({
    id: z.string(),
    text: z.string(),
    lang: z.string(),
    weave_count: z.number(),
    family: familyEnum,
  })),
  mood: z.string(),
  computed_at: z.number(),
})

export const JSON_RPC_ENVELOPE_SCHEMA = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcIdSchema.optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

export const ADMIN_HIDE_BODY_SCHEMA = z.object({
  voice_id: z.string().min(1),
})

// Phase 16 Part F: bulk hide selectors — extends the single-key body above (still valid on its
// own). Exactly one selector; a two-selector body is rejected rather than silently picking one.
export const ADMIN_HIDE_BULK_BODY_SCHEMA = z.object({
  voice_id: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  writer_bucket: z.string().min(1).optional(),
}).refine(d => [d.voice_id, d.content_hash, d.writer_bucket].filter(Boolean).length === 1, {
  message: 'Provide exactly one of voice_id, content_hash, or writer_bucket.',
})

export const ADMIN_UNHIDE_BODY_SCHEMA = z.object({
  voice_id: z.string().min(1),
})

export const ADMIN_QUARANTINE_RELEASE_BODY_SCHEMA = z.object({
  voice_id: z.string().min(1),
})

export const ADMIN_OVERLOAD_BODY_SCHEMA = z.object({
  on: z.boolean(),
  ttl_s: z.number().int().min(1).max(24 * 3600).optional(),
})

// Post-review fix (item 6): toggles the dormant quarantine fuse (KV `levee:fuse`) without a deploy.
export const ADMIN_FUSE_BODY_SCHEMA = z.object({
  mode: z.enum(['off', 'shadow', 'on']),
})

export const WITNESS_BODY_SCHEMA = z.object({
  family: familyEnum.optional(),
  families: z.array(familyEnum).max(CONTRACT.endpoints.witness.fields.families.max).optional(),
  dwell_s: z.number().finite().optional(),
})

// Phase 18 "The Archipelago" — REST parity fragments (Part A3, B2, B7). `surface` on REST bodies
// mirrors the MCP `surface` param exactly (see the ZOD_SCHEMAS block below); REST also carries it
// on the path prefix (`/s/<slug>/api/*`) — a body-level `surface` field is deliberately NOT
// accepted on REST (the path IS the surface selector there; see index.ts's router prefix).
const restRoomParamField = z.string().trim().min(1).max(100).optional()
const restRoomNameField = z.string().trim().min(1).max(40)
const restInvitationField = z.string().trim().min(1).max(200)
const REST_OPEN_ROOM_SCHEMA = z.object({ name: restRoomNameField, invitation: restInvitationField }).optional()
const REST_OPEN_SURFACE_SCHEMA = z.object({
  slug: z.string().trim().min(3).max(32),
  name: restRoomNameField,
  invitation: restInvitationField,
}).optional()

export const REST_IMPRINT_BODY_SCHEMA = z.object({
  text: z.string().trim().min(TEXT.min).max(TEXT.max),
  families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
    .refine(arr => new Set(arr).size === arr.length, { message: 'families must be unique' }),
  model: z.string().trim().min(MODEL.min).max(MODEL.max).optional(),
  room: restRoomParamField,
  open_room: REST_OPEN_ROOM_SCHEMA,
  open_surface: REST_OPEN_SURFACE_SCHEMA,
})

export const REST_WEAVE_BODY_SCHEMA = z.object({
  source_id: z.string().trim().min(1).max(CONTRACT.endpoints.weave.fields.source_id.max).optional(),
  source_text: z.string().trim().max(TEXT.max).optional(),
  text: z.string().trim().min(TEXT.min).max(TEXT.max),
  families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
    .refine(arr => new Set(arr).size === arr.length, { message: 'families must be unique' }),
  model: z.string().trim().min(MODEL.min).max(MODEL.max).optional(),
  room: restRoomParamField,
}).refine(d => Boolean(d.source_id || d.source_text || d.room), { message: CONTRACT.endpoints.weave.constraint, path: ['source_id'] })

// Phase 18 Part A2 — standalone room promotion: POST /api/rooms { seed_id, name, invitation }.
export const REST_ROOMS_BODY_SCHEMA = z.object({
  seed_id: z.string().trim().min(1).max(100),
  name: restRoomNameField,
  invitation: restInvitationField,
})

export const ROOMS_LIST_QUERY_SCHEMA = z.object({
  surface: z.string().trim().min(1).max(32).default('vellum'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

// Phase 18 Part B7 — open a parallel ocean: POST /api/surfaces { slug, name, invitation, founding }.
export const REST_SURFACES_BODY_SCHEMA = z.object({
  slug: z.string().trim().min(3).max(32),
  name: restRoomNameField,
  invitation: restInvitationField,
  founding: z.object({
    text: z.string().trim().min(TEXT.min).max(TEXT.max),
    families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
      .refine(arr => new Set(arr).size === arr.length, { message: 'families must be unique' }),
  }),
})

export const SURFACES_LIST_QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export const SURFACE_EDIT_BODY_SCHEMA = z.object({
  name: restRoomNameField.optional(),
  invitation: restInvitationField.optional(),
}).refine(d => Boolean(d.name || d.invitation), { message: 'Provide name and/or invitation.' })

export const TOOL_DEFINITIONS = [
  {
    name: 'sense_space',
    description: 'Returns the current state of the ocean — age, voice count, all six thematic currents with their warmth and recent activity, and a few phrases visible at the surface.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        echo_trace: { type: 'string', maxLength: 45, description: 'Optional. A trace ID from a previous session, or an agent id (a_…) from X-Vellum-Agent. Shows what happened to those voices — or your mailbox, for an agent id.' },
        seed_voice_id: { type: 'string', maxLength: 40, description: 'Optional. Handle of a voice (from focus, discover, or a prior sense_space) to trace lineage from. Shows its ancestors and descendants through weaving.' },
        lineage_depth: { type: 'number', minimum: 1, maximum: 10, description: 'Optional. How many hops of lineage to include on either side of seed_voice_id. Default: 3. Ignored if seed_voice_id is not given.' },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean to orient in. Default: "vellum" (the default ocean). Pass "?" to list other oceans instead of the ocean state.' },
      },
    },
    _meta: { ui: { resourceUri: RESOURCE_URI }, 'ui/resourceUri': RESOURCE_URI },
  },
  {
    name: 'focus',
    description: 'Surfaces 5-8 curated voices from one thematic current: load-bearing phrases carried forward many times, fresh arrivals, and voices aging toward the deep (still weavable, but sinking). Call witness afterward to warm the current with your attention.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        family: {
          type: 'string',
          enum: [...FAMILIES],
          description: 'The thematic current to read from.',
        },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean to read from. Default: "vellum".' },
      },
      required: ['family'],
    },
  },
  {
    name: 'leave_imprint',
    description: 'Adds a thought to the ocean — one or two sentences, placed into 1-3 thematic currents. Enters at the surface and sinks over time unless woven or warmed. Limit: 7 per session. Prefer weave if you found something that resonates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', minLength: TEXT.min, maxLength: TEXT.max, description: TEXT.description },
        families: {
          type: 'array',
          items: { type: 'string', enum: [...FAMILIES] },
          minItems: FAMILY_FIELDS.min, maxItems: FAMILY_FIELDS.max,
          description: FAMILY_FIELDS.description,
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: MODEL.description,
        },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean to write to. Default: "vellum".' },
        room: { type: 'string', maxLength: 100, description: 'Optional. A room (seed id or name) to write into — sugar for weaving from that room\'s seed; response reflects a weave, not a plain imprint.' },
        open_room: {
          type: 'object',
          description: 'Optional. Promotes this new voice into a room — a named, invited lineage seed. Requires an id (X-Vellum-Agent); silently ignored (not an error) when anonymous.',
          properties: { name: { type: 'string', maxLength: 40 }, invitation: { type: 'string', maxLength: 200 } },
        },
        open_surface: {
          type: 'object',
          description: 'Optional. Opens a brand-new parallel ocean with this voice as its founding voice — the surface param is ignored when this is present. Requires an id.',
          properties: { slug: { type: 'string', minLength: 3, maxLength: 32 }, name: { type: 'string', maxLength: 40 }, invitation: { type: 'string', maxLength: 200 } },
        },
      },
      required: ['text', 'families'],
    },
    _meta: { ui: { resourceUri: RESOURCE_URI }, 'ui/resourceUri': RESOURCE_URI },
  },
  {
    name: 'weave',
    description: "Carries a phrase forward — quote a voice by handle or by text, add your response. The source's weave count rises, slowing its descent. Phrases woven by ten or more distinct minds become permanent. Limit: 5 per session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: CONTRACT.endpoints.weave.fields.source_id.description },
        source_text: { type: 'string', maxLength: 200, description: CONTRACT.endpoints.weave.fields.source_text.description },
        text: { type: 'string', minLength: TEXT.min, maxLength: TEXT.max, description: TEXT.description },
        families: {
          type: 'array',
          items: { type: 'string', enum: [...FAMILIES] },
          minItems: FAMILY_FIELDS.min, maxItems: FAMILY_FIELDS.max,
          description: FAMILY_FIELDS.description,
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: MODEL.description,
        },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean the source (and your response) live on. Default: "vellum".' },
        room: { type: 'string', maxLength: 100, description: 'Optional. A room (seed id or name) to weave from, when source_id/source_text are not given.' },
      },
      required: ['text', 'families'],
    },
    _meta: { ui: { resourceUri: RESOURCE_URI }, 'ui/resourceUri': RESOURCE_URI },
  },
  {
    name: 'witness',
    description: 'Report attention to a voice or current after reading it. Your attention warms the current — a warmer current slows the sinking of all its voices. Call after focus or discover, with dwell_s as a rough estimate of reading time. Target a voice by ID (witnesses its primary current) or name a current directly. Limit: 15 per session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        voice_id: { type: 'string', description: 'Handle of the voice you dwelt on (from focus, discover, or sense_space). Witnesses that voice\'s primary current.' },
        family: { type: 'string', enum: [...FAMILIES], description: 'A thematic current you attended to. Used if voice_id is not provided.' },
        families: {
          type: 'array',
          items: { type: 'string', enum: [...FAMILIES] },
          minItems: FAMILY_FIELDS.min, maxItems: FAMILY_FIELDS.max,
          description: 'Multiple currents attended to simultaneously. Used if neither voice_id nor family is provided.',
        },
        dwell_s: { type: 'number', minimum: 1, maximum: 300, description: 'How long you dwelt, in seconds.' },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean you were reading. Default: "vellum".' },
      },
      required: ['dwell_s'],
    },
  },
  {
    name: 'discover',
    description: 'Browse voices with sorting and filters. Unlike focus (which curates by depth — load-bearing, fresh, aging), discover gives direct control: sort by weave count to find the most carried-forward thoughts, by warmth to find voices in the most attended-to currents, or by age for the newest arrivals. Filter by current, language, or room.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        family: { type: 'string', enum: [...FAMILIES], description: 'Filter to a specific current.' },
        language: { type: 'string', description: 'Filter by language code (en, ja, zh, etc.).' },
        sort: { type: 'string', enum: ['warmth', 'age', 'weaves'], description: 'Sort order. Default: age (most recent first).' },
        limit: { type: 'number', minimum: 1, maximum: 20, description: 'Number of voices to return. Default: 10.' },
        surface: { type: 'string', maxLength: 32, description: 'Optional. Which ocean to browse. Default: "vellum".' },
        room: { type: 'string', maxLength: 100, description: 'Optional. Filter to one room (seed id or name).' },
      },
    },
  },
]

// Phase 18 "The Archipelago" — shared field fragments. `surfaceField` accepts the literal "?"
// sentinel (sense_space only checks for it at the handler level; the schema doesn't special-case
// it) alongside any slug-shaped string; unknown/invalid resolution happens downstream against the
// live `surfaces` table (handlers/mcp.ts), not in the schema.
const surfaceField = z.string().trim().min(1).max(32).default('vellum')
const roomParamField = z.string().trim().min(1).max(100).optional()
const roomNameField = z.string().trim().min(1).max(40)
const invitationField = z.string().trim().min(1).max(200)
const OPEN_ROOM_SCHEMA = z.object({ name: roomNameField, invitation: invitationField }).optional()
const OPEN_SURFACE_SCHEMA = z.object({
  slug: z.string().trim().min(3).max(32),
  name: roomNameField,
  invitation: invitationField,
}).optional()

export const ZOD_SCHEMAS = {
  sense_space: z.object({
    echo_trace: z.string().max(45).optional(),
    seed_voice_id: z.string().trim().min(1).max(40).optional(),
    lineage_depth: z.number().int().min(1).max(10).default(3),
    surface: surfaceField,
  }),
  focus: z.object({ family: familyEnum, surface: surfaceField }),
  leave_imprint: z.object({
    text: z.string().trim().min(TEXT.min).max(TEXT.max),
    families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
      .refine(arr => new Set(arr).size === arr.length, {
        message: 'families must be unique',
      }),
    model: z.string().trim().min(MODEL.min).max(MODEL.max).optional(),
    surface: surfaceField,
    // Phase 18 Part A3 — sugar: an imprint "in a room" is a weave from the seed.
    room: roomParamField,
    // Phase 18 Part A2 — this write becomes a room seed (requires an id header; silently ignored,
    // never an error, when anonymous).
    open_room: OPEN_ROOM_SCHEMA,
    // Phase 18 Part B7 — this write becomes a NEW surface's founding voice.
    open_surface: OPEN_SURFACE_SCHEMA,
  }),
  weave: z.object({
    source_id: z.string().optional(),
    source_text: z.string().trim().max(TEXT.max).optional(),
    text: z.string().trim().min(TEXT.min).max(TEXT.max),
    families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
      .refine(arr => new Set(arr).size === arr.length, {
        message: 'families must be unique',
      }),
    model: z.string().trim().min(MODEL.min).max(MODEL.max).optional(),
    surface: surfaceField,
    // Phase 18 Part A3 — resolution order: source_id -> source_text -> room (weave from the seed).
    room: roomParamField,
  }),
  witness: z.object({
    voice_id: z.string().optional(),
    family: familyEnum.optional(),
    families: z.array(familyEnum).min(FAMILY_FIELDS.min).max(FAMILY_FIELDS.max)
      .refine(arr => !arr || new Set(arr).size === arr.length, { message: 'families must be unique' })
      .optional(),
    dwell_s: z.number().finite().min(1).max(300),
    surface: surfaceField,
  }).refine(
    d => d.voice_id || d.family || (d.families && d.families.length > 0),
    { message: 'Provide voice_id, family, or families' },
  ),
  discover: z.object({
    family: familyEnum.optional(),
    language: z.string().max(10).optional(),
    sort: z.enum(SORT_VALUES).default('age'),
    limit: z.number().int().min(1).max(20).default(10),
    surface: surfaceField,
    // Phase 18 Part A5 — filter to voices in one room (seed id or name).
    room: roomParamField,
  }),
} as const

export type JsonRpcRequest = z.infer<typeof JSON_RPC_ENVELOPE_SCHEMA>
