import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './ui/App'
import './index.css'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
