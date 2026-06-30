/**
 * A/B Compare Hook — sends the same prompt to two models in parallel.
 */

import { useCallback, useRef } from 'react'
import { useCompareStore } from '../stores/compareStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderForModel } from '../api/providers'
import { v4 as uuid } from 'uuid'
import type { ChatMessage } from '../api/providers/types'
import type { Message } from '../types/chat'

export function useABCompare() {
  const store = useCompareStore()
  const settings = useSettingsStore((s) => s.settings)
  const abortA = useRef<AbortController | null>(null)
  const abortB = useRef<AbortController | null>(null)

  const sendCompare = useCallback(async (text: string) => {
    const { modelA, modelB } = useCompareStore.getState()
    if (!modelA || !modelB || !text.trim()) return

    const userMessage: Message = {
      id: uuid(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    }

    store.startRound(userMessage)

    // Build messages for the providers
    const persona = useSettingsStore.getState().getActivePersona()
    const chatMessages: ChatMessage[] = []
    if (persona?.prompt) {
      chatMessages.push({ role: 'system', content: persona.prompt })
    }

    // Include previous messages for context
    const prevMessages = useCompareStore.getState().messagesA.slice(0, -1) // exclude the empty assistant msg
    for (const m of prevMessages) {
      chatMessages.push({ role: m.role as 'user' | 'assistant', content: m.content })
    }

    const opts = {
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      maxTokens: settings.maxTokens || undefined,
      // Bug AA v2.5.0 — forward num_ctx override to both A/B sides.
      contextWindow: settings.contextWindowOverride || undefined,
    }

    // Stream Model A
    abortA.current = new AbortController()
    const streamA = async () => {
      const startTime = Date.now()
      let fullContent = ''
      let tokenCount = 0
      try {
        const { provider, modelId } = getProviderForModel(modelA)
        const stream = provider.chatStream(modelId, chatMessages, { ...opts, signal: abortA.current!.signal })
        for await (const chunk of stream) {
          if (chunk.content) {
            fullContent += chunk.content
            tokenCount++
            useCompareStore.getState().addContentA(chunk.content)
          }
        }
      } catch { /* aborted or error */ }
      const elapsed = Date.now() - startTime
      useCompareStore.getState().finishA(fullContent, {
        tokens: tokenCount,
        timeMs: elapsed,
        tokensPerSec: elapsed > 0 ? (tokenCount / elapsed) * 1000 : 0,
      })
    }

    // Stream Model B
    abortB.current = new AbortController()
    const streamB = async () => {
      const startTime = Date.now()
      let fullContent = ''
      let tokenCount = 0
      try {
        const { provider, modelId } = getProviderForModel(modelB)
        const stream = provider.chatStream(modelId, chatMessages, { ...opts, signal: abortB.current!.signal })
        for await (const chunk of stream) {
          if (chunk.content) {
            fullContent += chunk.content
            tokenCount++
            useCompareStore.getState().addContentB(chunk.content)
          }
        }
      } catch { /* aborted or error */ }
      const elapsed = Date.now() - startTime
      useCompareStore.getState().finishB(fullContent, {
        tokens: tokenCount,
        timeMs: elapsed,
        tokensPerSec: elapsed > 0 ? (tokenCount / elapsed) * 1000 : 0,
      })
    }

    // Run both in parallel
    await Promise.all([streamA(), streamB()])
  }, [settings, store])

  const stopCompare = useCallback(() => {
    abortA.current?.abort()
    abortB.current?.abort()
    store.setStreamingA(false)
    store.setStreamingB(false)
  }, [store])

  return { sendCompare, stopCompare }
}
