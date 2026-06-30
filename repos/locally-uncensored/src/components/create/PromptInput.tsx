import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Square, History, X, Minus } from 'lucide-react'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel, isI2VModel } from '../../api/comfyui'
import type { ClassifiedModel } from '../../api/comfyui'

interface Props {
  onGenerate: () => void
  onCancel: () => void
  disabled?: boolean
  imageModels: ClassifiedModel[]
  videoModels: ClassifiedModel[]
}

/**
 * Create-tab composer, rebuilt on the chat composer's DNA (David 2026-06-11:
 * "prompt fenster kleiner ... etwas wie bei chat, button elemente wie bei
 * chat/agent/code"): one centered max-w-[70%] box, a single auto-growing
 * input row with all controls inline, compact p-1.5 icon buttons.
 */
export function PromptInput({ onGenerate, onCancel, disabled, imageModels, videoModels }: Props) {
  const {
    prompt, negativePrompt, isGenerating, promptHistory, mode, imageSubMode, videoSubMode,
    imageModel, videoModel, setPrompt, setNegativePrompt, setImageSubMode, setVideoSubMode,
    setImageModel, setVideoModel,
  } = useCreateStore()

  // Model picker (lives right next to Generate). Video models are filtered by
  // the T2V/I2V sub-mode so the list only shows compatible checkpoints.
  const modelOptions = mode === 'video'
    ? videoModels.filter((m) => (videoSubMode === 'i2v' ? isI2VModel(m.name) : !isI2VModel(m.name)))
    : imageModels
  const activeModelValue = mode === 'video' ? videoModel : imageModel
  const onModelChange = (name: string) => {
    if (mode === 'video') setVideoModel(name)
    else setImageModel(name, classifyModel(name))
  }
  const [showNegative, setShowNegative] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  // Auto-grow like the chat composer: single line at rest, expands with
  // content up to a cap instead of a fixed 3-row block.
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
    }
  }, [prompt])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      if (!isGenerating && prompt.trim()) onGenerate()
    }
  }

  const selectFromHistory = (p: string) => {
    setPrompt(p)
    setShowHistory(false)
    textareaRef.current?.focus()
  }

  const subModeBtn = (active: boolean) =>
    `px-2 h-full text-[0.6rem] font-medium transition-colors ${
      active
        ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
        : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
    }`

  return (
    <div className="w-full max-w-[70%] mx-auto">
      <div className="flex flex-col rounded-lg border bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06] px-2.5 py-1 transition-colors">
        {/* Input row — everything inline, chat style. items-center + a single
            28px control height keeps every element on the same line/height. */}
        <div className="flex items-center gap-2">
          {/* T2I/I2I resp. T2V/I2V sub-mode switch */}
          {mode === 'image' ? (
            <div className="flex items-center rounded-md border border-gray-200 dark:border-white/10 overflow-hidden shrink-0 h-[28px]">
              <button onClick={() => setImageSubMode('text2img')} className={subModeBtn(imageSubMode === 'text2img')} title="Text to Image">T2I</button>
              <button onClick={() => setImageSubMode('img2img')} className={subModeBtn(imageSubMode === 'img2img')} title="Image to Image">I2I</button>
            </div>
          ) : (
            <div className="flex items-center rounded-md border border-gray-200 dark:border-white/10 overflow-hidden shrink-0 h-[28px]">
              <button onClick={() => setVideoSubMode('t2v')} className={subModeBtn(videoSubMode === 't2v')} title="Text to Video">T2V</button>
              <button onClick={() => setVideoSubMode('i2v')} className={subModeBtn(videoSubMode === 'i2v')} title="Image to Video">I2V</button>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want to create..."
            rows={1}
            className="flex-1 bg-transparent resize-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[0.75rem] leading-relaxed max-h-[160px] py-1 disabled:opacity-50 scrollbar-thin"
            disabled={isGenerating || disabled}
            aria-label="Image or video generation prompt"
          />

          {/* Negative-prompt toggle — pill like the chat Think toggle */}
          <button
            onClick={() => setShowNegative(!showNegative)}
            className={`flex items-center gap-1 px-2 h-[28px] rounded-md transition-all shrink-0 text-[0.6rem] font-medium ${
              showNegative || negativePrompt.trim()
                ? 'bg-white/10 text-gray-800 dark:text-gray-200 border border-gray-300 dark:border-white/15'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5'
            }`}
            title="Negative prompt — what to avoid"
            aria-expanded={showNegative}
          >
            <Minus size={11} />
            <span>Neg</span>
          </button>

          {/* Prompt history */}
          {promptHistory.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`h-[28px] w-[28px] flex items-center justify-center rounded-md transition-all shrink-0 ${showHistory ? 'bg-white/10 text-gray-700 dark:text-gray-200' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5'}`}
              title="Prompt history"
              aria-label="Prompt history"
            >
              <History size={13} />
            </button>
          )}

          {/* Clear */}
          {prompt.trim() && !isGenerating && (
            <button
              onClick={() => setPrompt('')}
              className="h-[28px] w-[28px] flex items-center justify-center rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5 transition-all shrink-0"
              aria-label="Clear prompt"
            >
              <X size={13} />
            </button>
          )}

          {/* Model picker — always visible + switchable without opening Advanced */}
          {modelOptions.length > 0 && (
            <select
              value={activeModelValue}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={isGenerating || disabled}
              title={activeModelValue || `Select ${mode} model`}
              aria-label={`${mode} model`}
              className="max-w-[140px] h-[28px] px-1.5 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 text-[0.65rem] focus:outline-none focus:border-gray-400 dark:focus:border-white/20 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {modelOptions.map((m) => (
                <option key={m.name} value={m.name}>{m.name.replace(/\.[^.]+$/, '')}</option>
              ))}
            </select>
          )}

          {isGenerating ? (
            <motion.button
              onClick={onCancel}
              className="flex items-center gap-1.5 px-2.5 h-[28px] rounded-md bg-red-500/15 text-red-500 dark:text-red-400 hover:bg-red-500/25 text-[0.65rem] font-medium transition-all shrink-0"
              whileTap={{ scale: 0.95 }}
              aria-label="Cancel generation"
            >
              <Square size={11} /> Cancel
            </motion.button>
          ) : (
            <motion.button
              onClick={onGenerate}
              disabled={!prompt.trim() || disabled}
              className="flex items-center gap-1.5 px-2.5 h-[28px] rounded-md bg-gray-900 text-white dark:bg-white/10 dark:text-white hover:bg-gray-700 dark:hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed text-[0.65rem] font-medium transition-all shrink-0"
              whileTap={{ scale: 0.95 }}
              title={`${isMac ? 'Cmd' : 'Ctrl'}+Enter`}
              aria-label="Generate"
            >
              <Sparkles size={11} /> Generate
            </motion.button>
          )}
        </div>

        {/* Negative prompt — slim row inside the same box, not a second panel */}
        <AnimatePresence>
          {showNegative && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="border-t border-gray-100 dark:border-white/5 mt-1 pt-1.5 pb-0.5">
                <textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="What to avoid (e.g. blurry, low quality, watermark)..."
                  rows={1}
                  className="w-full bg-transparent resize-none text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[0.7rem] leading-relaxed scrollbar-thin"
                  disabled={isGenerating}
                  aria-label="Negative prompt"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Prompt history dropdown */}
        <AnimatePresence>
          {showHistory && promptHistory.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-gray-100 dark:border-white/5 mt-1 max-h-28 overflow-y-auto scrollbar-thin"
            >
              {promptHistory.map((p, i) => (
                <button
                  key={i}
                  onClick={() => selectFromHistory(p)}
                  className="w-full text-left px-1.5 py-1 text-[0.65rem] text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded truncate transition-colors"
                >
                  {p}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
