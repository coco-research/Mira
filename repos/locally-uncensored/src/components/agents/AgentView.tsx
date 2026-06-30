import { useState, useEffect } from 'react'
import { backendCall } from '../../api/backend'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, Play, Square, Trash2, Clock, Download, Loader2, CircleCheck, CircleAlert } from 'lucide-react'
import { GlowButton } from '../ui/GlowButton'
import { GlassCard } from '../ui/GlassCard'
import { TaskBreakdown } from './TaskBreakdown'
import { AgentLog } from './AgentLog'
import { useAgent } from '../../hooks/useAgent'
import { useAgentStore } from '../../stores/agentStore'
import { useModelStore } from '../../stores/modelStore'
import type { AgentRun } from '../../types/agents'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function statusColor(status: AgentRun['status']): string {
  switch (status) {
    case 'completed': return 'text-green-400'
    case 'failed': return 'text-red-400'
    case 'executing': case 'planning': return 'text-blue-400'
    case 'paused': return 'text-amber-400'
    default: return 'text-gray-400'
  }
}

function statusLabel(status: AgentRun['status']): string {
  switch (status) {
    case 'completed': return 'Done'
    case 'failed': return 'Failed'
    case 'executing': return 'Running'
    case 'planning': return 'Planning'
    case 'paused': return 'Paused'
    default: return 'Idle'
  }
}

export function AgentView() {
  const [goal, setGoal] = useState('')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [searxngStatus, setSearxngStatus] = useState<{ installed: boolean; running: boolean; dockerAvailable: boolean } | null>(null)
  const [searxngInstalling, setSearxngInstalling] = useState(false)
  const [searxngMsg, setSearxngMsg] = useState('')

  const checkSearxngStatus = async () => {
    try {
      const data = await backendCall('searxng_status')
      setSearxngStatus({ installed: data.installed, running: data.running, dockerAvailable: data.dockerAvailable })
    } catch {
      setSearxngStatus({ installed: false, running: false, dockerAvailable: false })
    }
  }

  const installOrStartSearxng = async () => {
    setSearxngInstalling(true)
    setSearxngMsg('Starting...')
    try {
      const data = await backendCall('install_searxng')
      if (data.error) {
        setSearxngMsg(data.error)
        setSearxngInstalling(false)
        return
      }
      if (data.status === 'ok') {
        setSearxngMsg(data.message)
        setSearxngInstalling(false)
        setTimeout(checkSearxngStatus, 3000)
        return
      }
      const poll = setInterval(async () => {
        try {
          const statusData = await backendCall('searxng_status')
          const lastLog = statusData.logs?.length ? statusData.logs[statusData.logs.length - 1] : ''
          setSearxngMsg(lastLog || statusData.status)
          if (statusData.status === 'complete') {
            clearInterval(poll)
            setSearxngInstalling(false)
            setSearxngMsg('')
            checkSearxngStatus()
          } else if (statusData.status === 'error') {
            clearInterval(poll)
            setSearxngInstalling(false)
            setSearxngMsg(statusData.error || 'Install failed')
          }
        } catch { /* ignore poll errors */ }
      }, 2000)
    } catch {
      setSearxngMsg('Failed to start install')
      setSearxngInstalling(false)
    }
  }

  useEffect(() => {
    checkSearxngStatus()
  }, [])
  const { activeRun, isRunning, startAgent, stopAgent, approveToolCall, rejectToolCall } = useAgent()
  const { runs, setActiveRun, deleteRun } = useAgentStore()
  const { models, activeModel } = useModelStore()

  const currentModel = selectedModel || activeModel || ''

  const handleRun = () => {
    if (!goal.trim() || !currentModel) return
    startAgent(goal.trim(), currentModel)
    setGoal('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleRun()
    }
  }

  return (
    <div className="flex flex-col h-full gap-3 p-4">
      {/* Goal Input Area */}
      <GlassCard className="flex-shrink-0">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[0.8rem] text-gray-400">
            <Bot size={16} />
            <span>Agent Goal</span>
          </div>
          <div className="flex gap-3 items-end">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want the agent to accomplish..."
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[0.85rem] text-white placeholder-gray-500 resize-none focus:outline-none focus:border-white/20 transition-colors min-h-[60px] max-h-[120px]"
              rows={2}
            />
            <div className="flex flex-col gap-2">
              <select
                value={currentModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[0.75rem] text-gray-300 focus:outline-none focus:border-white/20 min-w-[140px]"
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name} className="bg-[#262626]">
                    {m.name}
                  </option>
                ))}
              </select>
              {isRunning ? (
                <GlowButton variant="danger" onClick={stopAgent} className="text-[0.75rem] py-1.5">
                  <Square size={14} className="inline mr-1" />
                  Stop
                </GlowButton>
              ) : (
                <GlowButton
                  onClick={handleRun}
                  disabled={!goal.trim() || !currentModel}
                  className="text-[0.75rem] py-1.5"
                >
                  <Play size={14} className="inline mr-1" />
                  Run Agent
                </GlowButton>
              )}
            </div>
          </div>
        </div>
      </GlassCard>

      {searxngStatus && (
        <div className="text-[0.7rem] px-1 -mt-1.5 flex items-center gap-2">
          {searxngStatus.running ? (
            <>
              <CircleCheck size={12} className="text-green-400 flex-shrink-0" />
              <span className="text-green-400/80">Search Enhanced</span>
            </>
          ) : searxngInstalling ? (
            <>
              <Loader2 size={12} className="text-blue-400 animate-spin flex-shrink-0" />
              <span className="text-blue-400/80 truncate max-w-[400px]" title={searxngMsg}>
                {searxngMsg || 'Installing SearXNG...'}
              </span>
            </>
          ) : searxngStatus.installed ? (
            <>
              <CircleAlert size={12} className="text-amber-400 flex-shrink-0" />
              <span className="text-gray-500">SearXNG: Stopped</span>
              <button
                onClick={installOrStartSearxng}
                className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors text-[0.65rem] font-medium border border-amber-500/30"
              >
                Start SearXNG
              </button>
            </>
          ) : (
            <>
              <span className="text-gray-500">SearXNG: Not installed</span>
              {searxngStatus.dockerAvailable ? (
                <button
                  onClick={installOrStartSearxng}
                  className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors text-[0.65rem] font-medium border border-blue-500/30"
                >
                  <Download size={10} className="inline mr-1 -mt-0.5" />
                  Install SearXNG
                </button>
              ) : (
                <span className="text-gray-600 text-[0.65rem]">Docker required</span>
              )}
              {searxngMsg && (
                <span className="text-red-400/70 text-[0.65rem] truncate max-w-[300px]" title={searxngMsg}>
                  {searxngMsg}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex gap-3 min-h-0 overflow-hidden">
        {/* Run History Sidebar */}
        <GlassCard className="w-[250px] flex-shrink-0 flex flex-col overflow-hidden">
          <div className="text-[0.75rem] text-gray-400 mb-2 font-medium flex items-center gap-1.5">
            <Clock size={13} />
            Run History
          </div>
          <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0 scrollbar-thin">
            <AnimatePresence>
              {runs.length === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-[0.75rem] text-gray-500 text-center py-6"
                >
                  No runs yet
                </motion.div>
              )}
              {[...runs].reverse().map((run) => (
                <motion.div
                  key={run.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  onClick={() => setActiveRun(run.id)}
                  className={`group flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors text-[0.75rem] ${
                    activeRun?.id === run.id
                      ? 'bg-white/10 border border-white/15'
                      : 'hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-white truncate leading-tight">
                      {run.goal.length > 50 ? run.goal.slice(0, 50) + '...' : run.goal}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`${statusColor(run.status)} text-[0.65rem]`}>
                        {statusLabel(run.status)}
                      </span>
                      <span className="text-gray-500 text-[0.65rem]">
                        {formatTime(run.createdAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteRun(run.id) }}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all p-0.5"
                  >
                    <Trash2 size={12} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </GlassCard>

        {/* Active Run Details */}
        <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
          {activeRun ? (
            <>
              {/* Task Breakdown */}
              <GlassCard className="flex-shrink-0 max-h-[40%] overflow-y-auto">
                <TaskBreakdown tasks={activeRun.tasks} />
              </GlassCard>

              {/* Agent Log */}
              <GlassCard className="flex-1 min-h-0 overflow-hidden flex flex-col">
                <AgentLog
                  entries={activeRun.log}
                  onApprove={activeRun.status === 'paused' ? (toolCallId) => approveToolCall(activeRun.id, toolCallId) : undefined}
                  onReject={activeRun.status === 'paused' ? (toolCallId) => rejectToolCall(activeRun.id, toolCallId) : undefined}
                />
              </GlassCard>
            </>
          ) : (
            <GlassCard className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-500">
                <Bot size={48} className="mx-auto mb-3 opacity-30" />
                <div className="text-[0.85rem]">No active run</div>
                <div className="text-[0.7rem] mt-1">
                  Enter a goal above and click Run Agent to start
                </div>
              </div>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  )
}
