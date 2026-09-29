import { describe, expect, it } from 'vitest'

import { planCuts } from '../src/media/audio'
import {
  type FaceObservation,
  type FrameSample,
  buildTracks,
  cropAt,
  cropSize,
  detectCuts,
  planReframe,
  smoothSeries,
  speakerTurns,
} from '../src/engine/reframe'

const W = 1920
const H = 1080

function face(t: number, cx: number, w = 200, mouth?: number): FaceObservation {
  return { t, x: cx - w / 2, y: 300, w, h: w * 1.2, eyeY: 400, score: 0.9, mouth }
}

function samples(duration: number, cutAt?: number): FrameSample[] {
  const out: FrameSample[] = []
  for (let t = 0; t < duration; t += 1 / 3) {
    const value = cutAt !== undefined && t >= cutAt ? 220 : 30
    out.push({ t, thumb: new Uint8Array(576).fill(value) })
  }
  return out
}

describe('reframe', () => {
  it('computes a 9:16 crop inside the frame', () => {
    expect(cropSize(W, H)).toEqual([608, 1080])
    expect(cropSize(1080, 1920)).toEqual([1080, 1920])
  })

  it('smooths jitter without drifting', () => {
    const noisy = Array.from({ length: 30 }, (_, i) => [i / 5, 500 + (i % 2 ? 6 : -6)] as [number, number])
    const smooth = smoothSeries(noisy)
    const values = smooth.map(([, v]) => v)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(12)
  })

  it('links detections into one track per person', () => {
    const obs = [0, 0.33, 0.66, 1].flatMap((t) => [face(t, 500), face(t, 1400)])
    expect(buildTracks(obs)).toHaveLength(2)
  })

  it('follows a single speaker with a crop', () => {
    const faces = Array.from({ length: 30 }, (_, i) => face(i / 3, 1300))
    const plan = planReframe({ sourceW: W, sourceH: H, duration: 10, faces, samples: samples(10) })
    expect(plan.segments).toHaveLength(1)
    const seg = plan.segments[0]!
    expect(seg.layout).toBe('crop')
    const { x } = cropAt(seg, 5)
    expect(x + seg.cropW! / 2).toBeGreaterThan(1200)
  })

  it('stacks two people who are too far apart to crop together', () => {
    const faces = Array.from({ length: 30 }, (_, i) => [face(i / 3, 300), face(i / 3, 1600)]).flat()
    const plan = planReframe({ sourceW: W, sourceH: H, duration: 10, faces, samples: samples(10) })
    expect(plan.segments[0]!.layout).toBe('stack')
  })

  it('uses the streamer layout for a small facecam in a corner', () => {
    const faces = Array.from({ length: 30 }, (_, i) => face(i / 3, 1750, 120))
    const plan = planReframe({ sourceW: W, sourceH: H, duration: 10, faces, samples: samples(10), allowSplit: true })
    expect(plan.segments[0]!.layout).toBe('split')
  })

  it('splits shots at a hard cut and tiles the clip exactly', () => {
    const cuts = detectCuts(samples(10, 5))
    expect(cuts).toHaveLength(1)
    const faces = [
      ...Array.from({ length: 15 }, (_, i) => face(i / 3, 400)),
      ...Array.from({ length: 15 }, (_, i) => face(5 + i / 3, 1500)),
    ]
    const plan = planReframe({ sourceW: W, sourceH: H, duration: 10, faces, samples: samples(10, 5) })
    expect(plan.segments.length).toBe(2)
    expect(plan.segments[0]!.start).toBe(0)
    expect(plan.segments.at(-1)!.end).toBe(10)
    expect(plan.segments[0]!.end).toBe(plan.segments[1]!.start)
  })

  it('follows whoever is talking, with no flicker', () => {
    const a: FaceObservation[] = []
    const b: FaceObservation[] = []
    for (let i = 0; i < 60; i++) {
      const t = i / 3
      const aTalks = t < 10
      a.push(face(t, 300, 200, aTalks ? (i % 2) * 0.6 : 0.05))
      b.push(face(t, 1600, 200, aTalks ? 0.05 : (i % 2) * 0.6))
    }
    const turns = speakerTurns(0, 20, [a, b])
    expect(turns.map((t) => t[2])).toEqual([0, 1])
  })
})

describe('audio chunking', () => {
  it('places cuts inside silences near the target', () => {
    const silences = [
      { start: 100, end: 100.5 },
      { start: 470, end: 471 },
      { start: 950, end: 952 },
    ]
    const cuts = planCuts(1400, silences, 480, 45)
    expect(cuts[0]).toBeCloseTo(470.5)
    expect(cuts[1]).toBeCloseTo(951)
  })
})
