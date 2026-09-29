import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

import { api, type SystemStatus } from './api'

/**
 * Application shell.
 *
 * A slim masthead rather than a sidebar: on a phone the content needs every
 * pixel of width, and this is a three-screen tool (create, progress, results).
 */
export function App() {
  const [system, setSystem] = useState<SystemStatus | null>(null)

  useEffect(() => {
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [])

  return (
    <div className="min-h-dvh bg-ink-900">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-900/95 pt-[env(safe-area-inset-top)] backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-3 sm:px-6 lg:px-10">
          <NavLink to="/" className="flex items-baseline gap-2.5" aria-label="HustlClip home">
            <span className="font-display text-2xl leading-none text-ink-100">
              Hustl<span className="italic text-sodium-500">Clip</span>
            </span>
          </NavLink>

          <nav className="ml-auto flex items-center gap-5 sm:ml-0">
            <TopLink to="/" end>
              New
            </TopLink>
            <TopLink to="/settings">Settings</TopLink>
          </nav>

          <div className="ml-auto hidden items-baseline gap-5 md:flex">
            {system && <SystemBadge system={system} />}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 lg:px-10">
        <Outlet />
      </main>
    </div>
  )
}

function TopLink({
  to,
  end,
  children,
}: {
  to: string
  end?: boolean
  children: React.ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'py-2 text-sm font-medium transition-colors duration-200',
          isActive ? 'text-sodium-500' : 'text-ink-400 hover:text-ink-200',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  )
}

/**
 * Compact machine status: whether rendering can work, and whether the GPU is
 * in use — the two facts that change how long everything takes.
 */
function SystemBadge({ system }: { system: SystemStatus }) {
  const accel = system.accel.toUpperCase()
  return (
    <div className="flex items-baseline gap-4 text-xs">
      <span className="numeric text-ink-400">
        {accel}
        {system.gpu_name && accel === 'CUDA' && (
          <span className="text-ink-600"> · {system.gpu_name.replace('NVIDIA ', '')}</span>
        )}
      </span>
      <span
        className={system.ready ? 'text-ink-400' : 'text-signal-bad'}
        title={system.ready ? 'All required components present' : 'Run hustlclip doctor'}
      >
        {system.ready ? 'ready' : 'not ready'}
      </span>
    </div>
  )
}
