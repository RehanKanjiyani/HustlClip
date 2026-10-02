/**
 * Deterministic global selection: the final set of clips is owned by code.
 *
 * Models score and judge; this module decides. A greedy selector with
 * explicit penalties, so every pick can be explained ("0.81 quality, -0.06
 * for sharing a topic with #2") and the behaviour is testable.
 *
 * 1. Hard constraint: two selected clips never overlap by more than
 *    MAX_OVERLAP of the shorter one. No duplicate fills the count.
 * 2. Quality: composite score plus a tier adjustment (judge-kept first,
 *    fallback and judge-rejected last).
 * 3. Soft diversity penalties: same story, topic similarity, same moment
 *    type, temporal crowding.
 * 4. Exact count: continue until the target or until nothing fits.
 */

import {
  type Candidate,
  contentWords,
  jaccard,
  timeOverlapFraction,
} from './candidates'

export const MAX_OVERLAP = 0.15

const SAME_STORY_PENALTY = 0.4
const DUPLICATE_RISK_THRESHOLD = 0.5
const TOPIC_PENALTY = 0.2
const TYPE_PENALTY = 0.03
const CROWDING_WINDOW_S = 45
const CROWDING_PENALTY = 0.05

const DIMENSION_WEIGHTS: Record<string, number> = {
  hook: 0.17,
  payoff: 0.15,
  retention: 0.12,
  context: 0.09,
  completeness: 0.09,
  opening: 0.07,
  ending: 0.07,
  curiosity: 0.05,
  emotion: 0.05,
  quotability: 0.05,
  surprise: 0.04,
  storytelling: 0.03,
  usefulness: 0.02,
}

export type Tier = 'judged_keep' | 'judged_reject' | 'scored' | 'triaged' | 'discovered' | 'fallback'

const TIER_ADJUST: Record<Tier, number> = {
  judged_keep: 0.12,
  judged_reject: -0.3,
  fallback: -0.25,
  discovered: -0.1,
  triaged: -0.05,
  scored: 0,
}

/** Every available signal as one 0..1 quality estimate; later stages dominate. */
export function compositeScore(c: Candidate): number {
  let score = c.initialScore
  if (c.triage) score = 0.5 * c.triage.priority + 0.3 * c.triage.keep + 0.2 * score
  if (c.scores) {
    const dims = c.scores.dimensions
    let weighted = 0
    let total = 0
    for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
      const value = dims[key]
      if (value === undefined) continue
      weighted += weight * value
      total += weight
    }
    const dimScore = total ? weighted / total / 10 : score
    let mid = 0.6 * c.scores.overall + 0.4 * dimScore
    if (c.scores.selfContained === false) mid -= 0.08
    score = 0.85 * mid + 0.15 * score
  }
  if (c.verdict) score = 0.65 * c.verdict.score + 0.35 * score
  // Measured audio energy: the room reacting (laughter, shouting, hype) is a
  // signal words alone miss. A bonus only, so a quiet great story still wins.
  if (c.energy !== undefined) score += ENERGY_BONUS * c.energy
  return Math.max(0, Math.min(1, score))
}

const ENERGY_BONUS = 0.06

export function tier(c: Candidate): Tier {
  if (c.source === 'fallback') return 'fallback'
  if (c.verdict) return c.verdict.keep ? 'judged_keep' : 'judged_reject'
  if (c.scores) return 'scored'
  if (c.triage) return 'triaged'
  return 'discovered'
}

export interface Pick {
  candidate: Candidate
  quality: number
  adjusted: number
  penalties: Record<string, number>
  rank: number
  tier: Tier
  /** Quality after the tier adjustment: what ranks and what users see. */
  final: number
}

export interface SelectionContext {
  /** Candidate text by id, for topic similarity. */
  texts: Map<string, string>
  /** "a|b" -> probability the pair is the same story. */
  duplicateRisk: Map<string, number>
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function select(candidates: Candidate[], target: number, context?: Partial<SelectionContext>): Pick[] {
  const texts = context?.texts ?? new Map<string, string>()
  const risk = context?.duplicateRisk ?? new Map<string, number>()
  const unique = dedupeIds(candidates)
  const words = new Map(unique.map((c) => [c.id, contentWords(texts.get(c.id) ?? c.title)]))
  const topics = new Map(unique.map((c) => [c.id, contentWords(c.scores?.topic ?? '')]))

  const pool = unique
    .map((c) => ({ candidate: c, quality: compositeScore(c) }))
    .sort((a, b) => b.quality - a.quality || a.candidate.startS - b.candidate.startS || a.candidate.id.localeCompare(b.candidate.id))

  const chosen: Pick[] = []
  while (chosen.length < target) {
    let best: Pick | null = null
    for (const { candidate, quality } of pool) {
      if (chosen.some((p) => p.candidate.id === candidate.id)) continue
      if (chosen.some((p) => timeOverlapFraction(candidate, p.candidate) > MAX_OVERLAP)) continue
      const penalties = penaltiesFor(candidate, chosen, risk, words, topics)
      const t = tier(candidate)
      const adjusted = quality + TIER_ADJUST[t] - Object.values(penalties).reduce((a, b) => a + b, 0)
      if (!best || adjusted > best.adjusted || (adjusted === best.adjusted && candidate.startS < best.candidate.startS)) {
        best = {
          candidate,
          quality,
          adjusted,
          penalties,
          rank: 0,
          tier: t,
          final: Math.max(0, Math.min(1, quality + TIER_ADJUST[t])),
        }
      }
    }
    if (!best) break
    chosen.push(best)
  }

  const ranked = chosen.sort(
    (a, b) => b.final - a.final || a.candidate.startS - b.candidate.startS || a.candidate.id.localeCompare(b.candidate.id),
  )
  ranked.forEach((pick, i) => (pick.rank = i + 1))
  return ranked
}

export function explain(pick: Pick): string {
  const parts = [`quality ${pick.quality.toFixed(2)} (${pick.tier})`]
  for (const [key, value] of Object.entries(pick.penalties).sort()) {
    if (value > 0) parts.push(`-${value.toFixed(2)} ${key}`)
  }
  return parts.join(', ')
}

function penaltiesFor(
  candidate: Candidate,
  chosen: Pick[],
  risk: Map<string, number>,
  words: Map<string, Set<string>>,
  topics: Map<string, Set<string>>,
): Record<string, number> {
  let sameStory = 0
  let topic = 0
  let moment = 0
  let crowding = 0
  const sameAs = new Set(candidate.verdict?.sameStoryAs ?? [])

  for (const pick of chosen) {
    const other = pick.candidate
    const otherSame = new Set(other.verdict?.sameStoryAs ?? [])
    const p = risk.get(pairKey(candidate.id, other.id)) ?? 0
    if (sameAs.has(other.id) || otherSame.has(candidate.id) || p >= DUPLICATE_RISK_THRESHOLD) {
      sameStory = Math.max(sameStory, SAME_STORY_PENALTY * Math.max(p, 0.75))
    }
    const candidateTopic = topics.get(candidate.id)!
    const similarity = Math.max(
      jaccard(words.get(candidate.id)!, words.get(other.id)!),
      candidateTopic.size ? jaccard(candidateTopic, topics.get(other.id)!) : 0,
    )
    topic = Math.max(topic, TOPIC_PENALTY * Math.min(1, similarity * 2))
    if (candidate.momentType === other.momentType && candidate.momentType !== 'other') moment += TYPE_PENALTY
    const gap = Math.max(other.startS - candidate.endS, candidate.startS - other.endS, 0)
    if (gap < CROWDING_WINDOW_S) crowding = Math.max(crowding, CROWDING_PENALTY * (1 - gap / CROWDING_WINDOW_S))
  }

  const r = (v: number) => Math.round(v * 10_000) / 10_000
  return {
    same_story: r(sameStory),
    topic: r(topic),
    moment_type: r(Math.min(moment, 0.09)),
    crowding: r(crowding),
  }
}

function dedupeIds(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}
