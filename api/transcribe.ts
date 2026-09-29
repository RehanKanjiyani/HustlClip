import { SPEECH_MODELS } from '../shared/models.js'
import { requireAuth, requireSameOrigin } from './_lib/auth.js'
import { HttpError, handle, json } from './_lib/http.js'
import { requireKey } from './_lib/keys.js'
import { type Recognition, recognize } from './_lib/riva.js'

/** Vercel rejects bodies above 4.5 MB; stay safely under it. */
const MAX_BODY = 4_300_000
const MAX_PARTS = 40
const PART_CONCURRENCY = 4

/**
 * Speech-to-text for one upload of audio.
 *
 * The body is one or more Ogg/Opus files back to back; `x-parts` lists their
 * byte lengths. English uploads are a single long part (the model returns
 * word timings). Multilingual uploads are many short parts, because that
 * model returns text only and the part edges are the timing signal.
 *
 * Query: `model` (speech model id), `lang` (BCP-47 code).
 */
export const POST = handle(async (request) => {
  requireSameOrigin(request)
  requireAuth(request)

  const url = new URL(request.url)
  const model = SPEECH_MODELS.find((m) => m.id === url.searchParams.get('model'))
  if (!model) throw new HttpError(400, 'bad_request', 'Unknown speech model.')
  const lang = url.searchParams.get('lang') ?? 'en-US'
  if (!/^[a-z]{2,5}(-[A-Z]{2})?$/.test(lang)) throw new HttpError(400, 'bad_request', 'Invalid language code.')

  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength === 0) throw new HttpError(400, 'bad_request', 'No audio received.')
  if (body.byteLength > MAX_BODY) throw new HttpError(413, 'too_large', 'Audio chunk is too large.')

  const lengths = (request.headers.get('x-parts') ?? String(body.byteLength))
    .split(',')
    .map((n) => Number(n))
  if (
    lengths.length > MAX_PARTS ||
    lengths.some((n) => !Number.isInteger(n) || n <= 0) ||
    lengths.reduce((a, b) => a + b, 0) !== body.byteLength
  ) {
    throw new HttpError(400, 'bad_request', 'x-parts does not match the body.')
  }

  const parts: Uint8Array[] = []
  let offset = 0
  for (const length of lengths) {
    parts.push(body.subarray(offset, offset + length))
    offset += length
  }

  const apiKey = requireKey('nvidia')
  const started = Date.now()
  const results: Recognition[] = new Array(parts.length)
  let next = 0
  const worker = async () => {
    while (next < parts.length) {
      const index = next++
      results[index] = await recognize({
        apiKey,
        functionId: model.functionId,
        audio: parts[index]!,
        encoding: 'OGGOPUS',
        sampleRateHz: 16000,
        languageCode: lang,
        timeoutMs: 240_000,
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker))

  return json({ model: model.id, parts: results, latencyMs: Date.now() - started })
})
