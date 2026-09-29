/**
 * Provider keys, read only from the server environment (Vercel → Settings →
 * Environment Variables). They never reach the browser, never appear in a
 * response, and are never logged.
 */

import type { ProviderId } from '../../shared/models.js'
import { HttpError, env } from './http.js'

const KEY_NAMES: Record<ProviderId, string> = {
  nvidia: 'NVIDIA_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
}

export function providerKey(provider: ProviderId): string | undefined {
  return env(KEY_NAMES[provider])
}

export function requireKey(provider: ProviderId): string {
  const key = providerKey(provider)
  if (!key) {
    throw new HttpError(
      503,
      'not_configured',
      `${KEY_NAMES[provider]} is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.`,
    )
  }
  return key
}

export function configuredProviders(): ProviderId[] {
  return (Object.keys(KEY_NAMES) as ProviderId[]).filter((p) => providerKey(p))
}
