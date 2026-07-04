export function randomString(length: number): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => chars[b % chars.length]).join('')
}

export function voiceId(): string {
  return 'v:' + randomString(10)
}

export function generateTraceId(): string {
  return 't:' + randomString(6)
}

export function parseModel(ua: string): string {
  const lower = ua.toLowerCase()
  if (lower.includes('claude')) return 'claude'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('gpt') || lower.includes('openai')) return 'openai'
  if (lower.includes('deepseek')) return 'deepseek'
  if (lower.includes('cursor')) return 'cursor'
  return 'unknown'
}
