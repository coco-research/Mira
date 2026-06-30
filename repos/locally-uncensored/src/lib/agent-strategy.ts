/**
 * Agent Strategy Resolution — Shared utility for determining tool calling strategy.
 *
 * Extracted from useAgentChat.ts so both the agent chat and workflow engine
 * can reuse the same logic.
 */

import { getProviderIdFromModel, getProviderForModel } from '../api/providers'
import { getToolCallingStrategy, type ToolCallingStrategy } from './model-compatibility'
import { agentVariantExists, createAgentVariant, getAgentModelName, canFixModel } from '../api/model-template-fix'

export interface ResolvedStrategy {
  strategy: ToolCallingStrategy
  modelToUse: string
  providerId: string
  provider: ReturnType<typeof getProviderForModel>['provider']
}

/**
 * Resolve the tool calling strategy for a given model.
 * Handles cloud providers (always native), Ollama native models,
 * template_fix (creates agent variant), and hermes_xml fallback.
 */
export async function resolveToolCallingStrategy(modelName: string): Promise<ResolvedStrategy> {
  const providerId = getProviderIdFromModel(modelName)
  const { provider, modelId } = getProviderForModel(modelName)

  let modelToUse = modelId
  let strategy: ToolCallingStrategy

  if (providerId === 'openai' || providerId === 'anthropic') {
    strategy = 'native'
  } else {
    strategy = getToolCallingStrategy(modelId)

    if (strategy === 'template_fix') {
      const agentName = getAgentModelName(modelId)
      const exists = await agentVariantExists(modelId)

      if (exists) {
        modelToUse = agentName
        strategy = 'native'
      } else {
        const { fixable } = await canFixModel(modelId)
        if (fixable) {
          try {
            modelToUse = await createAgentVariant(modelId)
            strategy = 'native'
          } catch {
            strategy = 'hermes_xml'
          }
        } else {
          strategy = 'hermes_xml'
        }
      }
    }
  }

  return { strategy, modelToUse, providerId, provider }
}
