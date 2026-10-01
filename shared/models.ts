/**
 * The model registry, shared by the browser (routing, fallback) and the
 * server (which only ever calls models listed here).
 *
 * Every AI step is a *capability*. The browser's AI manager asks for a
 * capability, walks this list in priority order, and falls back when a model
 * is slow, rate-limited, or returns unusable output. Nothing outside this file
 * names a model.
 *
 * NVIDIA's free endpoints vary a lot from hour to hour: the same model can
 * answer in 3 seconds or sit in a queue for minutes. Timeouts here are
 * deliberately short so a stuck model costs one timeout, not the whole job.
 */

export type ProviderId = 'nvidia' | 'anthropic' | 'gemini' | 'openai'

export const PROVIDERS: readonly ProviderId[] = ['nvidia', 'anthropic', 'gemini', 'openai']

export type Capability =
  | 'candidate_discovery'
  | 'candidate_triage'
  | 'text_scoring'
  | 'final_judgment'
  | 'duplicate_risk'

export const CAPABILITIES: readonly Capability[] = [
  'candidate_discovery',
  'candidate_triage',
  'text_scoring',
  'final_judgment',
  'duplicate_risk',
]

export interface ModelEntry {
  /** Stable registry id, used by the browser and in decision records. */
  id: string
  provider: ProviderId
  /** The model name the provider's API expects. */
  apiModel: string
  label: string
  /** Capability -> priority (lower runs first). Absent = not used for it. */
  priority: Partial<Record<Capability, number>>
  maxOutputTokens: number
  /** Seconds without any streamed byte before the call is abandoned. */
  firstByteTimeoutS: number
  /** Hard ceiling for one call, in seconds. */
  timeoutS: number
  /** Whether the model accepts a temperature parameter. */
  temperature: boolean
}

export const MODELS: readonly ModelEntry[] = [
  {
    id: 'nvidia/nemotron-3-super',
    provider: 'nvidia',
    apiModel: 'nvidia/nemotron-3-super-120b-a12b',
    label: 'Nemotron 3 Super',
    priority: {
      candidate_discovery: 10,
      candidate_triage: 20,
      text_scoring: 10,
      final_judgment: 20,
      duplicate_risk: 20,
    },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 170,
    temperature: true,
  },
  {
    id: 'nvidia/gpt-oss-20b',
    provider: 'nvidia',
    apiModel: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B',
    priority: {
      candidate_discovery: 30,
      candidate_triage: 30,
      text_scoring: 30,
      final_judgment: 40,
      duplicate_risk: 30,
    },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 150,
    temperature: true,
  },
  {
    id: 'nvidia/kimi-k3',
    provider: 'nvidia',
    apiModel: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    priority: { final_judgment: 10, text_scoring: 40 },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 200,
    temperature: true,
  },
  {
    id: 'nvidia/deepseek-v4.1-flash',
    provider: 'nvidia',
    apiModel: 'deepseek-ai/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    priority: {
      candidate_discovery: 20,
      candidate_triage: 10,
      text_scoring: 20,
      final_judgment: 30,
      duplicate_risk: 10,
    },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 200,
    temperature: true,
  },
  {
    id: 'nvidia/nemotron-3.5-lightning',
    provider: 'nvidia',
    apiModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    label: 'Nemotron 3.5 Lightning',
    priority: { candidate_discovery: 40, candidate_triage: 40, duplicate_risk: 40 },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 150,
    temperature: true,
  },
  {
    id: 'nvidia/glm-5.3-flash',
    provider: 'nvidia',
    apiModel: 'z-ai/glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    priority: {
      candidate_discovery: 50,
      candidate_triage: 50,
      text_scoring: 50,
      final_judgment: 50,
      duplicate_risk: 50,
    },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 20,
    timeoutS: 240,
    temperature: true,
  },
  {
    id: 'anthropic/claude',
    provider: 'anthropic',
    apiModel: 'claude-opus-5',
    label: 'Claude Opus 5',
    // Only present when ANTHROPIC_API_KEY is set; then it is the judge.
    priority: { final_judgment: 1, text_scoring: 60 },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 60,
    timeoutS: 240,
    temperature: false,
  },
  {
    // Only present when GEMINI_API_KEY is set. Fast, with a free tier: a strong
    // partner for NVIDIA on the high-volume steps. GEMINI_MODEL overrides the name.
    id: 'gemini/flash',
    provider: 'gemini',
    apiModel: 'gemini-flash-latest',
    label: 'Gemini Flash',
    priority: {
      candidate_discovery: 5,
      candidate_triage: 5,
      text_scoring: 5,
      final_judgment: 15,
      duplicate_risk: 5,
    },
    maxOutputTokens: 16384,
    firstByteTimeoutS: 60,
    timeoutS: 200,
    temperature: true,
  },
  {
    // Only present when OPENAI_API_KEY is set. OPENAI_MODEL overrides the name.
    id: 'openai/mini',
    provider: 'openai',
    apiModel: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    priority: {
      candidate_discovery: 25,
      candidate_triage: 25,
      text_scoring: 12,
      final_judgment: 5,
      duplicate_risk: 25,
    },
    maxOutputTokens: 8192,
    firstByteTimeoutS: 60,
    timeoutS: 200,
    temperature: false,
  },
]

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id)
}

/** Models for a capability, best first, limited to configured providers. */
export function modelsFor(capability: Capability, providers: readonly ProviderId[]): ModelEntry[] {
  return MODELS.filter((m) => m.priority[capability] !== undefined && providers.includes(m.provider)).sort(
    (a, b) => (a.priority[capability] ?? 0) - (b.priority[capability] ?? 0) || a.id.localeCompare(b.id),
  )
}

/** Speech-to-text models on NVIDIA's cloud (Riva gRPC, addressed by function id). */
export interface SpeechModel {
  id: string
  label: string
  functionId: string
  /** Whether the model returns per-word timestamps. */
  wordTimes: boolean
}

export const SPEECH_MODELS: readonly SpeechModel[] = [
  {
    id: 'parakeet-tdt-0.6b-v2',
    label: 'Parakeet TDT 0.6B v2 (English)',
    functionId: 'd3fe9151-442b-4204-a70d-5fcc597fd610',
    wordTimes: true,
  },
  {
    id: 'parakeet-ctc-1.1b',
    label: 'Parakeet CTC 1.1B (English)',
    functionId: '1598d209-5e27-4d3c-8079-4751568b1081',
    wordTimes: true,
  },
  {
    id: 'whisper-large-v3',
    label: 'Whisper Large v3 (multilingual)',
    functionId: 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d',
    wordTimes: false,
  },
]

export type LanguageChoice = 'en' | 'hi' | 'auto'

export const LANGUAGES: readonly { id: LanguageChoice; label: string; hint: string }[] = [
  { id: 'en', label: 'English', hint: 'Exact word timing' },
  { id: 'hi', label: 'Hindi / Hinglish', hint: 'Captions are approximately timed' },
  { id: 'auto', label: 'Other language', hint: 'Captions are approximately timed' },
]

/** Speech models to try for a language, best first. */
export function speechModelsFor(language: LanguageChoice): SpeechModel[] {
  const byId = (id: string) => SPEECH_MODELS.find((m) => m.id === id)!
  return language === 'en'
    ? [byId('parakeet-tdt-0.6b-v2'), byId('parakeet-ctc-1.1b')]
    : [byId('whisper-large-v3')]
}

/** BCP-47 code sent to the speech service. */
export function languageCode(language: LanguageChoice): string {
  return language === 'en' ? 'en-US' : language === 'hi' ? 'hi-IN' : 'multi'
}
