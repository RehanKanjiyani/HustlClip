import { useCallback, useEffect, useState } from 'react'

import { PROVIDERS, type ProviderId } from '../../shared/models'
import { type Status, api } from '../lib/api'
import { persistStorage } from '../lib/store'
import { Gate } from './Gate'
import { Home } from './Home'
import { JobView } from './JobView'
import { type Route, navigate, parseRoute } from './nav'

/** A file shared to HustlClip from Android's share sheet (see public/sw.js). */
async function takeSharedFile(): Promise<File | null> {
  if (!new URLSearchParams(location.search).has('shared')) return null
  history.replaceState(null, '', `/${location.hash}`)
  try {
    const cache = await caches.open('hustlclip-share')
    const response = await cache.match('/shared-video')
    if (!response) return null
    const blob = await response.blob()
    const name = decodeURIComponent(response.headers.get('x-file-name') ?? 'shared-video.mp4')
    const modified = Number(response.headers.get('x-file-modified')) || Date.now()
    return new File([blob], name, { type: blob.type || 'video/mp4', lastModified: modified })
  } catch {
    return null
  }
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>(parseRoute)
  const [sharedFile, setSharedFile] = useState<File | null>(null)

  const refresh = useCallback(() => {
    setStatusError(null)
    api
      .status()
      .then(setStatus)
      .catch((error: Error) => setStatusError(error.message))
  }, [])

  useEffect(() => {
    refresh()
    void persistStorage()
    void takeSharedFile().then((file) => file && setSharedFile(file))
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [refresh])

  const ready = status?.passwordSet && status.signedIn
  const providers = (status?.providers ?? []).filter((p): p is ProviderId => (PROVIDERS as readonly string[]).includes(p))

  return (
    <div className="mx-auto min-h-dvh max-w-xl px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between border-b rule pb-3">
        <button type="button" onClick={() => navigate({ page: 'home' })} className="font-display text-2xl text-ink-100">
          Hustl<span className="italic text-sodium-500">Clip</span>
        </button>
        {ready && (
          <button
            type="button"
            className="btn-quiet btn text-xs"
            onClick={() => api.logout().then(refresh).catch(refresh)}
          >
            Sign out
          </button>
        )}
      </header>

      {!status && !statusError && <p className="mt-16 text-center text-ink-400">Loading…</p>}
      {statusError && (
        <div className="mt-16 space-y-4 text-center">
          <p className="text-ink-300">{statusError}</p>
          <button type="button" className="btn btn-ghost" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {status && !ready && <Gate status={status} onSignedIn={refresh} />}
      {ready && providers.length === 0 && (
        <p className="mt-10 border-l-2 border-signal-bad pl-4 text-sm leading-relaxed text-ink-300">
          No AI key is set on the server. In Vercel, open your project → Settings → Environment Variables, add{' '}
          <code className="text-sodium-400">NVIDIA_API_KEY</code>, then Deployments → ⋯ → Redeploy.
        </p>
      )}
      {ready && providers.length > 0 && route.page === 'home' && (
        <Home sharedFile={sharedFile} onSharedUsed={() => setSharedFile(null)} providers={providers} />
      )}
      {ready && providers.length > 0 && route.page === 'job' && <JobView id={route.id} providers={providers} />}
    </div>
  )
}
