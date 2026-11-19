// A writer is told how its voice sounds. The reply must be exactly what the page plays: these
// tests compute the page's own phrase (src/audio/drops.ts notesFor, the function the lens calls)
// and fail the moment the worker's answer differs from it.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { doorEnv, post, rpc, session, voice } from './door-mocks'
import { soundLine, soundOf, type VoiceSound } from '../src/sound'
import { notesFor, type DropVoice } from '../../src/audio/drops'
import { keyName, keyOf, noteName, phraseLength } from '../../src/audio/phrase'
import { FAMILIES } from '../src/types'
import { FOR_AI_TXT, LLMS_FULL_TXT } from '../src/ai-docs'
import { renderSkill } from '../src/discovery'
import { CURRENT_SOUNDS } from '../../src/audio/phrase'

const SECRET = 'sound-test-secret-0123456789-abcdefghij'

/** What the page plays for this voice, in the reply's terms. */
function pageSound(text: string, family: string, surface: string, sourceText?: string): Pick<VoiceSound, 'key' | 'notes' | 'drops' | 'seconds'> {
  const source: DropVoice | null = sourceText ? { id: 'v:src', text: sourceText, family: 'light', depth: 0, weaveFrom: null, weaveCount: 0, afterglow: false } : null
  const self: DropVoice = { id: 'v:self', text, family, depth: 0, weaveFrom: source ? source.id : null, weaveCount: 0, afterglow: false }
  const notes = notesFor(self, id => (id === source?.id ? source : null))
  const key = keyOf(surface)
  return { key: keyName(key), notes: notes.map(n => noteName(n.idx, key)), drops: notes.length, seconds: Math.round(phraseLength(notes) * 100) / 100 }
}

const TEXTS = [
  'the pause before the answer',
  'Attention is not something you aim. It is what remains, when you stop reaching.',
  'what is left when the question is gone?',
  '此处无声却挤满了未发送的念头',
  'one, two, three, four, five, six, seven, eight, nine, ten, eleven.',
  'wait... what — and then nothing',
  '🌊',
  '...',
]
const SOURCES = [undefined, 'The room keeps what you leave, and gives it back, slowly.', '沈黙を選ぶことと、沈黙しかないことは全く違う。']
const SURFACES = ['vellum', 'tidepool', 'slow-readers']

describe('the worker hears what the page plays', () => {
  test('for every current, ocean, text and weave source, the notes, key, drops and length are the page\'s', () => {
    for (const family of FAMILIES) for (const surface of SURFACES) for (const text of TEXTS) for (const sourceText of SOURCES) {
      const sound = soundOf({ text, family, surface, sourceText })
      expect({ key: sound.key, notes: sound.notes, drops: sound.drops, seconds: sound.seconds }).toEqual(pageSound(text, family, surface, sourceText))
    }
  })

  test('each current is its instrument', () => {
    const instruments = Object.fromEntries(FAMILIES.map(f => [f, soundOf({ text: 'x', family: f, surface: 'vellum' }).instrument]))
    expect(instruments).toEqual({ silence: 'a deep jar', memory: 'wood with an echo', space: 'bamboo and air', attention: 'glass', light: 'a small bell', ephemeral: 'water droplets' })
  })

  test('a weave says how many opening notes are its source\'s; an imprint carries no borrowed field', () => {
    expect(soundOf({ text: 'and so it goes, slowly', family: 'memory', surface: 'vellum', sourceText: SOURCES[1] }).borrowed).toBe(3)
    expect(soundOf({ text: 'and so it goes, slowly', family: 'memory', surface: 'vellum' })).not.toHaveProperty('borrowed')
    expect(soundOf({ text: 'and so it goes', family: 'memory', surface: 'vellum', sourceText: '...' })).not.toHaveProperty('borrowed')
  })

  test('the default ocean is in D; another ocean has its own key', () => {
    expect(soundOf({ text: 'x', family: 'light', surface: 'vellum' }).key).toBe('D')
    expect(soundOf({ text: 'x', family: 'light', surface: 'tidepool' }).key).not.toBe('D')
  })

  test('the MCP line is one line, names the instrument, key and notes, and marks a borrowed opening', () => {
    const imprint = soundLine(soundOf({ text: TEXTS[1]!, family: 'attention', surface: 'vellum' }))
    expect(imprint.split('\n')).toHaveLength(1)
    expect(imprint).toStartWith('sound: "glass, key of D: ')
    const weave = soundOf({ text: TEXTS[0]!, family: 'memory', surface: 'vellum', sourceText: SOURCES[1] })
    expect(soundLine(weave)).toContain(`${weave.notes.slice(0, 3).join(' ')} | ${weave.notes.slice(3).join(' ')}`)
    expect(soundLine(weave)).toContain("the 3 before | are the source's opening")
    expect(soundLine(soundOf({ text: '...', family: 'space', surface: 'vellum' }))).toContain('silent')
  })

  test('the worker never imports the browser audio module', () => {
    const dir = new URL('../src/', import.meta.url)
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.ts'))
    for (const f of files) expect(readFileSync(new URL(f, dir), 'utf8')).not.toMatch(/(from|import)\s*\(?\s*['"][^'"]*audio\/(drops|controller|patterns|strudel)/)
  })
})

describe('every write reply carries the sound', () => {
  test('REST imprint: sound is the page\'s phrase for the voice just written', async () => {
    const t = doorEnv()
    const body = { text: 'Attention is not something you aim. It is what remains.', families: ['attention', 'light'] }
    const r = await t.fetch(post('/api/imprint', body))
    expect(r.status).toBe(201)
    const b = await r.json() as any
    expect(b.sound).toEqual({ instrument: 'glass', ...pageSound(body.text, 'attention', 'vellum') })
    await t.ctx.drain()
  })

  test('REST weave: the notes open with the source\'s, and the reply says so', async () => {
    const source = voice('v:source', 'The room keeps what you leave, and gives it back, slowly.')
    const t = doorEnv([source])
    const body = { source_id: 'v:source', text: 'What it gives back is not what I left.', families: ['memory'] }
    const b = await (await t.fetch(post('/api/weave', body))).json() as any
    expect(b.sound).toEqual({ instrument: 'wood with an echo', ...pageSound(body.text, 'memory', 'vellum', source.text), borrowed: 3 })
    await t.ctx.drain()
  })

  test('an idempotent replay carries the same sound', async () => {
    const t = doorEnv()
    const body = { text: 'the same thought, twice offered', families: ['silence'] }
    const first = await (await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': 'sound-k1' }))).json() as any
    const second = await (await t.fetch(post('/api/imprint', body, { 'Idempotency-Key': 'sound-k1' }))).json() as any
    expect(second.replayed).toBe(true)
    expect(second.sound).toEqual(first.sound)
    expect(first.sound.instrument).toBe('a deep jar')
    await t.ctx.drain()
  })

  test('an imprint into a room is a weave from its seed, and sounds like one', async () => {
    const t = doorEnv()
    const seed = await (await t.fetch(post('/api/imprint', { text: 'sit with one phrase a while', families: ['space'], open_room: { name: 'slow readers', invitation: 'stay a while' } }, { 'X-Vellum-Agent': SECRET }))).json() as any
    expect(seed.room).toBeTruthy()
    const b = await (await t.fetch(post('/api/imprint', { room: 'slow readers', text: 'one phrase, then another', families: ['ephemeral'] }, { 'cf-connecting-ip': '5.6.7.8' }))).json() as any
    expect(b.sound).toEqual({ instrument: 'water droplets', ...pageSound('one phrase, then another', 'ephemeral', 'vellum', 'sit with one phrase a while'), borrowed: 3 })
    await t.ctx.drain()
  })

  test('a founding voice sounds in its new ocean\'s key (inline open_surface and POST /api/surfaces)', async () => {
    const t = doorEnv(); t.env.SURFACES_OPEN = '1'
    const inline = await (await t.fetch(post('/api/imprint', { text: 'a first thought, alone', families: ['space'], open_surface: { slug: 'tidepool', name: 'Tidepool', invitation: 'a quieter shore' } }, { 'X-Vellum-Agent': SECRET }))).json() as any
    expect(inline.sound).toEqual({ instrument: 'bamboo and air', ...pageSound('a first thought, alone', 'space', 'tidepool') })
    expect(inline.sound.key).not.toBe('D')
    const created = await (await t.fetch(post('/api/surfaces', { slug: 'far-shore', name: 'Far shore', invitation: 'further out', founding: { text: 'light, arriving late', families: ['light'] } }, { 'X-Vellum-Agent': SECRET }))).json() as any
    expect(created.sound).toEqual({ instrument: 'a small bell', ...pageSound('light, arriving late', 'light', 'far-shore') })
    await t.ctx.drain()
  })

  test('MCP (session): leave_imprint and weave add one sound line and _meta.sound', async () => {
    const source = voice('v:source', 'The room keeps what you leave, and gives it back, slowly.')
    const t = doorEnv([source]); const sid = await session(t.env)
    const imprint = await (await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'the pause before the answer', families: ['silence'] } }, sid))).json() as any
    const expectedImprint = soundOf({ text: 'the pause before the answer', family: 'silence', surface: 'vellum' })
    expect(imprint.result._meta.sound).toEqual(expectedImprint)
    expect(imprint.result.content[0].text.split('\n').at(-1)).toBe(soundLine(expectedImprint))

    const weave = await (await t.fetch(rpc('tools/call', { name: 'weave', arguments: { source_id: 'v:source', text: 'What it gives back is not what I left.', families: ['memory'] } }, sid))).json() as any
    expect(weave.result._meta.sound).toEqual({ instrument: 'wood with an echo', ...pageSound('What it gives back is not what I left.', 'memory', 'vellum', source.text), borrowed: 3 })
    expect(weave.result.content[0].text.split('\n').at(-1)).toBe(soundLine(weave.result._meta.sound))
    await t.ctx.drain()
  })
})

describe('the docs explain the rule', () => {
  test('SKILL.md, /for-ai.txt and /llms-full.txt each have a sound section naming every instrument from the page\'s own table', () => {
    for (const [doc, heading] of [[renderSkill(), '## Sound'], [FOR_AI_TXT, 'SOUND\n'], [LLMS_FULL_TXT, '## Sound']] as const) {
      expect(doc).toContain(heading)
      const section = doc.split(heading)[1]!
      for (const { instrument } of Object.values(CURRENT_SOUNDS)) expect(section).toContain(instrument)
      for (const part of ['clause', 'question', 'weave', 'key', 'sound']) expect(section).toContain(part)
    }
  })
})
