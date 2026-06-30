/**
 * Backend Selection Dialog
 *
 * Shown ONCE per install when multiple local backends are detected.
 * User picks one as the primary backend + acknowledges the "don't show this
 * again" tickbox (pre-checked). Dismissing ALWAYS persists the opt-out so the
 * modal never re-appears mid-session or after a restart. Users manage providers
 * from Settings → Providers going forward.
 */

import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { useProviderStore } from '../../stores/providerStore'
import { useUIStore } from '../../stores/uiStore'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import type { DetectedBackend } from '../../lib/backend-detector'

interface Props {
  open: boolean
  backends: DetectedBackend[]
  onClose: () => void
}

export function BackendSelector({ open, backends, onClose }: Props) {
  const [selected, setSelected] = useState<string>(backends[0]?.id || '')
  // Pre-checked: the common case is "saw it once, don't bug me again". User can
  // uncheck if they want it to re-appear on next launch.
  const [dontShowAgain, setDontShowAgain] = useState(true)
  const { setProviderConfig, setHideBackendSelector } = useProviderStore()

  const dismiss = () => {
    // Persist the user's choice on EVERY dismissal (Skip, Use selected, X).
    // Even if the tickbox was unchecked we still hide for this session via the
    // AppShell sessionStorage guard; persistent opt-out only fires when checked.
    if (dontShowAgain) setHideBackendSelector(true)
    onClose()
  }

  const handleConfirm = () => {
    const backend = backends.find(b => b.id === selected)
    if (!backend) { dismiss(); return }

    const preset = PROVIDER_PRESETS.find(p => p.id === backend.id)
    if (!preset) { dismiss(); return }

    if (preset.providerId === 'ollama') {
      // Ollama uses its own provider slot. Default is enabled=true, but pin
      // the detected baseUrl + (re-)enable so a previously disabled config
      // reappears in Settings and its models show up in the chat selector.
      setProviderConfig('ollama', {
        enabled: true,
        baseUrl: backend.baseUrl,
        isLocal: true,
      })
    } else {
      setProviderConfig('openai', {
        enabled: true,
        name: backend.name,
        baseUrl: backend.baseUrl,
        isLocal: true,
      })
    }

    dismiss()
  }

  const openSettings = () => {
    useUIStore.getState().setView('settings')
    dismiss()
  }

  return (
    <Modal open={open} onClose={dismiss} title="">
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-white text-center">
          {backends.length} local backend{backends.length > 1 ? 's' : ''} detected
        </h3>
        <p className="text-[0.75rem] text-gray-400 text-center leading-relaxed">
          {backends.length === 1
            ? `${backends[0].name} is running on your system.`
            : 'Multiple backends running. Select your primary backend.'}
        </p>

        <div className="space-y-1">
          {backends.map(backend => (
            <button
              key={backend.id}
              onClick={() => setSelected(backend.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                selected === backend.id
                  ? 'bg-white/10 border border-white/15'
                  : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/5'
              }`}
            >
              <div className={`w-2 h-2 rounded-full shrink-0 ${
                selected === backend.id ? 'bg-green-500' : 'bg-gray-600'
              }`} />
              <div className="flex-1">
                <p className="text-[0.7rem] font-medium text-white">{backend.name}</p>
                <p className="text-[0.55rem] text-gray-500 font-mono">localhost:{backend.port}</p>
              </div>
            </button>
          ))}
        </div>

        <p className="text-[0.65rem] text-gray-500 text-center leading-relaxed">
          You can add, remove, or switch backends anytime in{' '}
          <button
            onClick={openSettings}
            className="text-gray-300 hover:text-white underline underline-offset-2 transition-colors"
          >
            Settings → Providers
          </button>
          .
        </p>

        <label className="flex items-center justify-center gap-2 text-[0.65rem] text-gray-400 cursor-pointer select-none pt-1">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="w-3 h-3 rounded border-white/20 bg-white/5 text-white focus:ring-0 focus:ring-offset-0 cursor-pointer"
          />
          Don't show this again
        </label>

        <div className="flex items-center justify-center gap-3 pt-1">
          <button
            onClick={dismiss}
            className="px-4 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
          >
            Use selected
          </button>
        </div>
      </div>
    </Modal>
  )
}
