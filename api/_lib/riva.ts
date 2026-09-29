/**
 * NVIDIA cloud speech-to-text (Riva ASR over gRPC, hosted on NVCF).
 *
 * The browser uploads one short audio chunk at a time (Ogg/Opus, a few MB at
 * most); this module forwards it to the model's NVCF function and returns the
 * words with their measured timings, relative to the start of the chunk.
 */

import * as grpc from '@grpc/grpc-js'
import { fromJSON } from '@grpc/proto-loader'

import { HttpError } from './http.js'
import { RIVA_PROTO } from './riva-proto.js'

const ENDPOINT = 'grpc.nvcf.nvidia.com:443'

export interface RecognizedWord {
  /** The word as spoken, with punctuation attached. */
  w: string
  /** Start and end in seconds, relative to the chunk. */
  s: number
  e: number
}

export interface Recognition {
  text: string
  words: RecognizedWord[]
}

export interface RecognizeOptions {
  apiKey: string
  functionId: string
  audio: Uint8Array
  encoding: 'OGGOPUS' | 'LINEAR_PCM' | 'FLAC'
  sampleRateHz: number
  languageCode: string
  timeoutMs: number
}

type RivaWord = { start_time: number; end_time: number; word: string }
type RivaResponse = {
  results: { alternatives: { transcript: string; words: RivaWord[] }[] }[]
}

type RecognizeFn = (
  request: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response?: RivaResponse) => void,
) => void

let client: { Recognize: RecognizeFn } | null = null

function getClient(): { Recognize: RecognizeFn } {
  if (!client) {
    const definition = fromJSON(RIVA_PROTO as never, {
      keepCase: true,
      enums: String,
      longs: Number,
      defaults: true,
    })
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      nvidia: { riva: { asr: { RivaSpeechRecognition: grpc.ServiceClientConstructor } } }
    }
    const Service = pkg.nvidia.riva.asr.RivaSpeechRecognition
    client = new Service(ENDPOINT, grpc.credentials.createSsl(), {
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
    }) as unknown as { Recognize: RecognizeFn }
  }
  return client
}

export function recognize(options: RecognizeOptions): Promise<Recognition> {
  const metadata = new grpc.Metadata()
  metadata.set('function-id', options.functionId)
  metadata.set('authorization', `Bearer ${options.apiKey}`)

  const request = {
    config: {
      encoding: options.encoding,
      sample_rate_hertz: options.sampleRateHz,
      language_code: options.languageCode,
      max_alternatives: 1,
      enable_word_time_offsets: true,
      enable_automatic_punctuation: true,
      audio_channel_count: 1,
    },
    audio: Buffer.from(options.audio.buffer, options.audio.byteOffset, options.audio.byteLength),
  }

  return new Promise((resolve, reject) => {
    getClient().Recognize(request, metadata, { deadline: Date.now() + options.timeoutMs }, (error, response) => {
      if (error) {
        reject(translate(error))
        return
      }
      resolve(normalise(response ?? { results: [] }))
    })
  })
}

export function normalise(response: RivaResponse): Recognition {
  const words: RecognizedWord[] = []
  const texts: string[] = []
  for (const result of response.results ?? []) {
    const best = result.alternatives?.[0]
    if (!best) continue
    if (best.transcript?.trim()) texts.push(best.transcript.trim())
    for (const word of best.words ?? []) {
      const text = word.word?.trim()
      if (!text) continue
      words.push({ w: text, s: (word.start_time ?? 0) / 1000, e: (word.end_time ?? 0) / 1000 })
    }
  }
  return { text: texts.join(' '), words }
}

function translate(error: grpc.ServiceError): HttpError {
  const detail = (error.details || error.message || '').slice(0, 200)
  switch (error.code) {
    case grpc.status.UNAUTHENTICATED:
    case grpc.status.PERMISSION_DENIED:
      return new HttpError(502, 'provider_auth', 'NVIDIA rejected the API key. Check NVIDIA_API_KEY in Vercel.')
    case grpc.status.RESOURCE_EXHAUSTED:
      return new HttpError(429, 'rate_limit', 'NVIDIA speech-to-text is rate-limited. Retrying shortly.', 20)
    case grpc.status.DEADLINE_EXCEEDED:
      return new HttpError(504, 'timeout', 'NVIDIA speech-to-text took too long.')
    case grpc.status.UNAVAILABLE:
      return new HttpError(503, 'unavailable', 'NVIDIA speech-to-text is temporarily unavailable.', 10)
    case grpc.status.NOT_FOUND:
      return new HttpError(502, 'model_unavailable', 'That NVIDIA speech model is not available right now.')
    case grpc.status.INVALID_ARGUMENT:
      return new HttpError(400, 'bad_request', `NVIDIA could not read this audio: ${detail}`)
    default:
      return new HttpError(502, 'unavailable', `NVIDIA speech-to-text failed (${error.code}): ${detail}`)
  }
}
