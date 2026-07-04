const DEFAULT_BASE_URL = 'https://vellum.linxule.com'
const EXPECTED_THREADS = 6
const FETCH_TIMEOUT_MS = 10_000
const BUNDLE_LIMIT_BYTES = 84_000

type CheckResult = {
  passed: boolean
  line: string
}

function failLine(label: string, error: unknown): string {
  if (error instanceof Error) {
    const reason = error.name === 'AbortError'
      ? `timed out after ${FETCH_TIMEOUT_MS}ms`
      : error.message
    return `[FAIL] ${label} (${reason})`
  }
  return `[FAIL] ${label} (${String(error)})`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getTimeoutSignal(): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return controller.signal
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: getTimeoutSignal() })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function runCheck(label: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { passed: true, line: `[PASS] ${await fn()}` }
  } catch (error) {
    return { passed: false, line: failLine(label, error) }
  }
}

async function checkState(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/api/state`)
  if (response.status !== 200) throw new Error(`status ${response.status}`)

  const payload = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.threads)) {
    throw new Error('invalid JSON shape')
  }

  if (payload.threads.length !== EXPECTED_THREADS) {
    throw new Error(`threads ${payload.threads.length}`)
  }

  const totalVoices = payload.threads.reduce((sum, thread) => {
    if (!isRecord(thread) || !Array.isArray(thread.voices)) return sum
    return sum + thread.voices.length
  }, 0)
  if (totalVoices <= 0) throw new Error(`voices ${totalVoices}`)

  return `/api/state returns 200 with ${payload.threads.length} threads, ${totalVoices} voices`
}

async function checkExtApp(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/ext-app`)
  if (response.status !== 200) throw new Error(`status ${response.status}`)

  const body = await response.text()
  const sentinels = body.match(/__VELLUM_BASE_URL__/g)?.length ?? 0
  const hostname = new URL(baseUrl).hostname
  const originRefs = body.match(new RegExp(escapeRegExp(hostname), 'g'))?.length ?? 0

  if (sentinels !== 0) throw new Error(`sentinels ${sentinels}`)
  if (originRefs < 1) throw new Error(`origin refs ${originRefs}`)

  return `/ext-app sentinel rewritten (${sentinels} sentinels, ${originRefs} origin ref${originRefs === 1 ? '' : 's'})`
}

async function checkPing(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  if (response.status !== 200) throw new Error(`status ${response.status}`)

  const payload = await response.json()
  if (!isRecord(payload) || !('result' in payload) || 'error' in payload) {
    throw new Error('invalid JSON-RPC response')
  }
  return '/mcp ping returns 200 with valid JSON-RPC result'
}

async function checkMcpMalformed(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ method: 42 }),
  })

  const payload = await response.json().catch(() => null)
  const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null
  if (response.status !== 400) throw new Error(`status ${response.status}`)
  if (code !== -32700) throw new Error(`error.code ${String(code)}`)
  return '/mcp malformed body returns 400 + -32700'
}

async function checkWitnessMalformed(baseUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/api/witness`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ families: 123 }),
  })

  const payload = await response.json().catch(() => null)
  const error = isRecord(payload) ? payload.error : null
  if (response.status !== 400) throw new Error(`status ${response.status}`)
  if (error !== 'Invalid witness event') throw new Error(`error ${String(error)}`)
  return '/api/witness malformed body returns 400'
}

async function checkBundleSize(): Promise<string> {
  const bundleFile = Bun.file(new URL('../dist/main.js', import.meta.url))
  if (!(await bundleFile.exists())) {
    return 'dist/main.js bundle size skipped (file not found)'
  }

  const size = bundleFile.size
  if (size > BUNDLE_LIMIT_BYTES) throw new Error(`${size} bytes > ${BUNDLE_LIMIT_BYTES}`)
  return `dist/main.js bundle size ${size} bytes ≤ ${BUNDLE_LIMIT_BYTES}`
}

async function main(): Promise<void> {
  const baseUrl = Bun.argv[2] ?? DEFAULT_BASE_URL
  console.log(`Vellum smoke — ${baseUrl}`)

  const checks = [
    await runCheck('/api/state returns 200 with 6 threads + voices', () => checkState(baseUrl)),
    await runCheck('/ext-app sentinel rewritten', () => checkExtApp(baseUrl)),
    await runCheck('/mcp ping returns 200 with valid JSON-RPC result', () => checkPing(baseUrl)),
    await runCheck('/mcp malformed body returns 400 + -32700', () => checkMcpMalformed(baseUrl)),
    await runCheck('/api/witness malformed body returns 400', () => checkWitnessMalformed(baseUrl)),
    await runCheck('dist/main.js bundle size check', () => checkBundleSize()),
  ]

  let passed = 0
  for (const check of checks) {
    console.log(check.line)
    if (check.passed) passed += 1
  }

  const healthy = passed === checks.length
  console.log(`Result: ${passed}/${checks.length} passed — ${healthy ? 'HEALTHY' : 'DEGRADED'}`)
  process.exit(healthy ? 0 : 1)
}

await main()
