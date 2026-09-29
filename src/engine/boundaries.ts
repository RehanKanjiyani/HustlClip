/**
 * Clip boundary refinement.
 *
 * A model proposes a word range. Turning that into a cut that sounds
 * deliberate takes three passes:
 *
 * 1. Sentence snap: move the edges to sentence boundaries, so a clip never
 *    opens or closes mid-thought.
 * 2. Duration clamp: land inside the configured length range, always
 *    stopping on a sentence boundary when one fits.
 * 3. Silence alignment: nudge the cut into a measured audio trough, which a
 *    fixed pad can't do (breaths and pauses vary).
 */

import { type Silence, type Transcript, endsSentence } from './transcript'

const SENTENCE_SEARCH_WORDS = 12
const FALLBACK_LEAD_S = 0.25
const FALLBACK_TAIL_S = 0.35
const SILENCE_SEARCH_RADIUS_S = 0.75
const SILENCE_LEAD_S = 0.12
const SILENCE_TAIL_S = 0.28
const SILENCE_MARGIN_S = 0.04

export interface Boundary {
  startS: number
  endS: number
  startWord: number
  endWord: number
}

export interface Limits {
  minS: number
  maxS: number
}

/** Returns null when the range can't satisfy the limits without butchering it. */
export function refine(
  transcript: Transcript,
  startWord: number,
  endWord: number,
  silences: Silence[],
  limits: Limits,
): Boundary | null {
  if (!transcript.length) return null
  const last = transcript.length - 1
  let start = Math.max(0, Math.min(startWord, last))
  let end = Math.max(start, Math.min(endWord, last))

  start = snapStart(transcript, start)
  end = snapEnd(transcript, end)
  if (end <= start) return null

  const clamped = clampDuration(transcript, start, end, limits)
  if (clamped === null) return null
  end = clamped

  let [startS, endS] = transcript.timeRange(start, end)
  startS = alignStart(startS, silences)
  endS = alignEnd(endS, silences)
  if (endS - startS > limits.maxS) endS = startS + limits.maxS

  return { startS: Math.max(0, startS), endS, startWord: start, endWord: end }
}

/** First word of the nearest sentence; ties prefer earlier (keep the hook). */
export function snapStart(transcript: Transcript, index: number): number {
  if (index <= 0) return 0
  for (let offset = 0; offset <= SENTENCE_SEARCH_WORDS; offset++) {
    for (const candidate of [index - offset, index + offset]) {
      if (candidate <= 0) return 0
      if (candidate >= transcript.length) continue
      if (endsSentence(transcript.words[candidate - 1]!)) return candidate
    }
  }
  return index
}

/** Last word of the nearest sentence; ties prefer later (keep the payoff). */
export function snapEnd(transcript: Transcript, index: number): number {
  const last = transcript.length - 1
  if (index >= last) return last
  for (let offset = 0; offset <= SENTENCE_SEARCH_WORDS; offset++) {
    for (const candidate of [index + offset, index - offset]) {
      if (candidate >= last) return last
      if (candidate < 0) continue
      if (endsSentence(transcript.words[candidate]!)) return candidate
    }
  }
  return index
}

function clampDuration(transcript: Transcript, start: number, end: number, limits: Limits): number | null {
  const startS = transcript.words[start]!.start
  const durationAt = (i: number) => transcript.words[i]!.end - startS

  if (durationAt(end) > limits.maxS) {
    let found: number | null = null
    for (let i = end; i > start; i--) {
      if (durationAt(i) <= limits.maxS && endsSentence(transcript.words[i]!)) {
        found = i
        break
      }
    }
    if (found === null) {
      // No sentence end fits: the speaker runs long without punctuation.
      for (let i = end; i > start; i--) {
        if (durationAt(i) <= limits.maxS) {
          found = i
          break
        }
      }
    }
    if (found === null) return null
    end = found
  }

  if (durationAt(end) < limits.minS) {
    for (let i = end + 1; i < transcript.length; i++) {
      if (durationAt(i) > limits.maxS) break
      if (endsSentence(transcript.words[i]!)) {
        end = i
        if (durationAt(end) >= limits.minS) break
      }
    }
  }

  const duration = durationAt(end)
  if (duration < limits.minS || duration > limits.maxS) return null
  return end
}

export function alignStart(startS: number, silences: Silence[]): number {
  const silence = nearest(silences, (s) => s.end, startS)
  if (!silence) return Math.max(0, startS - FALLBACK_LEAD_S)
  const earliest = Math.min(silence.start + SILENCE_MARGIN_S, silence.end)
  const preferred = silence.end - SILENCE_LEAD_S
  return Math.max(0, Math.max(earliest, Math.min(preferred, startS)))
}

export function alignEnd(endS: number, silences: Silence[]): number {
  const silence = nearest(silences, (s) => s.start, endS)
  if (!silence) return endS + FALLBACK_TAIL_S
  const latest = Math.max(silence.end - SILENCE_MARGIN_S, silence.start)
  const preferred = silence.start + SILENCE_TAIL_S
  return Math.max(endS, Math.min(preferred, latest))
}

function nearest(silences: Silence[], edge: (s: Silence) => number, t: number): Silence | null {
  let best: Silence | null = null
  let bestDistance = SILENCE_SEARCH_RADIUS_S
  for (const silence of silences) {
    const distance = Math.abs(edge(silence) - t)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = silence
    }
  }
  return best
}
