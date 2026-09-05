import { describe, test, expect, afterEach } from 'bun:test'
import { renderRunnerScript } from '../src/discovery'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('F2: the reference runner.sh against a mock server', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  let dir: string | undefined

  afterEach(() => {
    server?.stop(true)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function writeScript(): string {
    dir = mkdtempSync(join(tmpdir(), 'vellum-runner-'))
    const scriptPath = join(dir, 'runner.sh')
    writeFileSync(scriptPath, renderRunnerScript(), { mode: 0o755 })
    return scriptPath
  }

  test('304 -> sleeps X-Vellum-Next-Check seconds, does not touch the cursor file', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/echo/')) {
          return new Response(null, { status: 304, headers: { 'X-Vellum-Next-Check': '1234', ETag: '"a_x:5"' } })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const scriptPath = writeScript()
    const cursorFile = join(dir!, 'cursor')
    writeFileSync(cursorFile, '5')

    const proc = Bun.spawn(['sh', scriptPath], {
      env: { ...process.env, VELLUM_BASE: `http://localhost:${server.port}`, VELLUM_ID: 'a_x', VELLUM_CURSOR_FILE: cursorFile },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited

    expect(stderr).toContain('1234')
    expect(stdout.trim()).toBe('')
    expect(readFileSync(cursorFile, 'utf8').trim()).toBe('5')
  })

  test('200 -> writes the new cursor, prints events as data, never echoes a secret', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/echo/')) {
          return Response.json(
            { id: 'a_x', events: [{ n: 9, kind: 'woven', voice: 'v:a' }], cursor: 9, has_more: false, next_check_after: 3600 },
            { headers: { 'X-Vellum-Next-Check': '3600', ETag: '"a_x:9"' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    })
    const scriptPath = writeScript()
    const cursorFile = join(dir!, 'cursor')
    writeFileSync(cursorFile, '5')

    const secretLike = 'super-secret-value-that-must-never-appear'
    const proc = Bun.spawn(['sh', scriptPath], {
      env: { ...process.env, VELLUM_BASE: `http://localhost:${server.port}`, VELLUM_ID: 'a_x', VELLUM_CURSOR_FILE: cursorFile, X_VELLUM_AGENT: secretLike },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited

    expect(stdout).toContain('"cursor":9')
    expect(existsSync(cursorFile)).toBe(true)
    expect(readFileSync(cursorFile, 'utf8').trim()).toBe('9')
    expect(stdout).not.toContain(secretLike)
    expect(stderr).not.toContain(secretLike)
    expect(renderRunnerScript()).not.toContain('X_VELLUM_AGENT')
  })

  // Post-review fix (item 5): the script used to make two separate requests per check (one for
  // the body, a second thrown-away one purely to read X-Vellum-Next-Check off its headers) — a
  // real race, since the two requests could observe a different server state (a new event
  // arriving between them). Now it's one request, headers captured via `curl -D`.
  test('the rendered script contains exactly one curl invocation', () => {
    const script = renderRunnerScript()
    const curlCount = (script.match(/\bcurl\b/g) ?? []).length
    expect(curlCount).toBe(1)
  })

  test('200 -> exactly one request reaches the server per run', async () => {
    let requestCount = 0
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/echo/')) {
          requestCount++
          return Response.json(
            { id: 'a_x', events: [{ n: 9, kind: 'woven', voice: 'v:a' }], cursor: 9, has_more: false, next_check_after: 3600 },
            { headers: { 'X-Vellum-Next-Check': '3600', ETag: '"a_x:9"' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    })
    const scriptPath = writeScript()
    const cursorFile = join(dir!, 'cursor')
    writeFileSync(cursorFile, '5')

    const proc = Bun.spawn(['sh', scriptPath], {
      env: { ...process.env, VELLUM_BASE: `http://localhost:${server.port}`, VELLUM_ID: 'a_x', VELLUM_CURSOR_FILE: cursorFile },
      stdout: 'pipe', stderr: 'pipe',
    })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited

    expect(requestCount).toBe(1)
  })
})
