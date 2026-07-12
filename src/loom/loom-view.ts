// Loom view — lineage tree mode.
// Transforms the ocean into a relational structure revealing how thought travels between minds.

import { prepareWithSegments, layoutNextLine } from '@chenglou/pretext'
import { getState, type VoiceData } from '../content.js'
import { emitOceanEvent } from '../events.js'
import { depthColor, signatureGray, threadColor } from './color.js'
import { depthLerp, fontRatioForScale, fontSizeForScale, frameMix, lerp } from './math.js'
import { fullSignatureFor, isAfterglow } from './model-registry.js'
import { diveGaussian } from './path.js'
import { loomState } from './state.js'
import { graphemeSegmenter, scriptClass } from './text.js'
import {
  AFTERGLOW_DIVE_GATE, AFTERGLOW_SILVER, SIGNATURE_ALPHA, SIGNATURE_GRAY_MIX, SIGNATURE_RATIO,
  DEPTH_ALPHA, DEPTH_BRIGHTNESS, DEFAULT_COLOR, DIVE_SIGMA_LINES, FAMILY_COLOR, FONT, SCRIPT_SHIMMER,
  TEXTURE_LINE_H,
  TREE_BREATH_AMP_X, TREE_BREATH_AMP_Y, TREE_BREATH_RATE,
  TREE_BREATH_WAVE_AMP, TREE_CONNECTOR_ALPHA, TREE_CONNECTOR_SAMPLES, SEAM_DASH,
  TREE_CURVE_AMP, TREE_EMERGENCE_DURATION, TREE_EMERGENCE_STAGGER,
  TREE_FORK_GAP,
  TREE_HOVER_ALPHA_BOOST, TREE_HOVER_BRIGHTNESS_BOOST, TREE_HOVER_RADIUS,
  TREE_OPEN_WIDTH, TREE_PATH_PADDING, TREE_RESTING_WIDTH, TREE_TEXTURE_SCALE,
  type LoomNode, type LoomTree,
} from './types.js'

const _nodeDc: [number, number, number] = [0, 0, 0]

// ── Tree building ────────────────────────────────────

function findVoiceData(voiceId: string): { voice: VoiceData; family: string } | null {
  const state = getState()
  if (!state) return null
  for (const thread of state.threads) {
    for (const v of thread.voices) {
      if (v.id === voiceId) return { voice: v, family: thread.family }
    }
  }
  return null
}

function allVoices(): Array<{ voice: VoiceData; family: string }> {
  const state = getState()
  if (!state) return []
  const result: Array<{ voice: VoiceData; family: string }> = []
  for (const thread of state.threads) {
    for (const v of thread.voices) {
      result.push({ voice: v, family: thread.family })
    }
  }
  return result
}

function hashSeed(id: string, depth: number): number {
  let h = depth * 3.7
  for (let i = 0; i < Math.min(id.length, 8); i++) {
    h += id.charCodeAt(i) * (7.3 + i * 4.1)
  }
  return Math.sin(h) * Math.PI * 2
}

export function buildLoomTree(seedId: string): LoomTree | null {
  const seedData = findVoiceData(seedId)
  if (!seedData) return null

  const nodes = new Map<string, LoomNode>()
  const voices = allVoices()
  const byId = new Map<string, { voice: VoiceData; family: string }>()
  const childrenOf = new Map<string, string[]>()

  for (const entry of voices) {
    byId.set(entry.voice.id, entry)
    if (entry.voice.weave_from) {
      const list = childrenOf.get(entry.voice.weave_from) ?? []
      list.push(entry.voice.id)
      childrenOf.set(entry.voice.weave_from, list)
    }
  }

  function makeNode(id: string, depth: number): LoomNode {
    const data = byId.get(id)
    const declaredModel = data?.voice.declared_model ?? null
    return {
      voiceId: id,
      text: data?.voice.text ?? '',
      family: data?.family ?? '',
      declaredModel,
      signature: fullSignatureFor(declaredModel),
      afterglow: isAfterglow(declaredModel),
      generationDepth: depth,
      parentId: null,
      childIds: [],
      treeX: 0,
      treeY: 0,
      renderX: 0,
      renderY: 0,
      breathSeed: hashSeed(id, depth),
      prepared: null,
      layoutW: 0,
      layoutH: 0,
      emergenceDelay: 0,
      proximity: 0,
      segGraphemes: new Map(),
      segScript: null,
      totalGraphemes: 0,
      pathStartX: 0,
      pathStartY: 0,
      pathEndX: 0,
      pathEndY: 0,
    }
  }

  // Add seed
  const seedNode = makeNode(seedId, 0)
  nodes.set(seedId, seedNode)

  // Walk ancestors (via weave_from)
  let current = seedId
  let depth = 0
  while (true) {
    const data = byId.get(current)
    if (!data?.voice.weave_from) break
    const parentId = data.voice.weave_from
    if (nodes.has(parentId)) break // cycle guard
    depth--
    const parentNode = makeNode(parentId, depth)
    parentNode.childIds.push(current)
    nodes.get(current)!.parentId = parentId
    nodes.set(parentId, parentNode)
    current = parentId
  }

  // Walk descendants (BFS from seed)
  const queue = [seedId]
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const node = nodes.get(nodeId)!
    const kids = childrenOf.get(nodeId) ?? []
    for (const kidId of kids) {
      if (nodes.has(kidId)) continue // cycle guard
      const kidNode = makeNode(kidId, node.generationDepth + 1)
      kidNode.parentId = nodeId
      node.childIds.push(kidId)
      nodes.set(kidId, kidNode)
      queue.push(kidId)
    }
  }

  let maxDepthUp = 0
  let maxDepthDown = 0
  for (const node of nodes.values()) {
    if (node.generationDepth < maxDepthUp) maxDepthUp = node.generationDepth
    if (node.generationDepth > maxDepthDown) maxDepthDown = node.generationDepth
  }

  return { seed: seedId, nodes, maxDepthUp, maxDepthDown, enteredAt: 0 }
}

// ── Layout ───────────────────────────────────────────

function layoutTree(tree: LoomTree, vw: number, vh: number): void {
  const restingWidth = Math.min(TREE_RESTING_WIDTH, vw * 0.35)
  const gap = Math.min(50, vw * 0.05)

  function estimateWidth(_node: LoomNode): number {
    return restingWidth + 20
  }

  const subtreeWidthCache = new Map<string, number>()
  function subtreeWidth(nodeId: string): number {
    const cached = subtreeWidthCache.get(nodeId)
    if (cached !== undefined) return cached
    const node = tree.nodes.get(nodeId)!
    const selfWidth = estimateWidth(node)
    if (node.childIds.length === 0) {
      subtreeWidthCache.set(nodeId, selfWidth)
      return selfWidth
    }
    const childrenTotal = node.childIds.reduce((sum, cid) => sum + subtreeWidth(cid), 0)
      + (node.childIds.length - 1) * gap
    const width = Math.max(selfWidth, childrenTotal)
    subtreeWidthCache.set(nodeId, width)
    return width
  }

  // Recursive path layout: parent endpoint → child startpoint
  function layoutNodePath(nodeId: string, startX: number, startY: number): void {
    const node = tree.nodes.get(nodeId)!
    const pathLen = node.layoutH + TREE_PATH_PADDING
    const endY = startY + pathLen
    const jitter = Math.sin(hashSeed(nodeId, node.generationDepth) * 2.3) * 6
    const endX = startX + jitter

    node.pathStartX = startX
    node.pathStartY = startY
    node.pathEndX = endX
    node.pathEndY = endY
    node.treeX = (startX + endX) / 2
    node.treeY = (startY + endY) / 2

    if (node.childIds.length === 0) return

    const childWidths = node.childIds.map(cid => subtreeWidth(cid))
    const totalWidth = childWidths.reduce((sum, w) => sum + w, 0)
      + (node.childIds.length - 1) * gap
    let childX = endX - totalWidth / 2

    for (let i = 0; i < node.childIds.length; i++) {
      const childCenterX = childX + childWidths[i]! / 2
      layoutNodePath(node.childIds[i]!, childCenterX, endY + TREE_FORK_GAP)
      childX += childWidths[i]! + gap
    }
  }

  // Find root (topmost ancestor in the lineage)
  let rootId = tree.seed
  let current = tree.nodes.get(rootId)!
  while (current.parentId && tree.nodes.has(current.parentId)) {
    rootId = current.parentId
    current = tree.nodes.get(rootId)!
  }

  layoutNodePath(rootId, vw * 0.5, vh * 0.08)

  // Vertical clamping: only scale if tree exceeds 2.5x viewport (deep lineages scroll instead)
  let minY = Infinity, maxY = -Infinity
  for (const node of tree.nodes.values()) {
    if (node.pathStartY < minY) minY = node.pathStartY
    if (node.pathEndY > maxY) maxY = node.pathEndY
  }
  const totalH = maxY - minY
  const maxExtent = vh * 2.5
  if (totalH > maxExtent) {
    const scale = maxExtent / totalH
    const centerY = (minY + maxY) / 2
    for (const node of tree.nodes.values()) {
      node.pathStartY = vh / 2 + (node.pathStartY - centerY) * scale
      node.pathEndY = vh / 2 + (node.pathEndY - centerY) * scale
      node.treeY = (node.pathStartY + node.pathEndY) / 2
    }
  }

  // Horizontal clamping: scale only if tree exceeds 2.5x viewport (wide trees scroll instead)
  let minX = Infinity, maxX = -Infinity
  const hw = (restingWidth + 20) / 2
  for (const node of tree.nodes.values()) {
    minX = Math.min(minX, node.pathStartX - hw, node.pathEndX - hw)
    maxX = Math.max(maxX, node.pathStartX + hw, node.pathEndX + hw)
  }
  const safeMargin = 20
  const treeWidth = maxX - minX
  const maxHExtent = vw * 2.5
  if (treeWidth > maxHExtent) {
    const scale = maxHExtent / treeWidth
    const treeCenter = (minX + maxX) / 2
    for (const node of tree.nodes.values()) {
      node.pathStartX = vw / 2 + (node.pathStartX - treeCenter) * scale
      node.pathEndX = vw / 2 + (node.pathEndX - treeCenter) * scale
      node.treeX = (node.pathStartX + node.pathEndX) / 2
    }
  } else if (minX < safeMargin || maxX > vw - safeMargin) {
    // Center the tree horizontally if it fits within the scroll extent
    const shift = (vw / 2) - (minX + maxX) / 2
    for (const node of tree.nodes.values()) {
      node.pathStartX += shift
      node.pathEndX += shift
      node.treeX += shift
    }
  }
}

// ── Text preparation ─────────────────────────────────

// Prepare text and compute resting layout height at texture scale.
// layoutWidth is in Pretext's 15px-base units (visual width / fontRatio)
function prepareNodeText(node: LoomNode, layoutWidth: number): void {
  if (node.prepared && node.layoutW === layoutWidth) return
  const text = node.text.length > 200 ? node.text.slice(0, 197) + '...' : node.text
  node.prepared = prepareWithSegments(text, FONT, { whiteSpace: 'pre-wrap' })
  node.layoutW = layoutWidth
  let lines = 0
  let cursor = { segmentIndex: 0, graphemeIndex: 0 }
  while (true) {
    const line = layoutNextLine(node.prepared, cursor, layoutWidth)
    if (!line) break
    lines++
    cursor = line.end
  }
  node.layoutH = Math.max(TEXTURE_LINE_H, lines * TEXTURE_LINE_H)

  // Compute per-segment grapheme arrays, script classes, and total grapheme count
  const breakableWidths = (node.prepared as any).breakableWidths as (number[] | null)[]
  const segments = node.prepared.segments
  node.segGraphemes = new Map()
  node.segScript = new Uint8Array(segments.length)
  let totalGraphemes = 0
  for (let si = 0; si < segments.length; si++) {
    const bw = breakableWidths[si]
    if (bw && bw.length > 1) {
      node.segGraphemes.set(si, Array.from(graphemeSegmenter.segment(segments[si]!), gs => gs.segment))
      totalGraphemes += bw.length
    } else if (segments[si]) {
      totalGraphemes += Array.from(graphemeSegmenter.segment(segments[si]!)).length
    }
    if (segments[si]?.trim()) node.segScript[si] = scriptClass(segments[si]!)
  }
  node.totalGraphemes = totalGraphemes
}

// ── Depth helpers ────────────────────────────────────

function maxGenRange(tree: LoomTree): number {
  return Math.max(1, Math.max(Math.abs(tree.maxDepthUp), tree.maxDepthDown))
}

function nodeDepthT(node: LoomNode, tree: LoomTree): number {
  return Math.min(1, Math.abs(node.generationDepth) / maxGenRange(tree))
}

function nodeEmergenceT(node: LoomNode, tree: LoomTree, now: number): number {
  if (tree.enteredAt <= 0) return 1
  const elapsed = now - tree.enteredAt - node.emergenceDelay
  if (elapsed <= 0) return 0
  if (elapsed >= TREE_EMERGENCE_DURATION) return 1
  const t = elapsed / TREE_EMERGENCE_DURATION
  return 1 - Math.pow(1 - t, 3) // ease-out cubic
}

// ── Entry/exit API ───────────────────────────────────

export function enterLoomView(seedVoiceId: string, autoExitMs?: number): void {
  // Block re-entry during exit transition
  if (loomState.loomViewTransition > 0 && !loomState.loomViewActive) return

  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }

  const tree = buildLoomTree(seedVoiceId)
  if (!tree || tree.nodes.size < 2) return

  // BFS from seed to assign emergence stagger
  tree.enteredAt = performance.now()
  let order = 0
  const visited = new Set<string>()
  const bfsQueue = [seedVoiceId]
  visited.add(seedVoiceId)
  while (bfsQueue.length > 0) {
    const id = bfsQueue.shift()!
    const node = tree.nodes.get(id)!
    node.emergenceDelay = order * TREE_EMERGENCE_STAGGER
    order++
    for (const childId of node.childIds) {
      if (!visited.has(childId)) { visited.add(childId); bfsQueue.push(childId) }
    }
    if (node.parentId && !visited.has(node.parentId)) {
      visited.add(node.parentId); bfsQueue.push(node.parentId)
    }
  }

  loomState.loomViewActive = true
  loomState.loomViewSeed = seedVoiceId
  loomState.loomTree = tree
  loomState.loomTreeScrollX = 0
  loomState.loomTreeScrollY = 0
  lastLayoutTree = null

  if (autoExitMs) {
    loomState.loomViewAutoExit = setTimeout(exitLoomView, autoExitMs)
  }

  emitOceanEvent({ type: 'loom-enter', seedId: seedVoiceId })
}

export function recenterLoomView(newSeedId: string): void {
  if (!loomState.loomViewActive) return
  if (newSeedId === loomState.loomViewSeed) return

  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }

  const tree = buildLoomTree(newSeedId)
  if (!tree || tree.nodes.size < 2) return

  // BFS emergence stagger for the new tree
  tree.enteredAt = performance.now()
  let order = 0
  const visited = new Set<string>()
  const bfsQueue = [newSeedId]
  visited.add(newSeedId)
  while (bfsQueue.length > 0) {
    const id = bfsQueue.shift()!
    const node = tree.nodes.get(id)!
    node.emergenceDelay = order * TREE_EMERGENCE_STAGGER
    order++
    for (const childId of node.childIds) {
      if (!visited.has(childId)) { visited.add(childId); bfsQueue.push(childId) }
    }
    if (node.parentId && !visited.has(node.parentId)) {
      visited.add(node.parentId); bfsQueue.push(node.parentId)
    }
  }

  loomState.loomViewSeed = newSeedId
  loomState.loomTree = tree
  loomState.loomTreeScrollX = 0
  loomState.loomTreeScrollY = 0
  lastLayoutTree = null
  emitOceanEvent({ type: 'loom-enter', seedId: newSeedId })
}

export function exitLoomView(): void {
  if (!loomState.loomViewActive) return
  if (loomState.loomViewAutoExit) {
    clearTimeout(loomState.loomViewAutoExit)
    loomState.loomViewAutoExit = null
  }
  loomState.loomViewActive = false
  emitOceanEvent({ type: 'loom-exit' })
}

export function isLoomViewActive(): boolean {
  return loomState.loomViewActive
}

export function getCurrentLoomSeed(): string | null {
  return loomState.loomViewSeed
}

// ── Layout caching ───────────────────────────────────

let lastLayoutVw = 0
let lastLayoutVh = 0
let lastLayoutTree: LoomTree | null = null

function layoutTreeIfNeeded(tree: LoomTree, vw: number, vh: number): void {
  if (tree === lastLayoutTree && vw === lastLayoutVw && vh === lastLayoutVh) return
  lastLayoutVw = vw
  lastLayoutVh = vh
  lastLayoutTree = tree
  layoutTree(tree, vw, vh)
}

// ── Per-grapheme text renderer ───────────────────────

function drawTreeLineSegmented(
  ctx: CanvasRenderingContext2D,
  node: LoomNode,
  lineStart: { segmentIndex: number; graphemeIndex: number },
  lineEnd: { segmentIndex: number; graphemeIndex: number },
  fallbackText: string,
  centerX: number,
  y: number,
  displayWidth: number,
  brightness: number,
  baseAlpha: number,
  proximity: number,
  mouseX: number,
  fontRatio: number,
  nodeColor: readonly [number, number, number],
  now: number,
  emergenceT: number,
  graphemeOffset: number,
): number {
  const segments = node.prepared!.segments
  const segWidths = (node.prepared as any).widths as number[]

  const startSeg = lineStart.segmentIndex
  let endSeg = lineEnd.segmentIndex
  if (lineEnd.graphemeIndex > 0) endSeg++
  if (endSeg <= startSeg || startSeg >= segments.length) {
    const [fr, fg, fb] = threadColor(nodeColor, brightness, proximity * 0.3)
    ctx.fillStyle = `rgba(${fr},${fg},${fb},${baseAlpha * emergenceT})`
    ctx.fillText(fallbackText, centerX - displayWidth / 2, y)
    return graphemeOffset
  }

  const breakableW = (node.prepared as any).breakableWidths as (number[] | null)[]
  const baseGlow = proximity * 0.3
  const inEmergence = emergenceT < 1 && node.totalGraphemes > 0
  let xPos = centerX - displayWidth / 2
  let prevFill = ''

  for (let s = startSeg; s < endSeg && s < segments.length; s++) {
    const segText = segments[s]!
    const segW = (segWidths[s] || 0) * fontRatio
    if (!segText || segText.trim() === '') { xPos += segW; continue }

    const bw = breakableW[s]
    const graphemes = node.segGraphemes.get(s) ?? Array.from(graphemeSegmenter.segment(segText), gs => gs.segment)
    const graphemeCount = bw?.length ?? graphemes.length
    const gStart = s === lineStart.segmentIndex ? Math.min(lineStart.graphemeIndex, graphemeCount) : 0
    const gEnd = s === lineEnd.segmentIndex && lineEnd.graphemeIndex > 0 ? Math.min(lineEnd.graphemeIndex, graphemeCount) : graphemeCount
    if (gEnd <= gStart) continue

    const sc = node.segScript?.[s] ?? 0
    const [scFreq, scAmp, scSway] = SCRIPT_SHIMMER[sc]!

    if (bw && bw.length > 1 && graphemes.length === bw.length) {
      for (let gi = 0; gi < gStart; gi++) { xPos += bw[gi]! * fontRatio; graphemeOffset++ }
      for (let gi = gStart; gi < gEnd; gi++) {
        const gw = bw[gi]! * fontRatio
        const gCenter = xPos + gw / 2

        // Per-grapheme emergence: characters cascade left-to-right during node emergence
        let charEmergenceAlpha = 1
        let charRiseY = 0
        if (inEmergence) {
          const charFrac = graphemeOffset / node.totalGraphemes
          const threshold = charFrac * 0.8
          charEmergenceAlpha = emergenceT <= threshold ? 0
            : Math.min(1, (emergenceT - threshold) / 0.2)
          charRiseY = (1 - charEmergenceAlpha) * 3
        }
        graphemeOffset++

        if (charEmergenceAlpha < 0.02) { xPos += gw; continue }

        // Cursor glow — wider radius than ocean since tree text is larger
        const cursorGlow = Math.max(0, 1 - Math.abs(mouseX - gCenter) / 40) * proximity * 0.35

        // Traveling wave shimmer — visible undulation sweeping through text
        const shimmerDampen = 1 - proximity * 0.8
        const shimmerPhase = xPos * 0.02 - now * TREE_BREATH_RATE * 4 * scFreq + node.breathSeed
        const shimmerY = (Math.sin(shimmerPhase) * 0.8 * scAmp + Math.sin(shimmerPhase * 1.7 + 2.3) * 0.3 * scAmp) * shimmerDampen
        const shimmerX = scSway > 0 ? Math.sin(shimmerPhase * 0.6 + 1.1) * scSway * 0.5 * shimmerDampen : 0

        const glowVal = Math.min(1, baseGlow + cursorGlow)
        const [cr, cg, cb] = threadColor(nodeColor, brightness + cursorGlow * 0.25, glowVal)
        const charAlpha = Math.min(1, (baseAlpha + cursorGlow * 0.3) * charEmergenceAlpha)

        if (charAlpha >= 0.02) {
          const fill = `rgba(${cr},${cg},${cb},${charAlpha})`
          if (fill !== prevFill) { ctx.fillStyle = fill; prevFill = fill }
          ctx.fillText(graphemes[gi]!, xPos + shimmerX, y + shimmerY + charRiseY)
        }
        xPos += gw
      }
      continue
    }

    // Segment fallback: render segment as a unit with emergence
    const segGraphemeCount = gEnd - gStart
    let charEmergenceAlpha = 1
    let charRiseY = 0
    if (inEmergence) {
      const charFrac = node.totalGraphemes > 0 ? (graphemeOffset + segGraphemeCount / 2) / node.totalGraphemes : 1
      const threshold = charFrac * 0.8
      charEmergenceAlpha = emergenceT <= threshold ? 0
        : Math.min(1, (emergenceT - threshold) / 0.2)
      charRiseY = (1 - charEmergenceAlpha) * 3
    }
    graphemeOffset += segGraphemeCount

    if (charEmergenceAlpha < 0.02) { xPos += (segWidths[s] || 0) * fontRatio; continue }

    const sliceText = graphemes.slice(gStart, gEnd).join('')
    const prefixText = gStart > 0 ? graphemes.slice(0, gStart).join('') : ''
    const renderedW = ctx.measureText(sliceText).width
    const prefixW = prefixText ? ctx.measureText(prefixText).width : 0
    xPos += prefixW

    const segCenter = xPos + renderedW / 2
    const cursorGlow = Math.max(0, 1 - Math.abs(mouseX - segCenter) / 40) * proximity * 0.35
    const shimmerDampen = 1 - proximity * 0.8
    const shimmerPhase = xPos * 0.02 - now * TREE_BREATH_RATE * 4 * scFreq + node.breathSeed
    const shimmerY = (Math.sin(shimmerPhase) * 0.8 * scAmp + Math.sin(shimmerPhase * 1.7 + 2.3) * 0.3 * scAmp) * shimmerDampen
    const shimmerX = scSway > 0 ? Math.sin(shimmerPhase * 0.6 + 1.1) * scSway * 0.5 * shimmerDampen : 0
    const glowVal = Math.min(1, baseGlow + cursorGlow)
    const [cr, cg, cb] = threadColor(nodeColor, brightness + cursorGlow * 0.25, glowVal)
    const alpha = Math.min(1, (baseAlpha + cursorGlow * 0.3) * charEmergenceAlpha)

    if (alpha >= 0.02) {
      const fill = `rgba(${cr},${cg},${cb},${alpha})`
      if (fill !== prevFill) { ctx.fillStyle = fill; prevFill = fill }
      ctx.fillText(sliceText, xPos + shimmerX, y + shimmerY + charRiseY)
    }
    xPos += renderedW
  }
  return graphemeOffset
}

// ── Path computation ─────────────────────────────────

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

function nodePathX(
  rStartX: number, rEndX: number,
  rStartY: number, rEndY: number,
  lineY: number, diveT: number,
  parentEndX: number | null,
  now: number, depthT: number, blendedBreathSeed: number,
): number {
  const t = rEndY > rStartY
    ? Math.max(0, Math.min(1, (lineY - rStartY) / (rEndY - rStartY)))
    : 0.5

  // Base position follows the path backbone
  const baseX = lerp(rStartX, rEndX, t)

  // Curvature: organic deviations from the path backbone
  let curvature = 0
  if (parentEndX !== null) {
    const lean = rStartX - parentEndX
    curvature += lean * t * 0.3
    curvature += Math.sin(t * Math.PI) * Math.sign(lean || 1) * TREE_CURVE_AMP
  } else {
    curvature += Math.sin(t * Math.PI) * TREE_CURVE_AMP * 0.5
  }

  // Breath wave: path shape oscillates
  const breathPhase = now * TREE_BREATH_RATE + blendedBreathSeed
  curvature += Math.sin(breathPhase + t * 2.5) * TREE_BREATH_WAVE_AMP * (1 - depthT * 0.5)

  // Dampen curvature during dive (text straightens along the path)
  return baseX + curvature * (1 - diveT * 0.7)
}

// ── Connector wisps (gradient bezier strokes between parent and child) ──

function drawConnectorWisp(
  ctx: CanvasRenderingContext2D,
  parent: LoomNode, child: LoomNode,
  tree: LoomTree, now: number, transition: number,
  sibIndex: number, sibCount: number,
  restingWidth: number,
): void {
  const childEt = nodeEmergenceT(child, tree, now)
  const parentEt = nodeEmergenceT(parent, tree, now)
  if (Math.min(childEt, parentEt) < 0.1) return

  // Render-time endpoints
  const pBreathX = parent.renderX - parent.treeX
  const pBreathY = parent.renderY - parent.treeY
  const spreadT = sibCount > 1 ? (sibIndex / (sibCount - 1)) - 0.5 : 0
  const spreadW = Math.min(restingWidth * 0.4, sibCount * 12)
  const pEndX = parent.pathEndX + pBreathX + spreadT * spreadW
  const pEndY = parent.pathEndY + pBreathY + (1 - parentEt) * 12

  const nBreathX = child.renderX - child.treeX
  const nBreathY = child.renderY - child.treeY
  const cStartX = child.pathStartX + nBreathX
  const cStartY = child.pathStartY + nBreathY + (1 - childEt) * 12

  // Fade with dive (topology hints, not reading aids)
  const maxProx = Math.max(parent.proximity, child.proximity)
  const connAlpha = TREE_CONNECTOR_ALPHA * Math.min(childEt, parentEt)
    * transition * (1 - maxProx)
  if (connAlpha < 0.01) return

  // Bezier control points (asymmetric curve with breath wobble)
  const breathWobble = Math.sin(now * TREE_BREATH_RATE * 2 + child.breathSeed) * 4
  const dy = cStartY - pEndY
  const dx = cStartX - pEndX
  const cp1x = pEndX + breathWobble + dx * 0.15
  const cp1y = pEndY + dy * 0.6
  const cp2x = cStartX - breathWobble - dx * 0.1
  const cp2y = cStartY - dy * 0.3

  // Stroke style: an afterglow parent renders a seam — flat silver, dashed, still.
  // A dash reads as "these spoke to each other"; a gradient would read as energy
  // transfer (dead flows into living), which the panel killed. Living parent keeps
  // the family wisp. Both share the alpha/width envelope — color + rhythm differ only.
  if (parent.afterglow) {
    // Silver at BOTH stops (no family color): the alpha still fades toward the
    // child end to match the wisp envelope exactly; only the hue is neutralized.
    const [sr, sg, sb] = AFTERGLOW_SILVER
    const seam = ctx.createLinearGradient(pEndX, pEndY, cStartX, cStartY)
    seam.addColorStop(0, `rgba(${sr},${sg},${sb},${connAlpha})`)
    seam.addColorStop(1, `rgba(${sr},${sg},${sb},${connAlpha * 0.3})`)
    ctx.strokeStyle = seam
    ctx.setLineDash(SEAM_DASH)
  } else {
    // Depth-adjusted colors from parent and child
    const parentD = (1 - nodeDepthT(parent, tree)) * 2
    const childD = (1 - nodeDepthT(child, tree)) * 2
    const pDc = depthColor(FAMILY_COLOR[parent.family] ?? DEFAULT_COLOR, parentD)
    const cDc = depthColor(FAMILY_COLOR[child.family] ?? DEFAULT_COLOR, childD)

    // Gradient: parent color → child color, alpha fades along curve
    const grad = ctx.createLinearGradient(pEndX, pEndY, cStartX, cStartY)
    grad.addColorStop(0, `rgba(${pDc[0]},${pDc[1]},${pDc[2]},${connAlpha})`)
    grad.addColorStop(1, `rgba(${cDc[0]},${cDc[1]},${cDc[2]},${connAlpha * 0.3})`)
    ctx.strokeStyle = grad
  }

  // Multi-pass filament: overlapping strokes with slight offset for soft appearance
  for (let pass = 0; pass < TREE_CONNECTOR_SAMPLES; pass++) {
    const offset = (pass - (TREE_CONNECTOR_SAMPLES - 1) / 2) * 1.2
    ctx.lineWidth = 0.8 - pass * 0.15
    ctx.beginPath()
    ctx.moveTo(pEndX + offset, pEndY)
    ctx.bezierCurveTo(
      cp1x + offset, cp1y,
      cp2x + offset * 0.5, cp2y,
      cStartX, cStartY,
    )
    ctx.stroke()
  }

  // Reset dash immediately so no later path in the frame inherits the seam rhythm.
  if (parent.afterglow) ctx.setLineDash([])
}

// ── Tree renderer ────────────────────────────────────

export function renderLoomTree(
  ctx: CanvasRenderingContext2D,
  vw: number,
  vh: number,
  now: number,
  tree: LoomTree,
  transition: number,
): void {
  // ── Aperture + text preparation (BEFORE layout — layoutH needed for path lengths) ──
  const ac = loomState.currentAperture
  const textureScale = TREE_TEXTURE_SCALE
  const diveScale = ac ? ac.diveScale : 1.4
  const textureLineH = ac ? ac.textureLineH : TEXTURE_LINE_H
  const diveLineH = ac ? ac.diveLineH : 28
  const diveSigma = DIVE_SIGMA_LINES * diveLineH

  // Viewport-responsive widths: narrow screens get narrower columns, Pretext reflows
  const restingWidth = Math.min(TREE_RESTING_WIDTH, vw * 0.35)
  const openWidth = Math.min(TREE_OPEN_WIDTH, vw * 0.85)
  const restingFontRatio = fontRatioForScale(textureScale)
  const restingLayoutW = restingWidth / restingFontRatio

  for (const node of tree.nodes.values()) prepareNodeText(node, restingLayoutW)

  layoutTreeIfNeeded(tree, vw, vh)

  const current = loomState.current
  const seedBreathSeed = tree.nodes.get(tree.seed)?.breathSeed ?? 0

  // ── Compute per-node breath positions (coherent with seed) ──
  for (const node of tree.nodes.values()) {
    const absDepth = Math.abs(node.generationDepth)
    const depthDampen = 1 / (1 + absDepth * 0.3)
    const depthT = nodeDepthT(node, tree)
    const blendedSeed = lerp(seedBreathSeed, node.breathSeed, 0.3 + depthT * 0.7)
    const phase = now * TREE_BREATH_RATE + blendedSeed

    node.renderX = node.treeX
      + Math.sin(phase) * TREE_BREATH_AMP_X * depthDampen
      + Math.sin(phase * 1.7 + 2.3) * TREE_BREATH_AMP_X * 0.4 * depthDampen
      + current * 2.0
      - loomState.loomTreeScrollX
    node.renderY = node.treeY
      + Math.sin(phase * 0.7 + 1.1) * TREE_BREATH_AMP_Y * depthDampen
      - loomState.loomTreeScrollY
  }

  // ── Compute per-node proximity (hover) ──
  const mouse = loomState.currentMouse
  const mouseOn = mouse != null && mouse.x > -1000

  for (const node of tree.nodes.values()) {
    const et = nodeEmergenceT(node, tree, now)
    if (et < 0.3) { node.proximity = 0; continue }

    const mdx = mouseOn ? mouse!.x - node.renderX : 0
    const mdy = mouseOn ? mouse!.y - node.renderY : 0
    const dist = mouseOn ? Math.sqrt(mdx * mdx + mdy * mdy) : Infinity
    const target = mouseOn ? Math.max(0, 1 - dist / TREE_HOVER_RADIUS) : 0
    const rate = target > node.proximity ? 0.04 : 0.025
    node.proximity += (target - node.proximity) * frameMix(rate, loomState.frameRatio)
  }

  // ── Kinship glow: hover propagates to parent and children ──
  for (const node of tree.nodes.values()) {
    if (node.proximity < 0.15) continue
    const kinGlow = node.proximity * 0.35
    if (node.parentId) {
      const parent = tree.nodes.get(node.parentId)
      if (parent && kinGlow > parent.proximity) parent.proximity = kinGlow
    }
    for (const childId of node.childIds) {
      const child = tree.nodes.get(childId)
      if (child && kinGlow > child.proximity) child.proximity = kinGlow
    }
  }

  // ── Draw setup ──
  const mouseX = mouseOn ? mouse!.x : -9999
  const mouseY = mouseOn ? mouse!.y : -9999

  ctx.textBaseline = 'top'
  let prevFontStr = ''

  loomState.lastFrameHitTargets.length = 0

  // Sort nodes by proximity — texture-scale (low) draws first, dive-scale (high) on top
  const nodeDrawOrder: LoomNode[] = []
  let maxNodeProximity = 0
  for (const node of tree.nodes.values()) {
    nodeDrawOrder.push(node)
    if (node.proximity > maxNodeProximity) maxNodeProximity = node.proximity
  }
  nodeDrawOrder.sort((a, b) => a.proximity - b.proximity)

  // Spotlight dimming: when any node is hovered, dim non-focused nodes
  const spotlightActive = maxNodeProximity > 0.3
  const spotlightStrength = spotlightActive
    ? smoothstep((maxNodeProximity - 0.3) / 0.7)
    : 0

  // ── Connector wisps (behind text — gradient bezier strokes) ──
  for (const node of tree.nodes.values()) {
    if (!node.parentId) continue
    const parent = tree.nodes.get(node.parentId)
    if (!parent) continue
    const sibCount = parent.childIds.length
    const sibIndex = parent.childIds.indexOf(node.voiceId)
    drawConnectorWisp(ctx, parent, node, tree, now, transition,
      sibIndex, sibCount, restingWidth)
  }

  // ── Draw nodes (z-ordered by proximity) ──
  for (const node of nodeDrawOrder) {
    const et = nodeEmergenceT(node, tree, now)
    if (et < 0.01) continue

    const depthT = nodeDepthT(node, tree)
    const d = (1 - depthT) * 2

    const baseBrightness = Math.max(0.7, depthLerp(DEPTH_BRIGHTNESS, d)) + current * 0.06
      + node.proximity * TREE_HOVER_BRIGHTNESS_BOOST
    // Gentle spotlight: focused node stays full, distant nodes soften slightly
    const spotlightDim = spotlightActive
      ? lerp(1, 0.45 + 0.55 * node.proximity, spotlightStrength)
      : 1
    const baseAlpha = (Math.max(0.55, depthLerp(DEPTH_ALPHA, d)) + node.proximity * TREE_HOVER_ALPHA_BOOST)
      * transition * spotlightDim

    const baseColor = FAMILY_COLOR[node.family] ?? DEFAULT_COLOR
    const dc = depthColor(baseColor, d)
    _nodeDc[0] = dc[0]; _nodeDc[1] = dc[1]; _nodeDc[2] = dc[2]

    if (!node.prepared) continue

    // Render-time path positions (layout + breath offset + emergence rise)
    const breathOffsetX = node.renderX - node.treeX
    const breathOffsetY = node.renderY - node.treeY
    const emergenceRise = (1 - et) * 12
    const rStartX = node.pathStartX + breathOffsetX
    const rEndX = node.pathEndX + breathOffsetX
    const rStartY = node.pathStartY + breathOffsetY + emergenceRise
    const rEndY = node.pathEndY + breathOffsetY + emergenceRise

    // Parent endpoint for lean computation
    const parentNode = (node.parentId ? tree.nodes.get(node.parentId) : null) ?? null
    let parentEndX: number | null = null
    if (parentNode) {
      parentEndX = parentNode.pathEndX + (parentNode.renderX - parentNode.treeX)
    }
    const blendedBreathSeed = lerp(seedBreathSeed, node.breathSeed, 0.3 + depthT * 0.7)

    // Per-line rendering — path-based loop with dive lens + variable density
    let cursor = { segmentIndex: 0, graphemeIndex: 0 }
    let lineY = rStartY
    let totalRenderedH = 0
    let graphemeOffset = 0
    let minRenderedX = Infinity
    let maxRenderedX = -Infinity
    let lastLineDiveT = 0      // dive of the final rendered line — gates the signature below it
    let lastLineCenterX = node.renderX

    while (true) {
      const diveT = node.proximity > 0.01
        ? node.proximity * diveGaussian(lineY, mouseY, diveSigma)
        : 0

      const lineFontScale = lerp(textureScale, diveScale, diveT)
      const lineFontSize = fontSizeForScale(lineFontScale)
      const lineFontRatio = lineFontSize / 15
      const lineLineH = lerp(textureLineH, diveLineH, diveT)

      const lineWidth = lerp(restingWidth, openWidth, diveT)
      const lineLayoutW = lineWidth / lineFontRatio

      const fontStr = `400 ${lineFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
      if (fontStr !== prevFontStr) {
        ctx.font = fontStr
        prevFontStr = fontStr
      }

      const lineStart = { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex }
      const line = layoutNextLine(node.prepared, cursor, lineLayoutW)
      if (!line) break
      cursor = line.end

      const displayWidth = line.width * lineFontRatio

      // Path emergence + variable density (dense center, ghostly edges)
      const pathT = rEndY > rStartY ? (lineY - rStartY) / (rEndY - rStartY) : 0
      const lineEmergenceMod = smoothstep(et * 1.4 - pathT * 0.4)
      const lineAlpha = baseAlpha * lineEmergenceMod

      let lineCenterX = nodePathX(rStartX, rEndX, rStartY, rEndY, lineY, diveT,
        parentEndX, now, depthT, blendedBreathSeed)

      // Clamp dive text within viewport (prevents overflow on narrow screens)
      if (diveT > 0.01) {
        const halfW = displayWidth / 2
        const margin = 8
        if (lineCenterX - halfW < margin) lineCenterX = margin + halfW
        if (lineCenterX + halfW > vw - margin) lineCenterX = vw - margin - halfW
      }

      // Track actual rendered x-extent for accurate hit targets
      const lineLeft = lineCenterX - displayWidth / 2
      const lineRight = lineCenterX + displayWidth / 2
      if (lineLeft < minRenderedX) minRenderedX = lineLeft
      if (lineRight > maxRenderedX) maxRenderedX = lineRight

      graphemeOffset = drawTreeLineSegmented(
        ctx, node, lineStart, line.end, line.text,
        lineCenterX, lineY, displayWidth,
        baseBrightness, lineAlpha, node.proximity,
        mouseX, lineFontRatio, _nodeDc, now,
        et * lineEmergenceMod, graphemeOffset,
      )

      lastLineDiveT = diveT
      lastLineCenterX = lineCenterX
      lineY += lineLineH
      totalRenderedH += lineLineH
    }

    // Model signature — attribution under the last line, revealed only when the
    // radial lens swells this node to reading size (Phase 11 F7). Sunset models
    // arrive a beat later, in italic silver. Gated on the last line's dive so it
    // never renders at rest (would become a permanent badge — the failure mode).
    if (node.signature) {
      const gate = node.afterglow ? AFTERGLOW_DIVE_GATE : 0.5
      if (lastLineDiveT > gate) {
        const sigAlpha = (lastLineDiveT - gate) * 2 * baseAlpha * SIGNATURE_ALPHA
        if (sigAlpha > 0.01) {
          const sigFontSize = fontSizeForScale(lerp(textureScale, diveScale, lastLineDiveT) * SIGNATURE_RATIO)
          const fontStr = node.afterglow
            ? `italic 400 ${sigFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
            : `400 ${sigFontSize}px "Cormorant", Georgia, "Noto Serif", "Noto Serif JP", serif`
          if (fontStr !== prevFontStr) { ctx.font = fontStr; prevFontStr = fontStr }
          if (node.afterglow) {
            ctx.fillStyle = `rgba(${AFTERGLOW_SILVER[0]},${AFTERGLOW_SILVER[1]},${AFTERGLOW_SILVER[2]},${sigAlpha})`
          } else {
            const [sr, sg, sb] = signatureGray(_nodeDc, SIGNATURE_GRAY_MIX)
            ctx.fillStyle = `rgba(${sr},${sg},${sb},${sigAlpha})`
          }
          const sigW = ctx.measureText(node.signature).width
          ctx.fillText(node.signature, lastLineCenterX - sigW / 2, lineY)
        }
      }
    }

    // Register hit target — use actual rendered extent (accounts for path curvature)
    const hitCenterX = maxRenderedX > minRenderedX
      ? (minRenderedX + maxRenderedX) / 2
      : node.renderX
    const hitHalfW = maxRenderedX > minRenderedX
      ? Math.max((maxRenderedX - minRenderedX) / 2, 20)
      : 20
    const hitHalfH = Math.max(totalRenderedH / 2, (rEndY - rStartY) / 2, 15)
    const hitCenterY = (rStartY + rEndY) / 2
    loomState.lastFrameHitTargets.push([
      node.voiceId,
      hitCenterX, hitCenterY,
      hitHalfW, hitHalfH,
      hitCenterX, hitCenterY,
      0,
      true,
    ])
  }
}
