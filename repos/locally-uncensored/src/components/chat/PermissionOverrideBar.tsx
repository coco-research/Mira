import { usePermissionStore } from '../../stores/permissionStore'
import { useChatStore } from '../../stores/chatStore'
import type { ToolCategory } from '../../api/mcp/types'
import { useImageToolNoti } from '../../hooks/useImageToolNoti'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, Film, GitBranch, Lock } from 'lucide-react'

// Image AND video generation are LIVE (chat agent → ComfyUI; video unlocked
// in v2.5.3 — T2V via Wan/Hunyuan/AnimateDiff, I2V via SVD/FramePack). The
// LOCKED set stays as the mechanism for future not-yet-shipped categories.
const LOCKED: Set<ToolCategory> = new Set()

const CATEGORIES: { key: ToolCategory; icon: typeof Globe; label: string }[] = [
  { key: 'web', icon: Globe, label: 'Web' },
  { key: 'system', icon: Cpu, label: 'System' },
  { key: 'filesystem', icon: FolderOpen, label: 'Files' },
  { key: 'terminal', icon: Terminal, label: 'Shell' },
  { key: 'desktop', icon: Monitor, label: 'Screenshot' },
  { key: 'image', icon: Image, label: 'Image' },
  { key: 'video', icon: Film, label: 'Video' },
  { key: 'workflow', icon: GitBranch, label: 'Workflows' },
]

export function PermissionOverrideBar() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const { getEffectivePermissions, setConversationOverride } = usePermissionStore()
  const { visible: imageNoti, dismiss: dismissImageNoti } = useImageToolNoti()

  if (!activeConversationId) return null

  const permissions = getEffectivePermissions(activeConversationId)

  const toggleTool = (cat: ToolCategory) => {
    if (LOCKED.has(cat)) return
    // First click on the image-tool noti only acknowledges it (purely visual,
    // no activation — David 2026-06-06). After that the row toggles as normal.
    if (cat === 'image' && imageNoti) { dismissImageNoti(); return }
    const current = permissions[cat]
    setConversationOverride(activeConversationId, cat, current === 'blocked' ? 'auto' : 'blocked')
  }

  return (
    <div>
      {CATEGORIES.map(({ key, icon: Icon, label }) => {
        const isLocked = LOCKED.has(key)
        const isOn = !isLocked && permissions[key] !== 'blocked'
        return (
          <button
            key={key}
            onClick={() => toggleTool(key)}
            disabled={isLocked}
            className={`flex items-center gap-1.5 w-full px-1.5 py-[3px] text-[0.5rem] transition-colors ${
              isLocked
                ? 'text-gray-400 dark:text-gray-700 cursor-default'
                : isOn
                  ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                  : 'text-gray-400 dark:text-gray-600 hover:bg-gray-100 dark:hover:bg-white/5'
            }`}
          >
            {isLocked ? (
              <Lock size={7} className="text-gray-700" />
            ) : (
              <Icon size={8} className={isOn ? 'text-green-400' : 'text-gray-600'} />
            )}
            <span className={`flex-1 text-left ${isLocked ? 'line-through' : ''}`}>{label}</span>
            {/* Image-tool discovery noti — small purple "1", purely visual,
                clears on first click (David 2026-06-06). HW-gated by the hook. */}
            {key === 'image' && imageNoti && (
              <span className="min-w-[12px] h-[12px] flex items-center justify-center rounded-full bg-purple-500 text-[0.45rem] font-bold text-white leading-none px-0.5 mr-0.5">
                1
              </span>
            )}
            {isLocked ? (
              <span className="text-[0.4rem] text-gray-700">soon</span>
            ) : (
              <div className={`w-1 h-1 rounded-full ${isOn ? 'bg-green-400' : 'bg-gray-700'}`} />
            )}
          </button>
        )
      })}
    </div>
  )
}
