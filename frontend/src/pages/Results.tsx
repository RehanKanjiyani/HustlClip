import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { api, formatBytes, formatDuration, type Clip, type Job } from '../api'
import { ErrorNote } from '../components/ErrorNote'

const MOMENT_LABELS: Record<string, string> = {
  strong_opening: 'Strong opener',
  surprising_statement: 'Surprise',
  controversial_opinion: 'Hot take',
  emotional_moment: 'Emotional',
  admission: 'Confession',
  punchline: 'Funny',
  story_payoff: 'Story',
  insight: 'Insight',
  advice: 'Advice',
  curiosity_gap: 'Curiosity',
  disagreement: 'Debate',
  revelation: 'Reveal',
  question_answer: 'Q&A',
  gameplay_highlight: 'Gameplay',
  reaction: 'Reaction',
}

/**
 * The finished clips, ready to take away.
 *
 * One column on a phone, a grid on wider screens. Each clip plays inline and
 * downloads with one tap; "Download all" is a single zip. Editing is one link
 * away but never in the way.
 */
export function Results() {
  const { jobId } = useParams()
  const [job, setJob] = useState<Job | null>(null)
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!jobId) return
    Promise.all([api.getJob(jobId), api.listClips(jobId)])
      .then(([loadedJob, loadedClips]) => {
        setJob(loadedJob)
        setClips(loadedClips)
      })
      .catch((err) => setError(err as Error))
  }, [jobId])

  if (error) {
    return (
      <div className="mx-auto max-w-xl pt-16">
        <ErrorNote error={error} />
      </div>
    )
  }
  if (!job || !clips) return <p className="pt-24 text-sm text-ink-500">Loading…</p>

  const rendered = clips.filter((clip) => clip.exports.length > 0)
  const fallbackCount = clips.filter((clip) => clip.quality === 'fallback').length

  return (
    <div className="pt-8 sm:pt-12">
      <div className="rise flex flex-wrap items-end justify-between gap-5 border-b border-ink-800 pb-6">
        <div className="min-w-0">
          <p className="eyebrow">
            {rendered.length} {rendered.length === 1 ? 'clip' : 'clips'} ready
          </p>
          <h1 className="mt-2 max-w-3xl truncate font-display text-[clamp(1.75rem,5vw,3rem)] leading-tight text-ink-100">
            {job.source?.title || 'Your clips'}
          </h1>
        </div>
        <div className="flex w-full gap-3 sm:w-auto">
          {rendered.length > 0 && (
            <a
              href={api.downloadAllUrl(job.id)}
              download
              className="btn btn-primary flex-1 py-3 sm:flex-none sm:px-6"
            >
              Download all
            </a>
          )}
          <Link to={`/jobs/${job.id}/clips`} className="btn btn-ghost flex-1 py-3 sm:flex-none">
            Edit
          </Link>
        </div>
      </div>

      {fallbackCount > 0 && (
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-ink-400">
          This video had fewer standout moments than requested, so {fallbackCount}{' '}
          {fallbackCount === 1 ? 'clip was' : 'clips were'} filled from the best remaining
          material. They are marked below.
        </p>
      )}

      {clips.length === 0 ? (
        <p className="mt-16 text-sm text-ink-500">This job produced no clips.</p>
      ) : (
        <ul className="mt-8 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {clips.map((clip, index) => (
            <li key={clip.id} className="rise" style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
              <ClipCard clip={clip} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ClipCard({ clip }: { clip: Clip }) {
  const latest = clip.exports[0]
  const moment = MOMENT_LABELS[clip.moment_type]

  return (
    <article>
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-ink-850">
        {latest ? (
          <video
            src={latest.download_url}
            controls
            playsInline
            preload="metadata"
            className="size-full object-contain"
          />
        ) : (
          <div className="flex size-full items-center justify-center px-6 text-center text-sm text-ink-500">
            Not rendered
          </div>
        )}
        <span className="numeric absolute left-2 top-2 bg-ink-900/80 px-1.5 py-0.5 text-xs text-ink-200">
          #{clip.rank}
        </span>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] leading-snug text-ink-100">{clip.title || 'Untitled'}</h2>
          <p className="numeric mt-1 text-xs text-ink-500">
            {formatDuration(clip.duration_s)}
            {moment ? ` · ${moment}` : ''}
            {clip.quality === 'fallback' ? ' · filler' : ''}
          </p>
        </div>
        {latest && (
          <a
            href={latest.download_url}
            download
            className="btn btn-ghost shrink-0 px-3 py-2"
            aria-label={`Download ${clip.title || 'clip'} (${formatBytes(latest.size_bytes)})`}
          >
            Download
          </a>
        )}
      </div>
    </article>
  )
}
