import { useState } from 'react'
import { X, Workflow } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import { WorkflowSearchModal } from './WorkflowSearchModal'
import type { ModelType } from '../../api/comfyui'

interface Props {
  modelName: string
  modelType: ModelType
}

export function WorkflowFinder({ modelName, modelType }: Props) {
  const [modalOpen, setModalOpen] = useState(false)
  const {
    getWorkflowForModel,
    assignToModelName,
    unassignModelName,
    unassignModelType,
  } = useWorkflowStore()

  const activeWorkflow = getWorkflowForModel(modelName, modelType)

  return (
    <>
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
          <Workflow size={12} />
          Workflow
        </label>

        {/* Load Workflow button - opens the finder modal */}
        <button
          onClick={() => setModalOpen(true)}
          className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm hover:bg-gray-200 dark:hover:bg-white/10 transition-colors text-left"
        >
          {activeWorkflow ? activeWorkflow.name : 'Auto'}
        </button>

        {/* Active workflow info badge + clear */}
        {activeWorkflow && (
          <div className="mt-1 flex items-center gap-1.5">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300">
              {activeWorkflow.source}
            </span>
            <span className="text-[10px] text-gray-500 truncate">
              {activeWorkflow.mode === 'video' ? 'Video' : activeWorkflow.mode === 'both' ? 'Image+Video' : 'Image'}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                unassignModelName(modelName)
                unassignModelType(modelType)
              }}
              className="ml-auto text-gray-500 hover:text-red-400 transition-colors"
              title="Reset to Auto"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>

      <WorkflowSearchModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        modelName={modelName}
        modelType={modelType}
      />
    </>
  )
}
