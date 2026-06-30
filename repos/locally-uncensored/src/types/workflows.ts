import type { ModelType } from '../api/comfyui'

export type WorkflowSource = 'civitai' | 'manual'

export interface ParameterMapping {
  nodeId: string
  inputKey: string
}

export interface ModelParameterMapping extends ParameterMapping {
  loaderType: 'checkpoint' | 'unet'
}

export interface ParameterMap {
  model?: ModelParameterMapping
  positivePrompt?: ParameterMapping
  negativePrompt?: ParameterMapping
  seed?: ParameterMapping
  steps?: ParameterMapping
  cfgScale?: ParameterMapping
  width?: ParameterMapping
  height?: ParameterMapping
  batchSize?: ParameterMapping
  sampler?: ParameterMapping
  scheduler?: ParameterMapping
  // Video-specific
  frames?: ParameterMapping
  fps?: ParameterMapping
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  source: WorkflowSource
  sourceUrl?: string
  modelTypes: ModelType[]
  mode: 'image' | 'video' | 'both'
  workflow: Record<string, any>
  parameterMap: ParameterMap
  installedAt: number
  thumbnailUrl?: string
}

export interface WorkflowSearchResult {
  name: string
  description: string
  source: WorkflowSource
  sourceUrl: string
  thumbnailUrl?: string
  modelTypes: ModelType[]
  mode: 'image' | 'video' | 'both'
  downloadUrl?: string
  rawWorkflow?: Record<string, any>
}
