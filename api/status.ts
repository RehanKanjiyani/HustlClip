import { MODELS } from '../shared/models.js'
import { isAuthenticated } from './_lib/auth.js'
import { env, handle, json } from './_lib/http.js'
import { configuredProviders } from './_lib/keys.js'

/**
 * What the app needs to know before showing anything: is the deployment set
 * up, is this browser signed in, and which AI providers have keys. Never
 * reveals a key or anything derived from one.
 */
export const GET = handle(async (request) => {
  const passwordSet = Boolean(env('HUSTLCLIP_PASSWORD'))
  const providers = configuredProviders()
  const signedIn = passwordSet && isAuthenticated(request)
  return json({
    passwordSet,
    signedIn,
    providers: signedIn ? providers : providers.length > 0 ? ['configured'] : [],
    models: signedIn
      ? MODELS.filter((m) => providers.includes(m.provider)).map((m) => ({ id: m.id, label: m.label }))
      : [],
  })
})
