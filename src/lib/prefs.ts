/**
 * Things HustlClip remembers on this phone between jobs: the caption brand
 * kit and output shape, and which clips the creator posted or passed on
 * (fed to the final judge so picks learn their taste).
 */

import type { AspectKey, CaptionCustom } from '../engine/captions'

const BRAND_KEY = 'hustlclip-brand'
const TASTE_KEY = 'hustlclip-taste'

export interface Brand {
  captionStyle: string
  custom: CaptionCustom
  aspect: AspectKey
  zoom: boolean
}

export const DEFAULT_BRAND: Brand = { captionStyle: 'bold_pop', custom: {}, aspect: '9:16', zoom: true }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private mode: not remembered
  }
}

export const brand = {
  load: (): Brand => read(BRAND_KEY, DEFAULT_BRAND),
  save: (value: Brand) => write(BRAND_KEY, value),
}

interface TasteEntry {
  title: string
  verdict: 'posted' | 'skip'
  at: number
}

export const taste = {
  record(title: string, verdict: 'posted' | 'skip' | null): void {
    const list = read<{ items: TasteEntry[] }>(TASTE_KEY, { items: [] }).items.filter((e) => e.title !== title)
    if (verdict) list.push({ title, verdict, at: Date.now() })
    write(TASTE_KEY, { items: list.slice(-60) })
  },
  /** The most recent few of each, for the judge's prompt. */
  examples(): { posted: string[]; skipped: string[] } {
    const items = read<{ items: TasteEntry[] }>(TASTE_KEY, { items: [] }).items
    const pick = (v: TasteEntry['verdict']) =>
      items
        .filter((e) => e.verdict === v)
        .slice(-6)
        .map((e) => e.title)
    return { posted: pick('posted'), skipped: pick('skip') }
  },
}
