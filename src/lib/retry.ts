import { FatalAIError, TransportError } from '../engine/manager'

const BACKOFF_MS = [3000, 8000, 20000, 40000]

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * Retries a server call on transient failures (rate limit, timeout, outage)
 * with backoff. Sign-in and key problems are fatal at once.
 */
export async function withRetries<T>(
  run: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
  attempts = 5,
): Promise<T> {
  let last: unknown = new Error('The request failed.')
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted()
    try {
      return await run(attempt)
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      if (error.category === 'auth' || error.category === 'not_configured' || error.category === 'provider_auth') {
        throw new FatalAIError(error.message, error.category)
      }
      if (error.category === 'bad_request' || error.category === 'too_large') throw error
      last = error
      const delay = error.retryAfterS ? error.retryAfterS * 1000 : (BACKOFF_MS[attempt] ?? 40000)
      await wait(delay, signal)
    }
  }
  throw last
}
