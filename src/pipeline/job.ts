/**
 * One job, start to finish, entirely in the browser except for the AI calls:
 *
 *   1. prepare  - decode the sound once, measure loudness, make speech audio
 *   2. listen   - NVIDIA speech-to-text, chunk by chunk
 *   3. choose   - the AI funnel picks exactly N distinct moments
 *   4. make     - per clip: find faces and shots, plan the layout, render
 *
 * Every step saves its result, so Resume (after a reload, a crash, or a
 * rate limit) continues where the job stopped instead of starting over.
 */

import type { ProviderId } from '../../shared/models'
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE, clipWords, toSrt } from '../engine/captions'
import { Funnel, timestamp } from '../engine/funnel'
import { AIManager, FatalAIError } from '../engine/manager'
import { detectCuts, planReframe, centrePlan } from '../engine/reframe'
import { type Silence, Transcript, type Word } from '../engine/transcript'
import { api } from '../lib/api'
import { type ClipRecord, type JobRecord, files, jobStore, jobs } from '../lib/store'
import { extractSpeechAudio, findSilences } from '../media/audio'
import { analyseClip, refineCut } from '../media/faces'
import { renderClip } from '../media/render'
import { type Source, openSource } from '../media/source'
import { transcribe } from './transcribe'

export type Update = (job: JobRecord) => void

const STAGES = {
  prepare: [0, 0.12],
  listen: [0.12, 0.35],
  choose: [0.35, 0.55],
  make: [0.55, 1],
} as const

type Stage = keyof typeof STAGES

export const STAGE_LABELS: Record<Stage, string> = {
  prepare: 'Preparing the sound',
  listen: 'Listening to the video',
  choose: 'Choosing the best moments',
  make: 'Making your clips',
}

export class JobRunner {
  private readonly controller = new AbortController()
  private job: JobRecord
  private lastSave = 0
  private wakeLock: WakeLockSentinel | null = null

  constructor(
    job: JobRecord,
    private readonly file: File,
    private readonly onUpdate: Update,
    private readonly providers: ProviderId[],
  ) {
    this.job = job
  }

  cancel(): void {
    this.controller.abort(new DOMException('Paused', 'AbortError'))
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  private async update(patch: Partial<JobRecord>, force = false): Promise<void> {
    this.job = { ...this.job, ...patch }
    this.onUpdate(this.job)
    const now = Date.now()
    if (force || now - this.lastSave > 1500) {
      this.lastSave = now
      await jobs.put(this.job)
    }
  }

  private progress(stage: Stage, fraction: number, message: string): void {
    const [a, b] = STAGES[stage]
    const overall = Math.max(this.job.progress, a + (b - a) * Math.max(0, Math.min(1, fraction)))
    void this.update({ stage, progress: overall, message })
  }

  private log(message: string): void {
    const line = `${new Date().toLocaleTimeString()} ${message}`
    this.job.log = [...this.job.log.slice(-199), line]
  }

  async run(): Promise<JobRecord> {
    await this.update({ status: 'running', error: null }, true)
    await this.keepAwake()
    let source: Source | null = null
    try {
      source = await openSource(this.file)
      const store = jobStore(this.job.id)
      const signal = this.controller.signal

      // 1. prepare
      let prepared = await store.load<{ energy: Float32Array; duration: number }>('audio_meta')
      let ogg = prepared ? await files.read(this.job.id, 'speech.ogg') : null
      if (!prepared || !ogg) {
        this.progress('prepare', 0, STAGE_LABELS.prepare)
        const speech = await extractSpeechAudio(this.file, (f) => this.progress('prepare', f, STAGE_LABELS.prepare), signal)
        await files.write(this.job.id, 'speech.ogg', speech.ogg)
        prepared = { energy: speech.energy, duration: speech.duration }
        await store.save('audio_meta', prepared)
        ogg = await files.read(this.job.id, 'speech.ogg')
        this.log(`Prepared ${timestamp(speech.duration)} of audio (${(speech.ogg.byteLength / 1e6).toFixed(1)} MB).`)
      }
      const silences: Silence[] = findSilences(prepared.energy)

      // 2. listen
      this.progress('listen', 0, STAGE_LABELS.listen)
      const words: Word[] = await transcribe({
        ogg: new Uint8Array(await ogg!.arrayBuffer()),
        energy: prepared.energy,
        duration: prepared.duration,
        silences,
        language: this.job.language,
        store,
        signal,
        onProgress: (f, m) => this.progress('listen', f, m),
      })
      if (words.length < 30) {
        throw new Error('HustlClip heard almost no speech in this video. Check the language setting, or try another video.')
      }
      this.log(`Transcript: ${words.length} words.`)
      const transcript = new Transcript(words)

      // 3. choose
      this.progress('choose', 0, STAGE_LABELS.choose)
      const manager = new AIManager({
        transport: (req, s) => api.chat(req, s ? AbortSignal.any([signal, s]) : signal),
        providers: this.providers,
        signal,
        onRecord: (r) => {
          if (r.status !== 'success') this.log(`AI ${r.capability} via ${r.model}: ${r.status} ${r.category ?? ''}`)
        },
      })
      let clips = this.job.clips
      let contentType = (await store.load<string>('content_type')) ?? 'general'
      if (!clips.length) {
        const funnel = new Funnel({
          manager,
          transcript,
          silences,
          limits: { minS: this.job.minS, maxS: this.job.maxS },
          target: this.job.count,
          store,
          signal,
          log: (m) => this.log(m),
        })
        const result = await funnel.run((f, m) => this.progress('choose', f, m))
        contentType = result.contentType
        await store.save('content_type', contentType)
        clips = result.picks.map((p) => ({
          rank: p.rank,
          id: p.candidate.id,
          title: p.candidate.verdict?.title || p.candidate.scores?.title || p.candidate.title || `Clip ${p.rank}`,
          reason: p.candidate.verdict?.reason || p.candidate.reason,
          startS: p.candidate.startS,
          endS: Math.min(p.candidate.endS, prepared!.duration),
          tier: p.tier,
          score: Math.round(p.final * 100),
          filler: p.tier === 'fallback',
          layout: '',
          file: null,
          srt: toSrt(clipWords(words, p.candidate.startS, p.candidate.endS)),
        }))
        await this.update({ clips }, true)
      }

      // 4. make
      const style = CAPTION_STYLES[this.job.captionStyle] ?? CAPTION_STYLES[DEFAULT_CAPTION_STYLE]!
      const allowSplit = contentType === 'stream' || contentType === 'gaming'
      const pending = clips.filter((c) => !c.file)
      let done = clips.length - pending.length
      for (const clip of [...clips].sort((a, b) => a.rank - b.rank)) {
        if (clip.file) continue
        signal.throwIfAborted()
        const share = 1 / clips.length
        const base = done / clips.length
        const label = `Making clip ${done + 1} of ${clips.length}`
        this.progress('make', base, `${label}: finding faces`)
        const duration = clip.endS - clip.startS
        let plan = source.video ? centrePlan(source.width, source.height, duration) : null
        if (source.video) {
          try {
            const analysis = await analyseClip(source.video, clip.startS, clip.endS, source.width, signal)
            const rough = detectCuts(analysis.samples)
            const cuts: number[] = []
            for (const c of rough.slice(0, 12)) cuts.push(await refineCut(source.video, clip.startS, c))
            plan = planReframe({
              sourceW: source.width,
              sourceH: source.height,
              duration,
              faces: analysis.faces,
              samples: analysis.samples,
              cuts,
              allowSplit,
            })
          } catch (error) {
            if ((error as Error)?.name === 'AbortError') throw error
            this.log(`Face analysis failed for clip ${clip.rank}; using a centre crop. ${(error as Error).message}`)
          }
        }
        if (!plan) throw new Error('This file has no video track, so there is nothing to frame.')
        this.progress('make', base + share * 0.25, `${label}: rendering`)
        const mp4 = await renderClip({
          source,
          startS: clip.startS,
          endS: clip.endS,
          plan,
          words: clipWords(words, clip.startS, clip.endS),
          style,
          signal,
          onProgress: (f) => this.progress('make', base + share * (0.25 + 0.75 * f), `${label}: rendering`),
        })
        const name = `${String(clip.rank).padStart(2, '0')}-${slug(clip.title)}.mp4`
        await files.write(this.job.id, name, mp4)
        clip.file = name
        clip.layout = [...new Set(plan.segments.map((s) => s.note))].join(' · ')
        done++
        await this.update({ clips: [...clips] }, true)
        this.log(`Clip ${clip.rank} ready (${(mp4.byteLength / 1e6).toFixed(1)} MB).`)
      }

      await files.remove(this.job.id, 'speech.ogg')
      await this.update({ status: 'done', progress: 1, message: `${clips.length} clips ready`, stage: 'make' }, true)
    } catch (error) {
      const paused = this.controller.signal.aborted
      const message = paused
        ? 'Paused. Tap Resume to continue.'
        : error instanceof FatalAIError
          ? error.message
          : (error as Error)?.message || 'Something went wrong.'
      this.log(paused ? 'Paused.' : `Stopped: ${message}`)
      await this.update({ status: paused ? 'paused' : 'failed', error: paused ? null : message, message }, true)
    } finally {
      source?.input.dispose()
      await this.wakeLock?.release().catch(() => undefined)
    }
    return this.job
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
      document.addEventListener('visibilitychange', this.reacquire)
    } catch {
      // Not critical; the guide asks people to keep the screen on.
    }
  }

  private reacquire = async () => {
    if (document.visibilityState === 'visible' && this.job.status === 'running') {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen')
      } catch {
        // ignore
      }
    }
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'clip'
  )
}

export function newJob(file: File, options: Pick<JobRecord, 'language' | 'captionStyle' | 'count' | 'minS' | 'maxS'>): JobRecord {
  const now = Date.now()
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: file.name,
    fileSize: file.size,
    fileModified: file.lastModified,
    createdAt: now,
    updatedAt: now,
    ...options,
    status: 'paused',
    stage: 'prepare',
    progress: 0,
    message: 'Ready to start',
    error: null,
    clips: [] as ClipRecord[],
    log: [],
  }
}

export function sameFile(job: JobRecord, file: File): boolean {
  return job.fileName === file.name && job.fileSize === file.size
}
