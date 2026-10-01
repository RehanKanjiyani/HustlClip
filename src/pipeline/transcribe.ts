/**
 * Speech-to-text through NVIDIA's cloud, chunk by chunk, resumable.
 *
 * English: ~8-minute chunks cut in silences, padded by a second on each side;
 * the model returns word timings and each word is kept by the chunk that owns
 * its midpoint, so nothing is lost or doubled at the seams.
 *
 * Other languages: the multilingual model returns text only, so the audio is
 * cut into ~20-second pieces at silences, sent a dozen at a time, and word
 * timings are estimated inside each piece (see estimateWordTimes).
 */

import { type LanguageChoice, languageCode, speechModelsFor } from '../../shared/models'
import type { Store } from '../engine/funnel'
import { mapPool } from '../engine/pool'
import { type Silence, type Word, estimateWordTimes, tidyWords } from '../engine/transcript'
import { api } from '../lib/api'
import { withRetries } from '../lib/retry'
import { FRAME_S, SpeechCutter, planCuts } from '../media/audio'

const ENGLISH_CHUNK_S = 8 * 60
const ENGLISH_SEARCH_S = 45
const ENGLISH_PAD_S = 1
const PIECE_S = 20
const PIECE_SEARCH_S = 8
const PIECES_PER_UPLOAD = 12
const CONCURRENCY = 3
/** Vercel refuses request bodies over 4.5 MB; stay well under it. */
const MAX_UPLOAD_BYTES = 3_500_000

export interface TranscribeInput {
  /** The original video; speech pieces are cut from it on demand. */
  file: Blob
  energy: Float32Array
  duration: number
  silences: Silence[]
  language: LanguageChoice
  store: Store
  onProgress: (fraction: number, message: string) => void
  signal?: AbortSignal
}

export async function transcribe(input: TranscribeInput): Promise<Word[]> {
  const cached = await input.store.load<Word[]>('transcript')
  if (cached) return cached
  const cutter = new SpeechCutter(input.file)
  try {
    const words = input.language === 'en' ? await english(input, cutter) : await multilingual(input, cutter)
    const tidy = tidyWords(words)
    await input.store.save('transcript', tidy)
    return tidy
  } finally {
    cutter.dispose()
  }
}

async function english(input: TranscribeInput, cutter: SpeechCutter): Promise<Word[]> {
  const [primary, backup] = speechModelsFor('en')
  const cuts = planCuts(input.duration, input.silences, ENGLISH_CHUNK_S, ENGLISH_SEARCH_S)
  const edges = [0, ...cuts, input.duration]
  const chunks = edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1]! }))
  const done = (await input.store.load<Record<number, Word[]>>('asr_chunks')) ?? {}
  let finished = Object.keys(done).length
  input.onProgress(finished / chunks.length, `Listening (${finished}/${chunks.length})`)

  await mapPool(chunks, CONCURRENCY, async (chunk, index) => {
    if (done[index]) return
    if (!hasSpeech(input.energy, chunk.start, chunk.end)) {
      done[index] = []
    } else {
      const from = Math.max(0, chunk.start - ENGLISH_PAD_S)
      const to = Math.min(input.duration, chunk.end + ENGLISH_PAD_S)
      const words = await recognizeRange(cutter, from, to, (audio, attempt) => {
        const model = attempt >= 2 && backup ? backup : primary!
        return api.transcribe([audio], model.id, languageCode('en'), input.signal)
      }, input.signal)
      const isLast = index === chunks.length - 1
      done[index] = words
        .filter((w) => {
          const mid = (w.start + w.end) / 2
          return mid >= chunk.start && (mid < chunk.end || isLast)
        })
    }
    await input.store.save('asr_chunks', done)
    finished++
    input.onProgress(finished / chunks.length, `Listening (${finished}/${chunks.length})`)
  })

  return chunks.flatMap((_, i) => done[i] ?? [])
}

async function multilingual(input: TranscribeInput, cutter: SpeechCutter): Promise<Word[]> {
  const [model] = speechModelsFor(input.language)
  const cuts = planCuts(input.duration, input.silences, PIECE_S, PIECE_SEARCH_S)
  const edges = [0, ...cuts, input.duration]
  const pieces = edges
    .slice(0, -1)
    .map((start, i) => ({ start, end: edges[i + 1]! }))
    .filter((p) => hasSpeech(input.energy, p.start, p.end))
  const uploads: { start: number; end: number }[][] = []
  for (let i = 0; i < pieces.length; i += PIECES_PER_UPLOAD) uploads.push(pieces.slice(i, i + PIECES_PER_UPLOAD))

  const done = (await input.store.load<Record<number, Word[]>>('asr_chunks')) ?? {}
  let finished = Object.keys(done).length
  const total = Math.max(1, uploads.length)
  input.onProgress(finished / total, `Listening (${finished}/${uploads.length})`)

  await mapPool(uploads, CONCURRENCY, async (group, index) => {
    if (done[index]) return
    const audio: Uint8Array[] = []
    for (const piece of group) audio.push(await cutter.cut(piece.start, piece.end))
    const result = await withRetries(
      () => api.transcribe(audio, model!.id, languageCode(input.language), input.signal),
      input.signal,
    )
    done[index] = group.flatMap((piece, i) => {
      const text = cleanWhisperText(result.parts[i]?.text ?? '')
      return text ? estimateWordTimes(text, piece.start, piece.end, input.silences) : []
    })
    await input.store.save('asr_chunks', done)
    finished++
    input.onProgress(finished / total, `Listening (${finished}/${uploads.length})`)
  })

  return uploads.flatMap((_, i) => done[i] ?? [])
}

/**
 * Transcribes [from, to] of the video as one upload, splitting the range in
 * half (at its quietest point) whenever the audio would be too big to send.
 * Returns words with absolute times.
 */
async function recognizeRange(
  cutter: SpeechCutter,
  from: number,
  to: number,
  send: (audio: Uint8Array, attempt: number) => Promise<{ parts: { words: { w: string; s: number; e: number }[] }[] }>,
  signal?: AbortSignal,
): Promise<Word[]> {
  const audio = await cutter.cut(from, to)
  if (audio.byteLength > MAX_UPLOAD_BYTES && to - from > 20) {
    const mid = (from + to) / 2
    const left = await recognizeRange(cutter, from, mid + 0.5, send, signal)
    const right = await recognizeRange(cutter, mid - 0.5, to, send, signal)
    return [...left.filter((w) => (w.start + w.end) / 2 < mid), ...right.filter((w) => (w.start + w.end) / 2 >= mid)]
  }
  const result = await withRetries((attempt) => send(audio, attempt), signal)
  const part = result.parts[0] ?? { words: [] }
  return part.words.map((w) => ({ text: w.w, start: from + w.s, end: from + Math.max(w.s, w.e) }))
}
/** At least ~10% of the span is louder than a quiet room. */
function hasSpeech(energy: Float32Array, start: number, end: number): boolean {
  const a = Math.max(0, Math.floor(start / FRAME_S))
  const b = Math.min(energy.length, Math.ceil(end / FRAME_S))
  if (b <= a) return false
  let loud = 0
  for (let i = a; i < b; i++) if (energy[i]! > -45) loud++
  return loud / (b - a) >= 0.1
}

const STOCK_PHRASES = /^(thank you\.?|thanks for watching[.!]?|subtitles by .*|\[music\]|\(music\))$/i

/** Whisper sometimes emits stock phrases on near-silence; drop the obvious ones. */
function cleanWhisperText(text: string): string {
  const t = text.trim()
  return STOCK_PHRASES.test(t) ? '' : t
}
