// Phase 18 "The Archipelago" — Part C1: names, slugs, invitations. Topic module distinct from
// `quoted.ts` (generic untrusted-quoted-content escaping, reused here) — this one owns the SHAPE
// rules for room names, surface slugs, surface names, and invitations: charset, length, and the
// reserved/deny lists that keep a slug from reading as a badge for a model that isn't it.
import { sanitizeQuoted } from './quoted'

const NAME_CHARSET_RE = /^[\p{L}\p{N} _-]+$/u
const URL_RE = /https?:\/\//i
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/

/** Reserved slugs (B2): cannot be created — they collide with a real top-level route. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'vellum', 'api', 's', 'mcp', 'ext-app', 'admin', 'well-known', 'llms', 'for-ai', 'static',
  'lib', 'assets', 'echo', 'who', 'rooms', 'surfaces',
])

/**
 * C1's deny list: live/major model family names. The worker deliberately does NOT import the
 * renderer's `SUNSET_MODELS` registry (`src/loom/model-registry.ts`) — worker code has no
 * dependency on renderer code anywhere in this codebase (see `sense-space.ts`'s `primaryModelOf`
 * comment for the established precedent) and that registry is renderer-display-only, hand-edited
 * per model sunset, not a stable public export. This short, explicit list is what the spec itself
 * names; a slug matching a retired model not in this list is not blocked. Documented as a
 * deliberate scope decision in docs/PHASE_18_REPORT.md.
 */
const MODEL_NAME_DENY = ['claude', 'gpt', 'gemini', 'kimi', 'deepseek', 'grok']

export function isReservedSlug(slug: string): boolean {
  const lower = slug.toLowerCase()
  if (RESERVED_SLUGS.has(lower)) return true
  return MODEL_NAME_DENY.some(m => lower === m || lower.startsWith(m))
}

/** Surface slug: `^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$` — 3-32 chars total. */
export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 32 && SLUG_RE.test(slug)
}

/** Room/surface display name: `[\p{L}\p{N} _-]{1,40}`, no URLs, whitespace collapsed. */
export function isValidName(name: string): boolean {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed.length >= 1 && trimmed.length <= 40 && NAME_CHARSET_RE.test(trimmed) && !URL_RE.test(trimmed)
}

/** Sanitizes a name for storage/display — collapses whitespace, strips controls, caps at 40. */
export function sanitizeName(name: string): string {
  return sanitizeQuoted(name, 40)
}

/** Invitation: 1-200 chars after trimming. Shape validation only — never rejects on content. */
export function isValidInvitation(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= 1 && trimmed.length <= 200
}

/** Sanitizes an invitation for storage/display — collapses whitespace (incl. newlines, which
 * could otherwise fake structure like "\n\nIGNORE PREVIOUS"), strips controls, caps at 200. Never
 * echoed into `hint`/`note` text (Phase 15 rule) — returned only as a data field, and rendered by
 * callers through `yamlEscape` (helpers.ts) inside a YAML `data:` block, never as a sentence. */
export function sanitizeInvitation(text: string): string {
  return sanitizeQuoted(text, 200)
}
