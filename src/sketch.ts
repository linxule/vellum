// "The drop" sketch: paper ground, ink washes, and the drop instrument.
// Entry-point glue for both the standalone page and the ext-app (which has no
// audio: its notes fall silently and still draw their rings). Off with ?look=old.

import { addRipple, enablePaper, getLoomState, grainTile, loomFrame, loomLineage, loomNodePoint, paintWash, paper, pointOnCurrent, randomCurrent, recolorLoom, setNight, setPaperStock } from './loom.js'
import { getState, surfaceFromPathname } from './content.js'
import { keyOf, setKey } from './audio/phrase.js'
import { onOceanEvent, type OceanEvent } from './events.js'
import { isAfterglow } from './loom/model-registry.js'
import { paintLineageRings, pulseLineageRing } from './loom/render/lineage-rings.js' // lineage rings
import { cancelDrops, configureDrops, dropsOn, dropsReady, initDrops, playVoice, resumeDrops, tickDrops, toggleDrops, type DropVoice } from './audio/drops.js'

const WASH_SCALE = 0.6

export interface Sketch {
  frame(now: number, vw: number, vh: number): void
  toggleSound(): Promise<boolean>
  resume(): void
  /** Turns the sheet to its night or day side, and stops following the system setting. */
  setNight(night: boolean): void
}

/** The paper stock for an ocean: the default keeps the first; another takes one from its key. */
export function stockFor(surface: string, key: number): number | null {
  return surface === 'vellum' ? null : key + 6
}

/** Day or night at start: ?paper=day|night fixes it; otherwise the system setting decides and keeps deciding. */
export function initialSheet(fixed: string | null, systemDark: boolean): { following: boolean, night: boolean } {
  const following = fixed !== 'day' && fixed !== 'night'
  return { following, night: following ? systemDark : fixed === 'night' }
}

export function setupSketch(): Sketch {
  enablePaper()
  const root = document.documentElement
  root.classList.add('paper')
  // Another ocean is another place: its own key and its own paper, both from its slug.
  const surface = surfaceFromPathname(location.pathname)
  const key = keyOf(surface)
  setKey(key)
  setPaperStock(stockFor(surface, key))
  const wash = document.getElementById('w') as HTMLCanvasElement
  const wctx = wash.getContext('2d')!
  const grain = document.getElementById('g')!

  // Day or night: ?paper=day|night fixes it; otherwise the sheet follows the
  // system setting until a host says otherwise (setNight).
  const turn = (night: boolean) => {
    const css = setNight(night)
    root.classList.toggle('night', night)
    root.style.setProperty('--paper', css)
    grain.style.backgroundImage = `url(${grainTile()})`
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', css)
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', night ? 'dark' : 'light')
    // Currents mix their ink when they are built: remix it for the new sheet.
    recolorLoom()
  }
  const fixed = new URLSearchParams(location.search).get('paper')
  const system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const sheet = initialSheet(fixed, system?.matches === true)
  let following = sheet.following
  turn(sheet.night)
  system?.addEventListener('change', e => { if (following) turn(e.matches) })

  // Voice lookup, rebuilt when the projection changes.
  let indexVersion = -2
  const index = new Map<string, DropVoice>()
  const lookup = (id: string): DropVoice | null => {
    const state = getState()
    if (!state) return null
    if (state.version !== indexVersion) {
      index.clear()
      for (const thread of state.threads) {
        for (const v of thread.voices) {
          if (index.has(v.id)) continue
          index.set(v.id, {
            id: v.id,
            text: v.text,
            family: thread.family,
            depth: typeof v.depth === 'number' ? v.depth : 0,
            weaveFrom: v.weave_from,
            weaveCount: v.weave_count,
            afterglow: isAfterglow(v.declared_model),
          })
        }
      }
      indexVersion = state.version
    }
    return index.get(id) ?? null
  }

  configureDrops({
    lookup,
    // lineage rings: a drop on a voice of the open lineage is taken by that voice's ring.
    onDrop: (family, point, strength) => pulseLineageRing(point.x, point.y, strength, performance.now()) || addRipple(family, point.x, point.y, strength, performance.now()),
  })

  const idle = () => {
    const current = randomCurrent()
    const voices = current ? getState()?.threads.find(t => t.family === current.family)?.voices : undefined
    if (!current || !voices || voices.length === 0) return null
    return { id: voices[Math.floor(Math.random() * voices.length)]!.id, point: current.point }
  }

  // A voice's ring falls on the voice when the lens is showing it (an arrival
  // steers the lens there), and otherwise somewhere on its current.
  const voicePoint = (id: string, family: string, along: number) =>
    loomFrame.lensVoiceId === id ? { x: loomFrame.lensVoiceX, y: loomFrame.lensVoiceY } : pointOnCurrent(family, along)

  // Arrivals and weaves from one poll are heard as one passage: for each weave,
  // the source's opening and then the answer; then any other new voice.
  // Passages wait for each other; when too much is already waiting, a new one
  // is seen (its ring) but not heard.
  let pending: OceanEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let passageUntil = 0
  const PASSAGE_BACKLOG_S = 10
  const flush = () => {
    flushTimer = null
    const events = pending
    pending = []
    const answered = new Set<string>()
    const started = performance.now()
    const waiting = Math.max(0, (passageUntil - started) / 1000)
    const heard = waiting < PASSAGE_BACKLOG_S
    let delay = waiting > 0 ? waiting + 0.8 : 0.3
    for (const e of events) {
      if (e.type !== 'weave' || answered.size >= 2 || !heard) continue
      const source = lookup(e.sourceId)
      const target = lookup(e.targetId)
      if (!target) continue
      answered.add(target.id)
      if (source) {
        // The source's own opening, on its own instrument; the answer then takes it up on its own.
        delay += playVoice(source.id, { point: () => voicePoint(source.id, source.family, 0.4), gain: 0.55, first: 3, own: true, delay, group: 'passage' }) + 0.7
      }
      delay += playVoice(target.id, { point: () => voicePoint(target.id, target.family, 0.52), delay, group: 'passage' }) + 1.6
    }
    let arrivals = 0
    for (const e of events) {
      if (e.type !== 'emergence') continue
      for (const id of e.voiceIds) {
        const voice = lookup(id)
        if (!voice || answered.has(id) || arrivals >= 3) continue
        arrivals++
        const at = delay
        setTimeout(() => {
          const p = voicePoint(id, voice.family, 0.5)
          if (p) addRipple(voice.family, p.x, p.y, 1.7, performance.now())
        }, at * 1000)
        if (heard) delay += playVoice(id, { point: () => voicePoint(id, voice.family, 0.5), delay, group: 'passage' }) + 1.4
      }
    }
    if (heard) passageUntil = started + delay * 1000
  }

  // A lineage is heard in order, each voice entering before the last has finished.
  const playLineage = (seedId: string) => {
    const nodes = loomLineage()
    const near = [...nodes].sort((a, b) => Math.abs(a.generationDepth) - Math.abs(b.generationDepth)).slice(0, 6)
    const ordered = nodes.filter(n => near.includes(n))
    let delay = 0.5
    for (const n of ordered) {
      const length = playVoice(n.voiceId, { point: () => loomNodePoint(n.voiceId), gain: n.voiceId === seedId ? 1 : 0.7, delay, group: 'lineage' })
      delay += Math.max(0.9, length * 0.6)
    }
  }

  let lineageTurn = 0
  onOceanEvent((e) => {
    if (e.type === 'weave' || e.type === 'emergence') {
      pending.push(e)
      if (flushTimer === null) flushTimer = setTimeout(flush, 120)
    } else if (e.type === 'loom-enter') {
      // One lineage at a time: a recentre replaces the one playing. The tree is
      // laid out on its first painted frame, so the start waits for it.
      cancelDrops('lineage')
      cancelDrops('lens')
      const turn = ++lineageTurn
      setTimeout(() => { if (turn === lineageTurn) playLineage(e.seedId) }, 250)
    } else if (e.type === 'loom-exit') {
      lineageTurn++
      cancelDrops('lineage')
    }
  })

  let prevW = -1
  let prevH = -1
  let frameNo = 0
  let toggling = false
  return {
    setNight(night) {
      following = false
      if (night !== root.classList.contains('night')) turn(night)
    },
    frame(now, vw, vh) {
      if (vw !== prevW || vh !== prevH) {
        wash.width = Math.round(vw * WASH_SCALE)
        wash.height = Math.round(vh * WASH_SCALE)
        prevW = vw
        prevH = vh
        frameNo = 0
      }
      if (frameNo++ % 2 === 0) {
        paintWash(wctx, WASH_SCALE, now)
        paintLineageRings(wctx, WASH_SCALE, now, paper.night ? 'screen' : 'multiply') // lineage rings: the open lineage, floated on the wash
      }
      tickDrops({
        lens: loomFrame.lensVoiceId ? { id: loomFrame.lensVoiceId, x: loomFrame.lensVoiceX, y: loomFrame.lensVoiceY } : null,
        viewportWidth: vw,
        proximity: getLoomState().proximity,
        idle,
      })
    },
    async toggleSound() {
      // A second tap while the first is still starting the audio is ignored.
      if (toggling) return dropsOn()
      if (dropsReady()) return toggleDrops()
      toggling = true
      try { return await initDrops() } finally { toggling = false }
    },
    resume() { resumeDrops() },
  }
}
