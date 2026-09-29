/**
 * Transcript windowing for candidate discovery.
 *
 * Long streams are cut into overlapping windows so each fits a model's
 * context comfortably. Overlap matters: a moment straddling a window edge
 * would otherwise be seen only in halves by both windows and proposed by
 * neither.
 */

import type { Transcript } from './transcript'

export const WINDOW_S = 8 * 60
export const OVERLAP_S = 60

export interface TranscriptWindow {
  firstWord: number
  lastWord: number
  durationS: number
}

export function buildWindows(transcript: Transcript, windowS = WINDOW_S, overlapS = OVERLAP_S): TranscriptWindow[] {
  if (!transcript.length) return []
  if (overlapS >= windowS) throw new Error('overlap must be smaller than the window')
  const words = transcript.words
  const windows: TranscriptWindow[] = []
  let cursor = 0
  while (cursor < words.length) {
    const endTime = words[cursor]!.start + windowS
    let last = cursor
    while (last + 1 < words.length && words[last + 1]!.end <= endTime) last++
    const [a, b] = transcript.timeRange(cursor, last)
    windows.push({ firstWord: cursor, lastWord: last, durationS: b - a })
    if (last >= words.length - 1) break
    const next = transcript.indexAtTime(words[last]!.end - overlapS)
    cursor = Math.max(cursor + 1, next)
  }
  return windows
}

/** Adaptive breadth: roughly one proposal per minute of speech, 4..12. */
export function candidatesPerWindow(durationS: number): number {
  return Math.max(4, Math.min(12, Math.round(durationS / 60) + 2))
}
