import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType } from '../api/comfyui'
import type { WorkflowTemplate } from '../types/workflows'

interface WorkflowState {
  installedWorkflows: WorkflowTemplate[]
  // ModelType -> WorkflowID (e.g., { flux2: 'uuid-123' })
  modelTypeAssignments: Record<string, string>
  // Specific model filename -> WorkflowID (e.g., { 'flux2-klein.safetensors': 'uuid-789' })
  modelNameAssignments: Record<string, string>
  // CivitAI API key for downloads
  civitaiApiKey: string
  // CivitAI host — civitai.com by default; swappable to a mirror like
  // civitai.red for regions where civitai.com is blocked (GitHub #53).
  civitaiHost: string

  installWorkflow: (wf: WorkflowTemplate) => void
  removeWorkflow: (id: string) => void
  assignToModelType: (modelType: string, workflowId: string) => void
  assignToModelName: (modelName: string, workflowId: string) => void
  unassignModelType: (modelType: string) => void
  unassignModelName: (modelName: string) => void
  getWorkflowForModel: (modelName: string, modelType: ModelType) => WorkflowTemplate | null
  setCivitaiApiKey: (key: string) => void
  setCivitaiHost: (host: string) => void
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      installedWorkflows: [],
      modelTypeAssignments: {},
      modelNameAssignments: {},
      civitaiApiKey: '',
      civitaiHost: 'civitai.com',

      installWorkflow: (wf) => set((s) => ({
        installedWorkflows: [wf, ...s.installedWorkflows.filter(w => w.id !== wf.id)],
      })),

      removeWorkflow: (id) => set((s) => {
        // Also clean up any assignments pointing to this workflow
        const typeAssignments = { ...s.modelTypeAssignments }
        const nameAssignments = { ...s.modelNameAssignments }
        for (const [key, val] of Object.entries(typeAssignments)) {
          if (val === id) delete typeAssignments[key]
        }
        for (const [key, val] of Object.entries(nameAssignments)) {
          if (val === id) delete nameAssignments[key]
        }
        return {
          installedWorkflows: s.installedWorkflows.filter(w => w.id !== id),
          modelTypeAssignments: typeAssignments,
          modelNameAssignments: nameAssignments,
        }
      }),

      assignToModelType: (modelType, workflowId) => set((s) => ({
        modelTypeAssignments: { ...s.modelTypeAssignments, [modelType]: workflowId },
      })),

      assignToModelName: (modelName, workflowId) => set((s) => ({
        modelNameAssignments: { ...s.modelNameAssignments, [modelName]: workflowId },
      })),

      unassignModelType: (modelType) => set((s) => {
        const assignments = { ...s.modelTypeAssignments }
        delete assignments[modelType]
        return { modelTypeAssignments: assignments }
      }),

      unassignModelName: (modelName) => set((s) => {
        const assignments = { ...s.modelNameAssignments }
        delete assignments[modelName]
        return { modelNameAssignments: assignments }
      }),

      setCivitaiApiKey: (key) => set({ civitaiApiKey: key }),

      // Accept "civitai.red", "https://civitai.red/", etc. — store the bare
      // host. Empty falls back to the canonical civitai.com (#53).
      setCivitaiHost: (host) =>
        set({ civitaiHost: (host || 'civitai.com').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') || 'civitai.com' }),

      getWorkflowForModel: (modelName, modelType) => {
        const state = get()
        // Priority 1: specific model name assignment
        const nameId = state.modelNameAssignments[modelName]
        if (nameId) {
          const wf = state.installedWorkflows.find(w => w.id === nameId)
          if (wf) return wf
        }
        // Priority 2: model type assignment
        const typeId = state.modelTypeAssignments[modelType]
        if (typeId) {
          const wf = state.installedWorkflows.find(w => w.id === typeId)
          if (wf) return wf
        }
        return null
      },
    }),
    {
      name: 'workflow-store',
    }
  )
)
