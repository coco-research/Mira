import { usePermissionStore } from '../../stores/permissionStore'
import type { ToolCategory, PermissionLevel } from '../../api/mcp/types'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, GitBranch, Lock } from 'lucide-react'

// Categories that are not yet fully implemented
const LOCKED_CATEGORIES = new Set<ToolCategory>(['image'])

const CATEGORIES: {
  key: ToolCategory
  label: string
  description: string
  icon: typeof FolderOpen
  risk: 'low' | 'medium' | 'high'
}[] = [
  { key: 'web', label: 'Web Access', description: 'Search & fetch web pages', icon: Globe, risk: 'low' },
  { key: 'system', label: 'System Info', description: 'OS info, process list', icon: Cpu, risk: 'low' },
  { key: 'filesystem', label: 'Filesystem', description: 'Read, write, search files anywhere', icon: FolderOpen, risk: 'medium' },
  { key: 'image', label: 'Image Generation', description: 'Generate images via ComfyUI', icon: Image, risk: 'medium' },
  { key: 'workflow', label: 'Workflows', description: 'Execute saved agent workflows', icon: GitBranch, risk: 'medium' },
  { key: 'terminal', label: 'Terminal / Shell', description: 'Execute commands, run code', icon: Terminal, risk: 'high' },
  { key: 'desktop', label: 'Desktop Control', description: 'Screenshots, screen interaction', icon: Monitor, risk: 'high' },
]

const RISK_COLORS = {
  low: 'bg-green-500',
  medium: 'bg-amber-500',
  high: 'bg-red-500',
}

const LEVEL_OPTIONS: { value: PermissionLevel; label: string }[] = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'confirm', label: 'Ask First' },
  { value: 'auto', label: 'Auto' },
]

export function PermissionSettings() {
  const { globalPermissions, setGlobalPermission, resetToDefaults } = usePermissionStore()

  return (
    <div className="space-y-2">
      <p className="text-[0.6rem] text-gray-500 mb-3">
        Control what the Agent can access. Per-category permissions apply to all tools in that category.
      </p>

      {CATEGORIES.map(({ key, label, description, icon: Icon, risk }) => {
        const isLocked = LOCKED_CATEGORIES.has(key)

        return (
          <div
            key={key}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
              isLocked
                ? 'bg-white/[0.01] border-white/[0.04] opacity-50'
                : 'bg-white/[0.02] border-white/[0.06] hover:border-white/10'
            }`}
          >
            {/* Risk dot */}
            <div className={`w-1.5 h-1.5 rounded-full ${RISK_COLORS[risk]} shrink-0`} />

            {/* Icon */}
            <Icon size={14} className="text-gray-500 shrink-0" />

            {/* Label + Description */}
            <div className="flex-1 min-w-0">
              <p className="text-[0.7rem] text-gray-300 font-medium">{label}</p>
              <p className="text-[0.55rem] text-gray-600 truncate">{description}</p>
            </div>

            {/* Locked badge or Permission Level Selector */}
            {isLocked ? (
              <div className="flex items-center gap-1 shrink-0">
                <Lock size={10} className="text-gray-600" />
                <span className="text-[0.55rem] text-gray-600 font-medium">Coming Soon</span>
              </div>
            ) : (
              <div className="flex gap-0.5 shrink-0">
                {LEVEL_OPTIONS.map(({ value, label: lvlLabel }) => {
                  const isActive = globalPermissions[key] === value
                  return (
                    <button
                      key={value}
                      onClick={() => setGlobalPermission(key, value)}
                      className={`px-2 py-0.5 rounded text-[0.55rem] font-medium transition-all ${
                        isActive
                          ? value === 'blocked'
                            ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                            : value === 'confirm'
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : 'bg-green-500/15 text-green-400 border border-green-500/30'
                          : 'text-gray-600 hover:text-gray-400 border border-transparent'
                      }`}
                    >
                      {lvlLabel}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <button
        onClick={resetToDefaults}
        className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors mt-2"
      >
        Reset to defaults
      </button>
    </div>
  )
}
