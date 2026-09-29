/**
 * Response helpers and the error vocabulary shared with the browser.
 *
 * Every failure leaves the server as `{ error: { category, message } }` with a
 * status code. The browser's AI manager routes on `category` alone (retry,
 * cool down, fall back, give up), so categories must stay stable.
 */

export type ErrorCategory =
  | 'auth' // wrong or missing HustlClip password
  | 'not_configured' // a required secret is not set on the server
  | 'provider_auth' // the provider rejected the API key
  | 'rate_limit'
  | 'timeout'
  | 'unavailable' // provider outage or queue
  | 'model_unavailable' // unknown / retired model
  | 'bad_request'
  | 'too_large'
  | 'internal'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly category: ErrorCategory,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message)
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {}
    if (error.retryAfterS) headers['retry-after'] = String(Math.ceil(error.retryAfterS))
    return json(
      { error: { category: error.category, message: error.message, retryAfterS: error.retryAfterS ?? null } },
      { status: error.status, headers },
    )
  }
  // Never echo unexpected errors: they can carry request details.
  console.error('Unhandled error', error instanceof Error ? error.name : typeof error)
  return json({ error: { category: 'internal', message: 'Something went wrong on the server.' } }, { status: 500 })
}

/** Wraps a handler so thrown HttpErrors become JSON responses. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await fn(request)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const text = await request.text()
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body is not valid JSON.')
  }
}

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}
