/**
 * Capability contracts: what each AI step is asked, and what counts as an
 * answer.
 *
 * Each capability defines its prompt, how its payload is rendered, and
 * validation that turns an HTTP-200 reply into either a normalised result or
 * a CapabilityError (malformed JSON, missing fields, invented references,
 * too little coverage). The AI manager uses the error category to decide
 * whether to repair, retry, or fall back to another model.
 */

import type { Capability } from '../../shared/models'
import { MOMENT_TYPES, type MomentType, type Scores, type Triage, type Verdict } from './candidates'
import { extractJsonObject } from './json'
import { PROMPTS, type PromptName } from './prompts'

export type CapabilityErrorCategory = 'malformed' | 'schema' | 'incomplete' | 'invalid_references'

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly category: CapabilityErrorCategory,
  ) {
    super(message)
  }
}

export interface CapabilitySpec<P, R> {
  name: Capability
  prompt: PromptName
  temperature: number
  /** Rough output budget, so long answers are not cut off. */
  maxTokens: (payload: P) => number
  render: (payload: P) => string
  parse: (text: string, payload: P) => R
}

export const CONTENT_TYPES = ['stream', 'gaming', 'podcast', 'interview', 'educational', 'commentary', 'general'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

export const SCORE_DIMENSIONS = [
  'hook',
  'context',
  'payoff',
  'emotion',
  'curiosity',
  'quotability',
  'usefulness',
  'surprise',
  'storytelling',
  'retention',
  'opening',
  'ending',
  'completeness',
] as const

// ---------------------------------------------------------------------------
// coercion helpers
// ---------------------------------------------------------------------------

/** A probability-like value in [0, 1]; accepts 0-100 and 0-10 scales. */
export function unit(value: unknown, fallback: number | null = null): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  let x = n
  if (x > 10) x /= 100
  else if (x > 1) x /= 10
  return Math.max(0, Math.min(1, x))
}

/** A 0-10 dimension score; accepts 0-1 and 0-100 scales. */
export function ten(value: unknown): number | null {
  if (typeof value === 'boolean') return null
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  let x = n
  if (x > 10) x /= 10
  else if (x > 0 && x <= 1 && !Number.isInteger(x)) x *= 10
  return Math.max(0, Math.min(10, x))
}

function text(value: unknown, limit = 200): string {
  return (value === null || value === undefined ? '' : String(value)).trim().slice(0, limit)
}

function int(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null
  const n = typeof value === 'string' ? Number(value.trim()) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null
}

function items(data: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function parseJson(reply: string): Record<string, unknown> {
  try {
    return extractJsonObject(reply)
  } catch (error) {
    throw new CapabilityError(`Response is not valid JSON: ${(error as Error).message}`, 'malformed')
  }
}

function momentType(value: unknown): MomentType | undefined {
  const t = text(value, 40).toLowerCase()
  return t in MOMENT_TYPES ? (t as MomentType) : undefined
}

function requireCoverage(got: number, expected: number, minimum: number): void {
  if (!expected) return
  if (!got) throw new CapabilityError('The response contained no usable entries.', 'schema')
  if (got / expected < minimum) throw new CapabilityError(`Only ${got} of ${expected} entries were usable.`, 'incomplete')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// candidate_discovery
// ---------------------------------------------------------------------------

export interface DiscoveryRequest {
  text: string
  firstWord: number
  lastWord: number
  minS: number
  maxS: number
  maxCandidates: number
}

export interface DiscoveredCandidate {
  startWord: number
  endWord: number
  momentType: MomentType
  initialScore: number
  title: string
  hook: string
  reason: string
}

export interface DiscoveryResult {
  contentType: ContentType
  candidates: DiscoveredCandidate[]
  invalidReferences: number
}

export const discovery: CapabilitySpec<DiscoveryRequest, DiscoveryResult> = {
  name: 'candidate_discovery',
  prompt: 'candidate_discovery_v2',
  temperature: 0.3,
  maxTokens: (p) => 1200 + 260 * p.maxCandidates,
  render: (p) =>
    `Transcript section, words ${p.firstWord} to ${p.lastWord}. Each word is tagged [index]word.\n` +
    `Target clip length: ${Math.round(p.minS)}-${Math.round(p.maxS)} s.\n` +
    `Return at most ${p.maxCandidates} candidates, strongest first.\n\n---\n${p.text}\n---`,
  parse: (reply, p) => {
    const data = parseJson(reply)
    const raw = items(data, 'candidates', 'clips', 'moments')
    let contentType = text(data.content_type, 30).toLowerCase() as ContentType
    if (!CONTENT_TYPES.includes(contentType)) contentType = 'general'

    const found: DiscoveredCandidate[] = []
    let invalid = 0
    for (const item of raw) {
      if (!isRecord(item)) {
        invalid++
        continue
      }
      let start = int(item.start_word_index)
      let end = int(item.end_word_index)
      if (start === null || end === null) {
        invalid++
        continue
      }
      // Wholly outside the section: hallucinated. Partially: a sloppy edge.
      if (end < p.firstWord || start > p.lastWord) {
        invalid++
        continue
      }
      start = Math.max(p.firstWord, start)
      end = Math.min(p.lastWord, end)
      if (end <= start) {
        invalid++
        continue
      }
      found.push({
        startWord: start,
        endWord: end,
        momentType: momentType(item.type ?? item.moment_type) ?? 'other',
        initialScore: unit(item.initial_score ?? item.score, 0.5) ?? 0.5,
        title: text(item.title, 80),
        hook: text(item.hook, 200),
        reason: text(item.reason, 300),
      })
    }
    if (raw.length && !found.length) {
      throw new CapabilityError(`All ${raw.length} candidates referenced words outside the section.`, 'invalid_references')
    }
    if (!Array.isArray(data.candidates) && !Array.isArray(data.clips) && !Array.isArray(data.moments)) {
      throw new CapabilityError('The response has no "candidates" list.', 'schema')
    }
    return { contentType, candidates: found.slice(0, Math.max(1, p.maxCandidates)), invalidReferences: invalid }
  },
}

// ---------------------------------------------------------------------------
// candidate_triage
// ---------------------------------------------------------------------------

export interface TriageItem {
  id: string
  durationS: number
  momentType: MomentType
  transcript: string
}

export const triage: CapabilitySpec<{ items: TriageItem[] }, Map<string, Triage>> = {
  name: 'candidate_triage',
  prompt: 'triage_v2',
  temperature: 0.1,
  maxTokens: (p) => 600 + 90 * p.items.length,
  render: (p) =>
    'Candidates:\n' +
    JSON.stringify(
      p.items.map((i) => ({
        candidate_id: i.id,
        duration_s: Math.round(i.durationS * 10) / 10,
        moment_type: i.momentType,
        transcript: i.transcript.slice(0, 2400),
      })),
      null,
      1,
    ),
  parse: (reply, p) => {
    const data = parseJson(reply)
    const known = new Set(p.items.map((i) => i.id))
    const out = new Map<string, Triage>()
    for (const raw of items(data, 'decisions', 'candidates', 'clips')) {
      if (!isRecord(raw) || typeof raw.candidate_id !== 'string' || !known.has(raw.candidate_id)) continue
      const keep = unit(raw.keep)
      const priority = unit(raw.priority)
      if (keep === null || priority === null) continue
      out.set(raw.candidate_id, {
        keep,
        priority,
        needsDeepReasoning: unit(raw.needs_deep_reasoning, 0) ?? 0,
        momentType: momentType(raw.moment_type),
      })
    }
    requireCoverage(out.size, known.size, 0.5)
    return out
  },
}

// ---------------------------------------------------------------------------
// text_scoring
// ---------------------------------------------------------------------------

export interface ScoringItem {
  id: string
  taggedText: string
  candidateFirst: number
  candidateLast: number
  contextFirst: number
  contextLast: number
  durationS: number
  momentType: MomentType
}

export interface ScoringRequest {
  items: ScoringItem[]
  contentType: ContentType
  minS: number
  maxS: number
}

const CONTENT_EMPHASIS: Record<ContentType, string> = {
  stream: 'Livestream: favour hype, strong reactions, funny moments, chat interactions that land, and clutch plays.',
  gaming: 'Gaming: favour clutch plays, fails, comebacks, and strong reactions; the transcript may understate what happens on screen.',
  podcast: 'Podcast: favour unexpected answers, personal stories, strong opinions, and quotable lines.',
  interview: 'Interview: favour unexpected answers, disagreements, and confessions.',
  educational: 'Educational: favour surprising facts, misconceptions corrected, and concise problem-to-solution explanations.',
  commentary: 'Commentary: favour strong takes with a clear point.',
  general: 'Use the universal rubric.',
}

export const scoring: CapabilitySpec<ScoringRequest, Map<string, Scores>> = {
  name: 'text_scoring',
  prompt: 'scoring_v2',
  temperature: 0.2,
  maxTokens: (p) => 800 + 320 * p.items.length,
  render: (p) =>
    `Content type: ${p.contentType}. ${CONTENT_EMPHASIS[p.contentType]}\n` +
    `Clip length limits: ${Math.round(p.minS)}-${Math.round(p.maxS)} s.\n\n` +
    p.items
      .map(
        (i) =>
          `### candidate_id: ${i.id}\nProposed clip: words ${i.candidateFirst}-${i.candidateLast} ` +
          `(${Math.round(i.durationS)} s). Context shown: words ${i.contextFirst}-${i.contextLast}. ` +
          `Proposed type: ${i.momentType}.\n${i.taggedText}`,
      )
      .join('\n\n'),
  parse: (reply, p) => {
    const data = parseJson(reply)
    const byId = new Map(p.items.map((i) => [i.id, i]))
    const out = new Map<string, Scores>()
    for (const raw of items(data, 'scores', 'candidates')) {
      if (!isRecord(raw) || typeof raw.candidate_id !== 'string') continue
      const item = byId.get(raw.candidate_id)
      if (!item) continue
      const source = isRecord(raw.scores) ? raw.scores : raw
      const dimensions: Record<string, number> = {}
      for (const name of SCORE_DIMENSIONS) {
        const value = ten(source[name])
        if (value !== null) dimensions[name] = value
      }
      const overall = unit(raw.overall)
      if (overall === null || Object.keys(dimensions).length < Math.floor(SCORE_DIMENSIONS.length / 2)) continue
      let start = int(raw.start_word_index)
      let end = int(raw.end_word_index)
      if (!(start !== null && end !== null && item.contextFirst <= start && start < end && end <= item.contextLast)) {
        start = end = null
      }
      out.set(item.id, {
        dimensions,
        overall,
        momentType: momentType(raw.moment_type),
        topic: text(raw.topic, 60),
        title: text(raw.title, 80),
        selfContained: typeof raw.self_contained === 'boolean' ? raw.self_contained : undefined,
        startWord: start ?? undefined,
        endWord: end ?? undefined,
      })
    }
    requireCoverage(out.size, byId.size, 0.67)
    return out
  },
}

// ---------------------------------------------------------------------------
// final_judgment
// ---------------------------------------------------------------------------

export interface FinalistItem {
  id: string
  startLabel: string
  durationS: number
  momentType: MomentType
  topic: string
  midScore: number
  text: string
}

export interface JudgmentRequest {
  finalists: FinalistItem[]
  target: number
  contentType: ContentType
}

export const judgment: CapabilitySpec<JudgmentRequest, Map<string, Verdict>> = {
  name: 'final_judgment',
  prompt: 'judgment_v2',
  temperature: 0.2,
  maxTokens: (p) => 1000 + 180 * p.finalists.length,
  render: (p) =>
    `Content type: ${p.contentType}. The editor will publish ${p.target} clips from this video.\n` +
    `${p.finalists.length} finalists follow.\n\n` +
    p.finalists
      .map(
        (f) =>
          `### ${f.id} | at ${f.startLabel} | ${Math.round(f.durationS)} s | ${f.momentType} | ` +
          `topic: ${f.topic || 'n/a'} | screening score ${Math.round(f.midScore)}/100\n${f.text}`,
      )
      .join('\n\n'),
  parse: (reply, p) => {
    const data = parseJson(reply)
    const known = new Set(p.finalists.map((f) => f.id))
    const out = new Map<string, Verdict>()
    for (const raw of items(data, 'verdicts', 'candidates', 'clips')) {
      if (!isRecord(raw) || typeof raw.candidate_id !== 'string' || !known.has(raw.candidate_id)) continue
      const score = unit(raw.score)
      const keep = raw.keep
      if (score === null || typeof keep !== 'boolean') continue
      const same = Array.isArray(raw.same_story_as) ? raw.same_story_as : []
      out.set(raw.candidate_id, {
        keep,
        score,
        title: text(raw.title, 80),
        reason: text(raw.reason, 300),
        sameStoryAs: same.filter(
          (s): s is string => typeof s === 'string' && known.has(s) && s !== raw.candidate_id,
        ),
      })
    }
    requireCoverage(out.size, known.size, 0.7)
    return out
  },
}

// ---------------------------------------------------------------------------
// duplicate_risk
// ---------------------------------------------------------------------------

export interface DuplicatePair {
  a: string
  aText: string
  b: string
  bText: string
}

export const duplicates: CapabilitySpec<{ pairs: DuplicatePair[] }, Map<string, number>> = {
  name: 'duplicate_risk',
  prompt: 'duplicate_v2',
  temperature: 0,
  maxTokens: (p) => 400 + 60 * p.pairs.length,
  render: (p) =>
    'Pairs:\n' +
    JSON.stringify(
      p.pairs.map((x) => ({ a: x.a, clip_a: x.aText.slice(0, 1800), b: x.b, clip_b: x.bText.slice(0, 1800) })),
      null,
      1,
    ),
  parse: (reply, p) => {
    const data = parseJson(reply)
    const wanted = new Set(p.pairs.map((x) => `${x.a}|${x.b}`))
    const out = new Map<string, number>()
    for (const raw of items(data, 'pairs')) {
      if (!isRecord(raw)) continue
      let key = `${raw.a}|${raw.b}`
      if (!wanted.has(key)) key = `${raw.b}|${raw.a}`
      if (!wanted.has(key)) continue
      const value = unit(raw.same_story)
      if (value !== null) out.set(key, value)
    }
    requireCoverage(out.size, wanted.size, 0.5)
    return out
  },
}

export function systemPrompt(spec: { prompt: PromptName }): string {
  return PROMPTS[spec.prompt]
}
