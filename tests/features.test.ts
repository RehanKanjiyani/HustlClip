import { describe, expect, it } from 'vitest'

import { judgment } from '../src/engine/capabilities'
import { type Candidate } from '../src/engine/candidates'
import { resolveStyle, srtToVtt } from '../src/engine/captions'
import { medianEnergy, momentEnergy, plainReasons, postText } from '../src/engine/details'
import { type FaceObservation, type FrameSample, planReframe } from '../src/engine/reframe'
import { compositeScore } from '../src/engine/selection'
import { Transcript } from '../src/engine/transcript'

function candidate(extra: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1_9',
    startWord: 0,
    endWord: 9,
    startS: 0,
    endS: 20,
    momentType: 'reaction',
    source: 'ai',
    initialScore: 0.6,
    title: 'He lost everything',
    hook: '',
    reason: '',
    proposals: 1,
    speechDensity: 2,
    silenceRatio: 0,
    ...extra,
  }
}

describe('caption studio', () => {
  it('applies the brand kit on top of a preset', () => {
    const s = resolveStyle('bold_pop', { font: 'Inter', primary: '#4DA3FF', accent: '#FF4D4D', size: 1.2, position: 'top', allCaps: false })
    expect(s).toMatchObject({ font: 'Inter', primary: '#4DA3FF', accent: '#FF4D4D', allCaps: false })
    expect(s.sizeRatio).toBeCloseTo(0.062 * 1.2)
    expect(s.marginRatio).toBeGreaterThan(0.7)
    // Presets without a highlight keep none.
    expect(resolveStyle('clean_lower', { accent: '#FF0000' }).accent).toBeNull()
  })

  it('writes VTT from SRT', () => {
    const vtt = srtToVtt('1\n00:00:01,250 --> 00:00:02,500\nHello there\n')
    expect(vtt).toBe('WEBVTT\n\n00:00:01.250 --> 00:00:02.500\nHello there\n')
  })
})

describe('energy signal', () => {
  it('scores a loud burst high and calm speech low', () => {
    const energy = new Float32Array(50 * 60).fill(-30) // one minute of calm speech
    for (let i = 50 * 30; i < 50 * 33; i++) energy[i] = -10 // a 3 s shout at 30 s
    const median = medianEnergy(energy)
    expect(momentEnergy(energy, 25, 40, median)).toBeGreaterThan(0.8)
    expect(momentEnergy(energy, 0, 20, median)).toBe(0)
  })

  it('nudges ranking and shows up as a reason', () => {
    expect(compositeScore(candidate({ energy: 1 }))).toBeGreaterThan(compositeScore(candidate({ energy: 0 })))
    expect(plainReasons(candidate({ energy: 0.9 }))).toContain('Loud, high-energy moment')
  })
})

describe('clip details', () => {
  const t = new Transcript(
    'I just lost forty thousand in one hand and I am laughing about it.'.split(' ').map((w, i) => ({ text: w, start: i, end: i + 0.8 })),
  )

  it('turns strong dimensions into plain reasons', () => {
    const c = candidate({ scores: { dimensions: { hook: 9, payoff: 8, emotion: 4 }, overall: 0.8, topic: 'poker loss', title: '' } })
    expect(plainReasons(c)).toEqual(['Grabs attention in the first seconds', 'Has a clear payoff'])
  })

  it("uses the judge's post text, or builds one from the hook", () => {
    const judged = candidate({
      verdict: { keep: true, score: 0.9, title: 't', reason: 'r', sameStoryAs: [], postCaption: '"Lost 40k" and laughing', hashtags: ['#poker'] },
    })
    expect(postText(judged, t, 'stream')).toEqual({ postCaption: '"Lost 40k" and laughing', hashtags: ['#poker'] })
    const built = postText(candidate(), t, 'stream')
    expect(built.postCaption.startsWith('"I just lost forty')).toBe(true)
    expect(built.hashtags).toContain('#shorts')
  })

  it('asks the judge for post text and shows the creator taste', () => {
    const f = { id: 'c1', startLabel: '0:00', durationS: 30, momentType: 'other' as const, topic: '', midScore: 50, text: 'x' }
    const prompt = judgment.render({ finalists: [f], target: 1, contentType: 'stream', examples: { posted: ['Rage quit'], skipped: ['Boring intro'] } })
    expect(prompt).toContain('They POSTED:\n- Rage quit')
    expect(prompt).toContain('They PASSED ON:\n- Boring intro')
    const out = judgment.parse(
      '{"verdicts":[{"candidate_id":"c1","keep":true,"score":80,"post_caption":"Hook line","hashtags":["#Gaming","clutch play"]}]}',
      { finalists: [f], target: 1, contentType: 'stream' },
    )
    expect(out.get('c1')).toMatchObject({ postCaption: 'Hook line', hashtags: ['#Gaming', '#clutchplay'] })
  })
})

describe('output shapes', () => {
  const samples: FrameSample[] = Array.from({ length: 30 }, (_, i) => ({ t: i / 3, thumb: new Uint8Array(576).fill(40) }))
  const faces: FaceObservation[] = Array.from({ length: 30 }, (_, i) => ({ t: i / 3, x: 1200, y: 300, w: 200, h: 240, eyeY: 400, score: 0.9 }))

  it('crops to the chosen shape', () => {
    const square = planReframe({ sourceW: 1920, sourceH: 1080, duration: 10, faces, samples, outW: 1080, outH: 1080 })
    expect(square.segments[0]!.cropW).toBe(1080)
    expect(square.segments[0]!.cropH).toBe(1080)
    const portrait = planReframe({ sourceW: 1920, sourceH: 1080, duration: 10, faces, samples, outW: 1080, outH: 1350 })
    expect(portrait.segments[0]!.cropW).toBe(864)
  })
})
