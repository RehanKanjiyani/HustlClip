import { useEffect, useRef, useState } from 'react'

import { LANGUAGES, type LanguageChoice, type ProviderId } from '../../shared/models'
import { ASPECTS, CAPTION_STYLES } from '../engine/captions'
import { type Brand, brand } from '../lib/prefs'
import { newJob } from '../pipeline/job'
import { type JobRecord, jobs } from '../lib/store'
import { navigate } from './nav'
import { formatAgo, formatBytes } from './format'
import { attachFile, start } from './runs'
import { CaptionStudio } from './Studio'

const LENGTHS = [
  { id: 'short', label: '15–45 s', minS: 15, maxS: 45 },
  { id: 'medium', label: '25–60 s', minS: 25, maxS: 60 },
  { id: 'long', label: '40–90 s', minS: 40, maxS: 90 },
] as const

interface Options {
  count: number
  length: (typeof LENGTHS)[number]['id']
  language: LanguageChoice
}

const DEFAULTS: Options = { count: 10, length: 'medium', language: 'en' }

function loadOptions(): Options {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('hustlclip-options') ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function Home({
  sharedFile,
  onSharedUsed,
  providers,
}: {
  sharedFile: File | null
  onSharedUsed: () => void
  providers: ProviderId[]
}) {
  const [file, setFile] = useState<File | null>(null)
  const [options, setOptions] = useState<Options>(loadOptions)
  const [showOptions, setShowOptions] = useState(false)
  const [showStudio, setShowStudio] = useState(false)
  const [brandKit, setBrandKit] = useState<Brand>(brand.load)
  const updateBrand = (next: Brand) => {
    setBrandKit(next)
    brand.save(next)
  }
  const [recent, setRecent] = useState<JobRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    jobs.list().then(setRecent).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (sharedFile) {
      setFile(sharedFile)
      onSharedUsed()
    }
  }, [sharedFile, onSharedUsed])

  const set = (patch: Partial<Options>) => {
    const next = { ...options, ...patch }
    setOptions(next)
    try {
      localStorage.setItem('hustlclip-options', JSON.stringify(next))
    } catch {
      // private mode: options just aren't remembered
    }
  }

  const go = async () => {
    if (!file) return
    setError(null)
    const length = LENGTHS.find((l) => l.id === options.length) ?? LENGTHS[1]
    const job = newJob(file, {
      language: options.language,
      captionStyle: brandKit.captionStyle,
      captionCustom: brandKit.custom,
      aspect: brandKit.aspect,
      zoom: brandKit.zoom,
      count: options.count,
      minS: length.minS,
      maxS: length.maxS,
    })
    try {
      await jobs.put(job)
      attachFile(job.id, file)
      void start(job.id, providers).catch((e: Error) => setError(e.message))
      navigate({ page: 'job', id: job.id })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="pt-8">
      <div className="rise">
        <h1 className="font-display text-[clamp(2.4rem,11vw,4rem)] leading-[0.98] text-ink-100">
          Turn your VOD into <span className="italic text-sodium-500">{options.count}</span> Shorts.
        </h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-400">
          Pick a long video. HustlClip finds the strongest moments, frames them vertically, adds captions, and saves
          finished clips to your phone.
        </p>
      </div>

      <section className="rise mt-8 space-y-5" style={{ animationDelay: '80ms' }}>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={[
            'flex min-h-36 w-full flex-col items-center justify-center gap-1.5 border border-dashed px-5 py-6 text-center transition-colors',
            file ? 'border-sodium-600 bg-sodium-700/10' : 'border-ink-700 active:border-ink-600',
          ].join(' ')}
        >
          {file ? (
            <>
              <span className="max-w-full truncate text-[0.9375rem] text-ink-100">{file.name}</span>
              <span className="numeric text-xs text-ink-400">{formatBytes(file.size)} · tap to change</span>
            </>
          ) : (
            <>
              <span className="font-display text-2xl text-ink-200">Pick a video</span>
              <span className="text-xs text-ink-500">from your gallery or Files · MP4 works best</span>
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept="video/*,.mkv,.webm,.mov,.mp4"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0]
            if (picked) setFile(picked)
            e.target.value = ''
          }}
        />

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="block">
            <span className="eyebrow">Language</span>
            <select
              className="field mt-1"
              value={options.language}
              onChange={(e) => set({ language: e.target.value as LanguageChoice })}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className="eyebrow">Captions &amp; shape</span>
            <button type="button" className="field mt-1 text-left" onClick={() => setShowStudio((v) => !v)}>
              {CAPTION_STYLES[brandKit.captionStyle]?.label ?? 'Bold Pop'} · {brandKit.aspect}
            </button>
          </div>
        </div>
        {showStudio && (
          <div className="border-l border-ink-800 pl-4">
            <CaptionStudio value={brandKit} onChange={updateBrand} />
            <p className="mt-3 text-xs text-ink-500">Saved on this phone and used for every new job. {ASPECTS[brandKit.aspect].label}.</p>
          </div>
        )}

        <button type="button" className="btn btn-quiet text-xs" onClick={() => setShowOptions((v) => !v)}>
          {showOptions ? 'Hide options' : 'More options'}
        </button>
        {showOptions && (
          <div className="space-y-4 border-l border-ink-800 pl-4 text-sm">
            <label className="block">
              <span className="eyebrow">Number of clips: {options.count}</span>
              <input
                type="range"
                min={3}
                max={15}
                value={options.count}
                onChange={(e) => set({ count: Number(e.target.value) })}
                className="mt-2 w-full accent-[var(--color-sodium-500)]"
              />
            </label>
            <div>
              <span className="eyebrow">Clip length</span>
              <div className="mt-2 flex gap-2">
                {LENGTHS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`btn flex-1 ${options.length === l.id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => set({ length: l.id })}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-ink-500">
              {LANGUAGES.find((l) => l.id === options.language)?.hint}. {CAPTION_STYLES[brandKit.captionStyle]?.description}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-signal-bad">{error}</p>}
        <button type="button" className="btn btn-primary w-full py-3.5 text-base" disabled={!file} onClick={() => void go()}>
          Make {options.count} clips
        </button>
        <p className="text-xs leading-relaxed text-ink-500">
          Keep this screen open while it works. A 1-hour video usually takes 15–40 minutes, depending on your phone.
        </p>
      </section>

      {recent.length > 0 && (
        <section className="mt-12">
          <h2 className="eyebrow border-b rule pb-2">Your jobs</h2>
          <ul>
            {recent.map((job) => (
              <li key={job.id} className="border-b rule">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 py-3 text-left"
                  onClick={() => navigate({ page: 'job', id: job.id })}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink-100">{job.fileName}</span>
                    <span className="block text-xs text-ink-500">
                      {formatAgo(job.createdAt)} · {job.clips.filter((c) => c.file).length}/{job.count} clips
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-xs ${job.status === 'done' ? 'text-signal-good' : job.status === 'failed' ? 'text-signal-bad' : 'text-sodium-400'}`}
                  >
                    {job.status === 'done' ? 'Done' : job.status === 'failed' ? 'Stopped' : job.status === 'running' ? 'Working' : 'Paused'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
