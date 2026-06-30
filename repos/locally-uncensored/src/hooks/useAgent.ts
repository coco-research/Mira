import { useCallback, useRef } from "react";
import { useAgentStore } from "../stores/agentStore";
import {
  AGENT_TOOLS,
  buildReActPrompt,
  buildJsonRetryPrompt,
  parseAgentResponse,
  executeTool,
  chatNonStreaming,
} from "../api/agents";
import type {
  AgentRun,
  ToolCall,
  ToolName,
} from "../types/agents";
import { log } from "../lib/logger";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const MAX_CONSECUTIVE_ERRORS = 3;

export function useAgent() {
  const store = useAgentStore();
  const abortRef = useRef<AbortController | null>(null);
  const loopRef = useRef<boolean>(false);

  const activeRun = store.getActiveRun();
  const isRunning =
    activeRun?.status === "planning" || activeRun?.status === "executing";

  const runReActLoop = useCallback(
    async (runId: string, model: string) => {
      const maxIter = store.maxIterations;
      let consecutiveErrors = 0;

      while (loopRef.current) {
        const currentRun = store.runs.find((r) => r.id === runId);
        if (!currentRun || currentRun.currentIteration >= maxIter) {
          store.updateRun(runId, {
            status: currentRun?.currentIteration! >= maxIter ? "failed" : "completed",
          });
          if (currentRun?.currentIteration! >= maxIter) {
            store.addLogEntry(runId, {
              id: generateId(),
              type: "error",
              content: `Max iterations (${maxIter}) reached`,
              timestamp: Date.now(),
            });
          }
          break;
        }

        // Check abort
        if (abortRef.current?.signal.aborted) {
          store.updateRun(runId, { status: "failed" });
          store.addLogEntry(runId, {
            id: generateId(),
            type: "error",
            content: "Agent run cancelled by user",
            timestamp: Date.now(),
          });
          break;
        }

        // Check consecutive errors - pause and ask user
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          store.updateRun(runId, { status: "paused" });
          store.addLogEntry(runId, {
            id: generateId(),
            type: "error",
            content: `${MAX_CONSECUTIVE_ERRORS} consecutive tool errors occurred. Agent paused. Please review the errors and resume or stop the agent.`,
            timestamp: Date.now(),
          });
          break;
        }

        const iteration = currentRun.currentIteration + 1;
        store.updateRun(runId, {
          currentIteration: iteration,
          status: "executing",
        });

        try {
          // Build prompt with full history
          const freshRun = store.runs.find((r) => r.id === runId)!;
          const systemPrompt = buildReActPrompt(
            freshRun.goal,
            AGENT_TOOLS,
            freshRun.log
          );

          // Call LLM
          let response = await chatNonStreaming(model, [
            { role: "system", content: systemPrompt },
            { role: "user", content: freshRun.goal },
          ]);

          // Parse response
          let parsed = parseAgentResponse(response);

          // If parse totally failed (action === 'continue'), retry once with simpler prompt
          if (parsed.action === "continue" && !parsed.answer) {
            store.addLogEntry(runId, {
              id: generateId(),
              type: "thought",
              content: "[JSON parse failed, retrying with simplified prompt]",
              timestamp: Date.now(),
            });

            const retryPrompt = buildJsonRetryPrompt(response);
            const retryResponse = await chatNonStreaming(model, [
              { role: "system", content: systemPrompt },
              { role: "user", content: retryPrompt },
            ]);

            const retryParsed = parseAgentResponse(retryResponse);
            // Only use retry result if it actually produced a real action
            if (retryParsed.action !== "continue") {
              parsed = retryParsed;
            }
          }

          // Log the thought
          store.addLogEntry(runId, {
            id: generateId(),
            type: "thought",
            content: parsed.thought,
            timestamp: Date.now(),
          });

          // Check if finished
          if (parsed.action === "finish") {
            store.addLogEntry(runId, {
              id: generateId(),
              type: "observation",
              content: parsed.answer || "Task completed",
              timestamp: Date.now(),
            });
            store.updateRun(runId, { status: "completed" });
            consecutiveErrors = 0;
            break;
          }

          // If still 'continue' after retry, log and loop again
          if (parsed.action === "continue") {
            store.addLogEntry(runId, {
              id: generateId(),
              type: "error",
              content: "LLM failed to produce valid JSON after retry. Continuing to next iteration.",
              timestamp: Date.now(),
            });
            consecutiveErrors++;
            continue;
          }

          // Validate tool
          const toolDef = AGENT_TOOLS.find((t) => t.name === parsed.action);
          if (!toolDef) {
            store.addLogEntry(runId, {
              id: generateId(),
              type: "error",
              content: `Unknown tool: ${parsed.action}`,
              timestamp: Date.now(),
            });
            consecutiveErrors++;
            continue;
          }

          const toolCall: ToolCall = {
            id: generateId(),
            tool: parsed.action as ToolName,
            args: parsed.args || {},
            status: "pending",
            timestamp: Date.now(),
          };

          // Log the action
          store.addLogEntry(runId, {
            id: generateId(),
            type: "action",
            content: `${parsed.action}(${JSON.stringify(parsed.args || {})})`,
            timestamp: Date.now(),
            toolCall,
          });

          // Check if tool requires approval
          if (toolDef.requiresApproval) {
            // Create a task for tracking and pause
            const taskId = generateId();
            const task = {
              id: taskId,
              description: `${parsed.action}: ${JSON.stringify(parsed.args || {})}`,
              status: "pending" as const,
              toolCalls: [toolCall],
              reasoning: parsed.thought,
              order: iteration,
            };

            store.updateRun(runId, {
              status: "paused",
              tasks: [...(store.runs.find((r) => r.id === runId)?.tasks || []), task],
            });

            store.addLogEntry(runId, {
              id: generateId(),
              type: "observation",
              content: `Tool "${parsed.action}" requires approval. Agent paused.`,
              timestamp: Date.now(),
            });

            // Break loop - will be resumed via approveToolCall
            break;
          }

          // Execute tool directly
          const startTime = Date.now();
          try {
            const result = await executeTool(
              parsed.action as ToolName,
              parsed.args || {}
            );
            const duration = Date.now() - startTime;

            store.addLogEntry(runId, {
              id: generateId(),
              type: "observation",
              content: result,
              timestamp: Date.now(),
              toolCall: { ...toolCall, status: "completed", result, duration },
            });

            // Tool succeeded, reset consecutive error counter
            consecutiveErrors = 0;
          } catch (err: any) {
            const duration = Date.now() - startTime;
            const errorMsg = err?.message || String(err);

            consecutiveErrors++;

            // Include the error in the log so the LLM sees it in the next iteration
            store.addLogEntry(runId, {
              id: generateId(),
              type: "error",
              content: `Tool "${parsed.action}" failed (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMsg}`,
              timestamp: Date.now(),
              toolCall: {
                ...toolCall,
                status: "failed",
                error: errorMsg,
                duration,
              },
            });
          }
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          store.addLogEntry(runId, {
            id: generateId(),
            type: "error",
            content: `LLM error: ${errorMsg}`,
            timestamp: Date.now(),
          });
          store.updateRun(runId, { status: "failed" });
          break;
        }
      }

      loopRef.current = false;
    },
    [store]
  );

  const startAgent = useCallback(
    async (goal: string, model: string) => {
      const runId = generateId();
      const run: AgentRun = {
        id: runId,
        goal,
        model,
        status: "planning",
        tasks: [],
        log: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxIterations: store.maxIterations,
        currentIteration: 0,
      };

      store.createRun(run);

      abortRef.current = new AbortController();
      loopRef.current = true;

      store.addLogEntry(runId, {
        id: generateId(),
        type: "user_input",
        content: goal,
        timestamp: Date.now(),
      });

      // Run the loop (not awaited to avoid blocking)
      runReActLoop(runId, model).catch((err) => {
        log.error("Agent loop crashed", { err });
        store.updateRun(runId, { status: "failed" });
      });
    },
    [store, runReActLoop]
  );

  const stopAgent = useCallback(() => {
    loopRef.current = false;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (activeRun && isRunning) {
      store.updateRun(activeRun.id, { status: "failed" });
      store.addLogEntry(activeRun.id, {
        id: generateId(),
        type: "error",
        content: "Agent stopped by user",
        timestamp: Date.now(),
      });
    }
  }, [activeRun, isRunning, store]);

  const approveToolCall = useCallback(
    async (runId: string, toolCallId: string) => {
      const run = store.runs.find((r) => r.id === runId);
      if (!run) return;

      // Find the pending tool call
      let pendingToolCall: ToolCall | undefined;
      for (const task of run.tasks) {
        const tc = task.toolCalls.find((tc) => tc.id === toolCallId);
        if (tc) {
          pendingToolCall = tc;
          break;
        }
      }

      if (!pendingToolCall) return;

      store.updateToolCallStatus(runId, toolCallId, "approved");

      // Execute the tool
      const startTime = Date.now();
      try {
        const result = await executeTool(pendingToolCall.tool, pendingToolCall.args);
        const duration = Date.now() - startTime;

        store.updateToolCallStatus(
          runId,
          toolCallId,
          "completed",
          result,
          undefined,
          duration
        );

        store.addLogEntry(runId, {
          id: generateId(),
          type: "observation",
          content: result,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        const duration = Date.now() - startTime;
        const errorMsg = err?.message || String(err);

        store.updateToolCallStatus(
          runId,
          toolCallId,
          "failed",
          undefined,
          errorMsg,
          duration
        );

        store.addLogEntry(runId, {
          id: generateId(),
          type: "error",
          content: `Tool error: ${errorMsg}`,
          timestamp: Date.now(),
        });
      }

      // Resume the ReAct loop
      abortRef.current = new AbortController();
      loopRef.current = true;
      runReActLoop(runId, run.model).catch((err) => {
        log.error("Agent loop crashed after approval", { err });
        store.updateRun(runId, { status: "failed" });
      });
    },
    [store, runReActLoop]
  );

  const rejectToolCall = useCallback(
    async (runId: string, toolCallId: string) => {
      const run = store.runs.find((r) => r.id === runId);
      if (!run) return;

      store.updateToolCallStatus(runId, toolCallId, "rejected");

      store.addLogEntry(runId, {
        id: generateId(),
        type: "observation",
        content: "Tool call rejected by user. Continuing to next iteration.",
        timestamp: Date.now(),
      });

      // Resume the ReAct loop
      abortRef.current = new AbortController();
      loopRef.current = true;
      runReActLoop(runId, run.model).catch((err) => {
        log.error("Agent loop crashed after rejection", { err });
        store.updateRun(runId, { status: "failed" });
      });
    },
    [store, runReActLoop]
  );

  return {
    activeRun,
    isRunning,
    startAgent,
    stopAgent,
    approveToolCall,
    rejectToolCall,
  };
}
