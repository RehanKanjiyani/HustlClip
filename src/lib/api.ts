/**
 * The browser's only door to the server. Every call is same-origin, carries
 * the session cookie, and turns server errors into TransportErrors whose
 * category the AI manager and the pipeline route on.
 */

import { type ChatReply, type ChatRequest, type TransportCategory, TransportError } from '../engine/manager'

export interface Status {
  passwordSet: boolean
  signedIn: boolean
  providers: string[]
  models: { id: string; label: string }[]
}

export interface RecognizedPart {
  text: string
  words: { w: string; s: number; e: number }[]
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 60_000),
    })
  } catch (error) {
    const name = (error as Error)?.name
    if (name === 'TimeoutError') throw new TransportError('The server took too long to answer.', 'timeout')
    if (name === 'AbortError') throw error
    throw new TransportError('No connection to the HustlClip server. Check your internet.', 'network')
  }
  let body: unknown = null
  const text = await response.text()
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const err = (body as { error?: { category?: string; message?: string; retryAfterS?: number | null } } | null)?.error
    const category = (err?.category as TransportCategory | undefined) ?? (response.status === 504 ? 'timeout' : 'unavailable')
    const message = err?.message ?? `Server error ${response.status}.`
    throw new TransportError(message, category, err?.retryAfterS ?? null)
  }
  return body as T
}

export const api = {
  status: () => request<Status>('/api/status', { timeoutMs: 20_000 }),

  login: (password: string) =>
    request<{ ok: true }>('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>('/api/login', { method: 'DELETE' }),

  chat: (req: ChatRequest, signal?: AbortSignal) =>
    request<ChatReply>('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      timeoutMs: 295_000,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(295_000)]) : undefined,
    }),

  transcribe: (parts: Uint8Array[], model: string, lang: string, signal?: AbortSignal) => {
    const total = parts.reduce((n, p) => n + p.byteLength, 0)
    const body = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      body.set(part, offset)
      offset += part.byteLength
    }
    const query = new URLSearchParams({ model, lang })
    return request<{ model: string; parts: RecognizedPart[]; latencyMs: number }>(`/api/transcribe?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-parts': parts.map((p) => p.byteLength).join(',') },
      body,
      timeoutMs: 295_000,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(295_000)]) : undefined,
    })
  },
}
