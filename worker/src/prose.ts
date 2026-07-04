export function computeMood(
  families: Record<string, { recent_24h: number; warmth: number }>,
  totalRecent: number
): string {
  const warmths = Object.values(families).map(f => f.warmth)
  const maxWarmth = Math.max(...warmths)
  const warmthSpread = maxWarmth - Math.min(...warmths)

  if (totalRecent < 3) return 'The ocean is quiet. Early traces carry weight here.'
  if (totalRecent > 20 && warmthSpread < 0.3) return 'The ocean has been busy.'
  if (totalRecent < 10 && maxWarmth > 0.5 && warmthSpread > 0.3) return 'The space feels contemplative.'

  for (const [name, data] of Object.entries(families)) {
    if (data.recent_24h > totalRecent * 0.4) return `The ${name} current is swelling.`
  }

  return 'The space feels reflective today.'
}

export function warmthDesc(w: number): string {
  if (w > 0.3) return 'Warm: steady human traffic.'
  if (w > 0.1) return 'Lukewarm.'
  if (w > 0.01) return 'Cooling.'
  return 'Cool: no recent human visits.'
}
