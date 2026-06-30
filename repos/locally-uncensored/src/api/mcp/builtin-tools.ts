// Built-in tool definitions + executors — replaces hardcoded AGENT_TOOL_DEFS

import type { MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { backendCall, fetchExternal } from '../backend'
import { getActiveChatId, getActiveWorkspace, isChatArtifactMode, captureChatArtifact } from '../agent-context'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { WorkflowEngine } from '../../lib/workflow-engine'
import type { StepResult } from '../../types/agent-workflows'
import { DELEGATE_TASK_TOOL_DEF, buildDelegateExecutor } from '../agents/sub-agent'

/**
 * Helper: current chat id as a plain `{ chatId }` fragment to spread into
 * backendCall payloads. Returns `{}` when no agent loop is active — the
 * Rust side then falls back to `agent-workspace/default/` for relative
 * paths (and uses absolute paths as-is regardless).
 */
function chatCtx(): { chatId?: string; workingDirectory?: string } {
  const id = getActiveChatId()
  if (!id) return {}
  // If the agent loop picked a real folder, thread it through so the
  // bridge resolves relative paths against that folder instead of the
  // per-chat sandbox. The workspace pointer is set on loop start by
  // useAgentChat / useCodex (see agent-context.setActiveWorkspace).
  const ws = getActiveWorkspace()
  if (ws?.kind === 'folder' && ws.path) {
    return { chatId: id, workingDirectory: ws.path }
  }
  return { chatId: id }
}

// ── Tool Definitions ────────────────────────────────────────────

const BUILTIN_TOOLS: MCPToolDefinition[] = [
  // Web
  {
    name: 'web_search',
    description:
      'Search the web via the configured provider (Brave, Tavily, or auto). Returns a ranked list of {title, url, snippet}. '
      + 'PREFER web_fetch on promising URLs for full content — snippets are teasers, not answers. '
      + 'DO NOT call more than 3x per turn with similar queries; refine the query instead of re-searching. '
      + 'For current date/time, use get_current_time — do NOT web_search for it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    category: 'web',
    source: 'builtin',
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a single URL and return its readable text (up to ~24 000 chars). '
      + 'Strips <script>, <style>, <nav>, <header>, <footer>, <aside>, <form> — returns main content only. '
      + 'PREFER this over web_search when you already know the target URL. '
      + 'NEVER call with localhost, private IPs (10.*, 192.168.*, 172.16-31.*), or file:// — they are refused. '
      + 'If response is empty or 4xx, try a different URL rather than retrying the same one.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including protocol (http:// or https://)' },
        maxLength: { type: 'number', description: 'Max chars to return (default: 24000)' },
      },
      required: ['url'],
    },
    category: 'web',
    source: 'builtin',
  },

  // Filesystem
  {
    name: 'file_read',
    description:
      'Read the complete contents of a file. PREFER absolute paths; relative paths resolve against the agent workspace (~/agent-workspace). '
      + 'The entire file is returned — there is no pagination or range parameter. '
      + 'DO NOT re-read a file you just wrote with file_write; the write response already confirmed the save. '
      + 'For directory listings use file_list; for content search across many files use file_search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute preferred)' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_write',
    description:
      'Write a file. Creates parent directories if missing. OVERWRITES existing content — there is NO append mode. '
      + 'To preserve existing content and append, use file_read FIRST then file_write with the combined content. '
      + 'PREFER absolute paths. '
      + 'Writes to the same path within one turn are serialized automatically via the sideEffectKey scheduler.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute preferred)' },
        content: { type: 'string', description: 'The complete new content of the file' },
      },
      required: ['path', 'content'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_list',
    description:
      'List directory contents. Returns entries with name, isDir, size, full path. '
      + 'Supports recursive=true for full tree and glob pattern ("*.ts", "**/*.py"). '
      + 'PREFER a specific pattern over recursive listing of large trees — recursing home / C:\\ is slow. '
      + 'For content search (grep), use file_search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default: false)' },
        pattern: { type: 'string', description: 'Glob pattern to filter results (e.g. "*.ts", "**/*.py")' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_search',
    description:
      'Grep-style regex content search across files in a directory. Returns matching lines with file + line number. '
      + 'PREFER over file_read + manual scan when hunting for a symbol across many files. '
      + 'Use file_list first if you do not know the layout. '
      + 'Default max 50 results — narrow the pattern or path if you flood. '
      + 'Pattern uses Rust regex syntax, not PCRE.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in (recursive by default)' },
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        maxResults: { type: 'number', description: 'Maximum matching files (default: 50)' },
      },
      required: ['path', 'pattern'],
    },
    category: 'filesystem',
    source: 'builtin',
  },

  // Terminal
  {
    name: 'shell_execute',
    description:
      'Run a shell command. PowerShell on Windows, bash on Unix. Returns stdout, stderr, exit code. '
      + 'PREFER dedicated tools where available: file_read over `cat`, file_list over `ls`/`dir`, file_search over `grep`, get_current_time over `date`. '
      + 'Use shell_execute for git, npm, cargo, docker, package managers, or platform utilities without a dedicated tool. '
      + 'NEVER use to permanently delete without confirmation (rm -rf, Remove-Item -Recurse, git reset --hard). '
      + 'Default timeout 120 s; set higher only for known long-running builds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, absolute preferred)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
        shell: { type: 'string', description: 'Override shell: "powershell" | "cmd" | "bash" (default: auto)' },
      },
      required: ['command'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'code_execute',
    description:
      'Execute Python code in a fresh subprocess. Returns stdout, stderr, exit code. '
      + 'Use for math, data transforms, JSON/CSV parsing, one-off scripts. '
      + 'NOT a REPL — state does not persist between calls; import everything you need each time. '
      + 'For system commands and shell utilities, PREFER shell_execute. '
      + 'Default timeout 30 s.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python source to execute (UTF-8)' },
        language: { type: 'string', description: 'Programming language: "python" or "shell"', enum: ['python', 'shell'] },
      },
      required: ['code'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'shell_execute_background',
    description:
      'Spawn a shell command on the bridge as a LONG-RUNNING BACKGROUND task. '
      + 'Returns an opaque task `id` immediately — the user can close the browser, '
      + 'come back later, and use `shell_task_status` to read the tail of stdout/stderr. '
      + 'USE for batch refactors, large `pnpm install`, `cargo build`, dataset transforms — '
      + 'anything that would time out a normal `shell_execute` call.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: ['command'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'shell_task_status',
    description:
      'Read the status of a background task started via `shell_execute_background`. '
      + 'Returns running/finished, exit code, cancelled flag, and the last ~64 KiB of '
      + 'output. Poll periodically while a task is running.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id returned by shell_execute_background.' },
      },
      required: ['id'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'shell_task_kill',
    description:
      'Cancel a running background task. No-op if the task already finished.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id to cancel.' },
      },
      required: ['id'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'shell_task_list',
    description:
      'List all background tasks the bridge knows about (newest first). Use for '
      + '"what is still running?" queries.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'git_status',
    description:
      'Run `git status --porcelain=2 --branch` and return a STRUCTURED summary: '
      + 'branch, ahead/behind counts, per-file status codes, clean-tree flag. '
      + 'PREFER over shell_execute for "what changed" queries — output is greppable.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory (defaults to chat workspace).' },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'git_commit',
    description:
      'Stage files (or all tracked changes) and create a commit with `message`. '
      + 'When `allTracked` is true → `git add -A` then `git commit`; '
      + 'when `files` is given → only those paths are staged; '
      + 'otherwise commits whatever is already staged. '
      + 'NEVER passes `--no-verify` — fix hook failures, don\'t skip them. '
      + 'Output includes the new commit SHA on success.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (multi-line OK).' },
        allTracked: { type: 'boolean', description: 'Stage every tracked change first.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage.' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: ['message'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'git_push',
    description:
      'Run `git push`. With no args pushes the current branch to its tracked upstream. '
      + 'WARN: not for `main`/`master` without explicit user instruction — '
      + 'check git_status first.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name (default: origin).' },
        branch: { type: 'string', description: 'Branch to push (default: current).' },
        setUpstream: { type: 'boolean', description: 'Pass `-u` for first-time push.' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'git_log',
    description:
      'Recent commits in one-line format. Returns parsed [{sha, subject}]. '
      + 'PREFER over shell_execute when answering "what changed recently" — output is greppable.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max commits to return (default 20).' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'git_diff',
    description:
      'Run `git diff` between HEAD (or a ref) and the working tree. '
      + 'Returns the raw unified diff — pair with file_search if you only need a path. '
      + 'For staged changes pass `staged: true`.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Base ref (e.g. main, HEAD~3). Defaults to HEAD.' },
        path: { type: 'string', description: 'Limit to a path.' },
        staged: { type: 'boolean', description: 'Diff the index instead of the working tree.' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'project_init',
    description:
      'Scaffold a new project from a known stack recipe. With no `recipe` arg, lists '
      + 'available stacks (next-postgres, next-supabase, next-stripe, rust-axum, vite-react). '
      + 'With a `recipe` arg, returns a markdown plan of ordered shell commands the model '
      + 'can then execute via shell_execute. Workspace-sandboxed IDEs can\'t do this — LU '
      + 'can because the bridge has real shell + filesystem access.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: {
          type: 'string',
          description: 'Stack id (e.g. "next-postgres"). Omit to list available recipes.',
        },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'pr_resume',
    description:
      'Pick up where a GitHub PR left off. Given a PR URL, fetches title, body, head '
      + 'branch, latest comments, and the full diff via the local `gh` CLI in one call, '
      + 'and returns a markdown summary. USE when the user says "continue this PR" / '
      + '"/resume <url>" / "pick up review of #123".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'PR URL (https://github.com/owner/repo/pull/N).' },
        cwd: { type: 'string', description: 'Working directory (default: chat workspace).' },
      },
      required: ['url'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'gh_pr_create',
    description:
      'Open a new GitHub pull request via the `gh` CLI. Requires the user to be authed against GitHub locally. '
      + 'Pushes the current branch first if it has no upstream. Returns the PR URL on success.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title (under 70 chars).' },
        body: { type: 'string', description: 'PR description in markdown.' },
        base: { type: 'string', description: 'Base branch (default: repo default).' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: ['title'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'run_tests',
    description:
      'Run the project test suite and return a STRUCTURED summary: passed/failed counts, '
      + 'failing test names, last 40 output lines. AUTO-DETECTS the runner '
      + '(vitest, jest, cargo, pytest) from files in the working directory unless `runner` is given. '
      + 'PREFER this over shell_execute when the user says "run the tests", "make this green", '
      + 'or you are iterating on a failing assertion — the output is greppable instead of an opaque dump. '
      + 'Default timeout 300 s. Pass `command` to override the auto-detected command (e.g. a single-file scope).',
    inputSchema: {
      type: 'object',
      properties: {
        runner: {
          type: 'string',
          description: 'Force a runner: "vitest" | "jest" | "cargo" | "pytest". Auto if omitted.',
          enum: ['vitest', 'jest', 'cargo', 'pytest'],
        },
        command: {
          type: 'string',
          description: 'Override the test command entirely. Use for single-file runs (`pnpm exec vitest run path/to/x.test.ts`).',
        },
        cwd: {
          type: 'string',
          description: 'Override working directory. Defaults to the chat workspace.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default 300_000 — tests can take a while).',
        },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },

  // System
  {
    name: 'system_info',
    description:
      'Return desktop system info: OS, architecture, hostname, username, total RAM, CPU count. Zero arguments. '
      + 'Call once when output needs to be tailored to the user\'s platform; do not call repeatedly in a loop.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },
  {
    name: 'process_list',
    description:
      'List the top 30 running processes sorted by memory: {name, pid, memory, cpu%}. Zero arguments. '
      + 'Use for task-manager-style queries ("is Chrome running?", "which process is eating RAM?"). '
      + 'There is NO process_kill tool — to kill a process use shell_execute with taskkill (Windows) or kill (Unix).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },

  // Desktop
  {
    name: 'screenshot',
    description:
      'Capture the primary display as a base64 PNG. Zero arguments. '
      + 'USE for visual verification when the user asks "what\'s on my screen" or "look at X". '
      + 'Returns a short summary string (size + filename); the actual image is forwarded to the model via message content. '
      + 'NEVER call in a tight loop — screenshots are expensive and privacy-sensitive.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'desktop',
    source: 'builtin',
  },

  // Image
  {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt via the local ComfyUI pipeline. Blocks up to 5 minutes. '
      + 'USE for "draw me", "make an image of", "generate a picture". '
      + 'Pass `inputImage` (a filename from an earlier image_generate result) for image-to-image — restyle / edit an existing image at the given `denoise` strength; omit it for text-to-image. '
      + 'First installed image model is auto-selected (or pass `model`). '
      + 'EXPECT A PAUSE: on a single-GPU machine LU may briefly unload the chat model from VRAM to fit the image model, then reload it after — typically a 30-90s swap (longer on a cold ComfyUI start). This avoids out-of-memory errors; your conversation is fully preserved across the swap. '
      + 'Rate-limit yourself to 1 call per turn — ComfyUI serializes generations internally so parallel calls will queue, not speed up. '
      + 'Fine-tune with the optional `settings` object (steps, cfg, sampler, scheduler, width/height, seed, lora, vae); set ONLY what the user asked for. A value beyond the installed model\'s real limit is REJECTED with the actual limit so you can retry lower — values are never silently changed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive text description of the desired image' },
        negativePrompt: { type: 'string', description: 'Things to avoid (blurry, deformed, etc.)' },
        model: { type: 'string', description: 'Optional image model filename to use. Omit to auto-select the first installed image model.' },
        inputImage: { type: 'string', description: 'Optional. Filename of a previously generated image (from an earlier image_generate result) to use as the base for image-to-image. Omit for text-to-image.' },
        denoise: { type: 'number', description: 'Image-to-image strength 0.05–1.0 (default 0.6). Lower keeps more of the input image, higher follows the prompt more. Only used together with inputImage.' },
        settings: {
          type: 'object',
          description: 'Optional fine-tuning. Set ONLY what the user explicitly asked for; omit the rest (the model\'s own defaults apply). Any value beyond the installed model\'s real limit is rejected with the actual limit. Flat top-level args (above) win over the same key here.',
          additionalProperties: true,
          properties: {
            steps: { type: 'number', description: 'Sampling steps.' },
            cfg: { type: 'number', description: 'CFG / guidance scale.' },
            sampler: { type: 'string', description: 'Sampler name — must be one this model supports, else rejected.' },
            scheduler: { type: 'string', description: 'Scheduler name — must be one this model supports, else rejected.' },
            seed: { type: 'number', description: 'Seed; omit or -1 for random.' },
            width: { type: 'number', description: 'Output width in px.' },
            height: { type: 'number', description: 'Output height in px.' },
            negativePrompt: { type: 'string', description: 'Things to avoid.' },
            denoise: { type: 'number', description: 'Image-to-image strength 0.05–1.0 (only with inputImage).' },
            lora: { type: ['string', 'array'], items: { type: 'string' }, description: 'LoRA filename to apply — or an ARRAY of filenames to stack multiple LoRAs (chained in order, like stacking LoraLoader nodes). Names are matched against the installed LoRAs (extension optional); an unknown name is rejected with the installed list.' },
            loraStrength: { type: ['number', 'array'], items: { type: 'number' }, description: 'LoRA strength (~0–2). Single number = applied to every LoRA; array = one strength per LoRA in the same order.' },
            vae: { type: 'string', description: 'Override VAE filename.' },
          },
        },
      },
      required: ['prompt'],
    },
    category: 'image',
    source: 'builtin',
  },
  {
    name: 'video_generate',
    description:
      'Generate a short video clip from a text prompt via the local ComfyUI pipeline (Wan / Hunyuan / AnimateDiff backend, auto-detected). Blocks up to 10 minutes. '
      + 'USE for "make a video of", "animate", "generate a clip". '
      + 'For a specific length pass `seconds` (e.g. seconds=4 for a 4-second clip) — prefer this over raw frames. Image-to-video (SVD) effectively tops out around 3-4 seconds; text-to-video can run longer. '
      + 'Pass `inputImage` (a filename from an earlier image_generate result) to animate a still image — image-to-video, which auto-selects an installed I2V model such as SVD; omit it for text-to-video. First installed video model is auto-selected (or pass `model`). '
      + 'Write ONE clear prompt and call this ONCE per turn — video generation is slow and ComfyUI queues parallel calls rather than speeding up. '
      + 'EXPECT A PAUSE: LU will briefly unload the chat model from VRAM to fit the (large) video model, then reload it after — typically a 30-90s swap, longer on a cold ComfyUI start. This prevents out-of-memory errors; your conversation is preserved across the swap. '
      + 'Fine-tune with the optional `settings` object (steps, cfg, sampler, scheduler, width/height, seed); set ONLY what the user asked for. A value beyond the installed model\'s real limit (e.g. more frames than the model can make) is REJECTED with the actual limit so you can retry lower — values are never silently changed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive text description of the desired video / motion' },
        negativePrompt: { type: 'string', description: 'Things to avoid (static, blurry, deformed, etc.)' },
        model: { type: 'string', description: 'Optional video model filename to use. Omit to auto-select the first installed video model.' },
        seconds: { type: 'number', description: 'Desired clip length in seconds (e.g. 4). PREFER this over frames for "an N second video". Image-to-video (SVD) effectively maxes near 3-4s; text-to-video can be longer.' },
        frames: { type: 'number', description: 'Advanced: exact frame count (rejected if beyond the model max; e.g. ~81 for Wan, ~25 for SVD). Prefer `seconds`. Omit for the model default.' },
        fps: { type: 'number', description: 'Frames per second of the output clip (e.g. 16). Omit for the model default.' },
        inputImage: { type: 'string', description: 'Optional. Filename of a previously generated image to animate (image-to-video). Requires an installed I2V model such as SVD. Omit for text-to-video.' },
        settings: {
          type: 'object',
          description: 'Optional fine-tuning. Set ONLY what the user explicitly asked for; omit the rest (the model\'s own defaults apply). Any value beyond the installed model\'s real limit is rejected with the actual limit. Flat top-level args (above) win over the same key here.',
          additionalProperties: true,
          properties: {
            seconds: { type: 'number', description: 'Clip length in seconds (preferred length control).' },
            frames: { type: 'number', description: 'Exact frame count — rejected if beyond the model max.' },
            fps: { type: 'number', description: 'Frames per second of the output clip.' },
            steps: { type: 'number', description: 'Sampling steps.' },
            cfg: { type: 'number', description: 'CFG / guidance scale.' },
            sampler: { type: 'string', description: 'Sampler name — must be one this model supports (ignored by FramePack, which uses a fixed sampler).' },
            scheduler: { type: 'string', description: 'Scheduler name — must be one this model supports.' },
            seed: { type: 'number', description: 'Seed; omit or -1 for random.' },
            width: { type: 'number', description: 'Output width in px (snapped to the video grid).' },
            height: { type: 'number', description: 'Output height in px (snapped to the video grid).' },
            negativePrompt: { type: 'string', description: 'Things to avoid.' },
          },
        },
      },
      // prompt intentionally NOT required: image-to-video can animate a still
      // without an explicit text prompt, and small models sometimes omit it —
      // LU defaults a gentle-motion prompt rather than rejecting the call.
      required: [],
    },
    category: 'video',
    source: 'builtin',
  },

  // Workflow
  {
    name: 'run_workflow',
    description:
      'Execute a saved agent workflow by name. Runs a nested ReAct with a pre-built step chain. '
      + 'USE for repeatable multi-step tasks: "Research Topic", "Summarize URL", "Code Review", plus any user-created workflows. '
      + 'DO NOT call from inside another workflow tool — depth capped at 5 to prevent recursion fork-bombs. '
      + 'Pass optional input as the starting variable. If the name is unknown, the error lists available names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow (case-insensitive match)' },
        input: { type: 'string', description: 'Initial input passed as user_input / last_output' },
      },
      required: ['name'],
    },
    category: 'workflow',
    source: 'builtin',
  },

  // Sub-agent delegation (Phase 13 v2.4.0).
  DELEGATE_TASK_TOOL_DEF,

  // Local clock — so the agent never googles "what day is it".
  {
    name: 'get_current_time',
    description:
      "Return the user's current local date, time, and timezone. Zero arguments. "
      + "USE FIRST for any 'what day / time / date is it' question — do NOT web_search or shell_execute `date`. "
      + "The Rust backend probes the OS timezone on every call, so this is always authoritative.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
]

// ── Executors ────────────────────────────────────────────────────

async function executeWebSearch(args: Record<string, any>): Promise<string> {
  const { useSettingsStore } = await import('../../stores/settingsStore')
  const searchSettings = useSettingsStore.getState().settings
  const data = await backendCall('web_search', {
    query: args.query,
    count: args.maxResults || 5,
    provider: searchSettings.searchProvider || 'auto',
    braveApiKey: searchSettings.braveApiKey || '',
    tavilyApiKey: searchSettings.tavilyApiKey || '',
  })
  if (Array.isArray(data.results) && data.results.length > 0) {
    const lines = data.results
      .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
    // When the configured paid provider failed we still return free-tier
    // results, but say why the configured one didn't answer — a silently
    // swallowed bad API key would look like "search is broken".
    const note = typeof data.providerError === 'string' && data.providerError
      ? `\n\n[Note: configured search provider failed — ${data.providerError}. Results above are from the free fallback (${data.provider || 'fallback'}).]`
      : ''
    return lines + note
  }
  if (typeof data.error === 'string' && data.error) {
    const extra = typeof data.providerError === 'string' && data.providerError ? ` (${data.providerError})` : ''
    return `Web search failed: ${data.error}${extra}`
  }
  return JSON.stringify(data)
}

async function executeWebFetch(args: Record<string, any>): Promise<string> {
  const url = args.url
  if (!url) return 'Error: No URL provided'

  // Preferred path: use the Rust `web_fetch` command which strips HTML
  // aggressively (<script>/<style>/<nav>/<footer> gone, paragraphs kept)
  // and caps at ~24 000 chars. The old path only gave the model the first
  // ~4 000 chars of a half-cleaned body — that's why the agent kept
  // complaining it "only sees the header" of the page.
  try {
    const data = await backendCall<{ url: string; status: number; contentType: string; title: string; text: string; truncated: boolean }>(
      'web_fetch',
      { url }
    )
    const parts: string[] = []
    if (data.title) parts.push(`Title: ${data.title}`)
    parts.push(`URL: ${data.url}`)
    parts.push(`Status: ${data.status}`)
    parts.push('')
    parts.push(data.text || '(empty body)')
    if (data.truncated) parts.push('\n…(truncated to 24 000 chars)')
    return parts.join('\n')
  } catch (e) {
    // Fallback: legacy fetchExternal + htmlToText (used in browser / dev mode
    // where the Rust command isn't reachable).
    try {
      const maxLength = args.maxLength || 24000
      const html = await fetchExternal(url)
      const text = htmlToText(html)
      if (text.length > maxLength) return text.substring(0, maxLength) + '\n\n[...truncated]'
      return text || 'Error: Page returned empty content'
    } catch (fallbackErr) {
      return `Error: web_fetch failed — ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function executeFileRead(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_read', { path: args.path, ...chatCtx() })
  return data.content || ''
}

/** Last path segment, defaulting to file.txt. */
function artifactBaseName(p: any): string {
  const raw = typeof p === 'string' && p.trim() ? p.trim() : 'file.txt'
  return raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'file.txt'
}

/** MIME from a filename extension — drives the in-chat artifact preview. */
function mimeForName(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript',
    ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
    py: 'text/x-python', html: 'text/html', htm: 'text/html', css: 'text/css',
    csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml', xml: 'application/xml',
    sh: 'text/x-shellscript', sql: 'text/plain', toml: 'text/plain',
    rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java', c: 'text/x-c', cpp: 'text/x-c++',
  }
  return map[ext] || 'text/plain'
}

async function executeFileWrite(args: Record<string, any>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
  // Plain-chat artifact mode (ChatGPT-style, David 2026-06-12): in the NORMAL
  // chat, a "file write" must NOT touch disk — capture it so it renders inline
  // with a preview + Download button. The Coding Agent / full Agent leave
  // artifact mode OFF and fall through to the real fs_write below.
  if (isChatArtifactMode()) {
    const name = artifactBaseName(args.path)
    captureChatArtifact(name, content, mimeForName(name))
    return `Created "${name}" (${formatBytes(content.length)}). It is shown to the user right here in the chat with a preview and a Download button — nothing was written to disk. Do not call file_read on it; just tell the user it's ready.`
  }
  const data = await backendCall('fs_write', { path: args.path, content, ...chatCtx() })
  // Rust returns {status: 'saved', path: <absolute>}. Surface the real path
  // so the model (and the file-change event) knows WHERE the write landed —
  // especially important when chatId is None and Rust routes a relative path
  // to `agent-workspace/default/`.
  if (data.status === 'saved' && data.path) return `File saved: ${data.path}`
  return JSON.stringify(data)
}

async function executeFileList(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_list', {
    path: args.path,
    recursive: args.recursive || false,
    pattern: args.pattern || null,
    ...chatCtx(),
  })
  if (Array.isArray(data.entries)) {
    return data.entries
      .map((e: any) => `${e.isDir ? '[DIR]' : ''} ${e.name} (${formatBytes(e.size)})  ${e.path}`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeFileSearch(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_search', {
    path: args.path,
    pattern: args.pattern,
    max_results: args.maxResults || 50,
    ...chatCtx(),
  })
  if (Array.isArray(data.results)) {
    return data.results
      .map((r: any) => {
        const matches = r.matches?.map((m: any) => `  L${m.line}: ${m.text}`).join('\n') || ''
        return `${r.file}\n${matches}`
      })
      .join('\n\n')
  }
  return JSON.stringify(data)
}

async function executeShellExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('shell_execute', {
    command: args.command,
    args: args.args || null,
    cwd: args.cwd || null,
    timeout: args.timeout || 120000,
    shell: args.shell || null,
    ...chatCtx(),
  })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function executeCodeExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('execute_code', { code: args.code, timeout: 30000, ...chatCtx() })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function runShell(command: string, cwd: string | undefined, timeout = 60000) {
  return backendCall('shell_execute', {
    command,
    args: null,
    cwd: cwd || null,
    timeout,
    shell: null,
    ...chatCtx(),
  })
}

async function executeShellExecuteBg(args: Record<string, any>): Promise<string> {
  const { bgStart } = await import('../agents/bg-tasks')
  const { id } = await bgStart({ command: args.command, cwd: args.cwd })
  return `Task started: ${id}. Use shell_task_status to poll, shell_task_kill to cancel.`
}

async function executeShellTaskStatus(args: Record<string, any>): Promise<string> {
  const { bgStatus, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const s = await bgStatus(args.id)
  const head = renderBgStatusOneLine(s)
  const tail = s.output_tail ? `\n---\n${s.output_tail}` : ''
  return `${head}${tail}`
}

async function executeShellTaskKill(args: Record<string, any>): Promise<string> {
  const { bgKill } = await import('../agents/bg-tasks')
  const r = await bgKill(args.id)
  return r.cancelled ? `Cancelled ${args.id}.` : `${args.id}: already finished.`
}

async function executeShellTaskList(): Promise<string> {
  const { bgList, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const { tasks } = await bgList()
  if (!tasks.length) return '(no background tasks)'
  return tasks.map(renderBgStatusOneLine).join('\n')
}

async function executeGitStatus(args: Record<string, any>): Promise<string> {
  const { parseGitStatus, renderGitStatus } = await import('../agents/git-tools')
  const data = await runShell('git status --porcelain=2 --branch', args.cwd)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_status failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const parsed = parseGitStatus(data.stdout || '')
  return renderGitStatus(parsed)
}

async function executeGitCommit(args: Record<string, any>): Promise<string> {
  const { buildGitCommitCommand } = await import('../agents/git-tools')
  const cmd = buildGitCommitCommand({
    message: args.message,
    files: Array.isArray(args.files) ? args.files : undefined,
    allTracked: !!args.allTracked,
  })
  if (!cmd) return 'git_commit: a non-empty `message` is required.'
  const data = await runShell(cmd, args.cwd)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_commit failed (exit ${data.exitCode}):\n${output}`
  }
  const m = output.match(/\[(\S+)\s+([0-9a-f]{7,40})\]/)
  return m ? `Committed on ${m[1]} as ${m[2]}.\n${output}` : output
}

async function executeGitPush(args: Record<string, any>): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const flags: string[] = []
  if (args.setUpstream) flags.push('-u')
  if (args.remote) flags.push(shellQuote(args.remote))
  if (args.branch) flags.push(shellQuote(args.branch))
  const cmd = `git push ${flags.join(' ')}`.trim()
  const data = await runShell(cmd, args.cwd, 120000)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_push failed (exit ${data.exitCode}):\n${output}`
  }
  return output || 'git push: ok.'
}

async function executeGitLog(args: Record<string, any>): Promise<string> {
  const { parseGitLog } = await import('../agents/git-tools')
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 20
  const cmd = `git log --oneline -n ${limit}`
  const data = await runShell(cmd, args.cwd)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_log failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const entries = parseGitLog(data.stdout || '')
  if (!entries.length) return '(no commits)'
  return entries.map((e) => `${e.sha} ${e.subject}`).join('\n')
}

async function executeGitDiff(args: Record<string, any>): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const parts = ['git', 'diff']
  if (args.staged) parts.push('--cached')
  if (args.ref) parts.push(shellQuote(String(args.ref)))
  if (args.path) parts.push('--', shellQuote(String(args.path)))
  const data = await runShell(parts.join(' '), args.cwd, 120000)
  if (data.exitCode && data.exitCode !== 0 && data.exitCode !== 1) {
    return `git_diff failed: ${data.stderr || `exit ${data.exitCode}`}`
  }
  const out = data.stdout || ''
  if (!out.trim()) return '(no diff)'
  return out.length > 16000 ? `${out.slice(0, 16000)}\n…(truncated)` : out
}

async function executeProjectInit(args: Record<string, any>): Promise<string> {
  const { findRecipe, renderInitPlan, listRecipes } = await import('../agents/project-init')
  const recipeId = typeof args.recipe === 'string' ? args.recipe.trim() : ''
  if (!recipeId) {
    const list = listRecipes()
    return [
      'Available project_init recipes:',
      '',
      ...list.map((r) => `- **${r.id}** — ${r.name}: ${r.summary}`),
      '',
      'Call again with `recipe` set to one of the ids above to get the full plan.',
    ].join('\n')
  }
  const recipe = findRecipe(recipeId)
  if (!recipe) {
    return `project_init: unknown recipe "${recipeId}". Call without args to see the list.`
  }
  return renderInitPlan(recipe)
}

async function executePrResume(args: Record<string, any>): Promise<string> {
  const { parsePrUrl, normalisePrJson, renderPrResume } = await import('../agents/pr-resume')
  const loc = parsePrUrl(String(args.url ?? ''))
  if (!loc) return 'pr_resume: not a GitHub PR URL (expected https://github.com/owner/repo/pull/N).'
  const view = await runShell(
    `gh pr view ${loc.number} --repo ${loc.owner}/${loc.repo} --json title,body,state,headRefName,baseRefName,author,comments`,
    args.cwd,
    60000,
  )
  if (view.exitCode && view.exitCode !== 0) {
    return `pr_resume: gh pr view failed (exit ${view.exitCode}): ${view.stderr || view.stdout || ''}`
  }
  let raw: any
  try {
    raw = JSON.parse(view.stdout || '{}')
  } catch (e) {
    return `pr_resume: unparseable gh output (${e instanceof Error ? e.message : String(e)})`
  }
  const meta = normalisePrJson(raw, String(args.url))
  const diff = await runShell(
    `gh pr diff ${loc.number} --repo ${loc.owner}/${loc.repo}`,
    args.cwd,
    60000,
  )
  return renderPrResume({
    ...meta,
    diff: diff.exitCode === 0 ? diff.stdout || '' : '',
  })
}

async function executeGhPrCreate(args: Record<string, any>): Promise<string> {
  const { buildGhPrCreateCommand } = await import('../agents/git-tools')
  const cmd = buildGhPrCreateCommand({
    title: args.title,
    body: args.body ?? '',
    base: args.base,
  })
  if (!cmd) return 'gh_pr_create: a non-empty `title` is required.'
  const data = await runShell(cmd, args.cwd, 60000)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `gh_pr_create failed (exit ${data.exitCode}):\n${output}`
  }
  // `gh pr create` prints the URL on stdout.
  const urlMatch = output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)
  return urlMatch ? `Opened PR: ${urlMatch[0]}\n${output}` : output
}

async function executeRunTests(args: Record<string, any>): Promise<string> {
  const { commandForRunner, detectRunnerFromFiles, parseForRunner, renderResult } =
    await import('../agents/test-runner')

  let runner = args.runner as Runner | undefined
  let command = typeof args.command === 'string' ? args.command : ''

  if (!command) {
    if (!runner) {
      // List the workspace root to find a config marker.
      try {
        const listing = await backendCall('fs_list', {
          path: '.',
          recursive: false,
          ...chatCtx(),
        })
        const names: string[] = Array.isArray(listing.items)
          ? listing.items.map((it: any) => String(it.name ?? '')).filter(Boolean)
          : []
        runner = detectRunnerFromFiles(names)
      } catch {
        runner = 'unknown'
      }
    }
    command = commandForRunner(runner as Runner)
  }
  if (!command) {
    return 'run_tests: could not detect a test runner. Pass `command` or `runner` explicitly.'
  }

  const shellArgs = {
    command,
    args: null,
    cwd: args.cwd || null,
    timeout: args.timeout || 300000,
    shell: null,
    ...chatCtx(),
  }
  const data = await backendCall('shell_execute', shellArgs)
  if (data.timedOut) {
    return `Test run timed out after ${shellArgs.timeout / 1000}s. Partial output:\n${(data.stdout || '').slice(-2000)}`
  }
  const combined = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  const parsed = parseForRunner(runner ?? 'unknown', combined)
  return renderResult(parsed)
}
type Runner = 'vitest' | 'cargo' | 'pytest' | 'jest' | 'unknown'

async function executeSystemInfo(): Promise<string> {
  const data = await backendCall('system_info', {})
  return Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n')
}

async function executeProcessList(): Promise<string> {
  const data = await backendCall('process_list', {})
  if (Array.isArray(data.processes)) {
    return data.processes
      .slice(0, 30)
      .map((p: any) => `${p.name} (PID: ${p.pid}) — ${formatBytes(p.memory)} RAM, ${p.cpu?.toFixed(1)}% CPU`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeScreenshot(): Promise<string> {
  const data = await backendCall('screenshot', {})
  if (data.image) {
    return `[Screenshot captured: base64 PNG, ${Math.round(data.image.length / 1024)}KB]`
  }
  return JSON.stringify(data)
}

async function executeImageGenerate(args: Record<string, any>): Promise<string> {
  // Feature EE (v2.5.0): the whole generation flow now goes through the VRAM
  // hand-off orchestrator. It resolves the image model (args.model or first
  // installed), decides whether the resident local text model has to be evicted
  // from VRAM to make room (single-GPU OOM avoidance), runs the ComfyUI
  // workflow exactly as before (buildDynamicWorkflow), then reloads the text
  // model afterwards. The returned string keeps the EXACT F1 contract —
  // `Image generated: <file> (prompt: "...")\n<comfyui /view URL>` — so
  // ToolCallBlock renders it inline and useAgentChat feeds it back unchanged.
  const prompt = args.prompt || args.description || ''
  if (!prompt) return 'Error: No prompt provided for image generation.'
  const settings = (args.settings && typeof args.settings === 'object') ? args.settings : {}
  const flat: Record<string, any> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'settings' && v !== undefined) flat[k] = v
  const merged: Record<string, any> = { ...settings, ...flat }   // explicit flat args win; undefined never clobbers settings
  // Model-Picker gate (v2.5.3): BEFORE the VRAM swap, let the user pick the
  // ComfyUI model in the tool call (or silently use the saved preference).
  // Returns null when an explicit model arg exists / nothing is installed /
  // ComfyUI is unreachable — the existing pipeline then behaves as before.
  const { pickModelForGeneration } = await import('../model-pick')
  const picked = await pickModelForGeneration('image', merged)
  if (picked) merged.model = picked
  const { vramHandoffGenerate } = await import('../vram-handoff')
  return vramHandoffGenerate('image', merged)
}

async function executeVideoGenerate(args: Record<string, any>): Promise<string> {
  // Feature EE (v2.5.0): text-to-video via the same hand-off orchestrator.
  // Picks the first installed video model (or args.model), detects the video
  // backend (Wan / AnimateDiff), evicts the local text model from VRAM if it
  // won't co-exist, runs buildTxt2VidWorkflow, then reloads the text model.
  // Same inline-render contract as image_generate (the URL may end .webp/.mp4 —
  // ToolCallBlock renders a <video> for those).
  // No prompt guard here: image-to-video can animate a still WITHOUT a text
  // prompt, and small models routinely omit it (gemma4 live). runHandoff
  // defaults a gentle-motion prompt for video, normalizes a snake_case
  // input_image alias, and falls back to the last generated image — so the
  // "animate the image you just made" chain works even with a sloppy call.
  const settings = (args.settings && typeof args.settings === 'object') ? args.settings : {}
  const flat: Record<string, any> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'settings' && v !== undefined) flat[k] = v
  const merged: Record<string, any> = { ...settings, ...flat }   // explicit flat args win; undefined never clobbers settings
  // Model-Picker gate (v2.5.3) — see executeImageGenerate. T2V and I2V keep
  // separate saved preferences (disjoint capability sets).
  const { pickModelForGeneration } = await import('../model-pick')
  const picked = await pickModelForGeneration('video', merged)
  if (picked) merged.model = picked
  const { vramHandoffGenerate } = await import('../vram-handoff')
  return vramHandoffGenerate('video', merged)
}

async function executeGetCurrentTime(_args: Record<string, any>): Promise<string> {
  try {
    const data = await backendCall<{ unix: number; iso_local: string; iso_utc: string; timezone: string; timezone_offset: number }>(
      'get_current_time',
      {},
    )
    return `Local: ${data.iso_local} ${data.timezone}\nUTC:   ${data.iso_utc}\nUnix:  ${data.unix}`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

let _workflowDepth = 0

async function executeRunWorkflow(args: Record<string, any>): Promise<string> {
  const workflowName = args.name
  if (!workflowName) return 'Error: No workflow name provided'
  if (_workflowDepth >= 5) return 'Error: Maximum workflow nesting depth (5) exceeded'

  const store = useAgentWorkflowStore.getState()
  const workflow = store.workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase())
  if (!workflow) {
    const available = store.workflows.map(w => w.name).join(', ')
    return `Error: Workflow "${workflowName}" not found. Available: ${available}`
  }

  const results: StepResult[] = []
  let finalOutput = ''
  const callbacks = {
    onStepStart: () => {},
    onStepComplete: (_idx: number, result: StepResult) => { results.push(result) },
    onStepError: () => {},
    onWaitingForInput: () => {},
    onComplete: () => {
      const lastOutput = results.filter(r => r.output).pop()
      finalOutput = lastOutput?.output || 'Workflow completed with no output.'
    },
    onError: (error: string) => { finalOutput = `Workflow error: ${error}` },
  }

  const initialVars = args.input ? { user_input: args.input, last_output: args.input } : {}
  _workflowDepth++
  try {
    const engine = new WorkflowEngine(workflow, 'tool-execution', callbacks, initialVars, _workflowDepth)
    await engine.run()
  } finally {
    _workflowDepth--
  }
  return finalOutput
}

// ── Helpers ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function htmlToText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, nav, header, footer, .nav, .header, .footer, .sidebar, .menu, .ad, .advertisement, [role="navigation"], [role="banner"]').forEach(el => el.remove())
    const main = doc.querySelector('main, article, [role="main"], .content, .article, .post, #content, #main')
    const target = main || doc.body
    if (!target) return ''
    let text = ''
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let node: Node | null = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim()
        if (t) text += t + ' '
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'].includes(tag)) text += '\n'
        if (['h1', 'h2', 'h3'].includes(tag)) text += '# '
      }
      node = walker.nextNode()
    }
    return text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Registration ────────────────────────────────────────────────

const EXECUTOR_MAP: Record<string, (args: Record<string, any>) => Promise<string>> = {
  web_search: executeWebSearch,
  web_fetch: executeWebFetch,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_list: executeFileList,
  file_search: executeFileSearch,
  shell_execute: executeShellExecute,
  code_execute: executeCodeExecute,
  run_tests: executeRunTests,
  shell_execute_background: executeShellExecuteBg,
  shell_task_status: executeShellTaskStatus,
  shell_task_kill: executeShellTaskKill,
  shell_task_list: executeShellTaskList,
  git_status: executeGitStatus,
  git_commit: executeGitCommit,
  git_push: executeGitPush,
  git_log: executeGitLog,
  git_diff: executeGitDiff,
  gh_pr_create: executeGhPrCreate,
  pr_resume: executePrResume,
  project_init: executeProjectInit,
  system_info: executeSystemInfo,
  process_list: executeProcessList,
  screenshot: executeScreenshot,
  image_generate: executeImageGenerate,
  video_generate: executeVideoGenerate,
  run_workflow: executeRunWorkflow,
  get_current_time: executeGetCurrentTime,
  delegate_task: buildDelegateExecutor(),
}

export function registerBuiltinTools(registry: ToolRegistry) {
  for (const tool of BUILTIN_TOOLS) {
    const executor = EXECUTOR_MAP[tool.name]
    if (executor) {
      registry.registerBuiltin(tool, executor)
    }
  }
}
