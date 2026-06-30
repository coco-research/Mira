/**
 * Vision feedback for the chat-agent image/video flow.
 *
 * David's requirement: after the agent generates an image, the chat LLM must
 * actually SEE it and be able to comment — and then optionally turn it into a
 * video. The generation tools (image_generate / video_generate) return a text
 * result with a ComfyUI `/view` URL; that text alone tells a model a file
 * exists but lets it see nothing. This helper turns that result into a real
 * image attachment so a vision-capable model (e.g. gemma4:e4b, which reports
 * the `vision` capability) receives the pixels on its next turn.
 *
 * Gated on the model genuinely supporting vision (Ollama /api/show), so we
 * never ship a useless base64 blob to a text-only model (qwen2.5-coder) or pay
 * the fetch when it can't help.
 */

import { modelSupportsVision } from './ollama'
import { fetchComfyImageBase64 } from './comfyui'
import { log } from '../lib/logger'

// Same contract as ToolCallBlock's inline preview: only a localhost ComfyUI
// /view URL is trusted (never auto-load arbitrary tool output).
const COMFY_VIEW_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/view\?[^\s)\]]+)/i

function urlIsVideo(url: string): boolean {
  try {
    const m = /[?&]filename=([^&]+)/i.exec(url)
    const name = m ? decodeURIComponent(m[1]) : url
    return /\.(mp4|webm)$/i.test(name)
  } catch {
    return /\.(mp4|webm)(?=[?&]|$)/i.test(url)
  }
}

function filenameFromResult(result: string): string | null {
  // image_generate result shape: `Image generated: <file> (prompt: "...")\n<url>`
  const m = result.match(/generated:\s*([^\s(]+\.(?:png|jpg|jpeg|webp))/i)
  return m ? m[1] : null
}

export interface VisionFeedbackMessage {
  role: 'user'
  content: string
  images: { data: string; mimeType: string }[]
}

/**
 * Build a follow-up user message carrying the just-generated image so the model
 * can look at it. Returns null when this isn't an image result, the model can't
 * see images, or the fetch fails (all non-fatal — the flow still works, the
 * model just won't visually comment).
 */
export async function buildVisionFeedback(
  model: string,
  toolName: string,
  result: string,
): Promise<VisionFeedbackMessage | null> {
  if (!result) return null
  if (toolName !== 'image_generate' && toolName !== 'video_generate') return null
  const m = result.match(COMFY_VIEW_RE)
  if (!m) return null
  const url = m[1]
  if (urlIsVideo(url)) return null // can't feed a video to the model as an image
  try {
    if (!(await modelSupportsVision(model))) return null
  } catch {
    return null
  }
  let b64: string
  try {
    b64 = await fetchComfyImageBase64(url)
  } catch (e) {
    log.warn('vision_feedback.fetch_failed', { err: String(e) })
    return null
  }
  if (!b64) return null

  const file = filenameFromResult(result)
  const chain = file
    ? ` If the user asked to turn it into a video, call video_generate now with inputImage set to "${file}".`
    : ' If the user asked to turn it into a video, call video_generate now with inputImage set to that image\'s filename.'

  return {
    role: 'user',
    content:
      'Here is the image you just generated, shown to the user. Look at it and describe in one or two sentences what you actually see in the picture (composition, subject, colors).' +
      chain,
    images: [{ data: b64, mimeType: 'image/png' }],
  }
}
