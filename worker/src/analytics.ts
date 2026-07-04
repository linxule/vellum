import type { Env } from './types'

function analyticsDayIndex(): string {
  return new Date().toISOString().slice(0, 10)
}

export function trackAnalytics(
  env: Env,
  blobs: Array<string | null>,
  doubles: number[] = [],
  index = analyticsDayIndex(),
): void {
  try {
    env.ANALYTICS.writeDataPoint({
      blobs,
      doubles,
      indexes: [index],
    })
  } catch (error) {
    console.error('Analytics write failed:', error)
  }
}

export function withHtmlNoCache(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-cache, must-revalidate')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
