/**
 * The HustlClip password gate.
 *
 * The server holds the owner's API keys, so every endpoint that spends them is
 * locked behind HUSTLCLIP_PASSWORD. Without that variable the app refuses to
 * work at all rather than running open: an unprotected deployment would let
 * anyone who finds the URL burn the owner's NVIDIA quota.
 *
 * A successful login sets an HttpOnly cookie holding an expiry and an HMAC of
 * it. Nothing is stored server-side; changing the password invalidates every
 * session at once.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { HttpError, env } from './http.js'

export const COOKIE = 'hc_session'
const SESSION_DAYS = 30

function secret(): string {
  const password = env('HUSTLCLIP_PASSWORD')
  if (!password) {
    throw new HttpError(
      503,
      'not_configured',
      'HUSTLCLIP_PASSWORD is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.',
    )
  }
  return password
}

function sign(value: string, key: string): string {
  return createHmac('sha256', `hustlclip-session:${key}`).update(value).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function checkPassword(candidate: string): boolean {
  const password = secret()
  // Compare digests so the comparison is constant-time regardless of length.
  const a = createHmac('sha256', 'hustlclip-password').update(candidate).digest('hex')
  const b = createHmac('sha256', 'hustlclip-password').update(password).digest('hex')
  return safeEqual(a, b)
}

export function sessionCookie(now = Date.now()): string {
  const expires = Math.floor(now / 1000) + SESSION_DAYS * 86400
  const value = `${expires}.${sign(String(expires), secret())}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

export function isAuthenticated(request: Request, now = Date.now()): boolean {
  const key = secret()
  const value = readCookie(request, COOKIE)
  if (!value) return false
  const [expires, signature] = value.split('.')
  if (!expires || !signature || !/^\d+$/.test(expires)) return false
  if (Number(expires) * 1000 < now) return false
  return safeEqual(signature, sign(expires, key))
}

/** Throws 401 unless the request carries a valid session. */
export function requireAuth(request: Request): void {
  if (!isAuthenticated(request)) throw new HttpError(401, 'auth', 'Please sign in again.')
}

/** Rejects cross-site requests to state-changing endpoints. */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  if (!origin) return
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw new HttpError(403, 'auth', 'Cross-site request refused.')
  }
  if (host && originHost !== host) throw new HttpError(403, 'auth', 'Cross-site request refused.')
}
