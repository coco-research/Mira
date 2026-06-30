/**
 * Chat Export — Markdown and JSON formats.
 *
 * When running inside Tauri, the user gets a native "Save As…" dialog to
 * pick the destination. In a plain browser context we fall back to a
 * blob-download.
 */

import type { Conversation } from '../types/chat'
import { isTauri, backendCall } from '../api/backend'

export function exportAsMarkdown(conversation: Conversation): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title}`)
  lines.push(`_Model: ${conversation.model} | ${new Date(conversation.createdAt).toLocaleString()}_`)
  lines.push('')

  if (conversation.systemPrompt) {
    lines.push('## System Prompt')
    lines.push(conversation.systemPrompt)
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  for (const msg of conversation.messages) {
    const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : msg.role
    lines.push(`### ${role}`)

    if (msg.thinking) {
      lines.push('')
      lines.push('<details><summary>Thinking</summary>')
      lines.push('')
      lines.push(msg.thinking)
      lines.push('')
      lines.push('</details>')
    }

    if (msg.toolCallSummary) {
      lines.push('')
      lines.push(`> Tool: ${msg.toolCallSummary}`)
    }

    lines.push('')
    lines.push(msg.content)
    lines.push('')

    if (msg.sources && msg.sources.length > 0) {
      lines.push('**Sources:**')
      for (const src of msg.sources) {
        lines.push(`- ${src.documentName} (chunk ${src.chunkIndex})`)
      }
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

export function exportAsJSON(conversation: Conversation): string {
  return JSON.stringify(conversation, null, 2)
}

export function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Export a conversation. Returns:
 *  - "saved" + the chosen path (Tauri dialog)
 *  - "cancelled" (user closed the dialog)
 *  - "downloaded" (browser fallback — file landed in the default Downloads folder)
 */
export async function exportConversation(
  conversation: Conversation,
  format: 'markdown' | 'json',
): Promise<{ status: 'saved' | 'cancelled' | 'downloaded'; path?: string; error?: string }> {
  const safeTitle = conversation.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  const ext = format === 'markdown' ? 'md' : 'json'
  const extLabel = format === 'markdown' ? 'Markdown' : 'JSON'
  const mime = format === 'markdown' ? 'text/markdown' : 'application/json'
  const filename = `${safeTitle}.${ext}`
  const content = format === 'markdown' ? exportAsMarkdown(conversation) : exportAsJSON(conversation)

  // Inside Tauri → native Save As dialog + real disk write
  if (isTauri()) {
    try {
      const chosenPath = await backendCall<string | null>('save_text_file_dialog', {
        content,
        defaultName: filename,
        extension: ext,
        extLabel,
      })
      if (!chosenPath) return { status: 'cancelled' }
      return { status: 'saved', path: chosenPath }
    } catch (e) {
      // Fall through to blob download if the Tauri command fails for any reason
      downloadFile(content, filename, mime)
      return { status: 'downloaded', error: String(e) }
    }
  }

  // Plain browser fallback
  downloadFile(content, filename, mime)
  return { status: 'downloaded' }
}
