import { useEffect, useRef, useState } from 'react'

import type { ProviderId } from '../../shared/models'
import { srtToVtt } from '../engine/captions'
import { STAGE_LABELS } from '../pipeline/job'
import { type Brand, DEFAULT_BRAND, taste } from '../lib/prefs'
import { type ClipRecord, type JobRecord, type PoolEntry, files, jobs } from '../lib/store'
import { formatBytes, formatDuration } from './format'
import { navigate } from './nav'
import { attachFile, fileFor, isRunning, pause, redo, start, subscribe } from './runs'
import { CaptionStudio, MoreMoments, TrimPanel } from './Studio'

async function clipFile(jobId: string, clip: ClipRecord): Promise<File | null> {
  if (!clip.file) return null
  const stored = await files.read(jobId, clip.file)
  return stored ? new File([stored], clip.file.replace(/-[a-z0-9]+\.mp4$/, '.mp4'), { type: 'video/mp4' }) : null
}

function download(file: Blob, name: string) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function shareFiles(list: File[], text?: string): Promise<void> {
  if (navigator.canShare?.({ files: list })) {
    try {
      await navigator.share({ files: list, ...(text ? { text } : {}) })
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
  }
  for (const f of list) download(f, f.name)
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function postText(clip: ClipRecord): string {
  return [clip.postCaption ?? clip.title, (clip.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n')
}

/** Time spent and time left for the current run, from its progress so far. */
function timing(job: JobRecord, running: boolean): string | null {
  if (!running || !job.runStartedAt) return null
  const elapsed = (Date.now() - job.runStartedAt) / 1000
  const gained = job.progress - (job.runStartProgress ?? 0)
  const text = `${formatDuration(elapsed)} so far`
  if (gained < 0.03 || elapsed < 20) return text
  const left = (elapsed / gained) * (1 - job.progress)
  return `${text} · about ${formatDuration(Math.max(60, left))} left`
}

export function JobView({ id, providers }: { id: string; providers: ProviderId[] }) {
  const [job, setJob] = useState<JobRecord | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [panel, setPanel] = useState<'none' | 'restyle' | 'more'>('none')
  const [restyle, setRestyle] = useState<Brand>(DEFAULT_BRAND)
  const [, tick] = useState(0)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    jobs.get(id).then((j) => alive && setJob(j ?? null))
    const off = subscribe(id, (j) => alive && setJob(j))
    const timer = setInterval(() => tick((n) => n + 1), 5000)
    return () => {
      alive = false
      off()
      clearInterval(timer)
    }
  }, [id])

  useEffect(() => {
    if (job) {
      setRestyle({
        captionStyle: job.captionStyle,
        custom: job.captionCustom ?? {},
        aspect: job.aspect ?? '9:16',
        zoom: job.zoom ?? true,
      })
    }
    // Only when a different job is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id])

  if (job === undefined) return <p className="mt-16 text-center text-ink-400">Loading…</p>
  if (job === null) {
    return (
      <div className="mt-16 text-center">
        <p className="text-ink-300">This job no longer exists.</p>
        <button type="button" className="btn btn-ghost mt-4" onClick={() => navigate({ page: 'home' })}>
          Back
        </button>
      </div>
    )
  }

  const running = isRunning(id)
  const status = running ? 'running' : job.status === 'running' ? 'paused' : job.status
  const ready = job.clips.filter((c) => c.file)
  const when = timing(job, running)

  const resume = (file?: File) => {
    setError(null)
    if (file) attachFile(id, file)
    if (!fileFor(id)) {
      picker.current?.click()
      return
    }
    void start(id, providers).catch((e: Error) => setError(e.message))
  }

  const change = async (mutate: (j: JobRecord) => void) => {
    setError(null)
    const result = await redo(id, providers, mutate)
    if (result === 'busy') setError('Wait for the current work to finish, or tap Pause first.')
    if (result === 'needs-file') picker.current?.click()
  }

  const addMoment = (p: PoolEntry) =>
    change((j) => {
      const rank = Math.max(0, ...j.clips.map((c) => c.rank)) + 1
      j.clips.push({
        rank,
        id: p.id,
        title: p.title,
        reason: p.reason,
        startS: p.startS,
        endS: p.endS,
        startWord: p.startWord,
        endWord: p.endWord,
        tier: 'added',
        score: p.score,
        filler: false,
        layout: '',
        file: null,
        srt: '',
        reasons: p.reasons,
        postCaption: p.postCaption,
        hashtags: p.hashtags,
      })
      setPanel('none')
    })

  const applyRestyle = () =>
    change((j) => {
      j.captionStyle = restyle.captionStyle
      j.captionCustom = restyle.custom
      j.aspect = restyle.aspect
      j.zoom = restyle.zoom
      for (const c of j.clips) c.file = null
      setPanel('none')
    })

  const remove = async () => {
    if (!confirm('Delete this job and its clips from this phone?')) return
    pause(id)
    await jobs.remove(id)
    navigate({ page: 'home' })
  }

  return (
    <div className="pt-6">
      <p className="truncate text-xs text-ink-500">{job.fileName}</p>
      <h1 className="font-display mt-1 text-3xl text-ink-100">
        {status === 'done' ? `${ready.length} clips ready` : status === 'failed' ? 'Stopped' : status === 'paused' ? 'Paused' : 'Working…'}
      </h1>

      {status !== 'done' && (
        <section className="mt-6 space-y-3">
          <div className="h-1.5 w-full overflow-hidden bg-ink-800">
            <div className="h-full bg-sodium-500 transition-[width] duration-500" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-ink-200">{STAGE_LABELS[job.stage as keyof typeof STAGE_LABELS] ?? job.stage}</span>
            <span className="numeric text-ink-400">{Math.round(job.progress * 100)}%</span>
          </div>
          <p className="text-sm text-ink-400">{job.message}</p>
          {when && <p className="numeric text-xs text-ink-500">{when}</p>}
          {job.error && <p className="border-l-2 border-signal-bad pl-3 text-sm leading-relaxed text-ink-200">{job.error}</p>}
          {error && <p className="text-sm text-signal-bad">{error}</p>}

          {running ? (
            <>
              <p className="text-xs leading-relaxed text-ink-500">
                Keep HustlClip open on screen. If you switch apps, Android may pause it; come back and tap Resume.
              </p>
              <button type="button" className="btn btn-ghost w-full" onClick={() => pause(id)}>
                Pause
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary w-full py-3 text-base" onClick={() => resume()}>
              {fileFor(id) ? 'Resume' : `Resume (pick “${job.fileName}” again)`}
            </button>
          )}
        </section>
      )}
      {status === 'done' && error && <p className="mt-4 text-sm text-signal-bad">{error}</p>}

      {job.ai && job.ai.calls > 0 && (
        <p className="numeric mt-4 text-xs text-ink-500">
          AI: {job.ai.model ?? 'waiting for a model'} · {job.ai.calls} requests
          {job.ai.failed ? ` (${job.ai.failed} retried)` : ''} · {Math.round(job.ai.tokens / 1000)}k tokens
        </p>
      )}

      <input
        ref={picker}
        type="file"
        accept="video/*,.mkv,.webm,.mov,.mp4"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = ''
          if (picked) resume(picked)
        }}
      />

      {job.clips.length > 0 && (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b rule pb-2">
            <h2 className="eyebrow">Clips</h2>
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost text-xs" onClick={() => setPanel(panel === 'more' ? 'none' : 'more')}>
                More moments
              </button>
              <button type="button" className="btn btn-ghost text-xs" onClick={() => setPanel(panel === 'restyle' ? 'none' : 'restyle')}>
                Restyle
              </button>
              {ready.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  onClick={async () => {
                    const list = (await Promise.all(ready.map((c) => clipFile(id, c)))).filter((f): f is File => !!f)
                    await shareFiles(list)
                  }}
                >
                  Save all
                </button>
              )}
            </div>
          </div>

          {panel === 'restyle' && (
            <div className="space-y-3 border-b rule py-4">
              <CaptionStudio value={restyle} onChange={setRestyle} />
              <button type="button" className="btn btn-primary w-full" disabled={running} onClick={() => void applyRestyle()}>
                Re-render all clips with this look
              </button>
            </div>
          )}
          {panel === 'more' && (
            <div className="border-b rule py-4">
              <MoreMoments jobId={id} clips={job.clips} onAdd={(p) => void addMoment(p)} />
            </div>
          )}

          <ol>
            {[...job.clips]
              .sort((a, b) => a.rank - b.rank)
              .map((clip) => (
                <ClipCard
                  key={`${clip.id}-${clip.file ?? 'pending'}`}
                  jobId={id}
                  clip={clip}
                  busy={running}
                  onTrim={(r) =>
                    void change((j) => {
                      const c = j.clips.find((x) => x.id === clip.id)
                      if (c) Object.assign(c, r, { file: null })
                    })
                  }
                  onFeedback={(v) =>
                    void jobs.get(id).then(async (j) => {
                      const c = j?.clips.find((x) => x.id === clip.id)
                      if (!j || !c) return
                      c.feedback = c.feedback === v ? undefined : v
                      taste.record(c.title, c.feedback ?? null)
                      await jobs.put(j)
                      setJob({ ...j })
                    })
                  }
                />
              ))}
          </ol>
        </section>
      )}

      <section className="mt-10 space-y-3 text-sm">
        <button type="button" className="btn btn-quiet text-xs" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide details' : 'Show details'}
        </button>
        {showLog && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap bg-ink-850 p-3 text-[11px] leading-relaxed text-ink-400">
            {job.log.join('\n') || 'Nothing yet.'}
          </pre>
        )}
        <div>
          <button type="button" className="btn btn-quiet text-xs text-signal-bad" onClick={() => void remove()}>
            Delete job
          </button>
        </div>
      </section>
    </div>
  )
}

function ClipCard({
  jobId,
  clip,
  busy,
  onTrim,
  onFeedback,
}: {
  jobId: string
  clip: ClipRecord
  busy: boolean
  onTrim: (r: { startWord: number; endWord: number; startS: number; endS: number }) => void
  onFeedback: (v: 'posted' | 'skip') => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [trimming, setTrimming] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<File | null>(null)

  useEffect(() => {
    let revoked = false
    let objectUrl: string | null = null
    clipFile(jobId, clip).then((f) => {
      if (!f || revoked) return
      fileRef.current = f
      setSize(f.size)
      objectUrl = URL.createObjectURL(f)
      setUrl(objectUrl)
    })
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, clip])

  const base = (clip.file ?? `${clip.rank}`).replace(/-[a-z0-9]+\.mp4$/, '').replace(/\.mp4$/, '')

  return (
    <li className="border-b rule py-5">
      <div className="flex gap-4">
        <div className="w-28 shrink-0 overflow-hidden bg-ink-850" style={{ aspectRatio: '9 / 16' }}>
          {url ? (
            <video src={`${url}#t=0.5`} className="h-full w-full object-contain" controls playsInline preload="metadata" />
          ) : (
            <div className="flex h-full items-center justify-center p-2 text-center text-xs text-ink-600">
              {busy ? 'Rendering soon' : 'Not rendered'}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="numeric text-xs text-ink-500">
            #{clip.rank} · {formatDuration(clip.endS - clip.startS)} · at {formatDuration(clip.startS)}
            {size ? ` · ${formatBytes(size)}` : ''}
          </p>
          <p className="flex items-start gap-2 text-[0.9375rem] leading-snug text-ink-100">
            <span className="numeric shrink-0 rounded bg-sodium-500 px-1.5 text-xs font-semibold leading-5 text-ink-900">
              {clip.score}
            </span>
            <span>{clip.title}</span>
          </p>
          {clip.filler ? (
            <p className="text-xs text-sodium-400">Filler: the AI found fewer strong moments than you asked for.</p>
          ) : (
            <>
              {clip.reasons && clip.reasons.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                  {clip.reasons.map((r) => (
                    <li key={r} className="rounded-full border border-ink-700 px-2 text-[11px] text-ink-300">
                      {r}
                    </li>
                  ))}
                </ul>
              )}
              {clip.reason && <p className="text-xs leading-relaxed text-ink-400">{clip.reason}</p>}
            </>
          )}
        </div>
      </div>

      {(clip.postCaption || clip.hashtags?.length) && (
        <div className="mt-3 rounded bg-ink-850 p-3 text-xs leading-relaxed">
          <p className="whitespace-pre-wrap text-ink-200">{clip.postCaption}</p>
          {clip.hashtags && clip.hashtags.length > 0 && <p className="mt-1 text-sodium-400">{clip.hashtags.join(' ')}</p>}
          <button
            type="button"
            className="btn btn-quiet mt-1 px-0 text-xs"
            onClick={async () => {
              setCopied(await copy(postText(clip)))
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied ✓' : 'Copy post text'}
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {clip.file && (
          <>
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={() => fileRef.current && void shareFiles([fileRef.current], postText(clip))}
            >
              Share
            </button>
            <button type="button" className="btn btn-ghost text-xs" onClick={() => fileRef.current && download(fileRef.current, fileRef.current.name)}>
              Download
            </button>
          </>
        )}
        <button type="button" className="btn btn-ghost text-xs" disabled={busy} onClick={() => setTrimming((v) => !v)}>
          Trim
        </button>
        {clip.srt && (
          <>
            <button type="button" className="btn btn-quiet text-xs" onClick={() => download(new Blob([clip.srt], { type: 'text/plain' }), `${base}.srt`)}>
              .srt
            </button>
            <button
              type="button"
              className="btn btn-quiet text-xs"
              onClick={() => download(new Blob([srtToVtt(clip.srt)], { type: 'text/vtt' }), `${base}.vtt`)}
            >
              .vtt
            </button>
          </>
        )}
      </div>

      <div className="mt-2 flex gap-2 text-xs">
        <button
          type="button"
          className={`btn text-xs ${clip.feedback === 'posted' ? 'btn-primary' : 'btn-quiet'}`}
          onClick={() => onFeedback('posted')}
        >
          ✓ Posted
        </button>
        <button
          type="button"
          className={`btn text-xs ${clip.feedback === 'skip' ? 'btn-primary' : 'btn-quiet'}`}
          onClick={() => onFeedback('skip')}
        >
          ✕ Not this one
        </button>
      </div>

      {trimming && (
        <div className="mt-3">
          <TrimPanel
            jobId={jobId}
            clip={clip}
            onApply={(r) => {
              setTrimming(false)
              onTrim(r)
            }}
          />
        </div>
      )}
    </li>
  )
}
