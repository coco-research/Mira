/**
 * ComfyUI WebSocket client for real-time generation progress.
 *
 * Connects to ws://localhost:8188/ws and provides events for:
 * - Model loading (CheckpointLoaderSimple, UNETLoader, CLIPLoader, VAELoader)
 * - Sampling progress (KSampler step value/max)
 * - Execution completion / errors
 */

import { v4 as uuid } from 'uuid'
import { log } from '../lib/logger'
import { comfyuiWsUrl } from './backend'

export type ComfyWSEvent =
  | { type: 'status'; data: { queue_remaining: number } }
  | { type: 'execution_start'; data: { prompt_id: string } }
  | { type: 'executing'; data: { node: string | null; prompt_id: string } }
  | { type: 'progress'; data: { value: number; max: number; prompt_id: string } }
  | { type: 'executed'; data: { node: string; prompt_id: string } }
  | { type: 'execution_complete'; data: { prompt_id: string } }
  | { type: 'execution_error'; data: { prompt_id: string; exception_message?: string; node_type?: string } }
  | { type: 'execution_cached'; data: { prompt_id: string; nodes: string[] } }

export type ComfyWSListener = (event: ComfyWSEvent) => void

// Loader node class types that indicate model loading
export const LOADER_NODES = new Set([
  'CheckpointLoaderSimple', 'UNETLoader', 'CheckpointLoader',
])
export const CLIP_LOADER_NODES = new Set([
  'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'CLIPVisionLoader',
])
export const VAE_LOADER_NODES = new Set([
  'VAELoader',
])
export const SAMPLER_NODES = new Set([
  'KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced',
])
export const DECODE_NODES = new Set([
  'VAEDecode', 'VAEDecodeTiled',
])

/** Shared client ID used for both WS connection and workflow submission */
export const CLIENT_ID = uuid()

class ComfyWSClient {
  private ws: WebSocket | null = null
  private listeners = new Set<ComfyWSListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private _connected = false
  private connectPromise: Promise<void> | null = null

  get connected() { return this._connected }

  /** Connect and return a promise that resolves when the WS is open */
  connect(timeoutMs = 3000): Promise<void> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectPromise = null
        reject(new Error('WebSocket connect timeout'))
      }, timeoutMs)

      try {
        this.ws = new WebSocket(`${comfyuiWsUrl()}?clientId=${CLIENT_ID}`)

        this.ws.onopen = () => {
          clearTimeout(timer)
          this._connected = true
          this.reconnectDelay = 1000
          this.connectPromise = null
          log.info('[ComfyWS] Connected')
          resolve()
        }

        this.ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data)
            if (msg.type && msg.data) {
              const event = msg as ComfyWSEvent
              for (const listener of this.listeners) {
                listener(event)
              }
            }
          } catch { /* ignore non-JSON messages */ }
        }

        this.ws.onclose = () => {
          this._connected = false
          this.ws = null
          this.connectPromise = null
          this.scheduleReconnect()
        }

        this.ws.onerror = () => {
          clearTimeout(timer)
          this._connected = false
          this.connectPromise = null
          // CRITICAL: reject so callers don't hang. A WS error fires onerror
          // and we clear the connect timeout above — if we don't reject here,
          // the connect() promise NEVER settles and `await comfyWS.connect()`
          // hangs forever. That's exactly what happened when ComfyUI was
          // started without `--enable-cors-header` (e.g. a user-run / external
          // ComfyUI, or the dev auto-starter): ComfyUI's origin-only CSRF
          // middleware rejects the WebView's cross-origin upgrade, the WS
          // errors, and image/video generation got stuck on "Submitting to
          // ComfyUI…" with no progress and no result. Rejecting lets useCreate
          // fall back to /history polling so the result still appears (it only
          // loses the live progress bar). onclose still fires after this and
          // schedules a reconnect; reject on a settled promise is a no-op.
          reject(new Error('WebSocket connection error'))
        }
      } catch {
        clearTimeout(timer)
        this.connectPromise = null
        reject(new Error('WebSocket creation failed'))
      }
    })

    return this.connectPromise
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      })
    }, this.reconnectDelay)
  }

  on(listener: ComfyWSListener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this._connected = false
    this.connectPromise = null
  }
}

/** Singleton WebSocket client */
export const comfyWS = new ComfyWSClient()
