/**
 * Speech audio: one decode pass over the whole video, in the browser.
 *
 * The audio track is decoded, mixed to mono, resampled to 16 kHz and encoded
 * as low-bitrate Opus (about 11 MB per hour), which is all speech-to-text
 * needs. While samples stream past, their loudness is measured every 20 ms;
 * that energy curve is where silences, and so clean cut points, come from.
 *
 * Chunks for upload are then cut from this small Opus file by remuxing
 * (copying packets), never by decoding the big video again.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  Input,
  OGG,
  OggOutputFormat,
  Output,
  Quality,
} from 'mediabunny'

import type { Silence } from '../engine/transcript'

export const FRAME_S = 0.02
const SPEECH_RATE = 16000
const BITRATE = 24000

export interface SpeechAudio {
  /** Ogg/Opus, mono, 16 kHz. */
  ogg: Uint8Array
  /** Loudness per 20 ms frame, in dBFS. */
  energy: Float32Array
  duration: number
}

export async function extractSpeechAudio(
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This video has no sound track, so there is nothing to transcribe.')
    if (!(await track.canDecode())) {
      throw new Error("This phone's browser can't decode the video's sound. Try an MP4 (H.264/AAC) file.")
    }
    const duration = await input.computeDuration()
    const frames = Math.ceil(duration / FRAME_S) + 64
    const sumSquares = new Float64Array(frames)
    const counts = new Uint32Array(frames)
    let scratch = new Float32Array(0)

    const output = new Output({ format: new OggOutputFormat({ maximumPageDuration: 1 }), target: new BufferTarget() })
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: {
        numberOfChannels: 1,
        sampleRate: SPEECH_RATE,
        codec: 'opus',
        quality: new Quality({ bitrate: BITRATE }),
        forceTranscode: true,
        process: (sample) => {
          const n = sample.numberOfFrames
          if (scratch.length < n) scratch = new Float32Array(n)
          sample.copyTo(scratch, { planeIndex: 0, format: 'f32-planar' })
          const base = sample.timestamp / FRAME_S
          const perFrame = sample.sampleRate * FRAME_S
          for (let i = 0; i < n; i++) {
            const index = Math.floor(base + i / perFrame)
            if (index < 0 || index >= frames) continue
            const v = scratch[i]!
            sumSquares[index]! += v * v
            counts[index]!++
          }
          return sample
        },
      },
      showWarnings: false,
    })
    if (!conversion.isValid) throw new Error('The sound track of this video cannot be processed.')
    conversion.onProgress = (p) => onProgress(p)
    const abort = () => void conversion.cancel()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await conversion.execute()
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    signal?.throwIfAborted()

    const energy = new Float32Array(Math.ceil(duration / FRAME_S))
    for (let i = 0; i < energy.length; i++) {
      const c = counts[i]!
      energy[i] = c ? 10 * Math.log10(sumSquares[i]! / c + 1e-10) : -100
    }
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('Audio encoding produced no data.')
    return { ogg: new Uint8Array(buffer), energy, duration }
  } finally {
    input.dispose()
  }
}

/**
 * Silences from the energy curve. The threshold adapts to the recording:
 * a few dB above its quiet floor, so background music or game sound doesn't
 * hide every pause, and a studio recording doesn't find silence mid-word.
 */
export function findSilences(energy: Float32Array, minDurationS = 0.25): Silence[] {
  const values = Array.from(energy).filter((v) => v > -99)
  if (!values.length) return []
  values.sort((a, b) => a - b)
  const pct = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))]!
  const floor = pct(0.1)
  const median = pct(0.5)
  const threshold = Math.max(-60, Math.min(floor + 10, median - 8))

  const silences: Silence[] = []
  let runStart = -1
  for (let i = 0; i <= energy.length; i++) {
    const quiet = i < energy.length && energy[i]! < threshold
    if (quiet && runStart < 0) runStart = i
    if (!quiet && runStart >= 0) {
      const start = runStart * FRAME_S
      const end = i * FRAME_S
      if (end - start >= minDurationS) silences.push({ start: round3(start), end: round3(end) })
      runStart = -1
    }
  }
  return silences
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * Cut points roughly every `targetS`, each placed in the longest silence
 * within `searchS` of the target so chunk edges fall between words.
 */
export function planCuts(duration: number, silences: Silence[], targetS: number, searchS: number): number[] {
  const cuts: number[] = []
  let last = 0
  while (duration - last > targetS * 1.25) {
    const target = last + targetS
    let best: Silence | null = null
    for (const s of silences) {
      const mid = (s.start + s.end) / 2
      if (mid < target - searchS || mid > target + searchS || mid <= last + targetS * 0.4) continue
      if (!best || s.end - s.start > best.end - best.start) best = s
    }
    const cut = best ? (best.start + best.end) / 2 : target
    cuts.push(round3(cut))
    last = cut
  }
  return cuts
}

/** Cuts standalone Ogg files out of the speech Ogg by copying packets. */
export class OggSlicer {
  private readonly input: Input

  constructor(ogg: Uint8Array) {
    const exact =
      ogg.byteOffset === 0 && ogg.byteLength === ogg.buffer.byteLength
        ? (ogg.buffer as ArrayBuffer)
        : (ogg.slice().buffer as ArrayBuffer)
    this.input = new Input({ source: new BufferSource(exact), formats: [OGG] })
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    const output = new Output({ format: new OggOutputFormat({ maximumPageDuration: 1 }), target: new BufferTarget() })
    const conversion = await Conversion.init({
      input: this.input,
      output,
      trim: { start: Math.max(0, start), end },
      showWarnings: false,
    })
    await conversion.execute()
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('Could not cut the audio.')
    return new Uint8Array(buffer)
  }

  dispose(): void {
    this.input.dispose()
  }
}
