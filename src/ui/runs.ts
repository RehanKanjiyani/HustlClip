/**
 * Jobs running in this tab. A job keeps running while you move between
 * screens; the picked video file lives in memory for the life of the page
 * (browsers can't reopen a file on their own after a reload, so Resume asks
 * you to pick it again).
 */

import type { ProviderId } from '../../shared/models'
import { JobRunner, sameFile } from '../pipeline/job'
import { type JobRecord, jobs } from '../lib/store'

const pickedFiles = new Map<string, File>()
const runners = new Map<string, JobRunner>()
const listeners = new Map<string, Set<(job: JobRecord) => void>>()

export function attachFile(jobId: string, file: File) {
  pickedFiles.set(jobId, file)
}

export function fileFor(jobId: string): File | undefined {
  return pickedFiles.get(jobId)
}

export function isRunning(jobId: string): boolean {
  return runners.has(jobId)
}

export function subscribe(jobId: string, listener: (job: JobRecord) => void): () => void {
  const set = listeners.get(jobId) ?? new Set()
  set.add(listener)
  listeners.set(jobId, set)
  return () => set.delete(listener)
}

function emit(job: JobRecord) {
  for (const listener of listeners.get(job.id) ?? []) listener(job)
}

export async function start(jobId: string, providers: ProviderId[]): Promise<void> {
  if (runners.has(jobId)) return
  const job = await jobs.get(jobId)
  const file = pickedFiles.get(jobId)
  if (!job || !file) return
  if (!sameFile(job, file)) throw new Error(`That's a different file. Pick "${job.fileName}".`)
  const runner = new JobRunner(job, file, emit, providers)
  runners.set(jobId, runner)
  try {
    await runner.run()
  } finally {
    runners.delete(jobId)
    const latest = await jobs.get(jobId)
    if (latest) emit(latest)
    if (latest?.status === 'done') await clearSharedCopy()
  }
}

export function pause(jobId: string) {
  runners.get(jobId)?.cancel()
}

/** Removes the copy of a video that was shared into HustlClip, once it's no longer needed. */
export async function clearSharedCopy() {
  try {
    const cache = await caches.open('hustlclip-share')
    await cache.delete('/shared-video')
  } catch {
    // ignore
  }
}
