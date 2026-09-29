import { findModel } from '../shared/models.js'
import { requireAuth, requireSameOrigin } from './_lib/auth.js'
import { HttpError, handle, json, readJson } from './_lib/http.js'
import { modelOverride, requireKey } from './_lib/keys.js'
import { generate } from './_lib/llm.js'

interface ChatBody {
  model?: unknown
  system?: unknown
  user?: unknown
  maxTokens?: unknown
  temperature?: unknown
}

const MAX_PROMPT_CHARS = 400_000

/**
 * One model call. The browser picks the model (from the shared registry) and
 * owns retries and fallback; this endpoint only runs registry models, with
 * the server's key, under the model's timeouts.
 */
export const POST = handle(async (request) => {
  requireSameOrigin(request)
  requireAuth(request)
  const body = await readJson<ChatBody>(request, MAX_PROMPT_CHARS + 10_000)

  const entry = typeof body.model === 'string' ? findModel(body.model) : undefined
  if (!entry) throw new HttpError(400, 'bad_request', 'Unknown model.')
  if (typeof body.system !== 'string' || typeof body.user !== 'string' || !body.user.trim()) {
    throw new HttpError(400, 'bad_request', 'A prompt is required.')
  }
  if (body.system.length + body.user.length > MAX_PROMPT_CHARS) {
    throw new HttpError(413, 'too_large', 'The prompt is too long.')
  }
  const maxTokens =
    typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)
      ? Math.max(256, Math.min(Math.floor(body.maxTokens), entry.maxOutputTokens))
      : entry.maxOutputTokens
  const temperature =
    typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 1.5 ? body.temperature : null

  const key = requireKey(entry.provider)
  const started = Date.now()
  const model = { ...entry, apiModel: modelOverride(entry.provider) ?? entry.apiModel }
  const result = await generate(model, { system: body.system, user: body.user, maxTokens, temperature }, key)
  return json({ ...result, latencyMs: Date.now() - started })
})
