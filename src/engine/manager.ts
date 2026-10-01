/**
 * The AI manager: deterministic routing between capability and model.
 *
 * Pipeline code calls `manager.run(spec, payload)` and gets a validated
 * result, never a provider response. For every request the manager:
 *
 * 1. lists the registry's models for the capability (configured providers
 *    only, best first),
 * 2. skips models that are unhealthy for this job (cooling down after a rate
 *    limit or timeout, disabled after a bad key, retired, or switched off for
 *    this capability after repeated unusable answers),
 * 3. calls the model through the server and validates the reply against the
 *    capability contract,
 * 4. on an unusable reply, asks the same model once more with the validation
 *    error attached (repair); otherwise falls back to the next model,
 * 5. records a DecisionRecord for every attempt.
 *
 * Nothing here is a language model; every decision is code.
 */

import { type ModelEntry, type ProviderId, modelsFor } from '../../shared/models'
import { CapabilityError, type CapabilitySpec, systemPrompt } from './capabilities'

export interface ChatRequest {
  model: string
  system: string
  user: string
  maxTokens: number
  temperature: number | null
}

export interface ChatReply {
  text: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
}

/** Categories the server reports (see api/_lib/http.ts). */
export type TransportCategory =
  | 'auth'
  | 'not_configured'
  | 'provider_auth'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'model_unavailable'
  | 'bad_request'
  | 'too_large'
  | 'internal'
  | 'network'

export class TransportError extends Error {
  constructor(
    message: string,
    readonly category: TransportCategory,
    readonly retryAfterS: number | null = null,
  ) {
    super(message)
  }
}

export type Transport = (request: ChatRequest, signal?: AbortSignal) => Promise<ChatReply>

export interface DecisionRecord {
  at: number
  capability: string
  model: string
  attempt: number
  fallback: boolean
  status: 'success' | 'invalid' | 'error' | 'skipped'
  category: string | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  detail: string
}

/** Thrown when every eligible model failed for a capability. */
export class CapabilityUnavailable extends Error {
  constructor(
    readonly capability: string,
    message: string,
    readonly category: string | null,
  ) {
    super(message)
  }
}

/** Thrown for problems no other model can fix (sign-in, missing key). */
export class FatalAIError extends Error {
  constructor(
    message: string,
    readonly category: TransportCategory,
  ) {
    super(message)
  }
}

const RATE_LIMIT_COOLDOWN_S = 60
const TIMEOUT_COOLDOWN_S = 240
const TRANSIENT_COOLDOWN_S = 45
const QUALITY_STRIKES = 2

type Clock = () => number

interface Health {
  until: number
  disabled: boolean
  failures: number
  successes: number
  state: string
}

/** Job-scoped model health. Nothing outlives the job. */
export class HealthTracker {
  private readonly models = new Map<string, Health>()
  private readonly pairs = new Map<string, number>()
  private readonly disabledPairs = new Set<string>()
  private readonly disabledProviders = new Set<ProviderId>()

  constructor(private readonly clock: Clock = Date.now) {}

  private get(id: string): Health {
    let h = this.models.get(id)
    if (!h) {
      h = { until: 0, disabled: false, failures: 0, successes: 0, state: 'healthy' }
      this.models.set(id, h)
    }
    return h
  }

  usable(entry: ModelEntry, capability: string): boolean {
    if (this.disabledProviders.has(entry.provider)) return false
    if (this.disabledPairs.has(`${entry.id}|${capability}`)) return false
    const h = this.get(entry.id)
    if (h.disabled) return false
    return this.clock() >= h.until
  }

  /** Earliest moment any of these models becomes usable again, or null. */
  nextAvailable(entries: ModelEntry[], capability: string): number | null {
    let best: number | null = null
    for (const e of entries) {
      if (this.disabledProviders.has(e.provider) || this.disabledPairs.has(`${e.id}|${capability}`)) continue
      const h = this.get(e.id)
      if (h.disabled) continue
      if (best === null || h.until < best) best = h.until
    }
    return best
  }

  success(entry: ModelEntry): void {
    const h = this.get(entry.id)
    h.successes++
    h.state = 'healthy'
    h.until = 0
  }

  cooldown(entry: ModelEntry, seconds: number, state: string): void {
    const h = this.get(entry.id)
    h.failures++
    h.state = state
    h.until = this.clock() + Math.max(1, seconds) * 1000
  }

  disable(entry: ModelEntry, state: string): void {
    const h = this.get(entry.id)
    h.failures++
    h.state = state
    h.disabled = true
  }

  disableProvider(provider: ProviderId): void {
    this.disabledProviders.add(provider)
  }

  qualityStrike(entry: ModelEntry, capability: string): void {
    const key = `${entry.id}|${capability}`
    const strikes = (this.pairs.get(key) ?? 0) + 1
    this.pairs.set(key, strikes)
    this.get(entry.id).failures++
    if (strikes >= QUALITY_STRIKES) this.disabledPairs.add(key)
  }

  snapshot(): Record<string, { state: string; failures: number; successes: number }> {
    const out: Record<string, { state: string; failures: number; successes: number }> = {}
    for (const [id, h] of this.models) {
      out[id] = { state: h.disabled ? h.state : this.clock() < h.until ? h.state : 'healthy', failures: h.failures, successes: h.successes }
    }
    return out
  }
}

const FREE_PROVIDERS = new Set<ProviderId>(['nvidia', 'gemini'])

type Outcome<R> = { ok: true; output: R } | { ok: false; category: string; repair: string | null }
type Settled<R> = { outcome: Outcome<R>; promise: Promise<Settled<R>>; entry: ModelEntry }

export interface ManagerOptions {
  transport: Transport
  providers: readonly ProviderId[]
  health?: HealthTracker
  onRecord?: (record: DecisionRecord) => void
  /** Wait for a cooled-down model instead of failing, up to this long. */
  maxWaitMs?: number
  /** Start the next model in parallel if the current one hasn't answered in this long. */
  hedgeMs?: number
  sleep?:(ms: number) => Promise<void>
  clock?: Clock
  signal?: AbortSignal
}

export class AIManager {
  readonly health: HealthTracker
  readonly records: DecisionRecord[] = []
  tokensUsed = 0
  private readonly clock: Clock
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: ManagerOptions) {
    this.clock = options.clock ?? Date.now
    this.health = options.health ?? new HealthTracker(this.clock)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  eligible(capability: CapabilitySpec<unknown, unknown>['name']): ModelEntry[] {
    return modelsFor(capability, this.options.providers)
  }

  available(capability: CapabilitySpec<unknown, unknown>['name']): boolean {
    return this.eligible(capability).length > 0
  }

  /**
   * `rotate` spreads parallel requests across the best few models (each has
   * its own queue on the provider side) instead of piling them onto one.
   */
  async run<P, R>(spec: CapabilitySpec<P, R>, payload: P, options: { rotate?: number } = {}): Promise<{ output: R; model: string }> {
    const ranked = this.eligible(spec.name)
    const spread = Math.min(3, ranked.length)
    const shift = options.rotate ? options.rotate % spread : 0
    const entries = [...ranked.slice(shift, spread), ...ranked.slice(0, shift), ...ranked.slice(spread)]
    if (!entries.length) {
      throw new CapabilityUnavailable(spec.name, 'No AI model is configured. Add NVIDIA_API_KEY in Vercel.', 'not_configured')
    }
    const waitUntil = this.clock() + (this.options.maxWaitMs ?? 150_000)
    const hedgeMs = this.options.hedgeMs ?? 20_000
    const state = { lastCategory: null as string | null, attempt: 0 }

    for (;;) {
      const queue = entries.filter((e) => this.health.usable(e, spec.name))
      const result = await this.race(spec, payload, queue, entries[0]!, hedgeMs, state)
      if (result) return result
      // Every model is cooling down: wait for the first one, within limits.
      const next = this.health.nextAvailable(entries, spec.name)
      if (next === null || next > waitUntil) break
      await this.sleep(Math.max(1000, next - this.clock()))
    }

    throw new CapabilityUnavailable(spec.name, failureMessage(spec.name, state.lastCategory), state.lastCategory)
  }

  /**
   * Tries models in priority order, but never waits on one model alone for
   * long: if the current model hasn't answered within `hedgeMs` (the free
   * tier often queues requests for minutes), the next model starts too, and
   * the first valid answer wins. At most two run at once.
   */
  private async race<P, R>(
    spec: CapabilitySpec<P, R>,
    payload: P,
    queue: ModelEntry[],
    first: ModelEntry,
    hedgeMs: number,
    state: { lastCategory: string | null; attempt: number },
  ): Promise<{ output: R; model: string } | null> {
    const inflight = new Map<Promise<Settled<R>>, AbortController>()
    const start = (entry: ModelEntry) => {
      const controller = new AbortController()
      const promise: Promise<Settled<R>> = this.tryModel(spec, payload, entry, entry !== first, state, controller.signal).then((outcome) => ({ outcome, promise, entry }))
      inflight.set(promise, controller)
    }
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      while (queue.length || inflight.size) {
        this.options.signal?.throwIfAborted()
        if (inflight.size === 0 && queue.length) start(queue.shift()!)
        const hedge =
          // Duplicate requests only to free providers; never double-pay.
          queue.length && inflight.size < 2 && FREE_PROVIDERS.has(queue[0]!.provider)
            ? new Promise<'hedge'>((resolve) => {
                hedgeTimer = setTimeout(() => resolve('hedge'), hedgeMs)
              })
            : null
        const settled = await Promise.race<Settled<R> | 'hedge'>([...inflight.keys(), ...(hedge ? [hedge] : [])])
        clearTimeout(hedgeTimer)
        if (settled === 'hedge') {
          start(queue.shift()!)
          continue
        }
        inflight.delete(settled.promise)
        if (settled.outcome.ok) return { output: settled.outcome.output, model: settled.entry.id }
        state.lastCategory = settled.outcome.category
      }
      return null
    } finally {
      clearTimeout(hedgeTimer)
      for (const controller of inflight.values()) controller.abort()
    }
  }

  /** One model: an attempt, plus one repair attempt if the answer was unusable. */
  private async tryModel<P, R>(
    spec: CapabilitySpec<P, R>,
    payload: P,
    entry: ModelEntry,
    fallback: boolean,
    state: { attempt: number },
    signal: AbortSignal,
  ): Promise<Outcome<R>> {
    let repair: string | null = null
    for (let tries = 0; ; tries++) {
      state.attempt++
      const outcome: Outcome<R> = await this.attempt(spec, payload, entry, repair, state.attempt, fallback, signal)
      if (outcome.ok || signal.aborted) return outcome
      if (outcome.repair && tries === 0 && this.health.usable(entry, spec.name)) {
        repair = outcome.repair
        continue
      }
      return outcome
    }
  }

  private async attempt<P, R>(
    spec: CapabilitySpec<P, R>,
    payload: P,
    entry: ModelEntry,
    repair: string | null,
    attempt: number,
    fallback: boolean,
    signal?: AbortSignal,
  ): Promise<Outcome<R>> {
    let user = spec.render(payload)
    if (repair) {
      user += `\n\nYour previous response could not be used:\n${repair}\nRespond again with ONLY the corrected JSON object.`
    }
    const started = this.clock()
    let reply: ChatReply
    try {
      reply = await this.options.transport({
        model: entry.id,
        system: systemPrompt(spec),
        user,
        maxTokens: Math.min(entry.maxOutputTokens, spec.maxTokens(payload) + 4096),
        temperature: spec.temperature,
      }, signal)
    } catch (error) {
      if (signal?.aborted) return { ok: false, category: 'cancelled', repair: null }
      const e = error instanceof TransportError ? error : new TransportError(String(error), 'network')
      this.record(spec.name, entry, attempt, fallback, 'error', e.category, this.clock() - started, null, null, e.message)
      this.handleTransportError(entry, e)
      return { ok: false, category: e.category, repair: null }
    }

    this.tokensUsed += (reply.inputTokens ?? 0) + (reply.outputTokens ?? 0)
    try {
      const output = spec.parse(reply.text, payload)
      this.health.success(entry)
      this.record(spec.name, entry, attempt, fallback, 'success', null, reply.latencyMs, reply.inputTokens, reply.outputTokens, '')
      return { ok: true, output }
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error
      this.health.qualityStrike(entry, spec.name)
      this.record(
        spec.name,
        entry,
        attempt,
        fallback,
        'invalid',
        error.category,
        reply.latencyMs,
        reply.inputTokens,
        reply.outputTokens,
        error.message,
      )
      return { ok: false, category: error.category, repair: error.message }
    }
  }

  private handleTransportError(entry: ModelEntry, error: TransportError): void {
    switch (error.category) {
      case 'auth':
      case 'not_configured':
        // Signing in again or setting a key is the only fix; no model can help.
        throw new FatalAIError(error.message, error.category)
      case 'provider_auth':
        this.health.disableProvider(entry.provider)
        return
      case 'model_unavailable':
        this.health.disable(entry, 'unavailable')
        return
      case 'rate_limit':
        this.health.cooldown(entry, error.retryAfterS ?? RATE_LIMIT_COOLDOWN_S, 'rate_limited')
        return
      case 'timeout':
        // A queued free-tier model tends to stay queued for a while.
        this.health.cooldown(entry, TIMEOUT_COOLDOWN_S, 'slow')
        return
      case 'too_large':
      case 'bad_request':
        this.health.cooldown(entry, TRANSIENT_COOLDOWN_S, 'refused')
        return
      default:
        this.health.cooldown(entry, error.retryAfterS ?? TRANSIENT_COOLDOWN_S, 'unavailable')
    }
  }

  private record(
    capability: string,
    entry: ModelEntry,
    attempt: number,
    fallback: boolean,
    status: DecisionRecord['status'],
    category: string | null,
    latencyMs: number | null,
    inputTokens: number | null,
    outputTokens: number | null,
    detail: string,
  ): void {
    const record: DecisionRecord = {
      at: this.clock(),
      capability,
      model: entry.id,
      attempt,
      fallback,
      status,
      category,
      latencyMs,
      inputTokens,
      outputTokens,
      detail: detail.slice(0, 300),
    }
    this.records.push(record)
    this.options.onRecord?.(record)
  }
}

function failureMessage(capability: string, category: string | null): string {
  const step = capability.replace(/_/g, ' ')
  switch (category) {
    case 'rate_limit':
      return `The AI models are rate-limited right now (step: ${step}). Wait a few minutes and tap Resume.`
    case 'timeout':
    case 'unavailable':
    case 'network':
      return `The AI models are busy or unreachable right now (step: ${step}). Check your internet, wait a minute, and tap Resume.`
    case 'provider_auth':
      return 'NVIDIA rejected the API key. Put a working key in Vercel (NVIDIA_API_KEY) and redeploy.'
    default:
      return `Every AI model returned unusable answers for ${step}. Tap Resume to try again.`
  }
}
