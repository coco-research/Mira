import { useState, useEffect } from 'react'
import { SHORTCUTS } from '../../hooks/useKeyboardShortcuts'
import { Modal } from '../ui/Modal'

export function ShortcutsModal() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('lu-show-shortcuts', handler)
    return () => window.removeEventListener('lu-show-shortcuts', handler)
  }, [])

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard Shortcuts">
      <div className="space-y-1.5">
        {SHORTCUTS.map(s => (
          <div key={s.keys} className="flex items-center justify-between py-1.5">
            <span className="text-[0.65rem] text-gray-600 dark:text-gray-300">{s.description}</span>
            <kbd className="text-[0.6rem] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-white/15">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </Modal>
  )
}
