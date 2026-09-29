import { useEffect, useRef, useState } from 'react'

import type { ProviderId } from '../../shared/models'
import { STAGE_LABELS } from '../pipeline/job'
import { type ClipRecord, type JobRecord, files, jobs } from '../lib/store'
import { navigate } from './nav'
import { formatBytes, formatDuration } from './format'
import { attachFile, fileFor, isRunning, pause, start, subscribe } from './runs'

async function clipFile(jobId: string, clip: ClipRecord): Promise<File | null> {
  if (!clip.file) return null
  const stored = await files.read(jobId, clip.file)
  return stored ? new File([stored], clip.file, { type: 'video/mp4' }) : null
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

async function shareFiles(list: File[], fallbackName?: string): Promise<void> {
  if (navigator.canShare?.({ files: list })) {
    try {
      await navigator.share({ files: list, title: fallbackName ?? 'HustlClip clips' })
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
  }
  for (const f of list) download(f, f.name)
}

export function JobView({ id, providers }: { id: string; providers: ProviderId[] }) {
  const [job, setJob] = useState<JobRecord | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    jobs.get(id).then((j) => alive && setJob(j ?? null))
    const off = subscribe(id, (j) => alive && setJob(j))
    return () => {
      alive = false
      off()
    }
  }, [id])

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

  const resume = (file?: File) => {
    setError(null)
    if (file) attachFile(id, file)
    if (!fileFor(id)) {
      picker.current?.click()
      return
    }
    void start(id, providers).catch((e: Error) => setError(e.message))
  }

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
            <>
              <button type="button" className="btn btn-primary w-full py-3 text-base" onClick={() => resume()}>
                {fileFor(id) ? 'Resume' : `Resume (pick “${job.fileName}” again)`}
              </button>
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
            </>
          )}
        </section>
      )}

      {ready.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between border-b rule pb-2">
            <h2 className="eyebrow">Clips</h2>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={async () => {
                const list = (await Promise.all(ready.map((c) => clipFile(id, c)))).filter((f): f is File => !!f)
                await shareFiles(list)
              }}
            >
              Save / share all
            </button>
          </div>
          <ol>
            {[...job.clips]
              .sort((a, b) => a.rank - b.rank)
              .map((clip) => (
                <ClipCard key={clip.id} jobId={id} clip={clip} />
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

function ClipCard({ jobId, clip }: { jobId: string; clip: ClipRecord }) {
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
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

  return (
    <li className="border-b rule py-5">
      <div className="flex gap-4">
        <div className="w-28 shrink-0 overflow-hidden bg-ink-850" style={{ aspectRatio: '9 / 16' }}>
          {url ? (
            <video src={`${url}#t=0.5`} className="h-full w-full object-cover" controls playsInline preload="metadata" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-ink-600">{clip.file ? '…' : 'Waiting'}</div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="numeric text-xs text-ink-500">
            #{clip.rank} · {formatDuration(clip.endS - clip.startS)} · at {formatDuration(clip.startS)}
            {size ? ` · ${formatBytes(size)}` : ''}
          </p>
          <p className="text-[0.9375rem] leading-snug text-ink-100">{clip.title}</p>
          {clip.filler ? (
            <p className="text-xs text-sodium-400">Filler: the AI found fewer strong moments than you asked for.</p>
          ) : (
            <p className="text-xs leading-relaxed text-ink-400">{clip.reason}</p>
          )}
          {clip.file && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="btn btn-ghost text-xs"
                onClick={() => fileRef.current && void shareFiles([fileRef.current], clip.title)}
              >
                Share
              </button>
              <button
                type="button"
                className="btn btn-ghost text-xs"
                onClick={() => fileRef.current && download(fileRef.current, clip.file!)}
              >
                Download
              </button>
              <button
                type="button"
                className="btn btn-quiet text-xs"
                onClick={() => download(new Blob([clip.srt], { type: 'text/plain' }), clip.file!.replace(/\.mp4$/, '.srt'))}
              >
                .srt
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
