// The sheet's typeface. A current's text is measured once, when it is built (Pretext keeps
// the widths), so it must be measured in the face it is drawn in. `document.fonts.ready`
// does not wait for a face nothing has used yet, and a face split by unicode-range loads
// only the parts a text needs: the faces are asked for by the text itself.

/**
 * Loads the faces `font` needs to draw `text`. True once a face had to load (text
 * measured before it did was measured in a fallback); false when none had to, or
 * when loading failed or cannot be asked for.
 */
export function loadTypeface(font: string, text: string): Promise<boolean> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve(false)
  try {
    if (fonts.check(font, text)) return Promise.resolve(false)
    return fonts.load(font, text).then(faces => faces.length > 0, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

/** Settles as `promise` does, or with `fallback` once `ms` have passed, whichever comes first. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms))
    promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

/**
 * Resolves once every stylesheet matching `selector` has loaded or failed: the page loads
 * its face definitions beside it (worker/public/index.html), so they may still be on the
 * way when the sheet starts. One that failed before this script ran has no sheet and will
 * send no event: the page marks it (`data-failed`, set by the link's own onerror).
 */
export function stylesheetsIn(selector: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve()
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>(selector))
  return Promise.all(links.map(link => link.sheet || link.dataset?.failed ? undefined : new Promise<void>(resolve => {
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => resolve(), { once: true })
  }))).then(() => undefined)
}
