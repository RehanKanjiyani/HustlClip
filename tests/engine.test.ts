import { describe, expect, it } from 'vitest'

import { refine, snapEnd, snapStart } from '../src/engine/boundaries'
import { clipWords, groupAt, groupWords, toSrt } from '../src/engine/captions'
import { type Candidate, fallbackCandidates, mergeDuplicates, normalize, timeOverlapFraction } from '../src/engine/candidates'
import { discovery, judgment, scoring, unit } from '../src/engine/capabilities'
import { extractJsonObject } from '../src/engine/json'
import { MAX_OVERLAP, compositeScore, select } from '../src/engine/selection'
import { Transcript, type Word, estimateWordTimes, tidyWords } from '../src/engine/transcript'
import { buildWindows } from '../src/engine/windows'

/** A synthetic talk: sentences of 8 words, 0.4 s per word, 0.3 s pause between sentences. */
function talk(sentences: number): Word[] {
  const words: Word[] = []
  let t = 0
  for (let s = 0; s < sentences; s++) {
    for (let w = 0; w < 8; w++) {
      const last = w === 7
      words.push({ text: `w${s}_${w}${last ? '.' : ''}`, start: t, end: t + 0.35 })
      t += 0.4
    }
    t += 0.3
  }
  return words
}

function candidate(id: string, startS: number, endS: number, extra: Partial<Candidate> = {}): Candidate {
  return {
    id,
    startWord: Math.round(startS * 2),
    endWord: Math.round(endS * 2),
    startS,
    endS,
    momentType: 'insight',
    source: 'ai',
    initialScore: 0.6,
    title: id,
    hook: '',
    reason: '',
    proposals: 1,
    speechDensity: 2,
    silenceRatio: 0,
    ...extra,
  }
}

describe('transcript', () => {
  it('repairs zero-length words without overlapping the next word', () => {
    const tidy = tidyWords([
      { text: 'back', start: 0.64, end: 0.64 },
      { text: 'to', start: 0.72, end: 0.72 },
      { text: 'the', start: 1.04, end: 1.04 },
    ])
    expect(tidy[0]!.end).toBeGreaterThan(0.64)
    expect(tidy[0]!.end).toBeLessThanOrEqual(0.72)
    expect(tidy.every((w) => w.end > w.start)).toBe(true)
  })

  it('estimates word times inside a span and skips silences', () => {
    const words = estimateWordTimes('one two three four', 10, 14, [{ start: 11, end: 12 }])
    expect(words).toHaveLength(4)
    expect(words[0]!.start).toBe(10)
    expect(words.at(-1)!.end).toBeCloseTo(14, 5)
    expect(words.some((w) => w.start > 11 && w.start < 12)).toBe(false)
  })

  it('finds words by time', () => {
    const t = new Transcript(talk(3))
    expect(t.indexAtTime(0)).toBe(0)
    expect(t.indexAtTime(0.45)).toBe(1)
    expect(t.indexAtTime(999)).toBe(t.length - 1)
  })
})

describe('boundaries', () => {
  const t = new Transcript(talk(20))

  it('snaps to sentence edges', () => {
    expect(snapStart(t, 10)).toBe(8)
    expect(snapEnd(t, 12)).toBe(15)
  })

  it('refines into the length limits', () => {
    const b = refine(t, 9, 60, [], { minS: 10, maxS: 20 })!
    expect(b).not.toBeNull()
    expect(b.endS - b.startS).toBeLessThanOrEqual(20)
    expect(b.endS - b.startS).toBeGreaterThanOrEqual(10)
    expect(t.words[b.startWord - 1]?.text.endsWith('.') ?? true).toBe(true)
  })

  it('rejects ranges that cannot fit', () => {
    expect(refine(new Transcript(talk(1)), 0, 7, [], { minS: 30, maxS: 60 })).toBeNull()
  })
})

describe('candidates and selection', () => {
  it('merges near-identical proposals', () => {
    const merged = mergeDuplicates([
      candidate('a', 0, 20, { startWord: 0, endWord: 40, initialScore: 0.7 }),
      candidate('b', 1, 21, { startWord: 2, endWord: 42, initialScore: 0.6 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.proposals).toBe(2)
  })

  it('never selects overlapping clips and returns exactly the target when possible', () => {
    const pool = Array.from({ length: 30 }, (_, i) => candidate(`c${i}`, i * 15, i * 15 + 25, { initialScore: 0.3 + (i % 7) / 10 }))
    const picks = select(pool, 10)
    expect(picks).toHaveLength(10)
    for (const a of picks) {
      for (const b of picks) {
        if (a !== b) expect(timeOverlapFraction(a.candidate, b.candidate)).toBeLessThanOrEqual(MAX_OVERLAP)
      }
    }
    expect(picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('ranks judge-kept clips above judge-rejected ones', () => {
    const kept = candidate('k', 0, 20, { verdict: { keep: true, score: 0.7, title: '', reason: '', sameStoryAs: [] } })
    const rejected = candidate('r', 100, 120, { verdict: { keep: false, score: 0.9, title: '', reason: '', sameStoryAs: [] } })
    const picks = select([rejected, kept], 2)
    expect(picks[0]!.candidate.id).toBe('k')
  })

  it('fills the count with fallback windows that never overlap chosen clips', () => {
    const t = new Transcript(talk(120))
    const chosen = [candidate('x', 0, 30)]
    const extra = fallbackCandidates(t, [], { minS: 15, maxS: 40 }, chosen)
    expect(extra.length).toBeGreaterThan(5)
    expect(extra.every((c) => c.source === 'fallback')).toBe(true)
    expect(extra.every((c) => timeOverlapFraction(c, chosen[0]!) === 0)).toBe(true)
    expect(Math.max(...extra.map(compositeScore))).toBeLessThanOrEqual(0.45)
  })

  it('normalises proposals into measured candidates', () => {
    const t = new Transcript(talk(40))
    const { candidates, report } = normalize(
      t,
      [
        { startWord: 17, endWord: 70, momentType: 'story_payoff', initialScore: 0.8, title: 'x', hook: '', reason: '' },
        { startWord: 70, endWord: 60, momentType: 'other', initialScore: 0.5, title: 'bad', hook: '', reason: '' },
      ],
      [],
      { minS: 10, maxS: 30 },
    )
    expect(report.noValidBoundary).toBe(1)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.startWord).toBe(16)
  })
})

describe('capability parsing', () => {
  it('keeps the complete moments from an answer that was cut off', () => {
    const payload = { text: '', firstWord: 0, lastWord: 500, minS: 10, maxS: 60, maxCandidates: 8 }
    const cut =
      '{"content_type": "stream", "candidates": [' +
      '{"start_word_index": 10, "end_word_index": 80, "type": "reaction", "initial_score": 0.8, "title": "A"},' +
      '{"start_word_index": 120, "end_word_index": 200, "type": "punchline", "initial_score": 0.7, "title": "B"},' +
      '{"start_word_index": 300, "end_word_index": 3'
    const out = discovery.parse(cut, payload)
    expect(out.candidates.map((c) => c.title)).toEqual(['A', 'B'])
    expect(out.contentType).toBe('stream')
  })

  it('extracts JSON after reasoning and fences', () => {
    expect(extractJsonObject('<think>{"no": 1}</think>Sure!\n```json\n{"a": [1, 2,]}\n```')).toEqual({ a: [1, 2] })
  })

  it('coerces scales', () => {
    expect(unit(85)).toBeCloseTo(0.85)
    expect(unit(7)).toBeCloseTo(0.7)
    expect(unit(0.4)).toBeCloseTo(0.4)
  })

  it('drops discovery ranges outside the window and rejects all-invalid answers', () => {
    const payload = { text: '', firstWord: 100, lastWord: 200, minS: 10, maxS: 60, maxCandidates: 5 }
    const ok = discovery.parse(
      '{"content_type":"stream","candidates":[{"start_word_index":90,"end_word_index":150,"type":"reaction","initial_score":80},{"start_word_index":500,"end_word_index":600}]}',
      payload,
    )
    expect(ok.candidates).toHaveLength(1)
    expect(ok.candidates[0]!.startWord).toBe(100)
    expect(ok.contentType).toBe('stream')
    expect(() => discovery.parse('{"candidates":[{"start_word_index":500,"end_word_index":600}]}', payload)).toThrow()
    expect(() => discovery.parse('not json', payload)).toThrow()
  })

  it('requires enough scores and ignores invented ids', () => {
    const item = { id: 'c1', taggedText: '', candidateFirst: 10, candidateLast: 20, contextFirst: 0, contextLast: 30, durationS: 20, momentType: 'other' as const }
    const reply = JSON.stringify({
      scores: [
        { candidate_id: 'c1', hook: 8, context: 7, payoff: 9, emotion: 6, curiosity: 7, quotability: 8, retention: 8, overall: 82, start_word_index: 5, end_word_index: 25 },
        { candidate_id: 'ghost', hook: 9, overall: 99 },
      ],
    })
    const out = scoring.parse(reply, { items: [item], contentType: 'general', minS: 10, maxS: 60 })
    expect(out.get('c1')!.overall).toBeCloseTo(0.82)
    expect(out.get('c1')!.startWord).toBe(5)
    expect(out.has('ghost')).toBe(false)
  })

  it('keeps same-story links only to known finalists', () => {
    const f = (id: string) => ({ id, startLabel: '0:00', durationS: 30, momentType: 'other' as const, topic: '', midScore: 50, text: '' })
    const out = judgment.parse(
      '{"verdicts":[{"candidate_id":"a","keep":true,"score":90,"same_story_as":["b","zzz"]},{"candidate_id":"b","keep":false,"score":40}]}',
      { finalists: [f('a'), f('b')], target: 2, contentType: 'general' },
    )
    expect(out.get('a')!.sameStoryAs).toEqual(['b'])
  })
})

describe('windows and captions', () => {
  it('covers the whole transcript with overlapping windows', () => {
    const t = new Transcript(talk(400))
    const windows = buildWindows(t, 120, 20)
    expect(windows[0]!.firstWord).toBe(0)
    expect(windows.at(-1)!.lastWord).toBe(t.length - 1)
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.firstWord).toBeLessThanOrEqual(windows[i - 1]!.lastWord)
  })

  it('groups caption words by sentence and size', () => {
    const groups = groupWords(talk(2), 4)
    expect(groups.map((g) => g.words.length)).toEqual([4, 4, 4, 4])
    expect(groupAt(groups, 0.1)).toBe(0)
    expect(groupAt(groups, 100)).toBe(-1)
  })

  it('rebases words onto a clip and writes SRT', () => {
    const words = clipWords(talk(3), 3.5, 7)
    expect(words[0]!.start).toBeGreaterThanOrEqual(0)
    expect(toSrt(words)).toMatch(/^1\n00:00:00,\d{3} --> /)
  })
})
