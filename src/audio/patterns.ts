// src/audio/patterns.ts
//
// Sound patterns for Vellum — one living tone built from the harmonic series.
// Six families are six partials of a fundamental on C. They fuse naturally.
// Warmth shifts timbre, not melody. Events perturb the drone, not replace it.

export interface PatternParams {
  familyGains: Record<string, number>  // 0-1 per family, from warmth map
}

// Base gains when warmth is zero — each partial has its own floor.
// Laptop speakers reproduce ~150 Hz+, so audible voices (C3, E4, G5)
// carry the sound; sub-bass voices (C1, C2) add depth on better speakers.
const BASE_GAIN: Record<string, number> = {
  silence: 0.10,     // C1 fundamental — sub-bass, felt not heard on laptops
  memory: 0.09,      // C2 octave — low bass, borderline on laptops
  attention: 0.10,   // G2 fifth — just audible on some laptops
  space: 0.14,       // C3 two octaves — lowest reliably audible voice
  light: 0.11,       // E4 major third — clearly audible, crystalline
  ephemeral: 0.07,   // G5 high partial — shimmer, clearly audible
}

function familyGain(family: string, params: PatternParams, baseOverride?: number): string {
  const base = baseOverride ?? (BASE_GAIN[family] ?? 0.02)
  const warmth = params.familyGains[family] ?? 0
  return (base + warmth * base * 0.4).toFixed(4)
}

// The six drone voices that form the harmonic ocean.
// Used by base, weave (with bell added), emergence (with wider filters).
function droneVoices(params: PatternParams): string {
  const s = familyGain('silence', params)
  const m = familyGain('memory', params)
  const a = familyGain('attention', params)
  const sp = familyGain('space', params)
  const l = familyGain('light', params)
  const e = familyGain('ephemeral', params)

  return [
    `  note("c1").s("sine").gain(sine.range(${(parseFloat(s) * 0.8).toFixed(4)}, ${s}).slow(32)).lpf(perlin.range(60, 180).slow(24)).attack(2).release(4).room(0.9).roomsize(9)`,
    `  note("c2").s("sine").fm(0.3).fmh(1).gain(${m}).lpf(perlin.range(150, 500).slow(22)).attack(1.5).release(3).room(0.85).roomsize(8)`,
    `  note("g2").s("sawtooth").gain(${a}).lpf(perlin.range(200, 700).slow(20)).attack(1.5).release(3).room(0.8).roomsize(7).chorus(0.3)`,
    `  note("c3").s("triangle").gain(${sp}).lpf(perlin.range(300, 1200).slow(18)).attack(1).release(3).room(0.85).roomsize(8).pan(perlin.range(0.35, 0.65).slow(15))`,
    `  note("e4").s("sine").fm(2).fmh(5.01).fmdecay(1.5).gain(${l}).room(0.9).roomsize(9).delay(0.2).delaytime(0.5).delayfeedback(0.4).degradeBy(0.15).pan(perlin.range(0.2, 0.8).slow(11))`,
    `  note("g5").s("sine").gain(${e}).lpf(perlin.range(1500, 5000).slow(14)).attack(0.5).release(2).room(0.9).roomsize(10).degradeBy(0.25).pan(perlin.range(0.15, 0.85).slow(9))`,
  ].join(',\n')
}

export function basePattern(params: PatternParams): string {
  return `setcps(0.1875)\nstack(\n${droneVoices(params)}\n)`
}

export function weavePattern(params: PatternParams): string {
  // The drone continues. An FM bell rings through it — "struck underwater."
  // Bell has natural 3s release decay; dissolves into the drone.
  const bell = `  note("e5").s("sine").fm(4).fmh(3.5).fmdecay(2).fmenv("exp").gain(0.07).attack(0.005).release(3).room(0.95).roomsize(10).delay(0.35).delaytime(0.375).delayfeedback(0.55).lpf(2500)`
  return `setcps(0.1875)\nstack(\n${droneVoices(params)},\n${bell}\n)`
}

export function emergencePattern(params: PatternParams): string {
  // Same drone, filters opened wider with sine sweeps. What was hidden surfaces.
  const s = familyGain('silence', params, 0.17)
  const m = familyGain('memory', params, 0.065)
  const a = familyGain('attention', params, 0.045)
  const sp = familyGain('space', params, 0.04)
  const l = familyGain('light', params, 0.025)
  const e = familyGain('ephemeral', params, 0.018)

  return `setcps(0.1875)\nstack(\n` + [
    `  note("c1").s("sine").gain(${s}).lpf(perlin.range(100, 350).slow(24)).attack(2).release(4).room(0.9).roomsize(9)`,
    `  note("c2").s("sine").fm(0.3).fmh(1).gain(${m}).lpf(perlin.range(300, 900).slow(18)).attack(1.5).release(3).room(0.85).roomsize(8)`,
    `  note("g2").s("sawtooth").gain(${a}).lpf(sine.range(400, 1400).slow(3)).attack(1.5).release(3).room(0.8).roomsize(7).chorus(0.4)`,
    `  note("c3").s("triangle").gain(${sp}).lpf(sine.range(500, 2200).slow(4)).attack(1).release(3).room(0.85).roomsize(8).pan(perlin.range(0.3, 0.7).slow(15))`,
    `  note("e4").s("sine").fm(2).fmh(5.01).fmdecay(1.5).gain(${l}).room(0.9).roomsize(9).delay(0.25).delaytime(0.5).delayfeedback(0.45).degradeBy(0.1).pan(perlin.range(0.2, 0.8).slow(11))`,
    `  note("g5").s("sine").gain(${e}).lpf(sine.range(2000, 7000).slow(3)).attack(0.5).release(2).room(0.9).roomsize(10).degradeBy(0.15).pan(perlin.range(0.2, 0.8).slow(9))`,
  ].join(',\n') + '\n)'
}

export function loomPattern(params: PatternParams): string {
  // Voices separate in stereo. Structure becomes audible. A pulse breathes underneath.
  const s = familyGain('silence', params)
  const m = familyGain('memory', params, 0.055)
  const a = familyGain('attention', params, 0.04)
  const sp = familyGain('space', params, 0.035)
  const l = familyGain('light', params, 0.02)
  const e = familyGain('ephemeral', params, 0.015)

  return `setcps(0.167)\nstack(\n` + [
    `  note("c1").s("sine").gain(${s}).lpf(perlin.range(60, 200).slow(24)).attack(2).release(4).room(0.9).roomsize(9)`,
    `  note("c2").s("sine").fm(0.3).fmh(1).gain(${m}).lpf(perlin.range(200, 700).slow(22)).attack(1.5).release(3).room(0.85).roomsize(8).pan(0.3).jux(rev)`,
    `  note("g2").s("sawtooth").gain(${a}).lpf(perlin.range(300, 1000).slow(20)).attack(1.5).release(3).room(0.8).roomsize(7).pan(0.7).chorus(0.35)`,
    `  note("c3").s("triangle").gain(${sp}).lpf(perlin.range(400, 1800).slow(18)).attack(1).release(3).room(0.85).roomsize(8).pan(perlin.range(0.15, 0.85).slow(12))`,
    `  note("e4").s("sine").fm(2).fmh(5.01).fmdecay(1.5).gain(${l}).room(0.9).roomsize(9).delay(0.25).delaytime(0.5).delayfeedback(0.45).degradeBy(0.15).pan(perlin.range(0.1, 0.9).slow(8))`,
    `  note("g5").s("sine").gain(${e}).lpf(perlin.range(2000, 6000).slow(14)).attack(0.5).release(2).room(0.9).roomsize(10).degradeBy(0.2).pan(perlin.range(0.1, 0.9).slow(7))`,
    `  note("c1").s("triangle").gain(0.08).lpf(120).attack(2).release(4).room(0.9).roomsize(10).tremolo(0.15).tremolodepth(0.6)`,
  ].join(',\n') + '\n)'
}
