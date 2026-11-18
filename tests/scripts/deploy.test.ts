import { expect, test } from 'bun:test'
import { configDrift, deployMessage, parseJsonc, preflight, type DeployFacts } from '../../scripts/deploy'

const clean: DeployFacts = { fetched: true, dirty: [], behindMain: 0, remoteBranches: ['origin/main'] }

test('a pushed, clean checkout that contains origin/main may deploy', () => {
  expect(preflight(clean)).toEqual([])
  expect(preflight({ ...clean, remoteBranches: ['origin/some-pr-branch'] })).toEqual([])
})

test('the 2026-09-30 deploy is refused: behind main with uncommitted worker code', () => {
  const problems = preflight({
    fetched: true,
    behindMain: 9,
    remoteBranches: ['origin/main'],
    dirty: [' M worker/src/handlers/rest-imprint.ts', '?? worker/src/spam.ts', '?? worker/src/spam-specimens.json'],
  })
  expect(problems.length).toBe(2)
  expect(problems.join('\n')).toContain('worker/src/spam.ts')
  expect(problems.join('\n')).toContain('missing 9 commit(s)')
})

test('an unpushed commit is refused', () => {
  expect(preflight({ ...clean, remoteBranches: [] }).join('\n')).toContain('not on GitHub')
})

test('a failed fetch is refused rather than trusted', () => {
  expect(preflight({ ...clean, fetched: false }).length).toBe(1)
})

test('an iCloud duplicate outside shipped paths is ignored; inside them it blocks', () => {
  expect(preflight({ ...clean, dirty: ['?? "worker/tests/door-mocks 2.ts"'] })).toEqual([])
  expect(preflight({ ...clean, dirty: ['?? "worker/public/index 2.html"'] }).length).toBe(1)
  expect(preflight({ ...clean, dirty: ['?? "worker/src/spam 2.ts"'] }).length).toBe(1)
})

test('any other untracked or modified file blocks', () => {
  expect(preflight({ ...clean, dirty: ['?? docs/NEW.md'] }).length).toBe(1)
  expect(preflight({ ...clean, dirty: [' M CLAUDE.md'] }).length).toBe(1)
})

test('the deploy message names the version and commit', () => {
  expect(deployMessage('0.2.1', 'abc1234', 'fix: a thing')).toBe('0.2.1 abc1234 fix: a thing')
  expect(deployMessage('0.2.1', 'abc1234', 'x'.repeat(200)).length).toBe(100)
})

test('a local config that differs from the tracked example is refused', () => {
  const example = parseJsonc(`{
    // comment with "quotes" and a // inside
    "compatibility_date": "2025-04-01", /* block */
    "vars": { "SPAM_FILTER": "on", "URL": "https://example.com/a", },
  }`)
  expect(example).toEqual({ compatibility_date: '2025-04-01', vars: { SPAM_FILTER: 'on', URL: 'https://example.com/a' } })
  expect(configDrift(example, example)).toEqual([])
  const local = { compatibility_date: '2025-04-01', vars: { SPAM_FILTER: 'off', EXTRA: '1', URL: 'https://example.com/a' }, d1_databases: [{ database_id: 'local-only' }] }
  expect(configDrift(local, example)).toEqual(['vars.EXTRA', 'vars.SPAM_FILTER'])
  expect(preflight({ ...clean, configDrift: ['vars.SPAM_FILTER'] }).join('\n')).toContain('vars.SPAM_FILTER')
  expect(preflight({ ...clean, configDrift: [] })).toEqual([])
})
