import { useEffect, useMemo, useState } from 'react'

import { ASPECTS, type AspectKey, CAPTION_FONTS, CAPTION_STYLES, type CaptionCustom, resolveStyle } from '../engine/captions'
import { alignEnd, alignStart } from '../engine/boundaries'
import { Transcript, type Word } from '../engine/transcript'
import type { Brand } from '../lib/prefs'
import { type ClipRecord, type PoolEntry, jobStore } from '../lib/store'
import { findSilences } from '../media/audio'
import { formatDuration } from './format'

// ---------------------------------------------------------------------------
// Caption studio: preset + brand-kit tweaks + shape, with a live preview
// ---------------------------------------------------------------------------

const SWATCHES = ['#FFFFFF', '#FFE500', '#31E981', '#FF4D4D', '#4DA3FF', '#FF8F42', '#C77DFF', '#000000']

export function CaptionStudio({ value, onChange }: { value: Brand; onChange: (next: Brand) => void }) {
  const style = resolveStyle(value.captionStyle, value.custom)
  const set = (patch: Partial<Brand>) => onChange({ ...value, ...patch })
  const setCustom = (patch: Partial<CaptionCustom>) => set({ custom: { ...value.custom, ...patch } })
  const aspect = ASPECTS[value.aspect]
  const previewW = 108
  const previewH = Math.round((previewW * aspect.h) / aspect.w)
  const fontFamily = style.font === 'system-ui' ? 'system-ui' : style.font

  return (
    <div className="space-y-4 text-sm">
      <div className="flex gap-4">
        <div
          className="relative shrink-0 overflow-hidden bg-gradient-to-b from-ink-700 to-ink-850"
          style={{ width: previewW, height: previewH }}
          aria-label="Caption preview"
        >
          {style.key !== 'none' && (
            <div
              className="absolute inset-x-1 text-center leading-tight"
              style={{
                bottom: `${Math.max(aspect.safeBottom, Math.min(1 - aspect.safeTop - 0.1, style.marginRatio)) * 100}%`,
                fontFamily,
                fontWeight: style.weight,
                fontSize: Math.max(9, previewW * 0.16 * (style.sizeRatio / 0.062)),
                textTransform: style.allCaps ? 'uppercase' : 'none',
                color: style.primary,
                textShadow: style.outlineRatio ? `0 0 2px ${style.outline}, 0 0 1px ${style.outline}` : undefined,
              }}
            >
              <span style={style.boxed ? { background: style.boxColour, padding: '0 3px' } : undefined}>
                make <span style={{ color: style.accent ?? style.primary }}>this</span> viral
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <label className="block">
            <span className="eyebrow">Style</span>
            <select className="field mt-1" value={value.captionStyle} onChange={(e) => set({ captionStyle: e.target.value })}>
              {Object.values(CAPTION_STYLES).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow">Shape</span>
            <select className="field mt-1" value={value.aspect} onChange={(e) => set({ aspect: e.target.value as AspectKey })}>
              {(Object.keys(ASPECTS) as AspectKey[]).map((k) => (
                <option key={k} value={k}>
                  {ASPECTS[k].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {style.key !== 'none' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="eyebrow">Font</span>
              <select
                className="field mt-1"
                value={value.custom.font ?? ''}
                onChange={(e) => setCustom({ font: (e.target.value || undefined) as CaptionCustom['font'] })}
              >
                <option value="">Style default</option>
                {Object.keys(CAPTION_FONTS).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow">Position</span>
              <select
                className="field mt-1"
                value={value.custom.position ?? 'bottom'}
                onChange={(e) => setCustom({ position: e.target.value as CaptionCustom['position'] })}
              >
                <option value="bottom">Bottom</option>
                <option value="middle">Middle</option>
                <option value="top">Top</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="eyebrow">Size: {Math.round((value.custom.size ?? 1) * 100)}%</span>
            <input
              type="range"
              min={70}
              max={150}
              step={5}
              value={Math.round((value.custom.size ?? 1) * 100)}
              onChange={(e) => setCustom({ size: Number(e.target.value) / 100 })}
              className="mt-2 w-full accent-[var(--color-sodium-500)]"
            />
          </label>
          <Swatches label="Text colour" value={style.primary} onPick={(c) => setCustom({ primary: c })} />
          {style.accent !== null && (
            <Swatches label="Highlight colour" value={style.accent} onPick={(c) => setCustom({ accent: c })} />
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.allCaps} onChange={(e) => setCustom({ allCaps: e.target.checked })} />
            <span>ALL CAPS</span>
          </label>
        </>
      )}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value.zoom} onChange={(e) => set({ zoom: e.target.checked })} />
        <span>Slow zoom on still shots</span>
      </label>
    </div>
  )
}

function Swatches({ label, value, onPick }: { label: string; value: string; onPick: (c: string) => void }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <div className="mt-2 flex flex-wrap gap-2">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => onPick(c)}
            className={`h-8 w-8 rounded-full border-2 ${value.toUpperCase() === c ? 'border-sodium-500' : 'border-ink-700'}`}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trim by sentence
// ---------------------------------------------------------------------------

export interface TrimResult {
  startWord: number
  endWord: number
  startS: number
  endS: number
}

export function TrimPanel({ jobId, clip, onApply }: { jobId: string; clip: ClipRecord; onApply: (r: TrimResult) => void }) {
  const [data, setData] = useState<{ t: Transcript; silences: ReturnType<typeof findSilences> } | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)

  useEffect(() => {
    const store = jobStore(jobId)
    void Promise.all([store.load<Word[]>('transcript'), store.load<{ energy: Float32Array }>('audio_meta')]).then(([words, meta]) => {
      if (!words) return
      const t = new Transcript(words)
      const silences = meta ? findSilences(meta.energy) : []
      const startWord = clip.startWord ?? t.indexAtTime(clip.startS + 0.3)
      const endWord = clip.endWord ?? t.indexAtTime(Math.max(clip.startS, clip.endS - 0.3))
      setData({ t, silences })
      setRange([t.sentenceOf(startWord), t.sentenceOf(endWord)])
    })
  }, [jobId, clip])

  const result = useMemo<TrimResult | null>(() => {
    if (!data || !range) return null
    const s = data.t.sentences
    const [a, b] = range
    const startWord = s[a]![0]
    const endWord = s[b]![1]
    return {
      startWord,
      endWord,
      startS: alignStart(data.t.words[startWord]!.start, data.silences),
      endS: alignEnd(data.t.words[endWord]!.end, data.silences),
    }
  }, [data, range])

  if (!data || !range || !result) return <p className="text-xs text-ink-500">Loading the transcript…</p>
  const s = data.t.sentences
  const [a, b] = range
  const move = (which: 0 | 1, delta: number) => {
    const next: [number, number] = [...range]
    next[which] = Math.max(0, Math.min(s.length - 1, next[which] + delta))
    if (next[0] > next[1]) return
    setRange(next)
  }
  const changed = result.startWord !== clip.startWord || result.endWord !== clip.endWord

  return (
    <div className="space-y-3 border-l border-ink-800 pl-3 text-xs">
      <TrimRow
        label="Starts with"
        text={data.t.textBetween(s[a]![0], s[a]![1])}
        onEarlier={() => move(0, -1)}
        onLater={() => move(0, 1)}
      />
      <TrimRow
        label="Ends with"
        text={data.t.textBetween(s[b]![0], s[b]![1])}
        onEarlier={() => move(1, -1)}
        onLater={() => move(1, 1)}
      />
      <div className="flex items-center justify-between">
        <span className="numeric text-ink-400">New length {formatDuration(result.endS - result.startS)}</span>
        <button type="button" className="btn btn-primary text-xs" disabled={!changed} onClick={() => onApply(result)}>
          Re-render this clip
        </button>
      </div>
    </div>
  )
}

function TrimRow({ label, text, onEarlier, onLater }: { label: string; text: string; onEarlier: () => void; onLater: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <span className="flex gap-1">
          <button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={onEarlier}>
            ◀ earlier
          </button>
          <button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={onLater}>
            later ▶
          </button>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-ink-300">“{text}”</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// More moments: runner-ups the creator can add as clips
// ---------------------------------------------------------------------------

export function MoreMoments({ jobId, clips, onAdd }: { jobId: string; clips: ClipRecord[]; onAdd: (p: PoolEntry) => void }) {
  const [pool, setPool] = useState<PoolEntry[] | null>(null)
  useEffect(() => {
    void jobStore(jobId)
      .load<PoolEntry[]>('pool')
      .then((p) => setPool(p ?? []))
  }, [jobId])
  if (!pool) return <p className="text-xs text-ink-500">Loading…</p>
  const overlaps = (p: PoolEntry) =>
    clips.some((c) => {
      const overlap = Math.min(c.endS, p.endS) - Math.max(c.startS, p.startS)
      return overlap > 0.15 * Math.min(c.endS - c.startS, p.endS - p.startS)
    })
  const free = pool.filter((p) => !overlaps(p)).slice(0, 12)
  if (!free.length) {
    return <p className="text-xs text-ink-500">No other strong moments that don't overlap your clips.</p>
  }
  return (
    <ul className="space-y-3">
      {free.map((p) => (
        <li key={p.id} className="flex items-start justify-between gap-3 border-b rule pb-3">
          <span className="min-w-0">
            <span className="numeric block text-xs text-ink-500">
              Score {p.score} · {formatDuration(p.endS - p.startS)} · at {formatDuration(p.startS)}
            </span>
            <span className="block text-sm text-ink-100">{p.title}</span>
            {p.reasons.length > 0 && <span className="block text-xs text-ink-400">{p.reasons.join(' · ')}</span>}
          </span>
          <button type="button" className="btn btn-ghost shrink-0 text-xs" onClick={() => onAdd(p)}>
            Add clip
          </button>
        </li>
      ))}
    </ul>
  )
}
