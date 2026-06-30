import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { mountFatalError } from './lib/fatal-error'

const rootEl = document.getElementById('root')!

// Bug D (surfingbird1010): a throw while a persisted store hydrates from corrupt
// data (D1 corrupt chat-settings / D2 migrate throw / D5 locked IndexedDB) fires
// at module-import time — before the React ErrorBoundary can mount. With the
// window starting hidden, that left the app launched-but-invisible. Load the app
// via dynamic import inside a catch so any boot throw renders an actionable
// recovery screen (which also force-shows the window) instead of a blank page.
// The Rust force-show timeout (main.rs setup) is the ultimate net.
async function boot() {
  const [{ default: App }, { ErrorBoundary }] = await Promise.all([
    import('./App.tsx'),
    import('./components/ui/ErrorBoundary'),
  ])
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary root>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot().catch((err) => mountFatalError(rootEl, err))
