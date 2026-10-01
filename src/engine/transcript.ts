/**
 * The transcript: the pipeline's shared vocabulary.
 *
 * Every later stage addresses the video through word indices. AI models
 * return indices, never seconds, so clip timing always comes from measured
 * speech timestamps rather than arithmetic a model did in its head. Captions
 * are built from the same words. One model, one source of truth.
 */

export interface Word {
  /** The word as spoken, punctuation attached ("world."). */
  text: string
  start: number
  end: number
}

export interface Silence {
  start: number
  end: number
}

/** A word ending in one of these closes a sentence. */
const SENTENCE_END = /[.!?…।]+["'”’)\]]*$/
/** Mid-sentence breaks. */
const CLAUSE_END = /[,;:—–]+["'”’)\]]*$/

export function endsSentence(word: Word): boolean {
  return SENTENCE_END.test(word.text.trim())
}

export function endsClause(word: Word): boolean {
  const text = word.text.trim()
  return SENTENCE_END.test(text) || CLAUSE_END.test(text)
}

export class Transcript {
  readonly words: Word[]
  private readonly starts: number[]

  constructor(words: Word[]) {
    this.words = words
    this.starts = words.map((w) => w.start)
  }

  get length(): number {
    return this.words.length
  }

  get duration(): number {
    return this.words.at(-1)?.end ?? 0
  }

  /** Index of the word being spoken at `t`, clamped to the valid range. */
  indexAtTime(t: number): number {
    if (!this.words.length) return 0
    // Largest i with starts[i] <= t.
    let lo = 0
    let hi = this.starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.starts[mid]! <= t) lo = mid + 1
      else hi = mid
    }
    return Math.max(0, Math.min(lo - 1, this.words.length - 1))
  }

  /** Inclusive index range of words overlapping [start, end). */
  indicesInRange(start: number, end: number): [number, number] {
    if (!this.words.length) return [0, -1]
    let first = this.indexAtTime(start)
    if (this.words[first]!.end <= start && first < this.words.length - 1) first += 1
    let last = this.indexAtTime(end)
    if (this.words[last]!.start >= end) last -= 1
    return [first, Math.max(first - 1, last)]
  }

  clamp(index: number): number {
    return Math.max(0, Math.min(index, this.words.length - 1))
  }

  /** Seconds spanned by an inclusive index range. */
  timeRange(first: number, last: number): [number, number] {
    if (!this.words.length) return [0, 0]
    const a = this.clamp(first)
    const b = Math.max(a, this.clamp(last))
    return [this.words[a]!.start, this.words[b]!.end]
  }

  slice(first: number, last: number): Word[] {
    if (!this.words.length) return []
    const a = this.clamp(first)
    const b = Math.max(a, this.clamp(last))
    return this.words.slice(a, b + 1)
  }

  textBetween(first: number, last: number): string {
    return this.slice(first, last)
      .map((w) => w.text.trim())
      .join(' ')
      .trim()
  }

  /** `[index]word` rendering so a model can cite exact positions by copying. */
  tagged(first: number, last: number): string {
    const parts: string[] = []
    const end = Math.min(last, this.words.length - 1)
    for (let i = Math.max(0, first); i <= end; i++) parts.push(`[${i}]${this.words[i]!.text.trim()}`)
    return parts.join(' ')
  }

  private sentenceCache: [number, number][] | null = null

  /**
   * Sentences as inclusive word ranges. Models cite sentence numbers instead
   * of word numbers: one tag per sentence instead of one per word cuts the
   * prompt by more than half, and clips snap to sentence edges anyway.
   * Long unpunctuated runs are split so a sentence never exceeds ~35 words.
   */
  get sentences(): [number, number][] {
    if (!this.sentenceCache) {
      const out: [number, number][] = []
      let start = 0
      for (let i = 0; i < this.words.length; i++) {
        const length = i - start + 1
        const word = this.words[i]!
        if (endsSentence(word) || (length >= 20 && endsClause(word)) || length >= 35 || i === this.words.length - 1) {
          out.push([start, i])
          start = i + 1
        }
      }
      this.sentenceCache = out
    }
    return this.sentenceCache
  }

  /** Index of the sentence containing word `index`. */
  sentenceOf(index: number): number {
    const s = this.sentences
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid]![0] <= index) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** `[s12] sentence text` lines for sentences first..last (inclusive). */
  taggedSentences(first: number, last: number): string {
    const s = this.sentences
    const lines: string[] = []
    for (let i = Math.max(0, first); i <= Math.min(last, s.length - 1); i++) {
      lines.push(`[s${i}] ${this.textBetween(s[i]![0], s[i]![1])}`)
    }
    return lines.join('\n')
  }
}

/** Reads a sentence reference like 12, "12" or "s12". */
export function sentenceRef(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') {
    const m = /^\s*s?(\d+)\s*$/i.exec(value)
    if (m) return Number(m[1])
  }
  return null
}

/**
 * Cleans raw speech-to-text words: sorts, drops empties, and repairs
 * zero-length or overlapping timings (some models report start == end).
 */
export function tidyWords(words: Word[]): Word[] {
  const sorted = words
    .filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start)

  for (let i = 0; i < sorted.length; i++) {
    const word = sorted[i]!
    const next = sorted[i + 1]
    // A word lasts at least ~80 ms per 3 characters, but never into the next word.
    const minimum = word.start + Math.min(0.6, Math.max(0.08, word.text.length * 0.045))
    let end = Math.max(word.end, minimum)
    if (next) end = Math.min(end, Math.max(word.start + 0.02, next.start))
    word.end = end
  }
  return sorted
}

/**
 * Spreads a text-only transcript over a time span, for speech models that do
 * not return word timings. Words are placed proportionally to their length
 * across the speech inside the span, skipping measured silences, which keeps
 * captions within a fraction of a second on normal speech.
 */
export function estimateWordTimes(text: string, start: number, end: number, silences: Silence[]): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length || end <= start) return []

  // Speech intervals inside [start, end].
  const speech: [number, number][] = []
  let cursor = start
  for (const s of silences) {
    if (s.end <= start || s.start >= end) continue
    if (s.start > cursor) speech.push([cursor, Math.min(s.start, end)])
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < end) speech.push([cursor, end])
  const total = speech.reduce((sum, [a, b]) => sum + (b - a), 0)
  if (total <= 0.05) speech.splice(0, speech.length, [start, end])
  const speechTotal = speech.reduce((sum, [a, b]) => sum + (b - a), 0)

  const weights = tokens.map((t) => Math.max(1, [...t].length) + 1)
  const weightTotal = weights.reduce((a, b) => a + b, 0)

  // Map a position along the speech-only timeline to real time.
  const at = (offset: number) => {
    let remaining = offset
    for (const [a, b] of speech) {
      if (remaining <= b - a) return a + remaining
      remaining -= b - a
    }
    return speech.at(-1)![1]
  }

  const words: Word[] = []
  let acc = 0
  tokens.forEach((token, i) => {
    const from = (acc / weightTotal) * speechTotal
    acc += weights[i]!
    const to = (acc / weightTotal) * speechTotal
    words.push({ text: token, start: at(from), end: at(to) })
  })
  return words
}
