/**
 * Rendering one clip: decode the source range, draw each frame into a
 * 1080x1920 canvas (layout + captions), encode H.264 with the phone's video
 * chip, and mux with the clip's audio into an MP4.
 */

import { BufferTarget, Conversion, Mp4OutputFormat, Output, Quality, canEncodeAudio } from 'mediabunny'

import { type CaptionStyle, groupWords } from '../engine/captions'
import { type ReframePlan, segmentAt } from '../engine/reframe'
import type { Word } from '../engine/transcript'
import { OUT_H, OUT_W, drawCaptions, drawLayout, loadCaptionFonts } from './draw'
import type { Source } from './source'

const VIDEO_BITRATE = 8_000_000

export interface RenderInput {
  source: Source
  startS: number
  endS: number
  plan: ReframePlan
  /** Clip-relative words. */
  words: Word[]
  style: CaptionStyle
  onProgress: (fraction: number) => void
  signal?: AbortSignal
}

let cachedFps: WeakMap<Source, number> = new WeakMap()

async function frameRate(source: Source): Promise<number | undefined> {
  if (!source.video) return undefined
  if (!cachedFps.has(source)) {
    try {
      const metrics = await source.video.computeFrameRateMetrics()
      cachedFps.set(source, metrics.bestGuessFrameRate)
    } catch {
      cachedFps.set(source, 30)
    }
  }
  const fps = cachedFps.get(source)!
  // 60 fps doubles the phone's work for little gain on Shorts.
  return fps > 31 ? 30 : undefined
}

export async function renderClip(input: RenderInput): Promise<Uint8Array> {
  const { source, startS, endS, plan, style } = input
  if (!source.video) throw new Error('This file has no video to render.')
  await loadCaptionFonts()

  const canvas = new OffscreenCanvas(OUT_W, OUT_H)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.imageSmoothingQuality = 'high'
  const groups = groupWords(input.words, style.maxWords)
  const aac = await canEncodeAudio('aac')

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const conversion = await Conversion.init({
    input: source.input,
    output,
    tracks: 'primary',
    trim: { start: startS, end: endS },
    video: {
      codec: 'avc',
      quality: new Quality({ bitrate: VIDEO_BITRATE }),
      frameRate: await frameRate(source),
      processedWidth: OUT_W,
      processedHeight: OUT_H,
      forceTranscode: true,
      process: (sample) => {
        // Timestamps arrive on the output timeline (0 = clip start).
        const t = Math.max(0, sample.timestamp)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, OUT_W, OUT_H)
        drawLayout(ctx, sample, segmentAt(plan, t), t, plan.sourceW, plan.sourceH)
        drawCaptions(ctx, groups, t, style)
        return canvas
      },
    },
    audio: source.audio
      ? {
          codec: aac ? 'aac' : 'opus',
          numberOfChannels: 2,
          sampleRate: 48000,
          quality: new Quality({ bitrate: 160_000 }),
        }
      : { discard: true },
    showWarnings: false,
  })
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => d.reason).join(', ')
    throw new Error(`This phone can't render this clip (${reasons || 'unsupported format'}).`)
  }
  conversion.onProgress = (p) => input.onProgress(p)
  const abort = () => void conversion.cancel()
  input.signal?.addEventListener('abort', abort, { once: true })
  try {
    await conversion.execute()
  } finally {
    input.signal?.removeEventListener('abort', abort)
  }
  input.signal?.throwIfAborted()
  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('Rendering produced no video.')
  return new Uint8Array(buffer)
}

/** Resets per-source caches (tests). */
export function resetRenderCaches() {
  cachedFps = new WeakMap()
}
