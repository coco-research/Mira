import { motion } from 'framer-motion'
import { User, Copy, Check, Pencil, RefreshCw, X, Wrench } from 'lucide-react'
import { useState, useRef, useEffect, useMemo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ReflectionBlock } from './ReflectionBlock'
import { VramSwitchCard } from './VramSwitchCard'
import { SpeakerButton } from './SpeakerButton'
import { ChatArtifactCard } from './ChatArtifactCard'
import type { Message } from '../../types/chat'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { extractToolCallsFromContent, looksLikeToolIntent } from '../../lib/tool-call-repair'
import { isAgentCompatible } from '../../lib/model-compatibility'

interface Props {
  message: Message
  onRegenerate?: () => void
  onEdit?: (messageId: string, newContent: string) => void
  /** Tool-call id awaiting user approval. When the matching block in
   *  this message has that id, ToolCallBlock renders Approve/Reject
   *  inline instead of a popup over the chat input. */
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
  /** True for the last visible message — gates the VRAM hand-off card so it
   *  only renders in the active assistant turn, not in every historical one. */
  isLast?: boolean
}

export function MessageBubble({ message, onRegenerate, onEdit, pendingApprovalId, onApprove, onReject, isLast }: Props) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'

  // Bug #7 (phantomderp v2.4.3): the Codex-style "model parrots tool-call
  // JSON as plaintext" only happens when the active chat does NOT have
  // agent mode on. Detect the JSON pattern and show a one-click "Enable
  // agent" banner instead of leaving the user staring at a JSON dump.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const activeModel = useModelStore((s) => s.activeModel)
  const toggleAgentMode = useAgentModeStore((s) => s.toggleAgentMode)
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)

  const suggestAgent = useMemo(() => {
    if (isUser || isAgentActive || !activeConversationId || !activeModel) return false
    if (!message.content || message.content.length < 10) return false
    // The repair helper extracts {name, arguments}-shaped JSON blocks, plus
    // <tool_call>...</tool_call> Hermes tags. If anything came out, the
    // model wanted to call a tool — even though we never registered any.
    const calls = extractToolCallsFromContent(message.content)
    if (!calls || calls.length === 0) return false
    // Only nudge when the model is on the agent-allow-list. Showing this
    // banner on a non-agent-capable model would be a dead-end.
    return isAgentCompatible(activeModel)
  }, [isUser, isAgentActive, activeConversationId, activeModel, message.content])

  // Thought-only completion (live find 2026-06-11): the model reasoned —
  // usually about calling a tool it doesn't have in a non-agent chat — and
  // stopped without ONE visible token. useChat persisted the reasoning onto
  // message.thinking; without this the bubble is silent dead air forever.
  // The last bubble additionally needs usage (set by the done chunk) so the
  // banner can't flash mid-stream while a visible thinking phase runs.
  const thoughtOnly = !isUser && !(message.content || '').trim() && !!(message.thinking || '').trim()
    && (!isLast || !!message.usage)
  const thoughtOnlyToolIntent = useMemo(
    () => thoughtOnly && !isAgentActive && looksLikeToolIntent(message.thinking || ''),
    [thoughtOnly, isAgentActive, message.thinking],
  )

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus()
      editRef.current.style.height = 'auto'
      editRef.current.style.height = editRef.current.scrollHeight + 'px'
    }
  }, [isEditing])

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    // Edit the short slash command, not its expanded instruction.
    setEditContent(message.displayContent || message.content)
    setIsEditing(true)
  }

  const confirmEdit = () => {
    if (editContent.trim() && editContent !== message.content && onEdit) {
      onEdit(message.id, editContent.trim())
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  return (
    <motion.div
      className={'flex gap-2 px-3 py-1 group ' + (isUser ? 'flex-row-reverse' : '')}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {/* Avatar */}
      <div
        className={
          'w-6 h-6 rounded-md overflow-hidden flex items-center justify-center shrink-0 ' +
          // User avatar keeps a framed chip; the AI monogram stands alone (no box).
          (isUser ? 'bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10' : '')
        }
      >
        {isUser ? (
          userAvatarDataUrl
            ? <img src={userAvatarDataUrl} alt="" className="w-full h-full object-cover" />
            : <User size={11} className="text-gray-400" />
        ) : (
          // AI avatar = the LU monogram ALONE, filling the slot — no box/border/bg.
          <img src="/LU-monogram-bw.png" alt="" className="w-full h-full object-contain dark:invert-0 invert opacity-80" />
        )}
      </div>

      <div className="max-w-[80%] space-y-0.5">
        {/* Thinking block — auto-expands while this (last) turn is still
            producing so the reasoning streams LIVE, then collapses (David 2026-06-04). */}
        {!isUser && message.thinking && (
          <ThinkingBlock thinking={message.thinking} streaming={!!isLast && !message.content?.trim() && !message.usage} />
        )}

        {/* Agent Mode: render tool_call + reflection + answer blocks
            chronologically. Reflection blocks persist narration the model
            emitted between tool calls (added for #29 follow-up). Answer
            blocks (2026-05) carry each iteration's outgoing text so the
            tool calls don't all stack above a wall of summary at the
            bottom — every provider, every model. */}
        {!isUser && message.agentBlocks && message.agentBlocks.length > 0 && (
          <>
            {[...message.agentBlocks]
              .filter(
                (b) =>
                  b.phase === 'tool_call' ||
                  b.phase === 'reflection' ||
                  (b.phase === 'answer' && b.content.trim()),
              )
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((block) => {
                if (block.phase === 'tool_call' && block.toolCall) {
                  const isPending = !!pendingApprovalId && block.toolCall.id === pendingApprovalId
                  return (
                    <ToolCallBlock
                      key={block.id}
                      toolCall={block.toolCall}
                      onApprove={isPending ? onApprove : undefined}
                      onReject={isPending ? onReject : undefined}
                    />
                  )
                }
                if (block.phase === 'reflection') {
                  return <ReflectionBlock key={block.id} content={block.content} />
                }
                if (block.phase === 'answer') {
                  return (
                    <div key={block.id} className="px-1 py-0.5">
                      <div className="text-[0.8rem] leading-relaxed">
                        <MarkdownRenderer content={block.content} />
                      </div>
                    </div>
                  )
                }
                return null
              })}
          </>
        )}

        {/* Feature EE (v2.5.0) — VRAM hand-off status card. Self-hides unless
            an actual model swap is in flight; gated to the last assistant
            message so a swap shows only in the active turn. */}
        {!isUser && isLast && <VramSwitchCard />}

        {/* Image attachments */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {message.images.map((img, i) => (
              <a
                key={i}
                href={`data:${img.mimeType};base64,${img.data}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="max-w-[180px] max-h-[120px] object-cover rounded-md border border-white/10 hover:border-white/25 transition-colors cursor-pointer"
                />
              </a>
            ))}
          </div>
        )}

        {/* Main content — assistant messages drop the bubble entirely
            (per user feedback: "die graue Blase komplett weghaben"). User
            messages keep theirs because they're right-aligned and need
            the visual anchor against the chat background. */}
        <div
          className={
            'relative ' +
            (isUser
              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
              : 'px-1 py-0.5')
          }
        >
          {isUser && isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={editRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() }
                  if (e.key === 'Escape') cancelEdit()
                }}
                className="w-full bg-transparent text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 resize-none focus:outline-none"
              />
              <div className="flex items-center gap-1 justify-end">
                <button onClick={confirmEdit} className="p-0.5 rounded hover:bg-green-500/20 text-green-500 transition-colors"><Check size={11} /></button>
                <button onClick={cancelEdit} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"><X size={11} /></button>
              </div>
            </div>
          ) : isUser ? (
            // Slash command: show the short "/commit" (displayContent), not the
            // long expanded instruction held in content (which drives the model).
            <p className="text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{message.displayContent || message.content}</p>
          ) : (
            // Answer-blocks (when present) already rendered the per-iteration
            // text chronologically above; skip message.content here to avoid
            // a duplicate dump at the bottom. Falls back to message.content
            // for legacy chats / non-agent messages without answer blocks.
            (() => {
              const hasAnswerBlock = !!message.agentBlocks?.some(
                (b) => b.phase === 'answer' && b.content.trim(),
              )
              if (hasAnswerBlock) return null
              return (
                <div className="text-[0.78rem] leading-relaxed">
                  <MarkdownRenderer content={message.content} />
                  {thoughtOnly && (
                    thoughtOnlyToolIntent && activeModel && isAgentCompatible(activeModel) ? (
                      <div className="mt-1 flex items-start gap-2 px-2 py-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 text-[0.65rem] text-amber-700 dark:text-amber-200">
                        <Wrench size={11} className="mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <p className="font-medium">The model spent its whole reply deciding to call a tool — but Agent Mode is off, so it never said anything.</p>
                          <p className="opacity-80 mt-0.5">Turn Agent Mode on and ask again to let it actually run the tool (search the web, generate media, read files). Its reasoning is in the thinking block above.</p>
                        </div>
                        <button
                          onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                          className="shrink-0 px-2 py-0.5 rounded border border-amber-400/40 hover:bg-amber-500/20 transition-colors font-medium"
                        >
                          Enable Agent
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-[0.65rem] italic text-gray-500 dark:text-gray-400">
                        The model only produced internal reasoning and no answer — see the thinking block above, or rephrase and try again.
                      </p>
                    )
                  )}
                  {suggestAgent && (
                    <div className="mt-2 flex items-start gap-2 px-2 py-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 text-[0.65rem] text-amber-700 dark:text-amber-200">
                      <Wrench size={11} className="mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="font-medium">This model tried to call a tool, but Agent Mode is off for this chat.</p>
                        <p className="opacity-80 mt-0.5">Turn it on to let the model actually execute tools (read files, run commands, browse). Until then it'll keep emitting JSON that nothing reads.</p>
                      </div>
                      <button
                        onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                        className="shrink-0 px-2 py-0.5 rounded border border-amber-400/40 hover:bg-amber-500/20 transition-colors font-medium"
                      >
                        Enable Agent
                      </button>
                    </div>
                  )}
                </div>
              )
            })()
          )}

        </div>

        {/* Chat-tools artifacts (David 2026-06-12): files the model "wrote" in
            plain chat — rendered inline with preview + Download, never on disk. */}
        {!isUser && message.artifacts && message.artifacts.length > 0 && (
          <div className="space-y-1">
            {message.artifacts.map((a) => (
              <ChatArtifactCard key={a.id} artifact={a} />
            ))}
          </div>
        )}

        {/* Action bar UNDER the message (David 2026-06-06: "eigene Leiste unter
            der Nachricht" instead of cramped hover-icons in the corner). Bigger
            targets, always visible but subtle; assistant left, user right. */}
        {!isEditing && (
          <div className={'flex items-center gap-0.5 ' + (isUser ? 'justify-end pr-0.5' : 'justify-start pl-0.5')}>
            {isUser && onEdit && (
              <button onClick={startEdit} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Edit message" title="Edit"><Pencil size={12} /></button>
            )}
            {!isUser && onRegenerate && (
              <button onClick={onRegenerate} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Regenerate response" title="Regenerate"><RefreshCw size={12} /></button>
            )}
            <button onClick={handleCopy} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'}>
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            {!isUser && <SpeakerButton text={message.content} />}
          </div>
        )}

        {/* RAG sources */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="pt-1 border-t border-white/[0.04]">
            <p className="text-[0.5rem] text-gray-500 mb-0.5">Sources:</p>
            {message.sources.map((s, i) => (
              <p key={i} className="text-[0.5rem] text-gray-600 truncate">
                [{i + 1}] {s.documentName} — {s.preview.slice(0, 60)}...
              </p>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}
