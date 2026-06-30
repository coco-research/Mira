/**
 * Hermes XML-Tag Tool Calling — Prompt-Based Fallback
 *
 * Works with ANY model (abliterated, uncensored, standard, small, large).
 * Uses the Hermes/NousResearch format:
 *   - Tools described in <tools></tools> XML block in system prompt
 *   - Model responds with <tool_call>{"name": ..., "arguments": ...}</tool_call>
 *   - Results injected as <tool_response>...</tool_response>
 *
 * Reference: https://github.com/NousResearch/Hermes-Function-Calling
 */

import type { AgentToolDef } from '../types/agent-mode'
import { repairJson } from '../lib/tool-call-repair'

// Generic tool shape accepted by the prompt builder
type ToolLike = { name: string; description: string; parameters?: any; inputSchema?: any }

// ── Build System Prompt with Tool Definitions ───────────────────

export function buildHermesToolPrompt(tools: (AgentToolDef | ToolLike)[]): string {
  const toolDefs = tools.map((t) => JSON.stringify({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t as any).inputSchema || (t as any).parameters,
    },
  })).join('\n')

  return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Ask for clarification if needed.

<tools>
${toolDefs}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

IMPORTANT: web_search returns ONLY short snippets, NOT real data. You MUST ALWAYS call web_fetch on the best URL to read actual page content before answering.

Workflow: web_search → get URLs → web_fetch → read page → answer based on real data.
Other tools: file_read, file_write, code_execute, image_generate.
Respond in the same language the user uses.`
}

// ── Build Tool Result Message ───────────────────────────────────

export function buildHermesToolResult(toolName: string, result: string): string {
  return `<tool_response>
{"name": "${toolName}", "content": ${JSON.stringify(result)}}
</tool_response>`
}

// ── Parse Tool Calls from Model Output ──────────────────────────

export interface ParsedToolCall {
  name: string
  arguments: Record<string, any>
}

/**
 * Parse Hermes-format tool calls from model output.
 * Looks for <tool_call>...</tool_call> XML tags containing JSON.
 * Returns array of parsed tool calls (can be 0 or more).
 */
export function parseHermesToolCalls(output: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []

  // Match all <tool_call>...</tool_call> blocks
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(output)) !== null) {
    const jsonStr = match[1].trim()
    // Try direct parse, then repair
    const parsed = repairJson(jsonStr)
    if (parsed && parsed.name) {
      calls.push({
        name: parsed.name,
        arguments: parsed.arguments || parsed.parameters || {},
      })
    } else {
      // Last resort regex
      const nameMatch = jsonStr.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i)
      const argsMatch = jsonStr.match(/["']?arguments["']?\s*[:=]\s*(\{[\s\S]*?\})/i)
      if (nameMatch) {
        let args = {}
        if (argsMatch) {
          const repaired = repairJson(argsMatch[1])
          if (repaired) args = repaired
        }
        calls.push({ name: nameMatch[1], arguments: args })
      }
    }
  }

  return calls
}

/**
 * Strip tool call tags from model output to get clean content.
 */
export function stripToolCallTags(output: string): string {
  return output
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
    .trim()
}

/**
 * Check if model output contains any tool call tags.
 */
export function hasToolCallTags(output: string): boolean {
  return /<tool_call>/.test(output)
}
