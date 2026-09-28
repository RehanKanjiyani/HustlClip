import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import {
  ApiError,
  api,
  formatBytes,
  formatDuration,
  type CaptionStyle,
  type Job,
  type JobSettingsOverrides,
} from '../api'
import { ErrorNote } from '../components/ErrorNote'

type Phase = { kind: 'idle' } | { kind: 'upload'; fraction: number } | { kind: 'fetch' } | { kind: 'queue' }

/**
 * The primary flow: pick a video (or paste a link), tap one button.
 *
 * Everything else — clip count, length, captions, composition — lives behind
 * "Options", and AI routing lives in Settings. A first-time user on a phone
 * should see exactly two inputs and one action.
 */
export function Ingest() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [error, setError] = useState<Error | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [defaultCount, setDefaultCount] = useState(10)
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const [styles, setStyles] = useState<CaptionStyle[]>([])
  const [overrides, setOverrides] = useState<JobSettingsOverrides>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listJobs(8).then(setJobs).catch(() => undefined)
    api.getSettings().then((s) => setDefaultCount(s.clips.max_clips)).catch(() => undefined)
    api
      .aiStatus()
      .then((status) => setAiReady((status.routes.candidate_discovery ?? []).length > 0))
      .catch(() => setAiReady(null))
    api.captionStyles().then(setStyles).catch(() => undefined)
  }, [])

  const count = overrides.max_clips ?? defaultCount
  const busy = phase.kind !== 'idle'
  const ready = (file !== null || url.trim() !== '') && !busy

  const create = async () => {
    if (!ready) return
    setError(null)
    try {
      let sourceId: string
      if (file) {
        setPhase({ kind: 'upload', fraction: 0 })
        const source = await api.uploadSource(file, (fraction) =>
          setPhase({ kind: 'upload', fraction }),
        )
        sourceId = source.id
      } else {
        setPhase({ kind: 'fetch' })
        sourceId = (await api.ingestUrl(url.trim())).id
      }
      setPhase({ kind: 'queue' })
      const job = await api.createJob(sourceId, overrides)
      navigate(`/jobs/${job.id}`)
    } catch (err) {
      setError(err as Error)
      setPhase({ kind: 'idle' })
    }
  }

  const pickFile = (picked: File | undefined) => {
    if (!picked) return
    setFile(picked)
    setUrl('')
  }

  return (
    <div className="mx-auto max-w-xl pt-10 sm:pt-16">
      <div className="rise">
        <h1 className="font-display text-[clamp(2.4rem,9vw,4.25rem)] leading-[0.98] text-ink-100">
          Turn your VOD into <span className="italic text-sodium-500">{count}</span> Shorts.
        </h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-400">
          Upload a long video. HustlClip finds the strongest moments, reframes them to
          vertical, adds captions, and hands you finished clips.
        </p>
      </div>

      {aiReady === false && (
        <p className="rise mt-8 border-l-2 border-sodium-600 pl-4 text-sm leading-relaxed text-ink-300">
          Add an AI key first — an NVIDIA key is free.{' '}
          <Link to="/settings" className="text-sodium-500 underline underline-offset-4">
            Open Settings
          </Link>
        </p>
      )}

      <section className="rise mt-10 space-y-6" style={{ animationDelay: '80ms' }}>
        {/* File — on a phone this opens the gallery / files picker. */}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className={[
            'flex min-h-32 w-full flex-col items-center justify-center gap-1.5 border border-dashed px-5 py-6 text-center transition-colors duration-200',
            file ? 'border-sodium-600 bg-sodium-700/10' : 'border-ink-700 hover:border-ink-600',
          ].join(' ')}
        >
          {file ? (
            <>
              <span className="max-w-full truncate text-[0.9375rem] text-ink-100">{file.name}</span>
              <span className="numeric text-xs text-ink-400">
                {formatBytes(file.size)} · tap to change
              </span>
            </>
          ) : (
            <>
              <span className="font-display text-2xl text-ink-200">Upload video</span>
              <span className="text-xs text-ink-500">mp4 · mov · mkv · webm · audio works too</span>
            </>
          )}
        </button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept="video/*,audio/*"
          onChange={(e) => {
            pickFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        <div className="flex items-center gap-4 text-xs text-ink-600" aria-hidden>
          <span className="h-px flex-1 bg-ink-800" />
          or
          <span className="h-px flex-1 bg-ink-800" />
        </div>

        <label className="block">
          <span className="eyebrow">Paste a video link</span>
          <input
            className="field mt-1 text-base"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (e.target.value) setFile(null)
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>

        <button
          type="button"
          onClick={create}
          disabled={!ready}
          className="btn btn-primary relative w-full overflow-hidden py-4 text-base"
        >
          {phase.kind === 'upload' && (
            <span
              className="absolute inset-y-0 left-0 bg-sodium-400/40 transition-[width] duration-300"
              style={{ width: `${Math.round(phase.fraction * 100)}%` }}
              aria-hidden
            />
          )}
          <span className="relative">
            {phase.kind === 'upload'
              ? `Uploading… ${Math.round(phase.fraction * 100)}%`
              : phase.kind === 'fetch'
                ? 'Fetching video…'
                : phase.kind === 'queue'
                  ? 'Starting…'
                  : `Create ${count} Clips`}
          </span>
        </button>

        <p className="text-xs leading-relaxed text-ink-500">
          Only use video you own or have permission to clip.
        </p>
      </section>

      {error && (
        <div className="mt-8">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {error instanceof ApiError && error.status === 0 && (
            <p className="mt-2 text-xs text-ink-500">Your file is still selected — tap Create to retry.</p>
          )}
        </div>
      )}

      <Options
        open={optionsOpen}
        onToggle={() => setOptionsOpen((v) => !v)}
        overrides={overrides}
        onChange={setOverrides}
        defaultCount={defaultCount}
        styles={styles}
      />

      <RecentJobs jobs={jobs} />
    </div>
  )
}

function Options({
  open,
  onToggle,
  overrides,
  onChange,
  defaultCount,
  styles,
}: {
  open: boolean
  onToggle: () => void
  overrides: JobSettingsOverrides
  onChange: (next: JobSettingsOverrides) => void
  defaultCount: number
  styles: CaptionStyle[]
}) {
  const set = <K extends keyof JobSettingsOverrides>(key: K, value: JobSettingsOverrides[K]) =>
    onChange({ ...overrides, [key]: value })

  return (
    <div className="mt-10">
      <button type="button" onClick={onToggle} className="btn btn-quiet -ml-1 py-2">
        <span
          className="inline-block transition-transform duration-300"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden
        >
          ›
        </span>
        {open ? 'Hide options' : 'Options'}
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-400 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="grid gap-x-8 gap-y-6 pt-5 sm:grid-cols-2">
            <NumberField
              label="Number of clips"
              value={overrides.max_clips}
              placeholder={String(defaultCount)}
              min={1}
              max={50}
              onChange={(v) => set('max_clips', v)}
            />
            <Selector
              label="Caption style"
              value={overrides.caption_style ?? ''}
              onChange={(v) => set('caption_style', v || undefined)}
              options={[
                { value: '', label: 'Default' },
                ...styles.map((s) => ({ value: s.key, label: s.label })),
              ]}
            />
            <NumberField
              label="Shortest clip (s)"
              value={overrides.min_duration_s}
              placeholder="20"
              min={5}
              max={300}
              onChange={(v) => set('min_duration_s', v)}
            />
            <NumberField
              label="Longest clip (s)"
              value={overrides.max_duration_s}
              placeholder="90"
              min={5}
              max={300}
              onChange={(v) => set('max_duration_s', v)}
            />
            <Selector
              label="Transcription accuracy"
              value={overrides.whisper_model ?? ''}
              onChange={(v) => set('whisper_model', v || undefined)}
              options={[
                { value: '', label: 'Default' },
                { value: 'base', label: 'Fast' },
                { value: 'small', label: 'Balanced' },
                { value: 'medium', label: 'Accurate' },
                { value: 'large-v3', label: 'Most accurate (slow)' },
              ]}
            />
            <div className="space-y-4 sm:col-span-2">
              <Check
                checked={overrides.diarization ?? false}
                onChange={(v) => set('diarization', v || undefined)}
                label="Several people talking — follow whoever speaks"
              />
              <Check
                checked={overrides.dynamic_composition ?? false}
                onChange={(v) => set('dynamic_composition', v || undefined)}
                label="Dynamic layouts — let AI switch between following the speaker and showing the whole frame"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-start gap-3 py-1 text-sm leading-snug text-ink-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-sodium-500"
      />
      {label}
    </label>
  )
}

function Selector({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field mt-1 cursor-pointer text-base sm:text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-ink-850">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function NumberField({
  label,
  value,
  placeholder,
  min,
  max,
  onChange,
}: {
  label: string
  value: number | undefined
  placeholder: string
  min: number
  max: number
  onChange: (value: number | undefined) => void
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        className="field numeric mt-1 text-base sm:text-sm"
        placeholder={placeholder}
        value={value ?? ''}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      />
    </label>
  )
}

function RecentJobs({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return null

  return (
    <section className="rise mt-16" style={{ animationDelay: '160ms' }}>
      <div className="flex items-baseline justify-between border-b border-ink-800 pb-3">
        <h2 className="eyebrow">Recent</h2>
      </div>

      <ul>
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              to={job.status === 'done' ? `/jobs/${job.id}/results` : `/jobs/${job.id}`}
              className="group grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-ink-850 py-4 transition-colors duration-200 hover:bg-ink-850/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.9375rem] text-ink-200 group-hover:text-ink-100">
                  {job.source?.title || 'Untitled'}
                </span>
                <span className="numeric mt-0.5 block text-xs text-ink-500">
                  {job.source ? formatDuration(job.source.duration_s) : '—'}
                </span>
              </span>
              <StatusTag job={job} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusTag({ job }: { job: Job }) {
  const tone: Record<string, string> = {
    done: 'text-signal-good',
    failed: 'text-signal-bad',
    running: 'text-sodium-500',
    queued: 'text-ink-400',
    cancelled: 'text-ink-500',
  }
  const label = job.status === 'running' ? `${Math.round(job.progress * 100)}%` : job.status

  return (
    <span className={`numeric justify-self-end text-xs ${tone[job.status] ?? 'text-ink-400'}`}>
      {label}
    </span>
  )
}
