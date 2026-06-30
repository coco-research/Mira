/**
 * Benchmark Runner — runs standardized prompts against a model and measures performance.
 */

import { useCallback, useRef } from 'react'
import { useBenchmarkStore, computeGenerationTps } from '../stores/benchmarkStore'
import { getProviderForModel } from '../api/providers'
import { BENCHMARK_PROMPTS } from '../lib/benchmark-prompts'
import type { ChatMessage } from '../api/providers/types'

export function useBenchmark() {
  const store = useBenchmarkStore()
  const abortRef = useRef<AbortController | null>(null)

  const runBenchmark = useCallback(async (modelName: string) => {
    if (store.isRunning) return

    store.setRunning(true, modelName, BENCHMARK_PROMPTS.length)

    for (let i = 0; i < BENCHMARK_PROMPTS.length; i++) {
      const prompt = BENCHMARK_PROMPTS[i]
      store.setStep(i + 1)

      abortRef.current = new AbortController()

      try {
        const { provider, modelId } = getProviderForModel(modelName)
        const messages: ChatMessage[] = [
          { role: 'user', content: prompt.prompt },
        ]

        const startTime = performance.now()
        let firstTokenTime = 0
        let tokenCount = 0
        let apiEvalCount: number | undefined
        let apiEvalDurationMs: number | undefined

        const stream = provider.chatStream(modelId, messages, {
          temperature: 0.7,
          signal: abortRef.current.signal,
        })

        for await (const chunk of stream) {
          if (chunk.content) {
            if (tokenCount === 0) {
              firstTokenTime = performance.now() - startTime
            }
            tokenCount++
          }
          // Bug M v2.4.7 — Ollama reports authoritative gen metrics in the
          // done:true chunk. Prefer these over client-side timing because
          // WebView2 release-mode buffers the response stream for fast small
          // models, collapsing firstTokenTime to ~totalTime and producing
          // absurd JS-measured tps values.
          if (chunk.evalCount !== undefined && chunk.evalCount > 0) {
            apiEvalCount = chunk.evalCount
          }
          if (chunk.evalDurationMs !== undefined && chunk.evalDurationMs > 0) {
            apiEvalDurationMs = chunk.evalDurationMs
          }
        }

        const totalTime = performance.now() - startTime

        // Three-way TPS branch for Bug M (v2.4.7):
        //   1. Provider returned authoritative server metrics (Ollama via
        //      eval_count/eval_duration) → use them. Most accurate.
        //   2. JS measurement with reasonable generation phase → use the
        //      post-TTFT formula (the original Bug M fix). Works for
        //      providers that don't return server metrics but where the
        //      stream actually streams (proper chunk-by-chunk delivery).
        //   3. JS measurement collapsed to ~0ms generation phase → the
        //      response was buffered (Tauri Rust proxy in release-mode
        //      collects all bytes before returning, or WebView2 / Edge
        //      aggregates TCP packets for fast small responses). The
        //      post-TTFT formula would divide by ~0 and produce absurd
        //      values like 685k tok/s. Fall back to wall-clock rate
        //      (tokens/totalTime). It under-counts because it includes
        //      load+TTFT time but at least is sane — and a real
        //      improvement over pre-v2.4.7 where this case also produced
        //      garbage just via a different formula path.
        const generationTimeMs = totalTime - firstTokenTime
        const hasApiMetrics = apiEvalCount !== undefined && apiEvalDurationMs !== undefined
        const isBuffered = !hasApiMetrics && generationTimeMs < 100 && totalTime > 0
        const reportedTokens = hasApiMetrics ? apiEvalCount! : tokenCount
        const reportedTps = hasApiMetrics
          ? (apiEvalCount! / apiEvalDurationMs!) * 1000
          : isBuffered
            ? (tokenCount / totalTime) * 1000
            : computeGenerationTps(tokenCount, totalTime, firstTokenTime)

        store.addResult({
          modelName,
          promptId: prompt.id,
          tokensPerSec: reportedTps,
          timeToFirstToken: firstTokenTime,
          totalTime,
          totalTokens: reportedTokens,
          timestamp: Date.now(),
        })
      } catch {
        // Aborted or error — skip this prompt
      }
    }

    store.setRunning(false)
  }, [store])

  const stopBenchmark = useCallback(() => {
    abortRef.current?.abort()
    store.setRunning(false)
  }, [store])

  return { runBenchmark, stopBenchmark }
}
