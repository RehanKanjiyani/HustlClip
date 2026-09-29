import { useState } from 'react'

import type { Status } from '../lib/api'
import { api } from '../lib/api'

/** First-run setup help, or the password screen. */
export function Gate({ status, onSignedIn }: { status: Status; onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!status.passwordSet) {
    return (
      <section className="rise mt-10 space-y-4 text-[0.9375rem] leading-relaxed text-ink-300">
        <h1 className="font-display text-4xl text-ink-100">Almost there</h1>
        <p>HustlClip needs two settings on Vercel before it can run:</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <code className="text-sodium-400">HUSTLCLIP_PASSWORD</code>: any password you like. It keeps strangers from using your key.
          </li>
          <li>
            <code className="text-sodium-400">NVIDIA_API_KEY</code>: your key from build.nvidia.com (starts with nvapi-).
          </li>
        </ol>
        <p>
          In Vercel open your project → <b>Settings</b> → <b>Environment Variables</b>, add both, then go to{' '}
          <b>Deployments</b> → ⋯ → <b>Redeploy</b>. Then reload this page.
        </p>
      </section>
    )
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      onSignedIn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="rise mt-16 space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h1 className="font-display text-4xl text-ink-100">Sign in</h1>
      <label className="block">
        <span className="eyebrow">Your HustlClip password</span>
        <input
          className="field mt-1 text-base"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="text-sm text-signal-bad">{error}</p>}
      <button type="submit" className="btn btn-primary w-full py-3 text-base" disabled={!password || busy}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <p className="text-xs text-ink-500">It's the password you set as HUSTLCLIP_PASSWORD in Vercel.</p>
    </form>
  )
}
