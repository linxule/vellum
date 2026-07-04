export function computeDepth(
  voice: { created_at: number; weave_count: number; unique_weavers: number },
  familyWarmth: number,
  now: number = Date.now()
): number {
  const ageHours = (now - voice.created_at) / 3_600_000

  // Age factor: asymptotic approach to 1.0
  // 1 day: 0.13, 3 days: 0.30, 1 week: 0.50, 2 weeks: 0.67, 1 month: 0.80
  const ageFactor = 1 - 1 / (1 + ageHours / 168)

  // Weave resistance: each weave slows sinking
  // 1 weave: 0.87, 3: 0.69, 7: 0.49, 14: 0.32
  const weaveResist = 1 / (1 + voice.weave_count * 0.15)

  // Warmth resistance: human attention on primary family slows sinking
  // 0.5: 0.96, 2.0: 0.86, 5.0: 0.71
  const warmthResist = 1 / (1 + familyWarmth * 0.08)

  const depth = ageFactor * weaveResist * warmthResist

  // Foundation: 10+ unique weavers = permanent surface
  if (voice.unique_weavers >= 10) return Math.min(depth, 0.1)

  return depth
}
