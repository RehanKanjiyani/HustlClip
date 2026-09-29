/**
 * Face and shot analysis for one clip, in the browser.
 *
 * Frames are sampled a few times a second at low resolution. MediaPipe's face
 * detector runs on the whole frame and on overlapping tiles, because its
 * short-range model misses faces smaller than ~15% of the image (a streamer's
 * facecam, a wide podcast shot). When two or more people are on screen, the
 * face landmarker measures how open each mouth is, which is how the framing
 * follows whoever is talking.
 */

import { FaceDetector, FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { CanvasSink, type InputVideoTrack } from 'mediabunny'

import type { FaceObservation, FrameSample } from '../engine/reframe'

const SAMPLE_FPS = 3
const ANALYSIS_WIDTH = 640
const THUMB_W = 32
const THUMB_H = 18

let vision: Promise<{ detector: FaceDetector; landmarker: FaceLandmarker | null }> | null = null

async function create<T>(factory: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await factory('GPU')
  } catch {
    return factory('CPU')
  }
}

export function loadVision() {
  vision ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks('/wasm')
    const detector = await create((delegate) =>
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite', delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.55,
      }),
    )
    const landmarker = await create((delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFaceBlendshapes: true,
      }),
    ).catch(() => null)
    return { detector, landmarker }
  })()
  vision.catch(() => (vision = null))
  return vision
}

interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
  eyeY: number
}

function canvas(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(w, h)
}

function detectIn(detector: FaceDetector, image: OffscreenCanvas | HTMLCanvasElement, ox: number, oy: number): Box[] {
  const result = detector.detect(image)
  return result.detections.flatMap((d) => {
    const b = d.boundingBox
    if (!b) return []
    const eyes = d.keypoints.slice(0, 2)
    const eyeY = eyes.length === 2 ? ((eyes[0]!.y + eyes[1]!.y) / 2) * image.height : b.originY + b.height * 0.4
    return [{ x: ox + b.originX, y: oy + b.originY, w: b.width, h: b.height, score: d.categories[0]?.score ?? 0.5, eyeY: oy + eyeY }]
  })
}

function overlap(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h)
}

/** Full frame plus a 3x2 grid of overlapping tiles, merged by suppression. */
function detectTiled(detector: FaceDetector, frame: OffscreenCanvas | HTMLCanvasElement, tile: OffscreenCanvas): Box[] {
  const boxes = detectIn(detector, frame, 0, 0)
  const cols = 3
  const rows = 2
  const tw = Math.round(frame.width / 2.2)
  const th = Math.round(frame.height / 1.6)
  const ctx = tile.getContext('2d')!
  tile.width = tw
  tile.height = th
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round(((frame.width - tw) * c) / (cols - 1))
      const y = Math.round(((frame.height - th) * r) / (rows - 1))
      ctx.drawImage(frame, x, y, tw, th, 0, 0, tw, th)
      boxes.push(...detectIn(detector, tile, x, y))
    }
  }
  boxes.sort((a, b) => b.score - a.score)
  const kept: Box[] = []
  for (const box of boxes) if (!kept.some((k) => overlap(k, box) > 0.5)) kept.push(box)
  return kept
}

function jawOpen(landmarker: FaceLandmarker, frame: OffscreenCanvas | HTMLCanvasElement, box: Box, crop: OffscreenCanvas): number | undefined {
  const size = Math.max(box.w, box.h) * 1.8
  const x = box.x + box.w / 2 - size / 2
  const y = box.y + box.h / 2 - size / 2
  const ctx = crop.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, crop.width, crop.height)
  ctx.drawImage(frame, x, y, size, size, 0, 0, crop.width, crop.height)
  const result = landmarker.detect(crop)
  const shapes = result.faceBlendshapes[0]?.categories
  return shapes?.find((c) => c.categoryName === 'jawOpen')?.score
}

function thumbnail(frame: OffscreenCanvas | HTMLCanvasElement, thumb: OffscreenCanvas): Uint8Array {
  const ctx = thumb.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame, 0, 0, THUMB_W, THUMB_H)
  const data = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data
  const out = new Uint8Array(THUMB_W * THUMB_H)
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4]! * 3 + data[i * 4 + 1]! * 6 + data[i * 4 + 2]!) / 10
  return out
}

export interface ClipAnalysis {
  faces: FaceObservation[]
  samples: FrameSample[]
}

/** Samples [start, end] of the source; times in the result are clip-relative. */
export async function analyseClip(
  track: InputVideoTrack,
  start: number,
  end: number,
  sourceW: number,
  signal?: AbortSignal,
): Promise<ClipAnalysis> {
  const { detector, landmarker } = await loadVision()
  const sink = new CanvasSink(track, { width: ANALYSIS_WIDTH, poolSize: 2 })
  const scale = sourceW / ANALYSIS_WIDTH
  const times: number[] = []
  for (let t = start; t < end; t += 1 / SAMPLE_FPS) times.push(t)

  const tile = canvas(1, 1)
  const crop = canvas(192, 192)
  const thumb = canvas(THUMB_W, THUMB_H)
  const faces: FaceObservation[] = []
  const samples: FrameSample[] = []
  let index = 0
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    signal?.throwIfAborted()
    const t = times[index++]! - start
    if (!wrapped) continue
    const frame = wrapped.canvas as OffscreenCanvas | HTMLCanvasElement
    samples.push({ t, thumb: thumbnail(frame, thumb) })
    const boxes = detectTiled(detector, frame, tile)
    const measureMouths = landmarker && boxes.length >= 2
    for (const box of boxes) {
      faces.push({
        t,
        x: box.x * scale,
        y: box.y * scale,
        w: box.w * scale,
        h: box.h * scale,
        eyeY: box.eyeY * scale,
        score: box.score,
        mouth: measureMouths ? jawOpen(landmarker, frame, box, crop) : undefined,
      })
    }
    // Let the page breathe between frames.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { faces, samples }
}

/**
 * Pinpoints a cut found between two coarse samples by checking frames ~10
 * times a second across the gap. Returns a clip-relative time.
 */
export async function refineCut(track: InputVideoTrack, clipStart: number, approx: number): Promise<number> {
  const sink = new CanvasSink(track, { width: THUMB_W, height: THUMB_H, fit: 'fill', poolSize: 0 })
  const from = clipStart + approx - 0.5 / SAMPLE_FPS - 0.1
  const times: number[] = []
  for (let t = Math.max(clipStart, from); t <= clipStart + approx + 0.5 / SAMPLE_FPS + 0.1; t += 0.1) times.push(t)
  const thumb = canvas(THUMB_W, THUMB_H)
  let prev: Uint8Array | null = null
  let best = approx
  let bestDiff = -1
  let i = 0
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    const t = times[i++]!
    if (!wrapped) continue
    const current = thumbnail(wrapped.canvas as OffscreenCanvas, thumb)
    if (prev) {
      let sum = 0
      for (let k = 0; k < current.length; k++) sum += Math.abs(current[k]! - prev[k]!)
      if (sum > bestDiff) {
        bestDiff = sum
        best = t - 0.05 - clipStart
      }
    }
    prev = current
  }
  return best
}
