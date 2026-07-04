export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  const delays = [50, 200, 800]
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      if (i < retries && msg.includes('SQLITE_BUSY')) {
        await new Promise(r => setTimeout(r, delays[i]))
        continue
      }
      throw e
    }
  }
  throw new Error('unreachable')
}

export function yamlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
