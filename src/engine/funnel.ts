/**
 * The intelligence funnel: transcript in, exactly N selected clips out.
 *
 *   transcript windows -> candidate_discovery (breadth, parallel)
 *     -> normalisation (code: measured timing, dedupe, features)
 *     -> candidate_triage (only when the pool is large)
 *     -> text_scoring (batches, with surrounding context)
 *     -> final_judgment (finalists compared side by side)
 *     -> duplicate_risk (ambiguous pairs only)
 *     -> selection (code: exact count, distinct, diverse)
 *
 * Every step saves its output through the Store and reuses it on resume, so
 * a rate limit during judgment never repeats discovery, let alone
 * transcription. A failed optional step degrades the job instead of failing
 * it; discovery must succeed at least partly.
 */

import type { Limits } from './boundaries'
import { refine } from './boundaries'
import * as caps from './capabilities'
import {
  type Candidate,
  type Proposal,
  buildCandidate,
  contentJaccard,
  duration,
  fallbackCandidates,
  normalize,
  textOf,
  timeOverlapFraction,
  wordIou,
} from './candidates'
import { type AIManager, CapabilityUnavailable } from './manager'
import { mapPool } from './pool'
import { type Pick, MAX_OVERLAP, compositeScore, explain, pairKey, select } from './selection'
import type { Silence, Transcript } from './transcript'
import { medianEnergy, momentEnergy } from './details'
import { buildWindows, candidatesPerWindow } from './windows'

const DISCOVERY_CONCURRENCY = 3
const SCORING_BATCH = 6
const SCORING_CONCURRENCY = 2
const TRIAGE_BATCH = 15
/** Sentences of context shown either side of a candidate when scoring. */
const CONTEXT_SENTENCES = 2
const JUDGE_HEAD_CHARS = 900
const JUDGE_TAIL_CHARS = 400
const MAX_DUPLICATE_PAIRS = 24

export interface Store {
  load<T>(name: string): Promise<T | undefined>
  save(name: string, data: unknown): Promise<void>
}

export type Progress = (fraction: number, message: string) => void

export class FunnelError extends Error {}

export interface FunnelOptions {
  manager: AIManager
  transcript: Transcript
  silences: Silence[]
  limits: Limits
  target: number
  store: Store
  log?: (message: string) => void
  signal?: AbortSignal
  /** Loudness per 20 ms of the whole video (dBFS), for the energy signal. */
  energy?: Float32Array
  /** The creator's posted / passed-on clip titles, for the final judge. */
  examples?: { posted: string[]; skipped: string[] }
}

export interface FunnelResult {
  picks: Pick[]
  contentType: caps.ContentType
  /** Every evaluated moment, best first: the 'More moments' list. */
  pool: Candidate[]
}

export class Funnel {
  private readonly o: FunnelOptions
  private readonly log: (message: string) => void

  constructor(options: FunnelOptions) {
    this.o = options
    this.log = options.log ?? (() => undefined)
  }

  async run(progress: Progress): Promise<FunnelResult> {
    const { candidates, contentType } = await this.discover((f, m) => progress(0.55 * f, m))
    this.addEnergy(candidates)
    const evaluated = await this.evaluate(candidates, contentType, (f, m) => progress(0.55 + 0.35 * f, m))
    const picks = await this.select(evaluated, (f, m) => progress(0.9 + 0.1 * f, m))
    const pool = [...evaluated].sort((a, b) => compositeScore(b) - compositeScore(a))
    return { picks, contentType, pool }
  }

  private energyMedian: number | null = null

  /** Measured loudness of each moment against the whole video. */
  addEnergy(candidates: Candidate[]): void {
    const energy = this.o.energy
    if (!energy) return
    this.energyMedian ??= medianEnergy(energy)
    for (const c of candidates) c.energy = momentEnergy(energy, c.startS, c.endS, this.energyMedian)
  }

  // -------------------------------------------------------------------------
  // 1. discovery + normalisation
  // -------------------------------------------------------------------------

  async discover(progress: Progress): Promise<{ candidates: Candidate[]; contentType: caps.ContentType }> {
    const cached = await this.o.store.load<{ candidates: Candidate[]; contentType: caps.ContentType }>('candidates')
    if (cached) return cached

    const { transcript } = this.o
    const windows = buildWindows(transcript)
    if (!windows.length) throw new FunnelError('The video has no speech, so there is nothing to clip.')

    const stored = (await this.o.store.load<Record<string, caps.DiscoveryResult>>('discovery')) ?? {}
    const key = (w: { firstWord: number; lastWord: number }) => `${w.firstWord}-${w.lastWord}`
    let done = windows.filter((w) => stored[key(w)]).length
    let lastFailure: CapabilityUnavailable | null = null
    progress(done / windows.length, `Finding moments (${done}/${windows.length})`)

    await mapPool(
      windows.filter((w) => !stored[key(w)]),
      DISCOVERY_CONCURRENCY,
      async (window, index) => {
        this.o.signal?.throwIfAborted()
        try {
          const { output } = await this.o.manager.run(
            caps.discovery,
            {
              ...sentenceWindow(transcript, window.firstWord, window.lastWord),
              firstWord: window.firstWord,
              lastWord: window.lastWord,
              minS: this.o.limits.minS,
              maxS: this.o.limits.maxS,
              maxCandidates: candidatesPerWindow(window.durationS),
            },
            { rotate: index },
          )
          stored[key(window)] = output
          await this.o.store.save('discovery', stored)
        } catch (error) {
          if (!(error instanceof CapabilityUnavailable)) throw error
          lastFailure = error
          this.log(`Discovery failed for words ${key(window)}: ${error.message}`)
        }
        done++
        progress(done / windows.length, `Finding moments (${done}/${windows.length})`)
      },
    )

    const results = Object.values(stored)
    if (!results.length) throw new FunnelError((lastFailure as CapabilityUnavailable | null)?.message ?? 'No part of the video could be analysed.')
    const failed = windows.length - results.length
    if (failed > 0) {
      // Partial discovery is usable but unreliable; resume retries the gaps.
      if (failed / windows.length > 0.34) {
        throw new FunnelError(
          `${failed} of ${windows.length} parts of the video could not be analysed: ${(lastFailure as CapabilityUnavailable | null)?.message ?? ''} Tap Resume to retry them.`,
        )
      }
      this.log(`${failed} of ${windows.length} windows could not be analysed; continuing with the rest.`)
    }

    const proposals: Proposal[] = results.flatMap((r) =>
      r.candidates.map((c) => ({ ...c, momentType: c.momentType })),
    )
    const contentType = majorityContentType(results)
    const { candidates, report } = normalize(transcript, proposals, this.o.silences, this.o.limits)
    this.log(
      `Discovery: ${report.proposed} proposals -> ${report.kept} candidates ` +
        `(${report.noValidBoundary} without a valid boundary, ${report.mergedDuplicates} merged). Content: ${contentType}.`,
    )
    const out = { candidates, contentType }
    await this.o.store.save('candidates', out)
    return out
  }

  // -------------------------------------------------------------------------
  // 2. evaluation
  // -------------------------------------------------------------------------

  async evaluate(found: Candidate[], contentType: caps.ContentType, progress: Progress): Promise<Candidate[]> {
    const pool = found.map((c) => ({ ...c }))
    progress(0, 'Shortlisting moments')
    const shortlist = await this.triage(pool)
    progress(0.2, `Scoring ${shortlist.length} moments`)
    await this.score(shortlist, contentType, (f) => progress(0.2 + 0.55 * f, 'Scoring moments'))
    const finalists = this.finalists(pool)
    progress(0.8, `Comparing ${finalists.length} finalists`)
    await this.judge(finalists, contentType)
    progress(1, 'Evaluation complete')
    return pool
  }

  private shortlistSize(): number {
    return Math.max(4 * this.o.target, 24)
  }

  private async triage(found: Candidate[]): Promise<Candidate[]> {
    const limit = this.shortlistSize()
    let stored = await this.o.store.load<Record<string, NonNullable<Candidate['triage']>>>('triage')
    if (!stored) {
      stored = {}
      if (found.length > limit) {
        const items = found.map((c) => ({
          id: c.id,
          durationS: duration(c),
          momentType: c.momentType,
          transcript: textOf(this.o.transcript, c),
        }))
        for (let i = 0; i < items.length; i += TRIAGE_BATCH) {
          this.o.signal?.throwIfAborted()
          try {
            const { output } = await this.o.manager.run(caps.triage, { items: items.slice(i, i + TRIAGE_BATCH) })
            for (const [id, decision] of output) stored[id] = decision
          } catch (error) {
            if (!(error instanceof CapabilityUnavailable)) throw error
            this.log(`Triage unavailable (${error.message}); ranking by discovery prior.`)
            break
          }
        }
      }
      await this.o.store.save('triage', stored)
    }
    for (const c of found) {
      const t = stored[c.id]
      if (!t) continue
      c.triage = t
      if (t.momentType && c.momentType === 'other') c.momentType = t.momentType
    }
    if (found.length <= limit) return found
    return [...found].sort((a, b) => compositeScore(b) - compositeScore(a) || a.startS - b.startS).slice(0, limit)
  }

  private async score(shortlist: Candidate[], contentType: caps.ContentType, progress: (f: number) => void) {
    const stored = (await this.o.store.load<Record<string, NonNullable<Candidate['scores']>>>('scores')) ?? {}
    const pending = shortlist.filter((c) => !stored[c.id])
    const batches: Candidate[][] = []
    for (let i = 0; i < pending.length; i += SCORING_BATCH) batches.push(pending.slice(i, i + SCORING_BATCH))
    let done = 0
    await mapPool(batches, SCORING_CONCURRENCY, async (batch, index) => {
      this.o.signal?.throwIfAborted()
      try {
        const { output } = await this.o.manager.run(
          caps.scoring,
          {
            items: batch.map((c) => this.scoringItem(c)),
            contentType,
            minS: this.o.limits.minS,
            maxS: this.o.limits.maxS,
          },
          { rotate: index },
        )
        for (const [id, s] of output) stored[id] = s
        await this.o.store.save('scores', stored)
      } catch (error) {
        if (!(error instanceof CapabilityUnavailable)) throw error
        this.log(`Scoring failed for ${batch.length} candidates: ${error.message}`)
      }
      done++
      progress(done / Math.max(1, batches.length))
    })
    for (const c of shortlist) {
      const s = stored[c.id]
      if (!s) continue
      c.scores = s
      if (s.momentType) c.momentType = s.momentType
      if (s.title) c.title = s.title
      this.applyBoundarySuggestion(c, s)
    }
  }

  private scoringItem(c: Candidate): caps.ScoringItem {
    const t = this.o.transcript
    const sentences = t.sentences
    const a = t.sentenceOf(c.startWord)
    const b = t.sentenceOf(c.endWord)
    const first = Math.max(0, a - CONTEXT_SENTENCES)
    const final = Math.min(sentences.length - 1, b + CONTEXT_SENTENCES)
    return {
      id: c.id,
      taggedText: t.taggedSentences(first, final),
      sentences,
      candidateFirst: a,
      candidateLast: b,
      contextFirst: first,
      contextLast: final,
      durationS: duration(c),
      momentType: c.momentType,
      energy: c.energy,
    }
  }

  /**
   * Accept a model's better edges only if code can cut them: the suggestion
   * must refine to a valid boundary and stay recognisably the same moment.
   */
  private applyBoundarySuggestion(c: Candidate, s: NonNullable<Candidate['scores']>): void {
    if (s.startWord === undefined || s.endWord === undefined || c.adjusted) return
    if (s.startWord === c.startWord && s.endWord === c.endWord) return
    const boundary = refine(this.o.transcript, s.startWord, s.endWord, this.o.silences, this.o.limits)
    if (!boundary) return
    if (wordIou(boundary.startWord, boundary.endWord, c.startWord, c.endWord) < 0.3) return
    const rebuilt = buildCandidate(this.o.transcript, boundary, this.o.silences, {
      momentType: c.momentType,
      source: c.source,
      initialScore: c.initialScore,
      title: c.title,
      hook: c.hook,
      reason: c.reason,
    })
    Object.assign(c, {
      startWord: rebuilt.startWord,
      endWord: rebuilt.endWord,
      startS: rebuilt.startS,
      endS: rebuilt.endS,
      speechDensity: rebuilt.speechDensity,
      silenceRatio: rebuilt.silenceRatio,
      adjusted: true,
    })
  }

  private finalists(pool: Candidate[]): Candidate[] {
    const size = Math.min(pool.length, Math.max(2 * this.o.target, this.o.target + 6), 24)
    const ranked = [...pool].sort((a, b) => compositeScore(b) - compositeScore(a) || a.startS - b.startS || a.id.localeCompare(b.id))
    const out: Candidate[] = []
    for (const c of ranked) {
      if (out.length >= size) break
      if (out.some((f) => timeOverlapFraction(c, f) > MAX_OVERLAP)) continue
      out.push(c)
    }
    return out
  }

  private async judge(finalists: Candidate[], contentType: caps.ContentType): Promise<void> {
    let stored = await this.o.store.load<Record<string, NonNullable<Candidate['verdict']>>>('judgment')
    if (!stored) {
      stored = {}
      if (finalists.length) {
        try {
          const { output } = await this.o.manager.run(caps.judgment, {
            finalists: finalists.map((c) => ({
              id: c.id,
              startLabel: timestamp(c.startS),
              durationS: duration(c),
              momentType: c.momentType,
              topic: c.scores?.topic ?? '',
              midScore: compositeScore(c) * 100,
              text: headAndTail(textOf(this.o.transcript, c)),
            })),
            target: this.o.target,
            contentType,
            examples: this.o.examples,
          })
          for (const [id, v] of output) stored[id] = v
        } catch (error) {
          if (!(error instanceof CapabilityUnavailable)) throw error
          this.log(`Final judgment unavailable (${error.message}); selecting on scores.`)
        }
      }
      await this.o.store.save('judgment', stored)
    }
    for (const c of finalists) {
      const v = stored[c.id]
      if (!v) continue
      c.verdict = v
      if (v.title) c.title = v.title
    }
  }

  // -------------------------------------------------------------------------
  // 3. selection
  // -------------------------------------------------------------------------

  async select(pool: Candidate[], progress: Progress): Promise<Pick[]> {
    const texts = new Map(pool.map((c) => [c.id, textOf(this.o.transcript, c)]))
    progress(0.1, 'Checking for repeats')
    const duplicateRisk = await this.duplicateRisk(pool, texts)
    progress(0.6, `Selecting the best ${this.o.target}`)

    let picks = select(pool, this.o.target, { texts, duplicateRisk })
    if (picks.length < this.o.target) {
      const extra = fallbackCandidates(
        this.o.transcript,
        this.o.silences,
        this.o.limits,
        picks.map((p) => p.candidate),
      )
      this.log(`Only ${picks.length} distinct AI clips qualified; adding filler from ${extra.length} windows.`)
      this.addEnergy(extra)
      for (const c of extra) texts.set(c.id, textOf(this.o.transcript, c))
      picks = select([...pool, ...extra], this.o.target, { texts, duplicateRisk })
    }
    if (picks.length < this.o.target) {
      this.log(`The video only has room for ${picks.length} distinct clips of this length.`)
    }
    for (const p of picks) this.log(`#${p.rank} ${p.candidate.id}: ${explain(p)}`)
    progress(1, `Selected ${picks.length} clips`)
    return picks
  }

  private async duplicateRisk(pool: Candidate[], texts: Map<string, string>): Promise<Map<string, number>> {
    const stored = await this.o.store.load<[string, number][]>('duplicates')
    if (stored) return new Map(stored)

    const top = [...pool]
      .sort((a, b) => compositeScore(b) - compositeScore(a) || a.startS - b.startS)
      .slice(0, 2 * this.o.target)
    const pairs: caps.DuplicatePair[] = []
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i]!
        const b = top[j]!
        if (timeOverlapFraction(a, b) > MAX_OVERLAP) continue
        const similarity = contentJaccard(texts.get(a.id) ?? '', texts.get(b.id) ?? '')
        const flagged = a.verdict?.sameStoryAs.includes(b.id) || b.verdict?.sameStoryAs.includes(a.id)
        if (!flagged && similarity >= 0.12 && similarity < 0.5) {
          pairs.push({ a: a.id, aText: texts.get(a.id) ?? '', b: b.id, bText: texts.get(b.id) ?? '' })
        }
      }
    }
    const result = new Map<string, number>()
    const limited = pairs.slice(0, MAX_DUPLICATE_PAIRS)
    if (limited.length) {
      try {
        const { output } = await this.o.manager.run(caps.duplicates, { pairs: limited })
        for (const [key, p] of output) {
          const [a, b] = key.split('|') as [string, string]
          result.set(pairKey(a, b), p)
        }
      } catch (error) {
        if (!(error instanceof CapabilityUnavailable)) throw error
        this.log(`Duplicate check unavailable (${error.message}); using text similarity only.`)
      }
    }
    await this.o.store.save('duplicates', [...result])
    return result
  }
}

/** The sentence-tagged text for a window of words, and the sentence table. */
function sentenceWindow(transcript: Transcript, firstWord: number, lastWord: number) {
  const firstSentence = transcript.sentenceOf(firstWord)
  const lastSentence = transcript.sentenceOf(lastWord)
  return {
    text: transcript.taggedSentences(firstSentence, lastSentence),
    sentences: transcript.sentences,
    firstSentence,
    lastSentence,
  }
}

/** A moment's opening and ending: what decides whether it works, at a fraction of the tokens. */
function headAndTail(text: string): string {
  if (text.length <= JUDGE_HEAD_CHARS + JUDGE_TAIL_CHARS + 20) return text
  return ` … `
}
function majorityContentType(results: caps.DiscoveryResult[]): caps.ContentType {
  const votes = new Map<caps.ContentType, number>()
  for (const r of results) votes.set(r.contentType, (votes.get(r.contentType) ?? 0) + 1)
  let best: caps.ContentType = 'general'
  let count = 0
  for (const [type, n] of votes) {
    if (n > count) {
      best = type
      count = n
    }
  }
  return count / Math.max(1, results.length) >= 0.6 ? best : 'general'
}

export function timestamp(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
