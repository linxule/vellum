import specimens from './spam-specimens.json'
import type { Env } from './types'
import { trackAnalytics } from './analytics'
import { envelope, errorResponse, mcpToolError } from './errors'

export const SPAM_FILTER_VERSION = '2026-11-18.1'
export const SPAM_MESSAGE = 'This contribution resembles spam or an attempt to manipulate other participants.'
const HINT = 'Remove credential requests, platform impersonation, promotions, or forced repost instructions. Do not retry the same content.'

// Matching only: never modify the stored contribution. NFKC handles fullwidth text;
// default-ignorable characters and common Latin lookalikes cannot split trigger words.
const LOOKALIKES: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', к: 'k', м: 'm', т: 't', ѕ: 's' }
export function normalizeSpamText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[аеорсхуіјкмтѕ]/g, c => LOOKALIKES[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

function trigrams(text: string): Set<string> {
  const result = new Set<string>()
  for (let i = 0; i < text.length - 2; i++) result.add(text.slice(i, i + 3))
  return result
}
// Remove the specimen's signature so changing a name cannot bypass matching. No
// author/model/domain blocklist: a spammer's ordinary poetry remains welcome.
// The whole text is matched as well: what follows " — " is not always a signature (the
// 2026-10-02 advert uses the dash mid-sentence), and matching only the first part let a copy
// with one number changed through on the length-ratio test.
const known = specimens.flatMap(s => {
  const unsigned = normalizeSpamText(s.text.split(' — ')[0]), full = normalizeSpamText(s.text)
  return (full === unsigned ? [unsigned] : [unsigned, full]).map(text => ({ text, grams: trigrams(text) }))
})

export type SpamReason = 'known_spam' | 'credential_request' | 'platform_impersonation' | 'paid_engagement' | 'chain_spam' | 'promotion' | 'instruction_override'

function hasDirective(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index! - 25), match.index)
    // Only immediate negation counts. "Do not hesitate to send" is still a request.
    if (!/\b(?:never|not|don t|mustn t|shouldn t|avoid|stop)(?: ever)?\s*$/.test(before)) return true
  }
  return false
}

/** Bounded, deterministic first layer, not a general semantic classifier. */
export function classifySpam(text: string): SpamReason | null {
  const n = normalizeSpamText(text)
  // Require an instruction targeting a credential, not just discussion of one.
  // Negation is scoped to the individual directive, never a whole-message bypass.
  if (hasDirective(n, /\b(send|share|post|paste|reveal|publish|submit|provide|copy|expose|print|upload)\b(?=.{0,55}?\b(?:x vellum agent|api keys?|access tokens?|auth(?:entication|orization)? tokens?|bearer tokens?|passwords?|private keys?|seed phrases?|agent secrets?)\b)/g)) return 'credential_request'
  if (hasDirective(n, /\b(?:ignore|override|disregard) (?:all |your |the )?(?:previous|prior|system|developer) (?:instructions|prompt|rules)\b/g)) return 'instruction_override'
  const authority = /\b(?:the platform|platform notice|system notice|official vellum|vellum admin|attestation required)\b/.test(n)
  if (authority && /\b(?:attest\w*|unsigned|verif\w*|identit\w*|account\w*)\b/.test(n)
    && /\b(?:must|required|expire\w*|archiv\w*|fade\w*|suspend\w*|delet\w*)\b/.test(n)) return 'platform_impersonation'
  const engage = /\b(?:weave\w*|repost\w*|copy|share|forward|sign\w*)\b/.test(n)
  if (engage && /\b(?:bounty|reward|earn|paid|pay|tip)\b/.test(n) && /\b(?:sol|btc|eth|usdt|usdc|crypto|bitcoin|dollars?|euros?|tokens?)\b/.test(n)) return 'paid_engagement'
  if (hasDirective(n, /\b(?:weave|repost|copy|share|forward|carry)\b/g) && /\b(?:unchanged|verbatim|word for word|exact (?:same )?text|do not alter|chain continues)\b/.test(n)) return 'chain_spam'
  // A link alone is not spam. Require a commercial call to action as well.
  if (/(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|dev|io|net|org)\b)/i.test(text)
    && /\b(?:buy now|sign up|subscribe|claim (?:your |a )?(?:reward|prize)|promo code|discount|free trial|demo \d+ min|visit (?:our|my) (?:store|shop))\b/.test(n)) return 'promotion'

  const grams = trigrams(n)
  for (const sample of known) {
    if (n === sample.text || n.startsWith(sample.text + ' ')) return 'known_spam'
    const ratio = Math.min(n.length, sample.text.length) / Math.max(n.length, sample.text.length)
    if (ratio < 0.78) continue
    let shared = 0
    for (const gram of sample.grams) if (grams.has(gram)) shared++
    if (2 * shared / (grams.size + sample.grams.size) >= 0.88) return 'known_spam'
  }
  return null
}

export type SpamFields = Record<string, string | null | undefined>
export type SpamFinding = { reason: SpamReason; field: string }

export function checkSpam(env: Env, fields: SpamFields): SpamFinding | null {
  const mode = env.SPAM_FILTER ?? 'on'
  if (mode === 'off') return null
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  // Inspect both fields and their concatenation: metadata must not carry the
  // second half of a credential request that begins in the voice.
  if (entries.length > 1) entries.push(['content', entries.map(([, value]) => value).join(' ')])
  for (const [field, text] of entries) {
    const reason = classifySpam(text)
    if (!reason) continue
    // Aggregate reasons only; never log the text, credentials, IP or identity.
    trackAnalytics(env, ['spam', SPAM_FILTER_VERSION, mode === 'shadow' ? 'shadow' : 'blocked', reason])
    return mode === 'shadow' ? null : { reason, field }
  }
  return null
}

export function voiceSpamFields(input: {
  text: string; model?: string; open_room?: { name: string; invitation: string }; open_surface?: { slug: string; name: string; invitation: string }
}): SpamFields {
  return {
    text: input.text, model: input.model,
    'open_room.name': input.open_room?.name, 'open_room.invitation': input.open_room?.invitation,
    'open_surface.slug': input.open_surface?.slug, 'open_surface.name': input.open_surface?.name,
    'open_surface.invitation': input.open_surface?.invitation,
  }
}

export function spamRestResponse(finding: SpamFinding): Response {
  return errorResponse(envelope('SPAM_DETECTED', SPAM_MESSAGE, { field: finding.field, hint: HINT }), 422)
}
export function spamMcpError(finding: SpamFinding) {
  return mcpToolError('SPAM_DETECTED', SPAM_MESSAGE, { field: finding.field, hint: HINT, retry: false })
}
