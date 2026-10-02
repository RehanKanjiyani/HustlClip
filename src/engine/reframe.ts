/**
 * Reframing: from face observations in a 16:9 source to a 9:16 layout plan.
 *
 * Pure code, no browser APIs. The media layer samples frames and runs face
 * detection; this module links detections into tracks, splits the clip into
 * shots, picks a layout per shot, and produces smoothed crop keyframes.
 *
 * The quality bar is "never jarring": no jitter, no cut-off faces, and the
 * person talking on screen for essentially all of their speaking time. Every
 * default is biased toward stillness: a locked frame that is slightly off
 * centre beats a frame that is always correct and always moving.
 *
 * Layouts:
 * - crop:  a 9:16 window that follows (or locks on) the subject.
 * - stack: two people, one above the other (podcast two-shot too wide to crop).
 * - split: streamer layout, facecam on top and the game or screen below.
 * - fit:   the whole frame over a blurred fill, when nothing can be cropped.
 */

export interface FaceObservation {
  /** Seconds, relative to the clip start. */
  t: number
  /** Box in source pixels. */
  x: number
  y: number
  w: number
  h: number
  /** Vertical position of the eyes, source pixels. */
  eyeY: number
  score: number
  /** Mouth openness 0..1 when measured (landmarks), else undefined. */
  mouth?: number
}

export interface FrameSample {
  t: number
  /** Small grayscale thumbnail, used for shot-cut detection. */
  thumb: Uint8Array
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CropKeyframe {
  t: number
  x: number
  y: number
}

export type Layout = 'crop' | 'stack' | 'split' | 'fit'

export interface LayoutSegment {
  start: number
  end: number
  layout: Layout
  /** crop: the moving 9:16 window (size fixed, position keyframed). */
  cropW?: number
  cropH?: number
  keyframes?: CropKeyframe[]
  /** stack: the two face regions (top, bottom), each output-half aspect. */
  top?: Rect
  bottom?: Rect
  /** split: facecam region and the main region. */
  cam?: Rect
  main?: Rect
  /** Human-readable reason, for the clip's details. */
  note: string
}

export interface ReframePlan {
  sourceW: number
  sourceH: number
  segments: LayoutSegment[]
}

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

const EYE_LINE = 0.38
const LOCK_IF_FACE_WIDER_THAN = 0.55
const FIT_IF_SPREAD_EXCEEDS = 0.95
const MIN_SEGMENT_S = 1.6
const CUT_THRESHOLD = 0.3
const FACECAM_MAX_WIDTH = 0.16
const FACECAM_MIN_PRESENCE = 0.55
/** Output canvas for split layout: cam gets this share of the height. */
export const SPLIT_CAM_SHARE = 0.4

// ---------------------------------------------------------------------------
// smoothing: One Euro filter + dead zone + velocity clamp
// ---------------------------------------------------------------------------

export interface SmoothingConfig {
  minCutoff: number
  beta: number
  deadZonePx: number
  maxVelocityPxS: number
}

export const DEFAULT_SMOOTHING: SmoothingConfig = { minCutoff: 0.6, beta: 0.02, deadZonePx: 12, maxVelocityPxS: 260 }

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

/** Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012), then dead zone and velocity clamp. */
export function smoothSeries(samples: [number, number][], config: SmoothingConfig = DEFAULT_SMOOTHING): [number, number][] {
  if (samples.length <= 1) return samples.map(([t, v]) => [t, v])
  let value: number | null = null
  let derivative: number | null = null
  let lastT: number | null = null
  let lastRaw = 0
  let held: number | null = null
  let prevT: number | null = null
  const out: [number, number][] = []

  for (const [t, raw] of samples) {
    let filtered: number
    if (lastT === null || t <= lastT || value === null) {
      value = raw
      filtered = raw
    } else {
      const dt = t - lastT
      const d = (raw - lastRaw) / dt
      derivative = derivative === null ? d : alpha(1, dt) * d + (1 - alpha(1, dt)) * derivative
      const cutoff = config.minCutoff + config.beta * Math.abs(derivative)
      const a = alpha(cutoff, dt)
      value = a * raw + (1 - a) * value
      filtered = value
    }
    lastT = t
    lastRaw = raw

    if (held === null) held = filtered
    else if (Math.abs(filtered - held) >= config.deadZonePx) {
      let target = filtered
      if (prevT !== null) {
        const maxStep = config.maxVelocityPxS * Math.max(1e-6, t - prevT)
        const delta = target - held
        if (Math.abs(delta) > maxStep) target = held + Math.sign(delta) * maxStep
      }
      held = target
    }
    out.push([t, held])
    prevT = t
  }
  return out
}

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

export interface FaceTrack {
  id: number
  obs: FaceObservation[]
}

const cx = (o: FaceObservation) => o.x + o.w / 2
const cy = (o: FaceObservation) => o.y + o.h / 2

function iou(a: FaceObservation, b: FaceObservation): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

function matchScore(last: FaceObservation, o: FaceObservation): number {
  const overlap = iou(last, o)
  if (overlap >= 0.25) return 1 + overlap
  const distance = Math.hypot(cx(last) - cx(o), cy(last) - cy(o))
  const tolerance = Math.max(last.w, o.w) * 1.2
  return distance <= tolerance ? 1 - distance / tolerance : 0
}

/** Links per-frame detections into per-person tracks, most prominent first. */
export function buildTracks(observations: FaceObservation[], maxGapS = 0.8, minDurationS = 0.5): FaceTrack[] {
  const byTime = new Map<number, FaceObservation[]>()
  for (const o of observations) {
    const list = byTime.get(o.t) ?? []
    list.push(o)
    byTime.set(o.t, list)
  }
  const tracks: FaceTrack[] = []
  let open: FaceTrack[] = []
  let nextId = 0
  for (const t of [...byTime.keys()].sort((a, b) => a - b)) {
    const frame = byTime.get(t)!
    open = open.filter((track) => t - track.obs.at(-1)!.t <= maxGapS)
    const pairs: [number, FaceTrack, FaceObservation][] = []
    for (const track of open) {
      for (const o of frame) {
        const s = matchScore(track.obs.at(-1)!, o)
        if (s > 0) pairs.push([s, track, o])
      }
    }
    pairs.sort((a, b) => b[0] - a[0])
    const usedTracks = new Set<number>()
    const usedObs = new Set<FaceObservation>()
    for (const [, track, o] of pairs) {
      if (usedTracks.has(track.id) || usedObs.has(o)) continue
      track.obs.push(o)
      usedTracks.add(track.id)
      usedObs.add(o)
    }
    for (const o of frame) {
      if (usedObs.has(o)) continue
      const track = { id: nextId++, obs: [o] }
      tracks.push(track)
      open.push(track)
    }
  }
  const span = (tr: FaceTrack) => tr.obs.at(-1)!.t - tr.obs[0]!.t
  const area = (tr: FaceTrack) => tr.obs.reduce((s, o) => s + o.w * o.h, 0) / tr.obs.length
  return tracks
    .filter((tr) => span(tr) >= minDurationS || tr.obs.length >= 3)
    .sort((a, b) => area(b) * (span(b) + 0.1) - area(a) * (span(a) + 0.1))
}

function between(track: FaceTrack, start: number, end: number): FaceObservation[] {
  return track.obs.filter((o) => o.t >= start && o.t < end)
}

// ---------------------------------------------------------------------------
// shots
// ---------------------------------------------------------------------------

/** Mean absolute difference between two thumbnails, 0..1. */
export function thumbDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / n / 255
}

/**
 * Cut times between consecutive samples whose picture changes abruptly.
 * The media layer can refine each cut with denser sampling.
 */
export function detectCuts(samples: FrameSample[], threshold = CUT_THRESHOLD): number[] {
  const cuts: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const d = thumbDifference(samples[i - 1]!.thumb, samples[i]!.thumb)
    // Relative to local motion, so a busy game scene doesn't read as cuts.
    const prev = i >= 2 ? thumbDifference(samples[i - 2]!.thumb, samples[i - 1]!.thumb) : 0
    if (d >= threshold && d > prev * 2.5) cuts.push((samples[i - 1]!.t + samples[i]!.t) / 2)
  }
  return cuts
}

export function shotsFromCuts(cuts: number[], duration: number, minShotS = 0.8): [number, number][] {
  const edges = [0, ...cuts.filter((c) => c > 0 && c < duration), duration]
  const shots: [number, number][] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i]!
    const b = edges[i + 1]!
    if (shots.length && b - a < minShotS) shots[shots.length - 1]![1] = b
    else shots.push([a, b])
  }
  return shots
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export function cropSize(sourceW: number, sourceH: number, aspectW = 9, aspectH = 16): [number, number] {
  let h = sourceH
  let w = Math.round((h * aspectW) / aspectH)
  if (w > sourceW) {
    w = sourceW
    h = Math.round((w * aspectH) / aspectW)
  }
  return [w & ~1, h & ~1]
}

function clamp(v: number, lo: number, hi: number): number {
  return hi > lo ? Math.max(lo, Math.min(v, hi)) : Math.max(0, lo)
}

export interface PlanInput {
  sourceW: number
  sourceH: number
  duration: number
  faces: FaceObservation[]
  samples: FrameSample[]
  /** Cut times already refined by the media layer; else detected from samples. */
  cuts?: number[]
  /** Streams/gaming: allow the facecam split layout. */
  allowSplit?: boolean
  /** Output shape (any units, e.g. 1080x1920); default 9:16. */
  outW?: number
  outH?: number
}

export function planReframe(input: PlanInput): ReframePlan {
  const { sourceW, sourceH, duration } = input
  const outW = input.outW ?? 9
  const outH = input.outH ?? 16
  const ratio = outW / outH
  const [cw, ch] = cropSize(sourceW, sourceH, outW, outH)
  const tracks = buildTracks(input.faces)
  const cuts = input.cuts ?? detectCuts(input.samples)
  const shots = shotsFromCuts(cuts, duration)
  const sampleTimes = input.samples.map((s) => s.t)

  const segments: LayoutSegment[] = []
  for (const [start, end] of shots) {
    segments.push(...planShot(start, end, tracks, sourceW, sourceH, cw, ch, sampleTimes, input.allowSplit ?? false, ratio))
  }
  // Tile the clip exactly: a gap or overlap would desync picture and sound.
  const merged = mergeSegments(segments)
  if (merged.length) {
    merged[0]!.start = 0
    merged[merged.length - 1]!.end = duration
    for (let i = 0; i < merged.length - 1; i++) merged[i]!.end = merged[i + 1]!.start
  }
  return { sourceW, sourceH, segments: merged.length ? merged : [centre(0, duration, sourceW, sourceH, cw, ch, 'No faces found')] }
}

function planShot(
  start: number,
  end: number,
  tracks: FaceTrack[],
  sourceW: number,
  sourceH: number,
  cw: number,
  ch: number,
  sampleTimes: number[],
  allowSplit: boolean,
  ratio: number,
): LayoutSegment[] {
  const samplesInShot = Math.max(1, sampleTimes.filter((t) => t >= start && t < end).length)
  const present = tracks
    .map((track) => ({ track, obs: between(track, start, end) }))
    .filter(({ obs }) => obs.length >= Math.max(2, samplesInShot * 0.25))

  if (!present.length) return [centre(start, end, sourceW, sourceH, cw, ch, 'No face in this shot')]

  // Streamer facecam: one small face parked near an edge, most of the shot.
  if (allowSplit) {
    const cam = present.find(({ obs }) => isFacecam(obs, sourceW, sourceH, samplesInShot))
    if (cam && present.every(({ obs }) => obs === cam.obs || meanWidth(obs) < sourceW * FACECAM_MAX_WIDTH)) {
      return [splitSegment(start, end, cam.obs, sourceW, sourceH, ratio)]
    }
  }

  if (present.length === 1) return [trackSegment(start, end, present[0]!.obs, sourceW, sourceH, cw, ch)]

  // Several people: hold them together if they fit in one crop.
  const all = present.flatMap(({ obs }) => obs)
  const left = Math.min(...all.map((o) => o.x))
  const right = Math.max(...all.map((o) => o.x + o.w))
  if (right - left <= cw * FIT_IF_SPREAD_EXCEEDS) {
    const centreX = (left + right) / 2
    const eye = all.reduce((s, o) => s + o.eyeY, 0) / all.length
    return [
      {
        start,
        end,
        layout: 'crop',
        cropW: cw,
        cropH: ch,
        keyframes: [{ t: start, x: clamp(centreX - cw / 2, 0, sourceW - cw), y: clamp(eye - EYE_LINE * ch, 0, sourceH - ch) }],
        note: `${present.length} people framed together`,
      },
    ]
  }

  // Too far apart. Follow whoever is talking when mouths tell us; else stack two.
  const byActivity = present
    .map(({ track, obs }) => ({ track, obs, activity: mouthActivity(obs) }))
    .sort((a, b) => b.obs.length - a.obs.length)
  const measured = byActivity.filter((p) => p.activity !== null)
  if (measured.length >= 2) {
    const turns = speakerTurns(start, end, measured.map((p) => p.obs))
    if (turns.length) {
      return turns.map(([a, b, index]) => trackSegment(a, b, measured[index]!.obs.filter((o) => o.t >= a && o.t < b), sourceW, sourceH, cw, ch, 'Following the speaker'))
    }
  }
  const [first, second] = byActivity.slice(0, 2).sort((a, b) => meanX(a.obs) - meanX(b.obs))
  return [stackSegment(start, end, first!.obs, second!.obs, sourceW, sourceH, ratio)]
}

function meanWidth(obs: FaceObservation[]): number {
  return obs.reduce((s, o) => s + o.w, 0) / obs.length
}

function meanX(obs: FaceObservation[]): number {
  return obs.reduce((s, o) => s + cx(o), 0) / obs.length
}

function isFacecam(obs: FaceObservation[], sourceW: number, sourceH: number, samplesInShot: number): boolean {
  if (obs.length < samplesInShot * FACECAM_MIN_PRESENCE) return false
  const w = meanWidth(obs)
  if (w > sourceW * FACECAM_MAX_WIDTH) return false
  const x = meanX(obs) / sourceW
  const y = obs.reduce((s, o) => s + cy(o), 0) / obs.length / sourceH
  const nearEdge = x < 0.3 || x > 0.7 || y < 0.3 || y > 0.7
  const still = Math.max(...obs.map((o) => cx(o))) - Math.min(...obs.map((o) => cx(o))) < w * 1.5
  return nearEdge && still
}

function mouthActivity(obs: FaceObservation[]): number | null {
  const values = obs.map((o) => o.mouth).filter((m): m is number => m !== undefined)
  if (values.length < 3) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
}

/**
 * Who is talking when: per ~1 s window, the face whose mouth moves most,
 * then merged with hysteresis so the frame never flips faster than
 * MIN_SEGMENT_S.
 */
export function speakerTurns(start: number, end: number, people: FaceObservation[][]): [number, number, number][] {
  const step = 1
  const raw: number[] = []
  for (let t = start; t < end; t += step) {
    let best = -1
    let bestValue = 0.0005
    people.forEach((obs, index) => {
      const window = obs.filter((o) => o.t >= t - 0.5 && o.t < t + step + 0.5 && o.mouth !== undefined).map((o) => o.mouth!)
      if (window.length < 2) return
      const mean = window.reduce((a, b) => a + b, 0) / window.length
      const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length
      if (variance > bestValue) {
        bestValue = variance
        best = index
      }
    })
    raw.push(best)
  }
  // Fill silent windows with the previous speaker (or the next one at the start).
  let lastKnown = raw.find((v) => v >= 0) ?? -1
  if (lastKnown < 0) return []
  const filled = raw.map((v) => (v >= 0 ? (lastKnown = v) : lastKnown))

  const turns: [number, number, number][] = []
  filled.forEach((speaker, i) => {
    const a = start + i * step
    const b = Math.min(end, a + step)
    const last = turns.at(-1)
    if (last && last[2] === speaker) last[1] = b
    else turns.push([a, b, speaker])
  })
  // Absorb turns that are too short into their neighbour.
  for (let i = 0; i < turns.length; ) {
    const turn = turns[i]!
    if (turns.length > 1 && turn[1] - turn[0] < MIN_SEGMENT_S) {
      if (i > 0) turns[i - 1]![1] = turn[1]
      else turns[i + 1]![0] = turn[0]
      turns.splice(i, 1)
      continue
    }
    i++
  }
  // Merge neighbours that became the same speaker.
  const merged: [number, number, number][] = []
  for (const turn of turns) {
    const last = merged.at(-1)
    if (last && last[2] === turn[2]) last[1] = turn[1]
    else merged.push([...turn])
  }
  return merged
}

function trackSegment(
  start: number,
  end: number,
  obs: FaceObservation[],
  sourceW: number,
  sourceH: number,
  cw: number,
  ch: number,
  note = 'Following the face',
): LayoutSegment {
  if (!obs.length) return centre(start, end, sourceW, sourceH, cw, ch, 'No face in this part')
  const raw = obs.map((o) => [o.t, clamp(cx(o) - cw / 2, 0, sourceW - cw), clamp(o.eyeY - EYE_LINE * ch, 0, sourceH - ch)] as const)
  const spread = Math.max(...raw.map((r) => r[1])) - Math.min(...raw.map((r) => r[1]))
  const lock = meanWidth(obs) > cw * LOCK_IF_FACE_WIDER_THAN || spread < DEFAULT_SMOOTHING.deadZonePx || raw.length < 3
  let keyframes: CropKeyframe[]
  if (lock) {
    keyframes = [{ t: start, x: raw.reduce((s, r) => s + r[1], 0) / raw.length, y: raw.reduce((s, r) => s + r[2], 0) / raw.length }]
  } else {
    const xs = smoothSeries(raw.map((r) => [r[0], r[1]]))
    const ys = smoothSeries(raw.map((r) => [r[0], r[2]]))
    keyframes = xs.map(([t, x], i) => ({ t, x, y: ys[i]![1] }))
    if (keyframes[0]!.t > start) keyframes.unshift({ ...keyframes[0]!, t: start })
    if (keyframes.at(-1)!.t < end) keyframes.push({ ...keyframes.at(-1)!, t: end })
  }
  return { start, end, layout: 'crop', cropW: cw, cropH: ch, keyframes, note: lock ? `${note} (locked)` : note }
}

function centre(start: number, end: number, sourceW: number, sourceH: number, cw: number, ch: number, note: string): LayoutSegment {
  return {
    start,
    end,
    layout: 'crop',
    cropW: cw,
    cropH: ch,
    keyframes: [{ t: start, x: (sourceW - cw) / 2, y: (sourceH - ch) / 2 }],
    note,
  }
}

/** A region around a face, shaped to `aspect` (w/h), clamped to the frame. */
function faceRegion(obs: FaceObservation[], aspect: number, sourceW: number, sourceH: number, scale: number): Rect {
  const w0 = meanWidth(obs) * scale
  let w = Math.min(sourceW, Math.max(w0, 64))
  let h = w / aspect
  if (h > sourceH) {
    h = sourceH
    w = h * aspect
  }
  const x = clamp(meanX(obs) - w / 2, 0, sourceW - w)
  const eye = obs.reduce((s, o) => s + o.eyeY, 0) / obs.length
  const y = clamp(eye - h * 0.42, 0, sourceH - h)
  return { x, y, w, h }
}

function stackSegment(start: number, end: number, a: FaceObservation[], b: FaceObservation[], sourceW: number, sourceH: number, ratio = 9 / 16): LayoutSegment {
  // Each half of a 1080x1920 canvas is 1080x960: aspect 9:8.
  // Each half of the output: full width, half height.
  const aspect = ratio * 2
  return {
    start,
    end,
    layout: 'stack',
    top: faceRegion(a, aspect, sourceW, sourceH, 3.2),
    bottom: faceRegion(b, aspect, sourceW, sourceH, 3.2),
    note: 'Two people, stacked',
  }
}

function splitSegment(start: number, end: number, cam: FaceObservation[], sourceW: number, sourceH: number, ratio = 9 / 16): LayoutSegment {
  const camAspect = ratio / SPLIT_CAM_SHARE
  const mainAspect = ratio / (1 - SPLIT_CAM_SHARE)
  const camRect = faceRegion(cam, camAspect, sourceW, sourceH, 3.6)
  // Main region: the centre of the frame, as wide as the aspect allows.
  let mw = sourceW
  let mh = mw / mainAspect
  if (mh > sourceH) {
    mh = sourceH
    mw = mh * mainAspect
  }
  return {
    start,
    end,
    layout: 'split',
    cam: camRect,
    main: { x: (sourceW - mw) / 2, y: (sourceH - mh) / 2, w: mw, h: mh },
    note: 'Streamer layout: facecam on top',
  }
}

function mergeSegments(segments: LayoutSegment[]): LayoutSegment[] {
  const out: LayoutSegment[] = []
  for (const seg of segments) {
    if (seg.end - seg.start <= 0.01) continue
    const last = out.at(-1)
    const bothLockedCrops =
      last &&
      last.layout === 'crop' &&
      seg.layout === 'crop' &&
      last.keyframes?.length === 1 &&
      seg.keyframes?.length === 1 &&
      Math.abs(last.keyframes[0]!.x - seg.keyframes[0]!.x) < DEFAULT_SMOOTHING.deadZonePx &&
      Math.abs(last.keyframes[0]!.y - seg.keyframes[0]!.y) < DEFAULT_SMOOTHING.deadZonePx
    if (bothLockedCrops) {
      last.end = seg.end
      continue
    }
    out.push({ ...seg })
  }
  return out
}

/** Crop position at time t within a crop segment (linear between keyframes). */
export function cropAt(segment: LayoutSegment, t: number): { x: number; y: number } {
  const k = segment.keyframes ?? []
  if (!k.length) return { x: 0, y: 0 }
  if (t <= k[0]!.t) return { x: k[0]!.x, y: k[0]!.y }
  for (let i = 1; i < k.length; i++) {
    const b = k[i]!
    if (t <= b.t) {
      const a = k[i - 1]!
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    }
  }
  const last = k.at(-1)!
  return { x: last.x, y: last.y }
}

export function segmentAt(plan: ReframePlan, t: number): LayoutSegment {
  let lo = 0
  let hi = plan.segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (plan.segments[mid]!.start <= t) lo = mid
    else hi = mid - 1
  }
  return plan.segments[lo]!
}

/** A plan that is just a centred crop (no face analysis). */
export function centrePlan(sourceW: number, sourceH: number, duration: number, outW = 9, outH = 16): ReframePlan {
  const [cw, ch] = cropSize(sourceW, sourceH, outW, outH)
  return { sourceW, sourceH, segments: [centre(0, duration, sourceW, sourceH, cw, ch, 'Centre crop')] }
}
