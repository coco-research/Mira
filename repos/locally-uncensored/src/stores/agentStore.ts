import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AgentRun,
  AgentLogEntry,
  ToolCall,
} from "../types/agents";

interface AgentState {
  runs: AgentRun[];
  activeRunId: string | null;
  maxIterations: number;
  workspacePath: string;

  // Actions
  createRun: (run: AgentRun) => void;
  updateRun: (
    runId: string,
    updates: Partial<
      Pick<
        AgentRun,
        "status" | "tasks" | "currentIteration" | "updatedAt" | "log"
      >
    >
  ) => void;
  addLogEntry: (runId: string, entry: AgentLogEntry) => void;
  addToolCall: (runId: string, taskId: string, toolCall: ToolCall) => void;
  updateToolCallStatus: (
    runId: string,
    toolCallId: string,
    status: ToolCall["status"],
    result?: string,
    error?: string,
    duration?: number
  ) => void;
  setActiveRun: (runId: string | null) => void;
  deleteRun: (runId: string) => void;
  getActiveRun: () => AgentRun | undefined;
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      runs: [],
      activeRunId: null,
      maxIterations: 20,
      workspacePath: "~/agent-workspace",

      createRun: (run) =>
        set((state) => ({
          runs: [...state.runs, run],
          activeRunId: run.id,
        })),

      updateRun: (runId, updates) =>
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === runId
              ? { ...r, ...updates, updatedAt: Date.now() }
              : r
          ),
        })),

      addLogEntry: (runId, entry) =>
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  log: [...r.log, entry],
                  updatedAt: Date.now(),
                }
              : r
          ),
        })),

      addToolCall: (runId, taskId, toolCall) =>
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  tasks: r.tasks.map((t) =>
                    t.id === taskId
                      ? { ...t, toolCalls: [...t.toolCalls, toolCall] }
                      : t
                  ),
                  updatedAt: Date.now(),
                }
              : r
          ),
        })),

      updateToolCallStatus: (runId, toolCallId, status, result, error, duration) =>
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  tasks: r.tasks.map((t) => ({
                    ...t,
                    toolCalls: t.toolCalls.map((tc) =>
                      tc.id === toolCallId
                        ? {
                            ...tc,
                            status,
                            ...(result !== undefined && { result }),
                            ...(error !== undefined && { error }),
                            ...(duration !== undefined && { duration }),
                          }
                        : tc
                    ),
                  })),
                  updatedAt: Date.now(),
                }
              : r
          ),
        })),

      setActiveRun: (runId) => set({ activeRunId: runId }),

      deleteRun: (runId) =>
        set((state) => ({
          runs: state.runs.filter((r) => r.id !== runId),
          activeRunId:
            state.activeRunId === runId ? null : state.activeRunId,
        })),

      getActiveRun: () => {
        const state = get();
        return state.runs.find((r) => r.id === state.activeRunId);
      },
    }),
    {
      name: "locally-uncensored-agent",
      partialize: (state) => ({
        runs: state.runs,
        activeRunId: state.activeRunId,
        maxIterations: state.maxIterations,
        workspacePath: state.workspacePath,
      }),
    }
  )
);
