/**
 * Everything a job needs to resume lives on the phone: job records and stage
 * results in IndexedDB, big files (speech audio, finished clips) in the
 * browser's private file system (OPFS). Nothing is uploaded except audio
 * chunks for speech-to-text and transcript text for the AI.
 */

import type { LanguageChoice } from '../../shared/models'
import type { Store } from '../engine/funnel'

export type JobStatus = 'running' | 'paused' | 'done' | 'failed'

export interface ClipRecord {
  rank: number
  id: string
  title: string
  reason: string
  startS: number
  endS: number
  tier: string
  score: number
  filler: boolean
  layout: string
  /** OPFS file name once rendered. */
  file: string | null
  srt: string
}

export interface JobRecord {
  id: string
  fileName: string
  fileSize: number
  fileModified: number
  createdAt: number
  updatedAt: number
  language: LanguageChoice
  captionStyle: string
  count: number
  minS: number
  maxS: number
  status: JobStatus
  stage: string
  progress: number
  message: string
  error: string | null
  clips: ClipRecord[]
  log: string[]
}

const DB_NAME = 'hustlclip'
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const d = request.result
      if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('artifacts')) d.createObjectStore('artifacts')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode)
    const request = run(t.objectStore(store))
    t.oncomplete = () => resolve(request.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export const jobs = {
  async list(): Promise<JobRecord[]> {
    const all = await tx<JobRecord[]>('jobs', 'readonly', (s) => s.getAll() as IDBRequest<JobRecord[]>)
    return all.sort((a, b) => b.createdAt - a.createdAt)
  },
  get: (id: string) => tx<JobRecord | undefined>('jobs', 'readonly', (s) => s.get(id) as IDBRequest<JobRecord | undefined>),
  put: (job: JobRecord) => tx('jobs', 'readwrite', (s) => s.put({ ...job, updatedAt: Date.now() })),
  async remove(id: string): Promise<void> {
    await tx('jobs', 'readwrite', (s) => s.delete(id))
    const range = IDBKeyRange.bound(`${id}/`, `${id}/￿`)
    await tx('artifacts', 'readwrite', (s) => s.delete(range))
    await files.removeJob(id)
  },
}

/** Stage results for one job (the funnel's and transcriber's Store). */
export function jobStore(jobId: string): Store {
  return {
    load: <T>(name: string) =>
      tx<T | undefined>('artifacts', 'readonly', (s) => s.get(`${jobId}/${name}`) as IDBRequest<T | undefined>),
    save: async (name: string, data: unknown) => {
      await tx('artifacts', 'readwrite', (s) => s.put(data, `${jobId}/${name}`))
    },
  }
}

async function jobDir(jobId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const jobsDir = await root.getDirectoryHandle('jobs', { create: true })
    return await jobsDir.getDirectoryHandle(jobId, { create })
  } catch {
    return null
  }
}

export const files = {
  async write(jobId: string, name: string, data: Uint8Array): Promise<void> {
    const dir = await jobDir(jobId, true)
    if (!dir) throw new Error('This browser cannot store files. Use Chrome on Android.')
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data as Uint8Array<ArrayBuffer>)
    await writable.close()
  },
  async read(jobId: string, name: string): Promise<File | null> {
    const dir = await jobDir(jobId, false)
    if (!dir) return null
    try {
      return await (await dir.getFileHandle(name)).getFile()
    } catch {
      return null
    }
  },
  async remove(jobId: string, name: string): Promise<void> {
    const dir = await jobDir(jobId, false)
    await dir?.removeEntry(name).catch(() => undefined)
  },
  async removeJob(jobId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory()
      const jobsDir = await root.getDirectoryHandle('jobs', { create: true })
      await jobsDir.removeEntry(jobId, { recursive: true })
    } catch {
      // already gone
    }
  },
}

/** Asks the browser not to evict our files under storage pressure. */
export async function persistStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    // best effort
  }
}
