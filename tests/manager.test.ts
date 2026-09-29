import { describe, expect, it } from 'vitest'

import { discovery } from '../src/engine/capabilities'
import { AIManager, CapabilityUnavailable, FatalAIError, type Transport, TransportError } from '../src/engine/manager'

const payload = { text: '[0]a [1]b', firstWord: 0, lastWord: 50, minS: 10, maxS: 60, maxCandidates: 4 }
const good = '{"content_type":"general","candidates":[{"start_word_index":1,"end_word_index":20,"type":"insight","initial_score":0.7}]}'
const reply = (text: string) => ({ text, model: 'm', inputTokens: 10, outputTokens: 5, latencyMs: 1 })

function manager(transport: Transport, clock = { now: 0 }) {
  return new AIManager({
    transport,
    providers: ['nvidia'],
    clock: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    maxWaitMs: 1000,
    hedgeMs: 1e9,
  })
}

describe('AI manager', () => {
  it('uses the first model when it answers well', async () => {
    const calls: string[] = []
    const m = manager(async (r) => (calls.push(r.model), reply(good)))
    const { output, model } = await m.run(discovery, payload)
    expect(output.candidates).toHaveLength(1)
    expect(model).toBe(calls[0])
    expect(m.records.at(-1)!.status).toBe('success')
  })

  it('repairs once on an unusable answer, feeding back the error', async () => {
    const prompts: string[] = []
    let n = 0
    const m = manager(async (r) => {
      prompts.push(r.user)
      return reply(n++ === 0 ? 'nonsense' : good)
    })
    await m.run(discovery, payload)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('could not be used')
  })

  it('falls back to the next model after a rate limit and cools the first one down', async () => {
    const seen: string[] = []
    const m = manager(async (r) => {
      seen.push(r.model)
      if (seen.length === 1) throw new TransportError('slow down', 'rate_limit', 30)
      return reply(good)
    })
    const { model } = await m.run(discovery, payload)
    expect(model).not.toBe(seen[0])
  })

  it('stops at once when the password or key is missing', async () => {
    const m = manager(async () => {
      throw new TransportError('Please sign in again.', 'auth')
    })
    await expect(m.run(discovery, payload)).rejects.toBeInstanceOf(FatalAIError)
  })

  it('gives up with a clear error when every model fails', async () => {
    const m = manager(async () => {
      throw new TransportError('queued', 'timeout')
    })
    await expect(m.run(discovery, payload)).rejects.toBeInstanceOf(CapabilityUnavailable)
    expect(m.records.every((r) => r.status === 'error')).toBe(true)
  })
})
