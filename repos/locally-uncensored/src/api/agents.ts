import type { Tool, ToolName, AgentLogEntry } from "../types/agents";
import { backendCall, ollamaUrl, localFetch } from "./backend";

export const AGENT_TOOLS: Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web. Returns a LIST of candidate results (title + URL + short snippet). The snippet alone is almost never enough — when the user needs an answer grounded in a specific page, follow up with `web_fetch(url)` on the best match to read the actual content.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "The search query string",
        required: true,
      },
      {
        name: "maxResults",
        type: "number",
        description: "Maximum number of results to return (default: 5)",
        required: false,
      },
    ],
    requiresApproval: false,
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its readable text content (up to ~24 000 characters). Use this AFTER web_search when you need the actual article / documentation / page body, not just the snippet. HTML is stripped, <script>/<style>/<nav>/<footer> are removed, paragraphs preserved. Refuses private / loopback addresses.",
    parameters: [
      {
        name: "url",
        type: "string",
        description: "Full URL to fetch (must start with http:// or https://)",
        required: true,
      },
    ],
    requiresApproval: false,
  },
  {
    name: "get_current_time",
    description:
      "Return the user's current local date, time and timezone. Use this FIRST for any 'what day / time / date is it' question — do NOT web_search for it. Zero arguments.",
    parameters: [],
    requiresApproval: false,
  },
  {
    name: "file_read",
    description:
      "Read the contents of a file from the local filesystem within the agent workspace.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file within the workspace",
        required: true,
      },
    ],
    requiresApproval: false,
  },
  {
    name: "file_write",
    description:
      "Write content to a file in the agent workspace. Creates the file if it does not exist, overwrites if it does.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file within the workspace",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "The content to write to the file",
        required: true,
      },
    ],
    requiresApproval: true,
  },
  {
    name: "code_execute",
    description:
      "Execute code in a sandboxed environment. Supports Python and shell commands. Returns stdout, stderr, and exit code.",
    parameters: [
      {
        name: "code",
        type: "string",
        description: "The code to execute",
        required: true,
      },
      {
        name: "language",
        type: "string",
        description: 'Programming language: "python" or "shell" (default: "python")',
        required: false,
      },
    ],
    requiresApproval: true,
  },
  {
    name: "image_generate",
    description:
      "Generate an image from a text description. Delegates to the Create tab for image generation.",
    parameters: [
      {
        name: "prompt",
        type: "string",
        description: "Text description of the image to generate",
        required: true,
      },
      {
        name: "negativePrompt",
        type: "string",
        description: "Things to avoid in the generated image",
        required: false,
      },
    ],
    requiresApproval: false,
  },
];

export function buildReActPrompt(
  goal: string,
  tools: Tool[],
  history: AgentLogEntry[]
): string {
  const toolDescriptions = tools
    .map((t) => {
      const params = t.parameters
        .map(
          (p) =>
            `    - ${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`
        )
        .join("\n");
      return `  ${t.name}: ${t.description}\n  Parameters:\n${params}`;
    })
    .join("\n\n");

  const historyText = history
    .map((entry) => {
      switch (entry.type) {
        case "thought":
          return `Thought: ${entry.content}`;
        case "action":
          return `Action: ${entry.content}`;
        case "observation":
          return `Observation: ${entry.content}`;
        case "error":
          return `Error: ${entry.content}`;
        case "user_input":
          return `User: ${entry.content}`;
        default:
          return entry.content;
      }
    })
    .join("\n");

  const codeBlockOpen = "``" + "`json";
  const codeBlockClose = "``" + "`";

  return `You are an autonomous AI agent. Your goal is: ${goal}

You have access to the following tools:

${toolDescriptions}

You must respond with a JSON object in one of these two formats:

To use a tool:
${codeBlockOpen}
{"thought": "your reasoning about what to do next", "action": "tool_name", "args": {"param1": "value1"}}
${codeBlockClose}

To finish the task:
${codeBlockOpen}
{"thought": "your final reasoning", "action": "finish", "answer": "your final answer or summary of what was accomplished"}
${codeBlockClose}

Rules:
- Always include a "thought" explaining your reasoning
- Use exactly one action per response
- Only use tools from the list above
- If a tool returns an error, try a different approach
- When the goal is accomplished, use the "finish" action
- Be concise and efficient

${historyText ? `\nPrevious steps:\n${historyText}\n\nContinue from where you left off.` : "Begin working on the goal now."}`;
}

/**
 * Build a simplified retry prompt when the LLM failed to produce valid JSON.
 */
export function buildJsonRetryPrompt(originalResponse: string): string {
  return `Your previous response could not be parsed as valid JSON. Please respond with ONLY a valid JSON object, no other text.

Your previous (unparsable) response was:
${originalResponse.slice(0, 500)}

Respond with ONLY a JSON object in this exact format:
{"thought": "your reasoning", "action": "tool_name", "args": {"param": "value"}}

Or to finish:
{"thought": "your reasoning", "action": "finish", "answer": "your answer"}`;
}

/**
 * Robustly parse an LLM agent response into structured thought/action/args.
 *
 * Handles:
 * 1. JSON in code blocks
 * 2. Multiple JSON objects (takes the first)
 * 3. Partial/broken JSON via regex fallback
 * 4. No JSON at all (treats as thought with action "continue")
 * 5. Action name casing normalization
 * 6. Alternative field names (thinking, reasoning, tool, arguments, parameters, etc.)
 */
export function parseAgentResponse(response: string): {
  thought: string;
  action: string;
  args?: Record<string, any>;
  answer?: string;
} {
  // 1. Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonCandidate = codeBlockMatch ? codeBlockMatch[1] : response;

  // 2. Try to find a JSON object
  const jsonMatch = jsonCandidate.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        thought: parsed.thought || parsed.thinking || parsed.reasoning || "",
        action: (parsed.action || parsed.tool || "continue").toLowerCase().trim(),
        args: parsed.args || parsed.arguments || parsed.parameters || parsed.input || {},
        answer: parsed.answer || parsed.final_answer || parsed.response || undefined,
      };
    } catch {
      // JSON parse failed - if there is a nested object, try the first one
      const firstObjMatch = jsonCandidate.match(/\{[^{}]*\}/);
      if (firstObjMatch && firstObjMatch[0] !== jsonMatch[0]) {
        try {
          const parsed = JSON.parse(firstObjMatch[0]);
          return {
            thought: parsed.thought || parsed.thinking || parsed.reasoning || "",
            action: (parsed.action || parsed.tool || "continue").toLowerCase().trim(),
            args: parsed.args || parsed.arguments || parsed.parameters || parsed.input || {},
            answer: parsed.answer || parsed.final_answer || parsed.response || undefined,
          };
        } catch {
          // Fall through to regex
        }
      }
    }
  }

  // 3. Regex fallback for individual fields
  const thoughtMatch = response.match(/["']?(?:thought|thinking|reasoning)["']?\s*[:=]\s*["']([^"']+)["']/i);
  const actionMatch = response.match(/["']?(?:action|tool)["']?\s*[:=]\s*["']([^"']+)["']/i);
  const answerMatch = response.match(/["']?(?:answer|final_answer|response)["']?\s*[:=]\s*["']([^"']+)["']/i);

  if (actionMatch) {
    return {
      thought: thoughtMatch?.[1] || "",
      action: actionMatch[1].toLowerCase().trim(),
      args: {},
      answer: answerMatch?.[1],
    };
  }

  // 4. Total fallback: treat entire response as a thought
  return {
    thought: response.slice(0, 500),
    action: "continue",
    args: {},
  };
}

export async function executeTool(
  tool: ToolName,
  args: Record<string, any>
): Promise<string> {
  // Thread the active agent loop's chat id through to Rust so relative paths
  // land in the per-chat workspace (~/agent-workspace/<chatId>/) instead of
  // the shared `default/` fallback.
  const { getActiveChatId } = await import("./agent-context");
  const chatId = getActiveChatId() || undefined;

  switch (tool) {
    case "code_execute": {
      const data = await backendCall("execute_code", {
        code: args.code,
        timeout: 30000,
        chatId,
      });
      const output = data.stdout || "";
      const err = data.stderr || "";
      if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`;
      return output || (err ? `stderr: ${err}` : "Done.");
    }

    case "file_read": {
      const data = await backendCall("file_read", { path: args.path, chatId });
      return data.content || "";
    }

    case "file_write": {
      // Rust returns {status: 'saved', path: <absolute>}. Return the real
      // resolved path so the model knows where the file actually landed.
      // The old "File written successfully" fallback was a silent lie when
      // Rust failed — surfaced as ✓ in the UI with no file on disk.
      const data = await backendCall("file_write", { path: args.path, content: args.content, chatId });
      if (data.status === "saved" && data.path) return `File saved: ${data.path}`;
      return data.message || JSON.stringify(data);
    }

    case "web_search": {
      // Pass search provider config from settings
      const { useSettingsStore } = await import('../stores/settingsStore')
      const searchSettings = useSettingsStore.getState().settings
      const data = await backendCall("web_search", {
        query: args.query,
        count: args.maxResults || 5,
        provider: searchSettings.searchProvider || 'auto',
        braveApiKey: searchSettings.braveApiKey || '',
        tavilyApiKey: searchSettings.tavilyApiKey || '',
      });
      if (Array.isArray(data.results)) {
        return data.results
          .map(
            (r: any, i: number) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
          )
          .join("\n\n");
      }
      return JSON.stringify(data);
    }

    case "web_fetch": {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) return "Error: web_fetch requires a `url` argument."
      try {
        const data = await backendCall<{ url: string; status: number; contentType: string; title: string; text: string; truncated: boolean }>(
          "web_fetch",
          { url }
        )
        const parts: string[] = []
        if (data.title) parts.push(`Title: ${data.title}`)
        parts.push(`URL: ${data.url}`)
        parts.push(`Status: ${data.status}${data.contentType ? ` (${data.contentType.split(';')[0]})` : ''}`)
        parts.push('')
        parts.push(data.text || '(empty body)')
        if (data.truncated) parts.push('\n…(truncated to 24 000 chars)')
        return parts.join('\n')
      } catch (e) {
        return `Error: web_fetch failed — ${e instanceof Error ? e.message : String(e)}`
      }
    }

    case "get_current_time": {
      try {
        const data = await backendCall<{ unix: number; iso_local: string; iso_utc: string; timezone: string; timezone_offset: number }>(
          "get_current_time",
          {}
        )
        return `Local: ${data.iso_local} ${data.timezone}\nUTC:   ${data.iso_utc}\nUnix:  ${data.unix}`
      } catch (e) {
        return `Error: get_current_time failed — ${e instanceof Error ? e.message : String(e)}`
      }
    }

    case "image_generate": {
      const prompt = args.prompt || args.description || ''
      if (!prompt) return "Error: No prompt provided for image generation."
      try {
        const { buildDynamicWorkflow } = await import('./dynamic-workflow')
        const { submitWorkflow, getHistory, classifyModel, getImageModels } = await import('./comfyui')
        const models = await getImageModels()
        if (models.length === 0) return "Error: No image models available in ComfyUI."
        const model = models[0]
        const workflow = await buildDynamicWorkflow({
          prompt, negativePrompt: '', model: model.name,
          sampler: 'euler', scheduler: 'normal', steps: 20, cfgScale: 7,
          width: 1024, height: 1024, seed: -1, batchSize: 1,
        }, classifyModel(model.name))
        const promptId = await submitWorkflow(workflow)
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const history = await getHistory(promptId)
          if (history?.status?.completed) {
            const outputs = history.outputs ?? {}
            for (const nodeId of Object.keys(outputs)) {
              const files = [...(outputs[nodeId].images ?? []), ...(outputs[nodeId].gifs ?? [])]
              if (files.length > 0) return `Image generated: ${files[0].filename} (prompt: "${prompt}")`
            }
            return "Generation completed but no output produced."
          }
          if (history?.status?.status_str === 'error') return `Generation failed: ${history.status.messages?.[0]?.[1]?.message || 'Unknown error'}`
        }
        return "Generation timed out after 5 minutes."
      } catch (err) {
        return `Generation failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

export async function chatNonStreaming(
  model: string,
  messages: { role: string; content: string }[],
  signal?: AbortSignal
): Promise<string> {
  const res = await localFetch(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Chat API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.message?.content || data.response || "";
}
