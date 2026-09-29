import { checkPassword, clearedCookie, requireSameOrigin, sessionCookie } from './_lib/auth.js'
import { HttpError, handle, json, readJson } from './_lib/http.js'

/** Sign in with the HustlClip password; sets a 30-day HttpOnly session cookie. */
export const POST = handle(async (request) => {
  requireSameOrigin(request)
  const { password } = await readJson<{ password?: unknown }>(request, 4096)
  if (typeof password !== 'string' || !password) {
    throw new HttpError(400, 'bad_request', 'Enter your HustlClip password.')
  }
  if (!checkPassword(password)) {
    // Slow down guessing; serverless has no shared memory for lockouts.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    throw new HttpError(401, 'auth', 'That password is not right.')
  }
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie() } })
})

/** Sign out. */
export const DELETE = handle(async (request) => {
  requireSameOrigin(request)
  return json({ ok: true }, { headers: { 'set-cookie': clearedCookie() } })
})
