import { useEffect, useState } from 'react'

import {
  api,
  type AIStatus,
  type ProviderStatus,
  type RoutingStrategy,
  type Settings as SettingsData,
  type SystemStatus,
} from '../api'
import { ErrorNote } from '../components/ErrorNote'

const SECRET_LABELS: Record<string, { label: string; hint: string }> = {
  nvidia: {
    label: 'NVIDIA API key',
    hint: 'Recommended. Free at build.nvidia.com — powers finding and scoring moments.',
  },
  anthropic: {
    label: 'Anthropic API key',
    hint: 'Optional. Claude makes the final pick of the best clips when present.',
  },
  typesafe: {
    label: 'TypeSafe (Jev) API key',
    hint: 'Optional. Fast, cheap yes/no decisions (triage, repeat detection).',
  },
  openai: { label: 'OpenAI-compatible API key', hint: 'Optional fallback.' },
  gemini: { label: 'Google Gemini API key', hint: 'Optional fallback.' },
  huggingface_token: {
    label: 'HuggingFace token',
    hint: 'Only for speaker identification.',
  },
}

const ROUTING: { value: RoutingStrategy; label: string; note: string }[] = [
  { value: 'automatic', label: 'Automatic', note: 'Cheap models find, strong models judge.' },
  { value: 'efficiency', label: 'Efficiency first', note: 'Keeps premium models out of it.' },
  { value: 'quality', label: 'Quality first', note: 'Uses the strongest model for more steps.' },
]

const JUDGE_PROVIDERS = ['anthropic', 'nvidia', 'openai', 'gemini', 'ollama']

export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [ai, setAi] = useState<AIStatus | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  const reload = () => {
    void api.getSettings().then(setSettings).catch((e) => setError(e as Error))
    void api.system().then(setSystem).catch(() => undefined)
    void api.aiStatus().then(setAi).catch(() => undefined)
  }

  // Live provider checks make network calls, so they run only when asked for.
  const checkProviders = () => {
    void api.providerStatus().then(setProviders).catch(() => undefined)
  }

  useEffect(reload, [])

  const patch = async (update: Partial<SettingsData>) => {
    setError(null)
    try {
      setSettings(await api.putSettings(update))
      void api.aiStatus().then(setAi).catch(() => undefined)
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (err) {
      setError(err as Error)
    }
  }

  if (!settings) return <p className="pt-24 text-sm text-ink-500">Loading…</p>

  return (
    <div className="mx-auto max-w-3xl pt-10 sm:pt-14">
      <div className="rise flex items-baseline justify-between border-b border-ink-800 pb-5">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-none text-ink-100">
          Settings
        </h1>
        <span
          className="text-xs text-signal-good transition-opacity duration-300"
          style={{ opacity: saved ? 1 : 0 }}
        >
          saved
        </span>
      </div>

      {error && (
        <div className="mt-6">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {settings.insecure_secret_storage && (
        <p className="mt-6 border-l-2 border-sodium-600 pl-4 text-sm leading-relaxed text-ink-300">
          No OS keyring is available on this machine, so API keys are stored in plain text
          in <code className="text-ink-200">config.json</code>. On headless Linux, installing
          a Secret Service provider or <code className="text-ink-200">keyrings.alt</code>{' '}
          fixes this.
        </p>
      )}

      <Section title="AI keys" note="Stored on the machine running HustlClip. Never shown again.">
        <div className="space-y-6">
          {Object.entries(SECRET_LABELS).map(([key, { label, hint }]) => (
            <SecretField
              key={key}
              secretKey={key}
              label={label}
              hint={hint}
              present={settings.keys_present[key] ?? false}
              onChanged={reload}
              onError={setError}
            />
          ))}
        </div>
      </Section>

      <Section title="AI routing" note="Each step goes to the right model automatically.">
        <div className="space-y-1">
          {ROUTING.map((option) => (
            <button
              key={option.value}
              onClick={() => patch({ ai: { ...settings.ai, routing: option.value } })}
              className={[
                'block w-full border-l-2 py-3 pl-3 text-left transition-colors duration-200',
                settings.ai.routing === option.value
                  ? 'border-sodium-500 bg-ink-850/60'
                  : 'border-transparent hover:border-ink-700 hover:bg-ink-850/30',
              ].join(' ')}
            >
              <span className="block text-sm text-ink-100">{option.label}</span>
              <span className="mt-0.5 block text-xs text-ink-500">{option.note}</span>
            </button>
          ))}
        </div>

        {ai && (
          <p className="mt-5 text-xs leading-relaxed text-ink-500">
            {(ai.routes.candidate_discovery ?? []).length === 0
              ? 'No AI model is available yet — add a key above.'
              : `Finding moments: ${ai.routes.candidate_discovery[0]} · Final pick: ${
                  ai.routes.final_judgment?.[0] ?? 'none (scores decide)'
                }`}
          </p>
        )}

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="btn btn-quiet -ml-1 mt-5 py-2">
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>

        {advanced && (
          <div className="mt-4 space-y-8">
            <div>
              <p className="eyebrow">Strongest model (final judgment)</p>
              <div className="mt-2 grid gap-5 sm:grid-cols-3">
                <Select
                  label="Provider"
                  value={settings.active_provider}
                  onChange={(value) => patch({ active_provider: value })}
                  options={JUDGE_PROVIDERS}
                />
                <Field
                  label="Model"
                  value={settings.providers[settings.active_provider]?.model ?? ''}
                  placeholder="model id"
                  onCommit={(value) =>
                    patch({
                      providers: {
                        [settings.active_provider]: {
                          ...settings.providers[settings.active_provider],
                          model: value,
                        },
                      },
                    })
                  }
                />
                <Field
                  label="Base URL"
                  value={settings.providers[settings.active_provider]?.base_url ?? ''}
                  placeholder="default"
                  onCommit={(value) =>
                    patch({
                      providers: {
                        [settings.active_provider]: {
                          ...settings.providers[settings.active_provider],
                          base_url: value || null,
                        },
                      },
                    })
                  }
                />
              </div>
            </div>

            {ai && (
              <div>
                <p className="eyebrow">Models</p>
                <ul className="mt-2">
                  {ai.models.map((model) => (
                    <li
                      key={model.id}
                      className="flex items-center justify-between gap-4 border-b border-ink-850 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-100">{model.display_name}</span>
                        <span className="block truncate text-xs text-ink-500">
                          {model.configured ? model.capabilities.join(' · ') : 'no key'}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        aria-label={`Use ${model.display_name}`}
                        checked={model.enabled}
                        onChange={(e) =>
                          patch({
                            ai: {
                              ...settings.ai,
                              models: {
                                ...settings.ai.models,
                                [model.id]: { enabled: e.target.checked, api_model: null },
                              },
                            },
                          })
                        }
                        className="size-5 shrink-0 accent-sodium-500"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <NumberField
                label="Token limit per job (0 = none)"
                value={settings.ai.job_token_budget}
                onCommit={(value) => patch({ ai: { ...settings.ai, job_token_budget: value } })}
              />
              <NumberField
                label="Clips checked visually"
                value={settings.ai.max_visual_candidates}
                onCommit={(value) =>
                  patch({ ai: { ...settings.ai, max_visual_candidates: value } })
                }
              />
            </div>
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={settings.ai.visual_analysis}
                onChange={(e) =>
                  patch({ ai: { ...settings.ai, visual_analysis: e.target.checked } })
                }
                className="mt-0.5 size-5 accent-sodium-500"
              />
              Look at frames of promising moments (gaming, reactions)
            </label>

            <div>
              <button type="button" onClick={checkProviders} className="btn btn-ghost">
                Test connections
              </button>
              {providers.length > 0 && (
                <ul className="mt-3">
                  {providers.map((provider) => (
                    <li
                      key={provider.name}
                      className="flex items-baseline justify-between gap-4 border-b border-ink-850 py-2 text-sm"
                    >
                      <span className="text-ink-200">{provider.name}</span>
                      <span
                        className={`truncate text-xs ${provider.available ? 'text-signal-good' : 'text-ink-500'}`}
                      >
                        {provider.available ? 'reachable' : provider.has_key ? 'unreachable' : 'no key'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section title="Transcription">
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Whisper model"
            value={settings.whisper.model}
            onChange={(value) => patch({ whisper: { ...settings.whisper, model: value } })}
            options={['tiny', 'base', 'small', 'medium', 'large-v3']}
          />
          <Field
            label="Language"
            hint="Leave empty to detect automatically."
            value={settings.whisper.language}
            placeholder="auto"
            onCommit={(value) => patch({ whisper: { ...settings.whisper, language: value } })}
          />
        </div>

        <label className="mt-5 flex items-start gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.whisper.diarization}
            disabled={!system?.diarization_available}
            onChange={(e) =>
              patch({ whisper: { ...settings.whisper, diarization: e.target.checked } })
            }
            className="mt-0.5 size-4 accent-sodium-500"
          />
          <span>
            Identify speakers
            {!system?.diarization_available && (
              <span className="mt-1 block text-xs text-ink-500">
                Needs the diarization extra:{' '}
                <code className="text-ink-300">uv pip install &apos;.[diarization]&apos;</code>
              </span>
            )}
          </span>
        </label>
      </Section>

      <Section title="Clips">
        <div className="grid gap-5 sm:grid-cols-3">
          <NumberField
            label="Min length (s)"
            value={settings.clips.min_duration_s}
            onCommit={(value) => patch({ clips: { ...settings.clips, min_duration_s: value } })}
          />
          <NumberField
            label="Max length (s)"
            value={settings.clips.max_duration_s}
            onCommit={(value) => patch({ clips: { ...settings.clips, max_duration_s: value } })}
          />
          <NumberField
            label="Clips per video"
            value={settings.clips.max_clips}
            onCommit={(value) => patch({ clips: { ...settings.clips, max_clips: value } })}
          />
        </div>
      </Section>

      <Section title="Ingest">
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="YouTube cookies from"
            hint="YouTube blocks most anonymous downloads. Sign in in that browser and close it before downloading."
            value={settings.ingest.cookies_from_browser}
            onChange={(value) =>
              patch({ ingest: { ...settings.ingest, cookies_from_browser: value } })
            }
            options={['', 'chrome', 'firefox', 'edge', 'brave', 'chromium', 'safari']}
            labels={{ '': 'None' }}
          />
        </div>
      </Section>

      <Section title="Export">
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Default ratio"
            value={settings.export.ratio}
            onChange={(value) => patch({ export: { ...settings.export, ratio: value } })}
            options={['9:16', '1:1', '16:9']}
          />
          <NumberField
            label="Loudness target (LUFS)"
            value={settings.export.loudness_lufs}
            onCommit={(value) => patch({ export: { ...settings.export, loudness_lufs: value } })}
          />
        </div>

        <label className="mt-5 flex items-start gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.export.prefer_hardware_encoder}
            onChange={(e) =>
              patch({
                export: { ...settings.export, prefer_hardware_encoder: e.target.checked },
              })
            }
            className="mt-0.5 size-4 accent-sodium-500"
          />
          <span>
            Use GPU encoding when available
            {system && !system.nvenc_works && (
              <span className="mt-1 block text-xs text-ink-500">
                Not usable on this machine — exports will use the CPU encoder. Same quality,
                slower.
              </span>
            )}
          </span>
        </label>

        <label className="mt-4 flex items-center gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.export.write_srt}
            onChange={(e) => patch({ export: { ...settings.export, write_srt: e.target.checked } })}
            className="size-4 accent-sodium-500"
          />
          Also write an .srt sidecar
        </label>
      </Section>

      {system && (
        <Section title="This machine">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Platform" value={system.platform} />
            <Row label="Python" value={system.python_version} />
            <Row label="ffmpeg" value={system.ffmpeg_version ?? 'not found'} />
            <Row label="Acceleration" value={system.accel.toUpperCase()} />
            <Row label="Device" value={system.gpu_name ?? '—'} />
            <Row label="Whisper compute" value={system.compute_type} />
            <Row label="GPU encode" value={system.nvenc_works ? 'available' : 'unavailable'} />
            <Row label="Captions" value={system.has_libass ? 'libass present' : 'libass missing'} />
          </dl>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="rise mt-14">
      <div className="border-b border-ink-800 pb-2">
        <h2 className="eyebrow">{title}</h2>
        {note && <p className="mt-1 text-xs text-ink-500">{note}</p>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-850 pb-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className="numeric truncate text-right text-ink-200">{value}</dd>
    </div>
  )
}

/** Commits on blur rather than per keystroke, so a PUT isn't fired per letter. */
function Field({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        className="field mt-1 text-sm"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        spellCheck={false}
      />
      {hint && <span className="mt-1.5 block text-xs leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        type="number"
        className="field numeric mt-1 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = Number(draft)
          if (!Number.isNaN(parsed) && parsed !== value) onCommit(parsed)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

function Select({
  label,
  hint,
  value,
  onChange,
  options,
  labels = {},
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  options: string[]
  labels?: Record<string, string>
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <select
        className="field mt-1 cursor-pointer text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option} className="bg-ink-850">
            {labels[option] ?? option}
          </option>
        ))}
      </select>
      {hint && <span className="mt-1.5 block text-xs leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

function SecretField({
  secretKey,
  label,
  hint,
  present,
  onChanged,
  onError,
}: {
  secretKey: string
  label: string
  hint: string
  present: boolean
  onChanged: () => void
  onError: (error: Error) => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await api.putSecret(secretKey, value.trim())
      setValue('')
      onChanged()
    } catch (err) {
      onError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.deleteSecret(secretKey)
      onChanged()
    } catch (err) {
      onError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-end gap-3">
        <label className="min-w-0 flex-1">
          <span className="eyebrow">
            {label}
            {present && <span className="ml-2 text-signal-good">set</span>}
          </span>
          <input
            type="password"
            className="field mt-1 text-base sm:text-sm"
            value={value}
            placeholder={present ? '••••••••••••' : 'paste to add'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            autoComplete="off"
          />
        </label>
        <button onClick={save} disabled={!value.trim() || busy} className="btn btn-ghost">
          Save
        </button>
        {present && (
          <button onClick={remove} disabled={busy} className="btn btn-quiet">
            Remove
          </button>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-snug text-ink-500">{hint}</p>
    </div>
  )
}
