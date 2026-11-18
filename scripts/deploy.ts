// Guarded production deploy. `bun run deploy` (root or worker/) runs this.
//
// Why: on 2026-09-30 production was deployed from a checkout nine commits
// behind origin/main with uncommitted changes. It silently rolled 0.2.1 back
// to 0.2.0 and ran code that was in no repository for seven weeks. So a deploy
// is refused unless what is on disk is exactly a commit GitHub already has,
// and that commit contains origin/main. Every deploy is labelled with it.
//
// Escape hatch for a real emergency: DEPLOY_FORCE=1 (prints what it skipped).
import { SERVER_VERSION } from '../worker/src/contract'

export type DeployFacts = {
  /** `git status --porcelain` lines, ignored files excluded. */
  dirty: string[]
  /** Commits on origin/main that HEAD does not contain. */
  behindMain: number
  /** Remote branches that contain HEAD. */
  remoteBranches: string[]
  /** False when `git fetch` failed, so the two facts above may be stale. */
  fetched: boolean
}

// iCloud leaves copy-numbered duplicates ("door-mocks 2.ts") beside tracked
// files. Outside the paths that ship they are noise, not a reason to refuse.
const SHIPPED = /^(worker\/(src|public|migrations)\/|src\/|app\/src\/|app\/[^/]+$|AGENTS\.md$|worker\/(package\.json|bun\.lock|tsconfig\.json)$)/
const ICLOUD_DUPLICATE = / \d+(\.[^/.]+)?$/

export function preflight(facts: DeployFacts): string[] {
  const problems: string[] = []
  if (!facts.fetched) problems.push('Could not fetch origin, so this checkout cannot be compared with GitHub.')
  const blocking = facts.dirty.filter(line => {
    const untracked = line.startsWith('??')
    const path = line.slice(3).replace(/^"|"$/g, '')
    if (!untracked) return true
    return SHIPPED.test(path) || !ICLOUD_DUPLICATE.test(path)
  })
  if (blocking.length > 0) {
    problems.push(`Uncommitted changes would ship without being in git:\n${blocking.map(line => `    ${line}`).join('\n')}`)
  }
  if (facts.behindMain > 0) {
    problems.push(`This checkout is missing ${facts.behindMain} commit(s) from origin/main; deploying it would roll production back.`)
  }
  if (facts.remoteBranches.length === 0) {
    problems.push('HEAD is not on GitHub. Push the branch first so production never runs code git does not have.')
  }
  return problems
}

export function deployMessage(version: string, sha: string, subject: string): string {
  // Short enough to read on one line of `wrangler deployments list`.
  return `${version} ${sha} ${subject}`.slice(0, 100)
}

async function git(...args: string[]): Promise<{ ok: boolean, out: string }> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  return { ok: (await proc.exited) === 0, out: out.replace(/\n+$/, '') }
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  const code = await proc.exited
  if (code !== 0) process.exit(code)
}

if (import.meta.main) {
  const root = (await git('rev-parse', '--show-toplevel')).out
  process.chdir(root)
  const fetched = (await git('fetch', '--quiet', 'origin')).ok
  const status = (await git('status', '--porcelain')).out
  const behind = (await git('rev-list', '--count', 'HEAD..origin/main')).out
  const remotes = (await git('branch', '-r', '--contains', 'HEAD')).out
  const problems = preflight({
    fetched,
    dirty: status === '' ? [] : status.split('\n'),
    behindMain: Number(behind) || 0,
    remoteBranches: remotes.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.includes(' -> ')),
  })

  if (problems.length > 0) {
    console.error(`\nDeploy preflight found ${problems.length} problem(s):\n`)
    for (const problem of problems) console.error(`  - ${problem}\n`)
    if (process.env.DEPLOY_FORCE !== '1') {
      console.error('Refusing to deploy. Commit, pull and push, then run it again. (DEPLOY_FORCE=1 overrides.)')
      process.exit(1)
    }
    console.error('DEPLOY_FORCE=1 set: deploying anyway.\n')
  }

  const sha = (await git('rev-parse', '--short', 'HEAD')).out
  const subject = (await git('log', '-1', '--format=%s')).out
  const forced = problems.length > 0 ? ' [forced, tree not clean]' : ''
  const message = deployMessage(SERVER_VERSION, sha, subject + forced)
  const worker = `${root}/worker`
  await run(['bun', 'run', 'predeploy'], worker)
  const extra = process.argv.slice(2)
  const args = extra.some(arg => arg === '--message' || arg.startsWith('--message=')) ? extra : ['--message', message, ...extra]
  console.log(`\nDeploying ${message}\n`)
  await run(['bunx', 'wrangler', 'deploy', ...args], worker)
}
