/**
 * Caption styles and word grouping.
 *
 * Grouping decides readability; the style decides whether it looks like a
 * real short or a subtitle track. Sizes are fractions of the frame height so
 * a preset looks the same at any resolution. Drawing lives in media/draw.ts.
 */

import { type Word, endsSentence } from './transcript'

export interface CaptionStyle {
  key: string
  label: string
  description: string
  font: string
  weight: number
  /** Font size as a fraction of frame height. */
  sizeRatio: number
  primary: string
  /** Colour of the word being spoken; null disables highlighting. */
  accent: string | null
  outline: string
  /** Outline width as a fraction of font size. */
  outlineRatio: number
  shadow: boolean
  allCaps: boolean
  /** Distance of the caption's bottom edge from the frame bottom, as a fraction of height. */
  marginRatio: number
  maxWords: number
  animation: 'none' | 'scale' | 'karaoke'
  scale: number
  boxed: boolean
  boxColour: string
}

export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  bold_pop: {
    key: 'bold_pop',
    label: 'Bold Pop',
    description: 'Chunky white with a heavy outline; the spoken word grows and turns yellow.',
    font: 'Anton',
    weight: 400,
    sizeRatio: 0.062,
    primary: '#FFFFFF',
    accent: '#FFE500',
    outline: '#000000',
    outlineRatio: 0.16,
    shadow: true,
    allCaps: true,
    marginRatio: 0.24,
    maxWords: 4,
    animation: 'scale',
    scale: 1.16,
    boxed: false,
    boxColour: 'rgba(0,0,0,0.7)',
  },
  karaoke_fill: {
    key: 'karaoke_fill',
    label: 'Karaoke Fill',
    description: 'Words fill with colour exactly as they are spoken.',
    font: 'Anton',
    weight: 400,
    sizeRatio: 0.058,
    primary: '#FFFFFF',
    accent: '#31E981',
    outline: '#000000',
    outlineRatio: 0.14,
    shadow: true,
    allCaps: true,
    marginRatio: 0.24,
    maxWords: 5,
    animation: 'karaoke',
    scale: 1,
    boxed: false,
    boxColour: 'rgba(0,0,0,0.7)',
  },
  clean_lower: {
    key: 'clean_lower',
    label: 'Clean Lower',
    description: 'Minimal lower third, no animation. For talks and professional cuts.',
    font: 'Inter',
    weight: 600,
    sizeRatio: 0.034,
    primary: '#FFFFFF',
    accent: null,
    outline: '#000000',
    outlineRatio: 0.1,
    shadow: true,
    allCaps: false,
    marginRatio: 0.1,
    maxWords: 8,
    animation: 'none',
    scale: 1,
    boxed: false,
    boxColour: 'rgba(0,0,0,0.7)',
  },
  boxed: {
    key: 'boxed',
    label: 'Boxed',
    description: 'High-contrast text on a solid block. Readable on any footage.',
    font: 'Anton',
    weight: 400,
    sizeRatio: 0.052,
    primary: '#FFFFFF',
    accent: '#FF4D4D',
    outline: '#000000',
    outlineRatio: 0,
    shadow: false,
    allCaps: true,
    marginRatio: 0.24,
    maxWords: 4,
    animation: 'scale',
    scale: 1.1,
    boxed: true,
    boxColour: 'rgba(0,0,0,0.72)',
  },
  none: {
    key: 'none',
    label: 'No captions',
    description: 'Clean video without burned-in text.',
    font: 'Inter',
    weight: 600,
    sizeRatio: 0.03,
    primary: '#FFFFFF',
    accent: null,
    outline: '#000000',
    outlineRatio: 0,
    shadow: false,
    allCaps: false,
    marginRatio: 0.1,
    maxWords: 6,
    animation: 'none',
    scale: 1,
    boxed: false,
    boxColour: 'transparent',
  },
}

export const DEFAULT_CAPTION_STYLE = 'bold_pop'

/** The creator's own tweaks on top of a preset (the "brand kit"). */
export interface CaptionCustom {
  font?: 'Anton' | 'Inter' | 'System'
  primary?: string
  accent?: string
  /** Size multiplier, 0.7..1.5. */
  size?: number
  position?: 'bottom' | 'middle' | 'top'
  allCaps?: boolean
}

export const CAPTION_FONTS: Record<NonNullable<CaptionCustom['font']>, { family: string; weight: number }> = {
  Anton: { family: 'Anton', weight: 400 },
  Inter: { family: 'Inter', weight: 700 },
  System: { family: 'system-ui', weight: 800 },
}

/** A preset with the creator's tweaks applied. */
export function resolveStyle(key: string, custom: CaptionCustom = {}): CaptionStyle {
  const base = CAPTION_STYLES[key] ?? CAPTION_STYLES[DEFAULT_CAPTION_STYLE]!
  const font = custom.font ? CAPTION_FONTS[custom.font] : null
  const size = Math.max(0.7, Math.min(1.5, custom.size ?? 1))
  const marginRatio = custom.position === 'top' ? 0.8 : custom.position === 'middle' ? 0.42 : base.marginRatio
  return {
    ...base,
    font: font?.family ?? base.font,
    weight: font?.weight ?? base.weight,
    primary: custom.primary ?? base.primary,
    accent: base.accent === null ? null : (custom.accent ?? base.accent),
    sizeRatio: base.sizeRatio * size,
    marginRatio,
    allCaps: custom.allCaps ?? base.allCaps,
  }
}

/** Output shapes, with the share of the frame each platform's on-screen buttons cover. */
export const ASPECTS = {
  '9:16': { w: 1080, h: 1920, label: '9:16 · Shorts, Reels, TikTok', safeBottom: 0.2, safeTop: 0.12 },
  '4:5': { w: 1080, h: 1350, label: '4:5 · Instagram feed', safeBottom: 0.08, safeTop: 0.06 },
  '1:1': { w: 1080, h: 1080, label: '1:1 · Square feed', safeBottom: 0.08, safeTop: 0.06 },
} as const

export type AspectKey = keyof typeof ASPECTS

/** WebVTT from SRT text (same cues, VTT header and dot decimals). */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n(?=\d{2}:)/gm, '')
  return `WEBVTT\n\n${body}`
}

export interface CaptionGroup {
  words: Word[]
  start: number
  /** When the caption leaves the screen (held until the next group, briefly). */
  end: number
}

/**
 * Splits words into caption-sized groups. Breaks on sentence punctuation, a
 * pause longer than `maxGapS`, and the word ceiling, in that priority, so a
 * caption rarely spans two sentences.
 */
export function groupWords(words: Word[], maxWords: number, maxGapS = 0.4): CaptionGroup[] {
  const groups: Word[][] = []
  let current: Word[] = []
  words.forEach((word, i) => {
    if (current.length) {
      const gap = word.start - current.at(-1)!.end
      if (gap > maxGapS || current.length >= maxWords) {
        groups.push(current)
        current = []
      }
    }
    current.push(word)
    if (endsSentence(word) && i < words.length - 1) {
      groups.push(current)
      current = []
    }
  })
  if (current.length) groups.push(current)

  return groups.map((g, i) => {
    const next = groups[i + 1]
    const end = g.at(-1)!.end
    // Hold briefly so the caption doesn't blink out between close groups.
    const hold = next ? Math.min(next[0]!.start, end + 0.35) : end + 0.35
    return { words: g, start: g[0]!.start, end: Math.max(end, hold) }
  })
}

/** Rebases words onto a clip's timeline and keeps only those inside it. */
export function clipWords(words: Word[], startS: number, endS: number): Word[] {
  return words
    .filter((w) => w.end > startS && w.start < endS)
    .map((w) => ({ text: w.text, start: Math.max(0, w.start - startS), end: Math.min(endS, w.end) - startS }))
}

/** Index of the group visible at time t, or -1. */
export function groupAt(groups: CaptionGroup[], t: number): number {
  let lo = 0
  let hi = groups.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (groups[mid]!.start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (found < 0) return -1
  return t < groups[found]!.end ? found : -1
}

/** Plain SRT text for a clip, for platforms that want an upload-time file. */
export function toSrt(words: Word[]): string {
  const fmt = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000))
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const sec = Math.floor((ms % 60_000) / 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }
  return groupWords(words, 8)
    .map((g, i) => `${i + 1}\n${fmt(g.start)} --> ${fmt(g.words.at(-1)!.end)}\n${g.words.map((w) => w.text).join(' ')}\n`)
    .join('\n')
}
