import { useCallback, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import {
  recheckWhisperAvailable,
  recheckTtsAvailable,
  synthesizeNeural,
  synthesizeExternal,
  playNeuralAudio,
  stopNeuralAudio,
  isSpeechSynthesisSupported,
  speak,
  speakStreaming,
  stopSpeaking as stopSpeakingApi,
  getVoicesAsync,
  createAudioRecorder,
  transcribeAudio,
  type AudioRecorder,
} from "../api/voice";
import { log } from "../lib/logger";

export function useVoice() {
  const store = useVoiceStore();
  const recorderRef = useRef<AudioRecorder | null>(null);
  // Streaming-dictation plumbing: a polling timer that transcribes the
  // audio-so-far while recording, and a single-in-flight guard so slow
  // (CPU Whisper) transcriptions never pile up.
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interimBusyRef = useRef(false);

  // Reactive: the source of truth is the store flag set by the startup probe
  // (App.tsx) and the in-app install (Settings). Reading a module-level boolean
  // here was the bug — it never re-rendered when Whisper came up.
  const sttSupported = store.sttAvailable;
  const ttsSupported = isSpeechSynthesisSupported();

  // Reactive neural-TTS availability (Piper), same model as sttAvailable.
  const ttsAvailable = store.ttsAvailable;

  // External HTTP TTS engine configured + selected (#58). Lets the read-aloud
  // button light up even on a machine without Piper or browser voices.
  const ttsExternalReady = store.ttsMode === "external" && !!store.externalTtsUrl.trim();

  // Re-probe Whisper on demand (mic mount / after install) and sync the store.
  const recheckStt = useCallback(async (): Promise<boolean> => {
    const ok = await recheckWhisperAvailable();
    store.setSttAvailable(ok);
    return ok;
  }, [store]);

  // Re-probe neural TTS on demand (after install) and sync the store.
  const recheckTts = useCallback(async (): Promise<boolean> => {
    const ok = await recheckTtsAvailable();
    store.setTtsAvailable(ok);
    return ok;
  }, [store]);

  /**
   * Start dictation. If `onInterim` is supplied, the audio captured so far is
   * transcribed on a ~1.4 s cadence and streamed back so the input grows live
   * (Whisper isn't truly real-time, so this is chunked, not word-by-word). A
   * single-in-flight guard skips ticks while a transcription is still running,
   * so slow CPU transcriptions never queue up.
   */
  const startRecording = useCallback(
    async (onInterim?: (text: string) => void) => {
      if (recorderRef.current?.isRecording()) return;

      const recorder = createAudioRecorder();
      recorderRef.current = recorder;

      try {
        await recorder.start();
        store.setRecording(true);
        store.setTranscript("");

        if (onInterim) {
          streamTimerRef.current = setInterval(async () => {
            const rec = recorderRef.current;
            if (!rec?.isRecording() || interimBusyRef.current) return;
            const snap = rec.snapshot();
            // ~0.4 s of 16 kHz / 16-bit mono ≈ 12.8 KB — wait for a little audio.
            if (!snap || snap.size < 12000) return;
            interimBusyRef.current = true;
            try {
              const partial = await transcribeAudio(snap);
              if (recorderRef.current?.isRecording() && partial.trim()) {
                store.setTranscript(partial.trim());
                onInterim(partial.trim());
              }
            } catch {
              /* interim failures are non-fatal — the final transcribe still runs */
            } finally {
              interimBusyRef.current = false;
            }
          }, 1400);
        }
      } catch (err) {
        log.error("Failed to start recording", { err });
        if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
        interimBusyRef.current = false;
        recorderRef.current = null;
      }
    },
    [store],
  );

  const stopRecording = useCallback(async (): Promise<string> => {
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
    interimBusyRef.current = false;
    if (!recorderRef.current) return "";

    try {
      // Stop recording and get the final WAV of the whole take.
      const blob = await recorderRef.current.stop();
      store.setRecording(false);
      recorderRef.current = null;

      if (blob.size === 0) return "";

      // Final full-take transcription — more accurate than the interim chunks.
      store.setTranscribing(true);
      try {
        const transcript = await transcribeAudio(blob);
        store.setTranscript(transcript);
        return transcript;
      } catch (err) {
        log.error("Whisper transcription error", { err });
        return "";
      } finally {
        store.setTranscribing(false);
      }
    } catch (err) {
      log.error("Failed to stop recording", { err });
      store.setRecording(false);
      store.setTranscribing(false);
      recorderRef.current = null;
      return "";
    }
  }, [store]);

  // Speak `text`. Prefers local neural TTS (Piper) when installed; otherwise
  // falls back to the browser's SpeechSynthesis voices. `streaming` only
  // affects the browser path (sentence-by-sentence so it starts sooner) —
  // neural always synthesizes the whole utterance in one local call.
  const speakInternal = useCallback(
    async (text: string, streaming: boolean) => {
      if (!store.ttsEnabled) return;
      // An external HTTP engine (#58) needs a configured URL; Piper needs to be
      // installed; the browser path needs SpeechSynthesis. Bail only if none of
      // the three can speak.
      const externalReady = store.ttsMode === "external" && !!store.externalTtsUrl.trim();
      if (!externalReady && !store.ttsAvailable && !ttsSupported) return;

      store.setSpeaking(true);
      try {
        // External HTTP TTS engine takes precedence when selected + configured.
        if (externalReady) {
          try {
            const url = await synthesizeExternal(text, store.externalTtsUrl.trim(), store.externalTtsVoice || undefined);
            await playNeuralAudio(url);
            return;
          } catch (err) {
            log.error("External TTS failed, falling back to browser voices", { err });
          }
        } else if (store.ttsAvailable) {
          try {
            const url = await synthesizeNeural(text, store.piperVoice);
            await playNeuralAudio(url);
            return;
          } catch (err) {
            log.error("Neural TTS failed, falling back to browser voices", { err });
          }
        }
        if (!ttsSupported) return;
        let voice: SpeechSynthesisVoice | undefined;
        if (store.ttsVoice) {
          const voices = await getVoicesAsync();
          voice = voices.find((v) => v.name === store.ttsVoice);
        }
        if (streaming) {
          await speakStreaming(text, voice, store.ttsRate, store.ttsPitch);
        } else {
          await speak(text, voice, store.ttsRate, store.ttsPitch);
        }
      } catch (err) {
        log.error("Speech synthesis error", { err });
      } finally {
        store.setSpeaking(false);
      }
    },
    [store, ttsSupported]
  );

  const speakText = useCallback((text: string) => speakInternal(text, false), [speakInternal]);
  const speakTextStreaming = useCallback((text: string) => speakInternal(text, true), [speakInternal]);

  const stopSpeaking = useCallback(() => {
    stopNeuralAudio();
    stopSpeakingApi();
    store.setSpeaking(false);
  }, [store]);

  return {
    isRecording: store.isRecording,
    isTranscribing: store.isTranscribing,
    isSpeaking: store.isSpeaking,
    transcript: store.transcript,
    sttSupported,
    ttsSupported,
    ttsAvailable,
    ttsExternalReady,
    ttsEnabled: store.ttsEnabled,
    startRecording,
    stopRecording,
    recheckStt,
    recheckTts,
    speakText,
    speakTextStreaming,
    stopSpeaking,
  };
}
