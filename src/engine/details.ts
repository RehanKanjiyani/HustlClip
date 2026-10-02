/**
 * What a creator sees for each clip: a score, a few plain-language reasons,
 * and ready-to-post text. Plus the audio-energy signal used in ranking.
 */

import { type Candidate, contentWords } from './candidates'
import type { Transcript } from './transcript'

const FRAME_S = 0.02

/**
 * Loudness of a moment compared with the whole video, 0..1. Uses the loudest
 * tenth of the moment against the video's median, so a burst of laughter,
 * shouting or hype counts even if the rest of the clip is calm.
 */
export function momentEnergy(energy: Float32Array, startS: number, endS: number, median: number): number {
  const a = Math.max(0, Math.floor(startS / FRAME_S))
  const b = Math.min(energy.length, Math.ceil(endS / FRAME_S))
  if (b - a < 10) return 0
  const values = Array.from(energy.subarray(a, b)).filter((v) => v > -99).sort((x, y) => y - x)
  if (!values.length) return 0
  const top = values.slice(0, Math.max(1, Math.floor(values.length / 10)))
  const loud = top.reduce((s, v) => s + v, 0) / top.length
  // ~6 dB above the median is ordinary speech peaks; ~18 dB is a real burst.
  return Math.max(0, Math.min(1, (loud - median - 6) / 12))
}

export function medianEnergy(energy: Float32Array): number {
  const values = Array.from(energy).filter((v) => v > -99)
  if (!values.length) return -60
  values.sort((x, y) => x - y)
  return values[Math.floor(values.length / 2)]!
}

const DIMENSION_REASONS: Record<string, string> = {
  hook: 'Grabs attention in the first seconds',
  payoff: 'Has a clear payoff',
  retention: 'Holds attention to the end',
  context: 'Makes sense without context',
  completeness: 'A complete thought',
  emotion: 'Emotional',
  curiosity: 'Builds curiosity',
  quotability: 'Has a quotable line',
  surprise: 'Surprising',
  storytelling: 'Tells a story',
  usefulness: 'Useful to viewers',
  opening: 'Starts cleanly',
  ending: 'Ends on a strong line',
}

/** Up to four short, plain-language reasons this clip was picked. */
export function plainReasons(c: Candidate): string[] {
  const reasons: string[] = []
  if (c.energy !== undefined && c.energy >= 0.5) reasons.push('Loud, high-energy moment')
  const dims = c.scores?.dimensions ?? {}
  const strongest = Object.entries(dims)
    .filter(([key, value]) => value >= 7 && DIMENSION_REASONS[key])
    .sort((a, b) => b[1] - a[1])
  for (const [key] of strongest) {
    if (reasons.length >= 4) break
    reasons.push(DIMENSION_REASONS[key]!)
  }
  if (!reasons.length && c.source === 'fallback') reasons.push('Filler: fewer strong moments than requested')
  return reasons
}

/** Ready-to-post text: the judge's, or one built from the hook and the topic. */
export function postText(c: Candidate, transcript: Transcript, contentType: string): { postCaption: string; hashtags: string[] } {
  if (c.verdict?.postCaption) {
    return { postCaption: c.verdict.postCaption, hashtags: c.verdict.hashtags ?? [] }
  }
  const opening = transcript.textBetween(c.startWord, Math.min(c.endWord, c.startWord + 14))
  const hook = c.hook || opening
  const postCaption = `"${hook.replace(/["“”]/g, '').trim()}" ${c.title ? `· ${c.title}` : ''}`.trim().slice(0, 200)
  const words = [...contentWords(`${c.scores?.topic ?? ''} ${c.title}`)].slice(0, 3)
  const base = contentType === 'gaming' || contentType === 'stream' ? ['gaming', 'streamer'] : ['podcast', 'clips']
  const hashtags = [...words, ...base, 'shorts'].map((w) => `#${w.replace(/[^\p{L}\p{N}]/gu, '')}`).filter((h) => h.length > 1)
  return { postCaption, hashtags: [...new Set(hashtags)].slice(0, 6) }
}
