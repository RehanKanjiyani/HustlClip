import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as chat } from '../api/chat'
import { DELETE as logout, POST as login } from '../api/login'
import { GET as status } from '../api/status'
import { POST as transcribe } from '../api/transcribe'
import { sseEvents, statusError } from '../api/_lib/llm'
import { normalise } from '../api/_lib/riva'

const origin = 'https://hustlclip.example'

function req(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('host', 'hustlclip.example')
  if (init.cookie) headers.set('cookie', init.cookie)
  return new Request(`${origin}${path}`, { ...init, headers })
}

async function signIn(): Promise<string> {
  const response = await login(req('/api/login', { method: 'POST', body: JSON.stringify({ password: 'pw-123456' }) }))
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('Secure')
  return cookie.split(';')[0]!
}

beforeEach(() => {
  process.env.HUSTLCLIP_PASSWORD = 'pw-123456'
  process.env.NVIDIA_API_KEY = 'nvapi-test-not-real'
  delete process.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.HUSTLCLIP_PASSWORD
  delete process.env.NVIDIA_API_KEY
})

describe('password gate', () => {
  it('refuses to run without a password configured', async () => {
    delete process.env.HUSTLCLIP_PASSWORD
    const response = await chat(req('/api/chat', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(503)
    expect((await response.json()).error.category).toBe('not_configured')
  })

  it('rejects a wrong password', async () => {
    const response = await login(req('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) }))
    expect(response.status).toBe(401)
  })

  it('rejects AI calls without a session and never leaks the key in status', async () => {
    const response = await chat(req('/api/chat', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(401)
    const s = await status(req('/api/status'))
    const text = await s.text()
    expect(text).not.toContain('nvapi')
    expect(JSON.parse(text)).toMatchObject({ passwordSet: true, signedIn: false })
  })

  it('accepts a valid session and rejects a forged one', async () => {
    const cookie = await signIn()
    const ok = await status(req('/api/status', { cookie }))
    expect((await ok.json()).signedIn).toBe(true)
    const forged = cookie.replace(/\.[^.]+$/, '.forged')
    expect((await (await status(req('/api/status', { cookie: forged }))).json()).signedIn).toBe(false)
  })

  it('refuses cross-site requests', async () => {
    const response = await login(
      req('/api/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ password: 'pw-123456' }) }),
    )
    expect(response.status).toBe(403)
  })

  it('signs out', async () => {
    const response = await logout(req('/api/login', { method: 'DELETE' }))
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('chat endpoint', () => {
  it('only runs registry models', async () => {
    const cookie = await signIn()
    const response = await chat(
      req('/api/chat', { method: 'POST', cookie, body: JSON.stringify({ model: 'evil/model', system: 's', user: 'u' }) }),
    )
    expect(response.status).toBe(400)
  })

  it('streams an NVIDIA answer and reports usage', async () => {
    const cookie = await signIn()
    const body = [
      'data: {"model":"openai/gpt-oss-20b","choices":[{"delta":{"content":"{\\"ok\\""}}]}',
      'data: {"choices":[{"delta":{"content":": true}"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const response = await chat(
      req('/api/chat', { method: 'POST', cookie, body: JSON.stringify({ model: 'nvidia/gpt-oss-20b', system: 's', user: 'u' }) }),
    )
    const data = await response.json()
    expect(data).toMatchObject({ text: '{"ok": true}', inputTokens: 12, outputTokens: 3 })
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(sent.model).toBe('openai/gpt-oss-20b')
    expect(String((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization)).toBe('Bearer nvapi-test-not-real')
  })

  it('calls OpenAI and Gemini with their own dialects and honours model overrides', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-real'
    process.env.GEMINI_API_KEY = 'gm-test-not-real'
    process.env.OPENAI_MODEL = 'gpt-test-override'
    try {
      const cookie = await signIn()
      const stream = 'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\ndata: [DONE]\n'
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(stream, { status: 200 }))
      for (const model of ['openai/mini', 'gemini/flash']) {
        const response = await chat(
          req('/api/chat', { method: 'POST', cookie, body: JSON.stringify({ model, system: 's', user: 'u', maxTokens: 1000 }) }),
        )
        expect(response.status).toBe(200)
      }
      const [openaiCall, geminiCall] = fetchMock.mock.calls
      expect(String(openaiCall![0])).toBe('https://api.openai.com/v1/chat/completions')
      const openaiBody = JSON.parse(String(openaiCall![1]!.body))
      expect(openaiBody).toMatchObject({ model: 'gpt-test-override', max_completion_tokens: 1000 })
      expect(openaiBody.max_tokens).toBeUndefined()
      expect(String(geminiCall![0])).toContain('generativelanguage.googleapis.com/v1beta/openai/chat/completions')
      const geminiBody = JSON.parse(String(geminiCall![1]!.body))
      expect(geminiBody).toMatchObject({ model: 'gemini-flash-lite-latest', max_tokens: 1000 })
      expect(String((geminiCall![1]!.headers as Record<string, string>).authorization)).toBe('Bearer gm-test-not-real')
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.GEMINI_API_KEY
      delete process.env.OPENAI_MODEL
    }
  })

  it('classifies provider errors', async () => {
    expect((await statusError(new Response('', { status: 429, headers: { 'retry-after': '7' } }), 'NVIDIA')).category).toBe('rate_limit')
    expect((await statusError(new Response('', { status: 401 }), 'NVIDIA')).category).toBe('provider_auth')
    expect((await statusError(new Response('model not found', { status: 400 }), 'NVIDIA')).category).toBe('model_unavailable')
  })

  it('parses SSE split across chunks', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"a"'))
        c.enqueue(new TextEncoder().encode(':1}\n\ndata: [DONE]\n'))
        c.close()
      },
    })
    const events: string[] = []
    for await (const e of sseEvents(new Response(stream))) events.push(e)
    expect(events).toEqual(['{"a":1}', '[DONE]'])
  })
})

describe('transcribe endpoint', () => {
  it('validates the part lengths against the body', async () => {
    const cookie = await signIn()
    const response = await transcribe(
      req('/api/transcribe?model=parakeet-tdt-0.6b-v2&lang=en-US', {
        method: 'POST',
        cookie,
        headers: { 'x-parts': '10,10' },
        body: new Uint8Array(15),
      }),
    )
    expect(response.status).toBe(400)
  })

  it('normalises Riva word timings from milliseconds', () => {
    const out = normalise({
      results: [{ alternatives: [{ transcript: 'Hello there.', words: [{ word: 'Hello', start_time: 0, end_time: 480 }, { word: 'there.', start_time: 640, end_time: 900 }] }] }],
    })
    expect(out.words).toEqual([
      { w: 'Hello', s: 0, e: 0.48 },
      { w: 'there.', s: 0.64, e: 0.9 },
    ])
  })
})
