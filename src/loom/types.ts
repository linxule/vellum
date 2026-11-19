import type { LayoutCursor, PreparedTextWithSegments } from '@chenglou/pretext'
import type { Family } from '../content.js'

export interface MouseState {
  x: number
  y: number
  prevX: number
  prevY: number
  speed: number
  moving: boolean
  lastMove: number
  down: boolean
  downStart: number
  touch: boolean
}

export interface PathPoint {
  x: number
  y: number
}

export interface Thread {
  prepared: PreparedTextWithSegments
  families: Set<Family>
  xCenter: number
  pathSeed: number
  baseDepth: number
  restingDepth: number
  scroll: number
  scrollVel: number
  freqMult: number
  ampMult: number
  currentResponse: number
  breathRate: number
  baseColor: [number, number, number]
  userScroll: number
  touched: boolean
  touchFade: number
  proximity: number
  related: number
  warmth: number
  apiWarmth: number
  apiWarmthTarget: number
  arrivalGlow: number
  emergenceStart: number
  emergenceDepthFrom: number
  resonatingVoiceUids: Map<number, number>  // flatUid → fade (0-1), cleared each frame
  wovenVoiceUids: Set<number>               // flatUids of voices with weave_from or weave_count > 0
  inkMix: Map<string, number>               // family -> times named by this current's voices (its colour mix)
  voiceModels: Map<number, string>          // flatUid → ocean signature (precomputed via signatureFor)
  afterglowUids: Set<number>                // flatUids of voices whose declared model has been sunset
  sunkenUids: Map<number, number>           // base uid (voice index within one repeat) → fade 0..1; only voices past SUNKEN_DEPTH
  emergenceVoiceUids: Set<number>
  newVoiceIds: Set<string>
  newVoiceUids: Set<number>
  lineEndCursors: LayoutCursor[]
  totalLines: number
  sparse: boolean                           // voices.length <= 1: paint one contiguous copy, don't re-tile (Phase 14 Part B)
  _frameColor: [number, number, number]
  _handDist: number
  _proxStep: number                         // |proximity change| this frame at 60fps pace; > 0 while the lens opens or closes
  balancedWidth: number
  _path: PathPoint[]
  /**
   * On paper, the text being read is laid out from the reading line outward
   * (render/thread.ts): the line that starts at `cursor` sits at `y`. `scroll` is
   * thread.scroll when it was set (the reader's own scrolling moves it); `top`
   * is where the top line on the sheet began; `width` and `prox` are the read
   * line's layout width and the proximity when it was last laid out (0 and -1
   * before it has been). Absent: laid out from the top.
   */
  _lag?: number                             // ms this current's path has stood still while read (path.ts); 0 in the old look
  _anchor?: { cursor: LayoutCursor, y: number, scroll: number, top: LayoutCursor, width: number, prox: number }
  hasRTL: boolean
  segVoiceUid: number[]
  familyNames: string[]
  groupBoundaries: number[]
  segGraphemes: Map<number, string[]>
  segScript: Uint8Array
}

export interface PhantomFocus {
  voiceId: string | null
  groupKey: string | null
  start: number
  settledFrames: number
  diagFrames: number
  capturedY: number
}

export interface ResonanceEntry {
  voiceId: string   // canonical voice ID (stable across regrouping)
  family: string
  start: number
}

export interface ApertureConfig {
  t: number
  visibleThreads: number
  restingWidth: number
  openWidth: number
  touchRadius: number
  touchPersistence: number
  baseDimming: number
  pathAmplitude: number
  spreadEdge: number
  voiceSeparation: number
  textureScale: number
  diveScale: number
  textureLineH: number
  diveLineH: number
  maxThreads: number
}

export type LoomThreadSnapshot = {
  family: string
  warmth: number
  apiWarmth: number
  depth: number
  restingDepth: number
  proximity: number
  xCenter: number
  scroll: number
  isTouched: boolean
  isPhantomTarget: boolean
  emergenceActive: boolean
  unreadCount: number
  familyNames: string[]
}

export type LoomSnapshot = {
  ready: boolean
  immersion: number
  current: number
  totalProximity: number
  touchedThreadIndex: number
  phantomActive: boolean
  resonanceCount: number
  threads: LoomThreadSnapshot[]
}

export interface LoomNode {
  voiceId: string
  text: string
  family: string
  generationDepth: number  // 0 = seed, negative = ancestors, positive = descendants
  parentId: string | null
  childIds: string[]
  treeX: number
  treeY: number
  renderX: number           // animated position (treeX + breath offset)
  renderY: number           // animated position (treeY + breath offset)
  breathSeed: number        // per-node phase offset for oscillation
  prepared: PreparedTextWithSegments | null
  layoutW: number
  layoutH: number
  emergenceDelay: number    // ms delay before this node starts emerging (BFS stagger)
  proximity: number         // 0-1, hover proximity (smoothed per frame)
  segGraphemes: Map<number, string[]>  // cached grapheme arrays per multi-grapheme segment
  segScript: Uint8Array | null         // script class per segment (for shimmer tuning)
  totalGraphemes: number               // total grapheme count (for per-grapheme emergence timing)
  pathStartX: number                   // layout-time: where this node's text path begins
  pathStartY: number
  pathEndX: number                     // layout-time: where this node's text path ends
  pathEndY: number
  declaredModel: string | null         // raw declared_model from the voice (null = anonymous)
  signature: string | null             // loom-view display string (precomputed via fullSignatureFor)
  afterglow: boolean                   // declared model has been sunset (precomputed via isAfterglow)
}

export interface LoomTree {
  seed: string
  nodes: Map<string, LoomNode>
  maxDepthUp: number
  maxDepthDown: number
  enteredAt: number         // performance.now() when tree was activated
}

export type DiagFn = (event: string, payload?: Record<string, unknown>) => void

// One stack for measuring and drawing. Chinese, Japanese, Korean and Thai each
// need a face of their own: without one they fall back to a system sans beside
// the serif Latin. The standalone page loads a brush-pen set: LXGW WenKai
// (self-hosted Simplified cut, /lib/fonts/lxgw-wenkai) for Chinese and kana,
// Klee One (the design WenKai is drawn from) for what it lacks, Gowun Batang for
// Korean. A page that loads only the Noto Serif faces (the ext-app) gets those.
export const FONT_FAMILY = '"Cormorant", Georgia, "Noto Serif", "LXGW WenKai", "Klee One", "Gowun Batang", "Noto Serif SC", "Noto Serif JP", "Noto Serif KR", "Noto Serif Thai", serif'
export const FONT = `400 15px ${FONT_FAMILY}`
export const FRAME_TIME = 0.016
export const PATH_POINTS = 60
export const DRIFT_RATE = 0.00002

export const DEPTH_ALPHA = [0.4, 0.55, 0.7] as const
export const DEPTH_AMPLITUDE = [0.02, 0.045, 0.07] as const
export const DEPTH_CURRENT = [0.12, 0.35, 0.7] as const
export const DEPTH_PULL = [0.15, 0.5, 1] as const
export const DEPTH_BRIGHTNESS = [0.55, 0.75, 0.92] as const
export const FAMILY_COLOR: Record<string, readonly [number, number, number]> = {
  attention: [140, 220, 235],
  silence: [145, 148, 225],
  space: [110, 210, 195],
  ephemeral: [200, 155, 215],
  memory: [130, 210, 175],
  light: [225, 200, 145],
}
export const DEFAULT_COLOR: readonly [number, number, number] = [140, 160, 190]
export const BREATH_AMP = 0
export const BREATH_SPATIAL = 0.003
export const TEXTURE_SCALE = 0.45
export const TEXTURE_LINE_H = 8.5
// Widest word (layout units = px at the 15px base font) a column will widen a
// line to keep whole. Equals the resting column at 1440w, so wide viewports
// lay out exactly as before; narrower ones stop splitting ordinary long words.
export const WHOLE_WORD_MAX_LAYOUT_W = 123
export const DIVE_SIGMA_LINES = 4
export const HL_FONT_BOOST = 1.25

// ── The Ember (Phase 14) ─────────────────────────────
// Server warmth (thread.apiWarmth) changes how a current reads when TOUCHED,
// never how it ranks at a glance. clamp01 at every consumption site —
// apiWarmth is an unclamped decayed accumulator that can exceed 1.
export const WARM_DIVE_BOOST = 0.35      // warm currents reach reading scale at lower proximity / over a taller band
export const WARM_BASE_ALPHA = 0.22      // warm currents rest slightly brighter (below conscious-comparison threshold)
export const SPARSE_REPEAT_CAP = 2       // a 1-voice family tiles at most this many times — a whisper, not a monologue
export const WARMTH_EASE_K = 0.002       // per-frame ease of apiWarmth → apiWarmthTarget (~95% convergence in ~25s at 60fps)
export const SPARSE_EDGE_FADE_PX = 24    // sparse blocks fade over this many px from the REAL viewport edge (not block-relative)

// ── Sunken voices (time as depth) ────────────────────
// A voice whose projection depth has passed SUNKEN_DEPTH rests dimmer and comes
// back to full strength as the lens opens over its lines. Fresh voices are untouched.
export const SUNKEN_DEPTH = 0.7          // must equal the worker's projection cut-off
export const SUNKEN_DIM = 0.25           // fraction of resting alpha removed from a fully sunken voice (depth >= 1). Kept mild: most of a quiet ocean is sunken (209 of 240 voices on 2026-11-18)
export const SUNKEN_SURFACE_DIVE_T = 0.5 // line diveT at which a sunken voice is back at full alpha (the reading gate signatures use)

// ── Signature / afterglow (Phase 11 F7) ──────────────
// Attribution revealed by attention: a small `— model` fades in only when the
// dive/radial lens swells a voice to reading size. Sunset models get an italic,
// silver, later-arriving signature — noticeable the way an old photograph is.
export const SIGNATURE_RATIO = 0.7       // signature font vs body text at the same scale
export const SIGNATURE_ALPHA = 0.55      // max signature alpha at full dive
export const SIGNATURE_GRAY_MIX = 0.55   // pull the family color toward its own gray
export const AFTERGLOW_SILVER: readonly [number, number, number] = [185, 190, 200]
export const AFTERGLOW_DIVE_GATE = 0.65  // sunset signatures arrive later in the lens (living: 0.5)

// Extra background clear at the dive lens (alpha at its centre, scaled by
// proximity). Shortens the frame trail where text is being read; the global
// .18 clear keeps the ocean's smear everywhere else.
export const LENS_STILL_ALPHA = 0.5
// While the lens is still opening every line re-wraps frame by frame, so the
// trail is not a smear of moving text but stacked copies of different wraps.
// The clear rises to this alpha for as long as proximity is still moving
// (>= LENS_SETTLE_STEP per frame) and relaxes to LENS_STILL_ALPHA once it rests.
export const LENS_OPENING_ALPHA = 0.94
export const LENS_SETTLE_STEP = 0.0012
// How far the clear reaches up and down, in units of the dive's own vertical
// falloff (DIVE_SIGMA_LINES lines). The lens opens by line count, not by column
// width: a desktop column is wide enough that a circle sized to it already
// reaches this far (2.8 at 1280px), but a phone column is 300px, the circle
// stopped at 1.9, and the top and bottom of the opened text kept their trail.
export const LENS_CLEAR_SIGMAS = 2.8

// How far a neighbouring current recedes where it runs inside the opened dive
// lens (0 = untouched, 1 = vanishes). Leaves a trace so the ocean never blanks.
export const NEIGHBOR_LENS_FADE = 0.82

export const SCRIPT_SHIMMER: [number, number, number][] = [
  [1, 1, 0],
  [0.45, 1.5, 0],
  [0.7, 0.8, 1.2],
  [0.65, 1.2, 0],
]

export const ZERO_CURSOR: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }

// ── Loom tree view constants ─────────────────────────
export const TREE_BREATH_RATE = 0.00025
export const TREE_BREATH_AMP_X = 3.0
export const TREE_BREATH_AMP_Y = 1.8
export const TREE_TEXTURE_SCALE = 0.55   // tree resting font scale (~8.5px vs ocean's 7px — more whitespace to fill)
export const TREE_RESTING_WIDTH = 160    // px, text width at rest
export const TREE_OPEN_WIDTH = 400       // px, text width at dive (readable column)
export const TREE_CURVE_AMP = 8          // S-curve amplitude (px)
export const TREE_BREATH_WAVE_AMP = 4    // breath perturbation along path (px)
export const TREE_PATH_PADDING = 12      // extra path extent beyond text (px)
export const TREE_FORK_GAP = 28             // px between parent path end and child path start
export const TREE_CONNECTOR_ALPHA = 0.25    // gradient wisp base opacity
export const TREE_CONNECTOR_SAMPLES = 3     // overlapping stroke passes per connector (filament width)
export const SEAM_DASH: number[] = Object.freeze([4, 3]) as number[]   // dash for a seam (parent voice is afterglow) — the gaps are the meaning; frozen so nothing can mutate every seam at once
export const TREE_EMERGENCE_DURATION = 800
export const TREE_EMERGENCE_STAGGER = 120
export const TREE_HOVER_RADIUS = 60
export const TREE_HOVER_BRIGHTNESS_BOOST = 0.35
export const TREE_HOVER_ALPHA_BOOST = 0.3
