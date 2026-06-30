import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { GlowButton } from '../ui/GlowButton'
import { useSettingsStore } from '../../stores/settingsStore'

interface SystemPromptEditorProps {
  /** When set, the editor updates this persona in place instead of adding a
   *  new one (GitHub #55 — edit custom personas). The parent remounts the
   *  editor with a `key` so the seeded fields below refresh per persona. */
  editingId?: string | null
  initialName?: string
  initialPrompt?: string
  /** Called after a successful save/update or a cancel, so the parent can
   *  close the editor. */
  onDone?: () => void
}

export function SystemPromptEditor({
  editingId,
  initialName = '',
  initialPrompt = '',
  onDone,
}: SystemPromptEditorProps) {
  const { addPersona, updatePersona } = useSettingsStore()
  const [name, setName] = useState(initialName)
  const [prompt, setPrompt] = useState(initialPrompt)
  const isEditing = !!editingId

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return
    if (isEditing) {
      // Only the user-editable fields — keep id/icon/isBuiltIn untouched.
      updatePersona(editingId!, { name: name.trim(), systemPrompt: prompt.trim() })
    } else {
      addPersona({
        id: uuid(),
        name: name.trim(),
        icon: 'User',
        systemPrompt: prompt.trim(),
        isBuiltIn: false,
      })
      setName('')
      setPrompt('')
    }
    onDone?.()
  }

  return (
    <div className="space-y-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Persona name..."
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="System prompt..."
        rows={4}
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm resize-none"
      />
      <div className="flex gap-2">
        <GlowButton onClick={handleSave} disabled={!name.trim() || !prompt.trim()} className="flex-1">
          {isEditing ? 'Update Persona' : 'Save Persona'}
        </GlowButton>
        {onDone && (
          <button
            onClick={onDone}
            className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 border border-white/10 hover:border-white/20 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
