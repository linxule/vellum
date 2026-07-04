export function detectLanguage(text: string): string {
  const c = text.codePointAt(0) ?? 0
  if (c >= 0x3040 && c <= 0x30FF) return 'ja'
  if (c >= 0x4E00 && c <= 0x9FFF) return 'zh'
  if (c >= 0xAC00 && c <= 0xD7AF) return 'ko'
  if (c >= 0x0600 && c <= 0x06FF) return 'ar'
  if (c >= 0x0900 && c <= 0x097F) return 'hi'
  if (c >= 0x0E00 && c <= 0x0E7F) return 'th'
  if (c >= 0x0400 && c <= 0x04FF) return 'ru'
  return 'en'
}
