/**
 * Canonical clip candidates and their deterministic normalisation.
 *
 * Everything an AI stage proposes arrives here as word indices and leaves as
 * a Candidate whose timing is measured: word index -> speech timestamp ->
 * sentence snap -> duration clamp -> silence alignment. Models never supply
 * seconds.
 */

import { type Boundary, type Limits, refine } from './boundaries'
import type { Silence, Transcript } from './transcript'
import { endsSentence } from './transcript'

/** Two proposals sharing this much of their words are the same moment. */
export const DUPLICATE_IOU = 0.4
const AGREEMENT_BONUS = 0.03
const AGREEMENT_BONUS_CAP = 0.09

export const MOMENT_TYPES = {
  strong_opening: 'An opening line that grabs attention immediately',
  surprising_statement: 'A surprising or counterintuitive claim',
  controversial_opinion: 'A strong or controversial opinion',
  emotional_moment: 'A genuine emotional beat',
  admission: 'An unexpected personal admission or confession',
  punchline: 'A joke or funny moment that lands',
  story_payoff: 'A story that reaches its payoff',
  insight: 'A strong insight, lesson, or explanation',
  advice: 'Concrete, useful advice',
  curiosity_gap: "Sets up a question the viewer needs answered",
  disagreement: 'A disagreement or debate between people',
  revelation: 'A reveal, transformation, or impressive result',
  question_answer: 'A question followed by an answer with a payoff',
  gameplay_highlight: 'A clutch play, kill, comeback, fail, or unexpected game event',
  reaction: 'A strong reaction (rage, shock, joy)',
  other: 'Something else worth clipping',
} as const

export type MomentType = keyof typeof MOMENT_TYPES

export interface Triage {
  keep: number
  priority: number
  needsDeepReasoning: number
  momentType?: MomentType
}

export interface Scores {
  dimensions: Record<string, number>
  overall: number
  momentType?: MomentType
  topic: string
  title: string
  selfContained?: boolean
  startWord?: number
  endWord?: number
}

export interface Verdict {
  keep: boolean
  score: number
  title: string
  reason: string
  sameStoryAs: string[]
}

export interface Candidate {
  id: string
  startWord: number
  endWord: number
  startS: number
  endS: number
  momentType: MomentType
  /** "ai" for model-discovered, "fallback" for deterministic sentence windows. */
  source: 'ai' | 'fallback'
  /** Discovery's prior, 0..1. */
  initialScore: number
  title: string
  hook: string
  reason: string
  proposals: number
  speechDensity: number
  silenceRatio: number
  triage?: Triage
  scores?: Scores
  verdict?: Verdict
  adjusted?: boolean
}

export interface Proposal {
  startWord: number
  endWord: number
  momentType: MomentType
  initialScore: number
  title: string
  hook: string
  reason: string
}

export function candidateId(startWord: number, endWord: number): string {
  return `c${startWord}_${endWord}`
}

export function duration(c: { startS: number; endS: number }): number {
  return c.endS - c.startS
}

/** Intersection over union of two inclusive word ranges. */
export function wordIou(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1)
  if (!intersection) return 0
  const union = aEnd - aStart + 1 + (bEnd - bStart + 1) - intersection
  return union ? intersection / union : 0
}

/** Overlap as a fraction of the shorter clip: 1.0 when one contains the other. */
export function timeOverlapFraction(
  a: { startS: number; endS: number },
  b: { startS: number; endS: number },
): number {
  const overlap = Math.max(0, Math.min(a.endS, b.endS) - Math.max(a.startS, b.startS))
  const shorter = Math.min(duration(a), duration(b))
  return shorter > 0 ? overlap / shorter : 0
}

export interface NormalizationReport {
  proposed: number
  noValidBoundary: number
  mergedDuplicates: number
  kept: number
}

export function normalize(
  transcript: Transcript,
  proposals: Proposal[],
  silences: Silence[],
  limits: Limits,
): { candidates: Candidate[]; report: NormalizationReport } {
  const report: NormalizationReport = { proposed: proposals.length, noValidBoundary: 0, mergedDuplicates: 0, kept: 0 }
  const refined: Candidate[] = []
  const last = transcript.length - 1

  for (const proposal of proposals) {
    if (last < 0 || proposal.endWord <= proposal.startWord) {
      report.noValidBoundary++
      continue
    }
    const boundary = refine(
      transcript,
      Math.max(0, Math.min(proposal.startWord, last)),
      Math.max(0, Math.min(proposal.endWord, last)),
      silences,
      limits,
    )
    if (!boundary) {
      report.noValidBoundary++
      continue
    }
    refined.push(
      buildCandidate(transcript, boundary, silences, {
        momentType: proposal.momentType,
        source: 'ai',
        initialScore: proposal.initialScore,
        title: proposal.title,
        hook: proposal.hook,
        reason: proposal.reason,
      }),
    )
  }

  const merged = mergeDuplicates(refined)
  report.mergedDuplicates = refined.length - merged.length
  report.kept = merged.length
  return { candidates: merged, report }
}

export function buildCandidate(
  transcript: Transcript,
  boundary: Boundary,
  silences: Silence[],
  fields: Pick<Candidate, 'momentType' | 'source' | 'initialScore' | 'title' | 'hook' | 'reason'>,
): Candidate {
  const words = transcript.slice(boundary.startWord, boundary.endWord)
  const length = Math.max(0.001, boundary.endS - boundary.startS)
  return {
    momentType: fields.momentType,
    source: fields.source,
    initialScore: fields.initialScore,
    title: fields.title,
    hook: fields.hook,
    reason: fields.reason,
    id: candidateId(boundary.startWord, boundary.endWord),
    startWord: boundary.startWord,
    endWord: boundary.endWord,
    startS: round(boundary.startS, 3),
    endS: round(boundary.endS, 3),
    proposals: 1,
    speechDensity: round(words.length / length, 3),
    silenceRatio: round(silenceInside(boundary.startS, boundary.endS, silences) / length, 3),
  }
}

/**
 * Collapses near-identical candidates, keeping the strongest prior.
 * Deterministic: ordered by prior, then position, then id.
 */
export function mergeDuplicates(candidates: Candidate[], iou = DUPLICATE_IOU): Candidate[] {
  const ordered = [...candidates].sort(
    (a, b) => b.initialScore - a.initialScore || a.startS - b.startS || a.id.localeCompare(b.id),
  )
  const kept: Candidate[] = []
  for (const candidate of ordered) {
    const match = kept.find(
      (existing) => wordIou(candidate.startWord, candidate.endWord, existing.startWord, existing.endWord) > iou,
    )
    if (!match) {
      kept.push({ ...candidate })
      continue
    }
    match.proposals += candidate.proposals
    const bonus = Math.min(AGREEMENT_BONUS_CAP, AGREEMENT_BONUS * (match.proposals - 1))
    match.initialScore = Math.min(1, Math.max(match.initialScore, candidate.initialScore) + bonus)
  }
  return kept.sort((a, b) => a.startS - b.startS || a.id.localeCompare(b.id))
}

function silenceInside(start: number, end: number, silences: Silence[]): number {
  let total = 0
  for (const s of silences) {
    const overlap = Math.min(end, s.end) - Math.max(start, s.start)
    if (overlap > 0) total += overlap
  }
  return total
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  `a an the and or but if then so to of in on at for with from by as is are was were
  be been being it its this that these those i you he she we they me him her us them
  my your his our their what which who whom when where why how all any both each few
  more most other some such no nor not only own same than too very can will just don
  should now do does did doing have has had having would could there here about into
  over under again further once up down out off like yeah um uh oh okay ok really
  know think mean gonna got get going right well also even still because thing things
  lot kind sort hai ka ki ke ko se me mein ye yeh wo woh aur bhi toh to na nahi kya`.split(/\s+/),
)

export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  return new Set(words.filter((w) => !STOPWORDS.has(w) && [...w].length > 2))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

export function contentJaccard(a: string, b: string): number {
  return jaccard(contentWords(a), contentWords(b))
}

export function textOf(transcript: Transcript, c: Candidate): string {
  return transcript.textBetween(c.startWord, c.endWord)
}

// ---------------------------------------------------------------------------
// Deterministic fallback windows
// ---------------------------------------------------------------------------

/**
 * Sentence-bounded windows cut by code, for when the AI funnel runs short.
 *
 * They exist so a job still delivers its full clip count from material the
 * models passed over. They are marked `source: "fallback"` and scored by a
 * transparent heuristic well below typical AI scores, so selection only
 * reaches for them after every usable AI candidate.
 */
export function fallbackCandidates(
  transcript: Transcript,
  silences: Silence[],
  limits: Limits,
  avoid: Candidate[] = [],
): Candidate[] {
  if (!transcript.length) return []
  const target = Math.min(limits.maxS, Math.max(limits.minS * 1.5, (limits.minS + limits.maxS) / 3))

  const sentenceStarts = [0]
  for (let i = 1; i < transcript.length; i++) if (endsSentence(transcript.words[i - 1]!)) sentenceStarts.push(i)

  const produced: Candidate[] = []
  let lastEndS = -1
  for (const start of sentenceStarts) {
    const startS = transcript.words[start]!.start
    if (startS < lastEndS) continue
    const endGuess = transcript.indexAtTime(startS + target)
    const boundary = refine(transcript, start, Math.max(start + 1, endGuess), silences, limits)
    if (!boundary) continue
    const candidate = buildCandidate(transcript, boundary, silences, {
      momentType: 'other',
      source: 'fallback',
      initialScore: 0,
      title: transcript.textBetween(boundary.startWord, Math.min(boundary.endWord, boundary.startWord + 7)),
      hook: '',
      reason: 'Filler: picked by HustlClip because the AI found fewer strong moments than requested.',
    })
    // Compare padded clip edges, not word times: silence alignment widens
    // clips, and adjacent windows must not share audio.
    if (candidate.startS < lastEndS) continue
    if (avoid.some((other) => timeOverlapFraction(candidate, other) > 0)) continue
    candidate.initialScore = heuristicScore(transcript, candidate)
    produced.push(candidate)
    lastEndS = candidate.endS
  }
  return produced
}

/** A transparent 0..0.45 prior for fallback windows, capped below AI scores. */
export function heuristicScore(transcript: Transcript, c: Candidate): number {
  const text = textOf(transcript, c)
  let score = 0.15
  score += 0.12 * Math.min(1, c.speechDensity / 3)
  score += text.includes('?') ? 0.06 : 0
  score += text.includes('!') ? 0.05 : 0
  score += /\d/.test(text) ? 0.04 : 0
  score -= 0.1 * Math.min(1, c.silenceRatio * 2)
  return round(Math.max(0, Math.min(0.45, score)), 4)
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}
