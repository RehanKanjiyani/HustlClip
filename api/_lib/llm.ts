/**
 * Text generation through the providers' HTTP APIs.
 *
 * One call, one model, no retries: fallback and retry policy belong to the
 * browser's AI manager, which sees every model's health across the job. This
 * layer only has to fail fast and classify the failure correctly.
 *
 * NVIDIA calls stream so a model stuck in the free-tier queue is detected by
 * silence (no first byte) instead of waiting out the full timeout.
 */

import type { ModelEntry } from '../../shared/models.js'
import { HttpError } from './http.js'

export interface GenerateRequest {
  system: string
  user: string
  maxTokens: number
  temperature: number | null
}

export interface Generation {
  text: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
}

export type Fetch = typeof fetch

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

export async function generate(
  entry: ModelEntry,
  request: GenerateRequest,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): Promise<Generation> {
  if (entry.provider === 'nvidia') return nvidia(entry, request, apiKey, fetchImpl)
  return anthropic(entry, request, apiKey, fetchImpl)
}

// ---------------------------------------------------------------------------
// NVIDIA (OpenAI-compatible, streamed)
// ---------------------------------------------------------------------------

async function nvidia(entry: ModelEntry, request: GenerateRequest, apiKey: string, fetchImpl: Fetch) {
  const controller = new AbortController()
  const hardTimer = setTimeout(() => controller.abort('timeout'), entry.timeoutS * 1000)
  let idleTimer = setTimeout(() => controller.abort('first-byte'), entry.firstByteTimeoutS * 1000)
  const touch = () => {
    clearTimeout(idleTimer)
    // After the first byte, allow generous gaps (long reasoning bursts).
    idleTimer = setTimeout(() => controller.abort('stalled'), 60_000)
  }

  try {
    const body: Record<string, unknown> = {
      model: entry.apiModel,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_tokens: Math.min(request.maxTokens, entry.maxOutputTokens),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (entry.temperature && request.temperature !== null) body.temperature = request.temperature

    let response: Response
    try {
      response = await fetchImpl(NVIDIA_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw abortError(controller, error)
    }
    if (!response.ok) throw await statusError(response, 'NVIDIA')
    touch()

    let text = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let model = entry.apiModel
    let finish: string | null = null

    try {
      for await (const event of sseEvents(response)) {
        touch()
        if (event === '[DONE]') break
        let chunk: {
          model?: string
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        try {
          chunk = JSON.parse(event)
        } catch {
          continue
        }
        if (chunk.model) model = chunk.model
        const choice = chunk.choices?.[0]
        if (choice?.delta?.content) text += choice.delta.content
        if (choice?.finish_reason) finish = choice.finish_reason
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? null
          outputTokens = chunk.usage.completion_tokens ?? null
        }
      }
    } catch (error) {
      throw abortError(controller, error)
    }

    if (!text.trim()) {
      throw new HttpError(
        502,
        'unavailable',
        finish === 'length'
          ? `${entry.label} used its whole output budget before answering.`
          : `${entry.label} returned an empty answer.`,
      )
    }
    return { text, model, inputTokens, outputTokens }
  } finally {
    clearTimeout(hardTimer)
    clearTimeout(idleTimer)
  }
}

/** Parses a server-sent-events body into `data:` payloads. */
export async function* sseEvents(response: Response): AsyncGenerator<string> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  const rest = buffer.trim()
  if (rest.startsWith('data:')) yield rest.slice(5).trim()
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API)
// ---------------------------------------------------------------------------

async function anthropic(entry: ModelEntry, request: GenerateRequest, apiKey: string, fetchImpl: Fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), entry.timeoutS * 1000)
  try {
    let response: Response
    try {
      response = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        // Current Claude models reject assistant prefill and sampling knobs,
        // so the request is just system + user.
        body: JSON.stringify({
          model: entry.apiModel,
          max_tokens: Math.min(request.maxTokens, entry.maxOutputTokens),
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
        signal: controller.signal,
      })
    } catch (error) {
      throw abortError(controller, error)
    }
    if (!response.ok) throw await statusError(response, 'Anthropic')
    const data = (await response.json()) as {
      model?: string
      stop_reason?: string
      content?: { type: string; text?: string }[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    if (data.stop_reason === 'refusal') {
      throw new HttpError(502, 'bad_request', 'Claude declined this request.')
    }
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (!text.trim()) throw new HttpError(502, 'unavailable', 'Claude returned an empty answer.')
    return {
      text,
      model: data.model ?? entry.apiModel,
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function abortError(controller: AbortController, error: unknown): HttpError {
  if (controller.signal.aborted) {
    const reason = String(controller.signal.reason)
    if (reason === 'first-byte') return new HttpError(504, 'timeout', 'The model is queued and did not start in time.')
    if (reason === 'stalled') return new HttpError(504, 'timeout', 'The model stopped responding mid-answer.')
    return new HttpError(504, 'timeout', 'The model took too long.')
  }
  const message = error instanceof Error ? error.message : String(error)
  return new HttpError(502, 'unavailable', `Could not reach the AI provider: ${message.slice(0, 120)}`)
}

export async function statusError(response: Response, provider: string): Promise<HttpError> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 300)
  } catch {
    // ignore
  }
  const retryAfter = Number(response.headers.get('retry-after')) || undefined
  const status = response.status
  if (status === 401 || status === 403) {
    return new HttpError(502, 'provider_auth', `${provider} rejected the API key.`)
  }
  if (status === 429) return new HttpError(429, 'rate_limit', `${provider} rate limit reached.`, retryAfter ?? 30)
  if (status === 404) return new HttpError(502, 'model_unavailable', `${provider} does not offer this model right now.`)
  if (status === 400 || status === 422) {
    // NVIDIA reports retired or unknown models as a 400 with a message.
    if (/model|not found|does not exist|unknown/i.test(detail)) {
      return new HttpError(502, 'model_unavailable', `${provider} does not offer this model right now.`)
    }
    return new HttpError(502, 'bad_request', `${provider} refused the request.`)
  }
  if (status === 413) return new HttpError(413, 'too_large', 'The request was too large for the model.')
  return new HttpError(503, 'unavailable', `${provider} is temporarily unavailable (${status}).`, retryAfter ?? 15)
}
