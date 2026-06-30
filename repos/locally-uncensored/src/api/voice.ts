import { backendCall, isTauri } from "./backend";

/**
 * Voice API — 100% local
 * STT: Local Whisper (faster-whisper or openai-whisper) via /local-api/transcribe
 * TTS: Browser SpeechSynthesis (runs locally in the browser, no cloud)
 */

let whisperChecked = false
let whisperAvailable = false

export function isSpeechRecognitionSupported(): boolean {
  return whisperAvailable
}

// Call once at startup to check if Whisper is actually running
export async function initWhisperCheck(): Promise<boolean> {
  if (whisperChecked) return whisperAvailable
  try {
    const result = await checkWhisperAvailable()
    whisperAvailable = result.available
  } catch {
    whisperAvailable = false
  }
  whisperChecked = true
  return whisperAvailable
}

// Force a fresh availability probe, bypassing the one-shot cache. Used after
// the in-app faster-whisper install finishes, and when the mic button mounts
// while STT shows unavailable — the persistent Whisper server can take a while
// to load its model after boot, so the first startup probe may have been early.
export async function recheckWhisperAvailable(): Promise<boolean> {
  whisperChecked = false
  return initWhisperCheck()
}

export function isSpeechSynthesisSupported(): boolean {
  return !!window.speechSynthesis;
}

export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];

  let voices = window.speechSynthesis.getVoices();

  if (voices.length === 0) {
    // Voices may load asynchronously; trigger the load
    window.speechSynthesis.onvoiceschanged = () => {};
    voices = window.speechSynthesis.getVoices();
  }

  return voices;
}

export function getVoicesAsync(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isSpeechSynthesisSupported()) {
      resolve([]);
      return;
    }

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }

    window.speechSynthesis.onvoiceschanged = () => {
      resolve(window.speechSynthesis.getVoices());
    };

    // Fallback timeout in case onvoiceschanged never fires
    setTimeout(() => {
      resolve(window.speechSynthesis.getVoices());
    }, 1000);
  });
}

export function speak(
  text: string,
  voice?: SpeechSynthesisVoice,
  rate: number = 1.0,
  pitch: number = 1.0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isSpeechSynthesisSupported()) {
      reject(new Error("Speech synthesis not supported"));
      return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = pitch;

    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") {
        resolve();
      } else {
        reject(new Error(`Speech synthesis error: ${event.error}`));
      }
    };

    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speak text sentence by sentence for streaming-style playback.
 * Each sentence is spoken sequentially, allowing early interruption
 * via stopSpeaking() between sentences.
 */
export async function speakStreaming(
  text: string,
  voice?: SpeechSynthesisVoice,
  rate?: number,
  pitch?: number
): Promise<void> {
  if (!isSpeechSynthesisSupported()) return;
  stopSpeaking();

  // Split into sentences (keeping the punctuation)
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Check if speech was cancelled between sentences
    if (!window.speechSynthesis) return;

    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(trimmed);
      if (voice) utterance.voice = voice;
      if (rate !== undefined) utterance.rate = rate;
      if (pitch !== undefined) utterance.pitch = pitch;

      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        if (event.error === "canceled" || event.error === "interrupted") {
          resolve();
        } else {
          reject(new Error(`Speech synthesis error: ${event.error}`));
        }
      };

      window.speechSynthesis.speak(utterance);
    });
  }
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

// --- Local Whisper STT ---

export async function checkWhisperAvailable(): Promise<{
  available: boolean;
  backend: string | null;
  loading?: boolean;
  error?: string;
}> {
  try {
    if (isTauri()) {
      return await backendCall("whisper_status");
    }
    const res = await fetch("/local-api/transcribe-status");
    return res.json();
  } catch {
    return { available: false, backend: null, error: "Failed to reach transcribe-status endpoint" };
  }
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  if (isTauri()) {
    // Convert blob to base64 for Tauri invoke
    const buffer = await audioBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const audioBase64 = btoa(binary);
    // Tauri maps the Rust snake_case params (audio_base64, content_type) to
    // camelCase invoke keys — passing snake_case silently fails the command
    // ("missing required key audioBase64") → every transcription returned
    // nothing. THIS was the "mic records but no text" bug.
    const data = await backendCall("transcribe", {
      audioBase64,
      contentType: audioBlob.type || "audio/wav",
    });
    if (data.error) throw new Error(data.error);
    return data.transcript || "";
  }

  const res = await fetch("/local-api/transcribe", {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.transcript || "";
}

// --- Local neural TTS (Piper) ---
// Synthesizes via the bundled Piper voice through the Rust `synthesize` command
// (100% local, no cloud). The browser SpeechSynthesis path in useVoice handles
// the case where neural TTS isn't installed.

let ttsChecked = false;
let ttsAvailableFlag = false;

export async function checkTtsAvailable(): Promise<{ available: boolean; piper?: boolean; voice?: boolean }> {
  try {
    if (isTauri()) return await backendCall("tts_status");
    return { available: false };
  } catch {
    return { available: false };
  }
}

export async function initTtsCheck(): Promise<boolean> {
  if (ttsChecked) return ttsAvailableFlag;
  try {
    ttsAvailableFlag = (await checkTtsAvailable()).available;
  } catch {
    ttsAvailableFlag = false;
  }
  ttsChecked = true;
  return ttsAvailableFlag;
}

// Force a fresh probe (after the in-app install, or when a Speaker button mounts
// while neural TTS still shows unavailable).
export async function recheckTtsAvailable(): Promise<boolean> {
  ttsChecked = false;
  return initTtsCheck();
}

/** Synthesize text to a playable WAV data URL via a local Piper voice. */
export async function synthesizeNeural(text: string, voice?: string): Promise<string> {
  const data = await backendCall<{ audio_base64?: string; mime?: string }>("synthesize", { text, voice });
  if (!data?.audio_base64) throw new Error("neural TTS returned no audio");
  return `data:${data.mime || "audio/wav"};base64,${data.audio_base64}`;
}

/**
 * Synthesize text via a user-configured external HTTP TTS engine (GitHub #58).
 * `url` is an OpenAI-compatible endpoint (e.g. Kokoro-FastAPI at
 * http://localhost:8880/v1/audio/speech); `voice` is that engine's voice name.
 * Returns a playable data URL (the Rust side honors the returned audio type).
 */
export async function synthesizeExternal(text: string, url: string, voice?: string): Promise<string> {
  const data = await backendCall<{ audio_base64?: string; mime?: string }>("synthesize_external", { text, url, voice });
  if (!data?.audio_base64) throw new Error("external TTS returned no audio");
  return `data:${data.mime || "audio/wav"};base64,${data.audio_base64}`;
}

/** Download a Piper voice model on demand. Blocks until done (~63 MB). */
export async function downloadPiperVoice(voice: string): Promise<void> {
  await backendCall("download_voice", { voice });
}

/** Voice ids already present on disk — used to mark the Settings picker. */
export async function listInstalledPiperVoices(): Promise<string[]> {
  try {
    if (isTauri()) return (await backendCall<string[]>("installed_piper_voices")) || [];
    return [];
  } catch {
    return [];
  }
}

let neuralAudio: HTMLAudioElement | null = null;

/** Play a WAV data URL; resolves when playback ends. Replaces any current clip. */
export function playNeuralAudio(dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopNeuralAudio();
    const audio = new Audio(dataUrl);
    neuralAudio = audio;
    audio.onended = () => {
      if (neuralAudio === audio) neuralAudio = null;
      resolve();
    };
    audio.onerror = () => {
      if (neuralAudio === audio) neuralAudio = null;
      reject(new Error("neural audio playback failed"));
    };
    audio.play().catch(reject);
  });
}

export function stopNeuralAudio(): void {
  if (neuralAudio) {
    try { neuralAudio.pause(); } catch { /* noop */ }
    neuralAudio = null;
  }
}

// --- Audio Recorder (Web Audio PCM → 16 kHz mono WAV) ---
//
// We deliberately do NOT use MediaRecorder here. MediaRecorder with a timeslice
// emits *fragmented* webm/opus chunks; concatenating them yields a blob whose
// header/cues are incomplete, which faster-whisper (PyAV/ffmpeg) often fails to
// decode → empty transcript (the "mic on but no text" bug). Capturing raw PCM
// via Web Audio and encoding a clean 16 kHz mono WAV is what faster-whisper
// expects natively, and it lets us take mid-recording WAV snapshots for live
// streaming transcription.

export interface AudioRecorder {
  start: () => Promise<void>;
  /** Final 16 kHz mono WAV of the whole take. */
  stop: () => Promise<Blob>;
  /** 16 kHz mono WAV of everything captured so far (for streaming interim STT). */
  snapshot: () => Blob | null;
  isRecording: () => boolean;
}

const STT_TARGET_RATE = 16000;

function floatTo16BitPCM(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Box-filter downsample to the target rate (Whisper wants 16 kHz). Averaging
// the source window is a cheap anti-alias that beats naive decimation.
function downsampleTo(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : input[start] || 0;
  }
  return out;
}

function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) view.setInt16(off, samples[i], true);
  return new Blob([view], { type: "audio/wav" });
}

export function createAudioRecorder(): AudioRecorder {
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let mute: GainNode | null = null;
  let stream: MediaStream | null = null;
  let pcmChunks: Float32Array[] = [];
  let inputRate = 48000;
  let recording = false;

  const buildWav = (): Blob | null => {
    if (!pcmChunks.length) return null;
    let total = 0;
    for (const c of pcmChunks) total += c.length;
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let o = 0;
    for (const c of pcmChunks) { merged.set(c, o); o += c.length; }
    const ds = downsampleTo(merged, inputRate, STT_TARGET_RATE);
    return encodeWav(floatTo16BitPCM(ds), STT_TARGET_RATE);
  };

  return {
    start: async () => {
      pcmChunks = [];
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
      inputRate = audioCtx.sampleRate;
      source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but works reliably in WebView2 without the
      // AudioWorklet module-loading dance. 4096-frame buffer ≈ 85 ms at 48 kHz.
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!recording) return;
        // Copy — the underlying buffer is reused by the audio thread.
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // Route through a zero-gain node so onaudioprocess fires WITHOUT echoing
      // the mic to the speakers.
      mute = audioCtx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioCtx.destination);
      // getUserMedia is awaited just above, which can drop the user-gesture
      // activation → the AudioContext may start "suspended" and never fire
      // onaudioprocess (= silent capture, empty WAV). Resume explicitly.
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch { /* noop */ }
      }
      recording = true;
    },

    stop: () => {
      return new Promise<Blob>((resolve) => {
        recording = false;
        const wav = buildWav() || new Blob([], { type: "audio/wav" });
        try { processor?.disconnect(); } catch { /* noop */ }
        try { source?.disconnect(); } catch { /* noop */ }
        try { mute?.disconnect(); } catch { /* noop */ }
        try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
        try { void audioCtx?.close(); } catch { /* noop */ }
        processor = null; source = null; mute = null; audioCtx = null; stream = null;
        resolve(wav);
      });
    },

    snapshot: () => buildWav(),

    isRecording: () => recording,
  };
}
