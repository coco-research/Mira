/**
 * Built-in Agent Workflows — Pre-configured workflow templates.
 */

import { v4 as uuid } from 'uuid'
import type { AgentWorkflow, WorkflowStep } from '../types/agent-workflows'

function step(type: WorkflowStep['type'], label: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: uuid(), type, label, ...overrides }
}

// ── Research Topic ────────────────────────────────────────────

const researchTopic: AgentWorkflow = {
  id: 'builtin-research-topic',
  name: 'Research Topic',
  description: 'Search the web, fetch the best result, and summarize it',
  icon: 'Search',
  steps: [
    step('user_input', 'Enter topic', { userInputPrompt: 'What topic should I research?' }),
    step('tool', 'Search the web', {
      toolName: 'web_search',
      toolArgTemplates: { query: '{{user_input}}' },
    }),
    step('prompt', 'Pick best URL', {
      prompt: 'Based on the search results below, pick the single best URL to read for comprehensive information about "{{user_input}}".\n\nSearch results:\n{{last_output}}\n\nRespond with ONLY the URL, nothing else.',
      allowedTools: [],
    }),
    step('tool', 'Fetch page content', {
      toolName: 'web_fetch',
      toolArgTemplates: { url: '{{last_output}}' },
    }),
    step('prompt', 'Summarize findings', {
      prompt: 'Summarize the following content about "{{user_input}}" in a clear, structured way. Use bullet points for key facts.\n\nContent:\n{{last_output}}',
      allowedTools: [],
    }),
    step('memory_save', 'Save to memory', {
      memorySave: {
        type: 'reference',
        titleTemplate: 'Research: {{user_input}}',
        contentTemplate: '{{last_output}}',
        tags: ['research', 'workflow'],
      },
    }),
  ],
  variables: {},
  isBuiltIn: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ── Summarize URL ─────────────────────────────────────────────

const summarizeUrl: AgentWorkflow = {
  id: 'builtin-summarize-url',
  name: 'Summarize URL',
  description: 'Fetch a URL and generate a concise summary',
  icon: 'FileText',
  steps: [
    step('user_input', 'Enter URL', { userInputPrompt: 'Enter the URL to summarize:' }),
    step('tool', 'Fetch page', {
      toolName: 'web_fetch',
      toolArgTemplates: { url: '{{user_input}}' },
    }),
    step('prompt', 'Generate summary', {
      prompt: 'Provide a concise summary of this page content. Include key points as bullet points.\n\nURL: {{user_input}}\n\nContent:\n{{last_output}}',
      allowedTools: [],
    }),
  ],
  variables: {},
  isBuiltIn: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ── Code Review ───────────────────────────────────────────────

const codeReview: AgentWorkflow = {
  id: 'builtin-code-review',
  name: 'Code Review',
  description: 'Read a file and provide a code review',
  icon: 'Code',
  steps: [
    step('user_input', 'Enter file path', { userInputPrompt: 'Enter the file path to review:' }),
    step('tool', 'Read file', {
      toolName: 'file_read',
      toolArgTemplates: { path: '{{user_input}}' },
    }),
    step('prompt', 'Review code', {
      prompt: `Review the following code from "{{user_input}}". Check for:
- Bugs and potential errors
- Security issues
- Performance concerns
- Code style and readability
- Suggestions for improvement

Code:
{{last_output}}

Provide a structured review with severity levels (critical/warning/info).`,
      allowedTools: [],
    }),
  ],
  variables: {},
  isBuiltIn: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ── Export ─────────────────────────────────────────────────────

export const BUILT_IN_WORKFLOWS: AgentWorkflow[] = [
  researchTopic,
  summarizeUrl,
  codeReview,
]
