// Daily check that production is the code on origin/main. Run by
// .github/workflows/production-watch.yml after `bun run smoke`.
//
// Why: on 2026-09-30 a deploy from a stale checkout rolled production back and
// nobody noticed for seven weeks. The deploy guard (scripts/deploy.ts) stops that
// happening again by accident; this notices if it happens anyway, and notices
// merged work that was never deployed.
import { SHIPPED_PATHS } from './deploy'

const DEFAULT_BASE_URL = 'https://vellum.linxule.com'
/** How long a merge may sit on main before "not deployed yet" becomes a failure. */
export const GRACE_HOURS = 24

export type WatchFacts = {
  /** X-Vellum-Build from /api/state; null when production did not send one. */
  build: string | null
  /** The build commit exists in this clone (it was pushed to GitHub). */
  known: boolean
  /** origin/main contains the build commit. */
  onMain: boolean
  /** Shipped files that differ between the build and origin/main. */
  changed: string[]
  /** Age in hours of the newest commit on origin/main that touches a shipped path. */
  newestShippedAgeHours: number
}

export function watchVerdict(facts: WatchFacts): { ok: boolean, line: string } {
  if (facts.build === null) {
    return { ok: false, line: 'Production sent no X-Vellum-Build header: it was not deployed with `bun run deploy`.' }
  }
  const short = facts.build.slice(0, 7)
  if (!facts.known) {
    return { ok: false, line: `Production runs ${short}, a commit GitHub does not have.` }
  }
  if (facts.changed.length === 0) {
    return { ok: true, line: `Production runs ${short}; no shipped file differs from origin/main.` }
  }
  const list = `${facts.changed.length} shipped file(s) differ (${facts.changed.slice(0, 5).join(', ')}${facts.changed.length > 5 ? ', …' : ''})`
  if (!facts.onMain) {
    return { ok: false, line: `Production runs ${short}, which is not on origin/main; ${list}.` }
  }
  if (facts.newestShippedAgeHours <= GRACE_HOURS) {
    return { ok: true, line: `Production runs ${short}; ${list}, merged ${facts.newestShippedAgeHours.toFixed(1)}h ago (within ${GRACE_HOURS}h).` }
  }
  return { ok: false, line: `Production runs ${short} and is behind origin/main: ${list}, merged ${Math.round(facts.newestShippedAgeHours)}h ago.` }
}

async function git(...args: string[]): Promise<{ ok: boolean, out: string }> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  return { ok: (await proc.exited) === 0, out: out.trim() }
}

if (import.meta.main) {
  const baseUrl = Bun.argv[2] ?? DEFAULT_BASE_URL
  const response = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(10_000) })
  const header = response.headers.get('x-vellum-build')
  // A commit id only; anything else is not something to hand to git.
  const build = header !== null && /^[0-9a-f]{7,40}$/.test(header) ? header : null
  let known = false
  let onMain = false
  let changed: string[] = []
  let newestShippedAgeHours = 0
  if (build !== null) {
    known = (await git('cat-file', '-e', `${build}^{commit}`)).ok
    if (known) {
      onMain = (await git('merge-base', '--is-ancestor', build, 'origin/main')).ok
      const diff = await git('diff', '--name-only', build, 'origin/main', '--', ...SHIPPED_PATHS)
      changed = diff.out === '' ? [] : diff.out.split('\n')
      const newest = await git('log', '-1', '--format=%ct', 'origin/main', '--', ...SHIPPED_PATHS)
      newestShippedAgeHours = (Date.now() / 1000 - Number(newest.out)) / 3600
    }
  }
  const verdict = watchVerdict({ build, known, onMain, changed, newestShippedAgeHours })
  console.log(`${verdict.ok ? '[PASS]' : '[FAIL]'} ${verdict.line}`)
  process.exit(verdict.ok ? 0 : 1)
}
