import { create } from "zustand";
import { persist } from "zustand/middleware";

interface VoiceState {
  // Transient state (not persisted)
  isRecording: boolean;
  isTranscribing: boolean;
  isSpeaking: boolean;
  transcript: string;
  // Whether local Whisper STT is actually available. Probed at startup and
  // after the in-app install — transient (re-probed every launch) so a stale
  // "available" can never light up the mic on a machine where Whisper is gone,
  // and a fresh install lights it up without a restart.
  sttAvailable: boolean;
  // Whether local neural TTS (Piper) is installed + a voice model is present.
  // Same transient/probe model as sttAvailable.
  ttsAvailable: boolean;

  // Persisted settings
  sttEnabled: boolean;
  ttsEnabled: boolean;
  /** Selected Piper neural voice id (e.g. "en_US-lessac-medium"). */
  piperVoice: string;
  /** Browser SpeechSynthesis voice — only the fallback when neural is off. */
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  /** TTS engine: bundled Piper (local) or a user-configured external HTTP
   *  endpoint (OpenAI-compatible, e.g. Kokoro-FastAPI) — GitHub #58. */
  ttsMode: "piper" | "external";
  /** External TTS endpoint URL, e.g. http://localhost:8880/v1/audio/speech. */
  externalTtsUrl: string;
  /** Voice name passed to the external engine (e.g. "af_bella" / "alloy"). */
  externalTtsVoice: string;

  // Actions
  setRecording: (recording: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  setTranscript: (transcript: string) => void;
  setSttAvailable: (available: boolean) => void;
  setTtsAvailable: (available: boolean) => void;
  setPiperVoice: (voice: string) => void;
  updateVoiceSettings: (
    settings: Partial<{
      sttEnabled: boolean;
      ttsEnabled: boolean;
      ttsVoice: string;
      ttsRate: number;
      ttsPitch: number;
      ttsMode: "piper" | "external";
      externalTtsUrl: string;
      externalTtsVoice: string;
    }>
  ) => void;
  resetTransient: () => void;
  /** GitHub #59 — restore the persisted voice settings to factory defaults.
   *  Transient probe state (sttAvailable/ttsAvailable) is left alone: it
   *  reflects what is installed on disk, not a preference. */
  resetVoiceDefaults: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      // Transient state
      isRecording: false,
      isTranscribing: false,
      isSpeaking: false,
      transcript: "",
      sttAvailable: false,
      ttsAvailable: false,

      // Persisted settings — voice OFF by default (David 2026-06-07:
      // "tts und stt standardmäßig AUS und nicht immer automatisch vorlesen").
      // STT and TTS are opt-in; nothing reads responses aloud automatically
      // (the auto-speak on turn-completion was removed in useChat/useAgentChat).
      // When the user turns TTS on, it only enables the per-message read-aloud
      // Speaker button — reading happens on click, never automatically.
      sttEnabled: false,
      ttsEnabled: false,
      piperVoice: "en_US-lessac-medium",
      ttsVoice: "",
      ttsRate: 1.0,
      ttsPitch: 1.0,
      ttsMode: "piper",
      externalTtsUrl: "",
      externalTtsVoice: "",

      // Actions
      setRecording: (recording) => set({ isRecording: recording }),
      setTranscribing: (transcribing) => set({ isTranscribing: transcribing }),
      setSpeaking: (speaking) => set({ isSpeaking: speaking }),
      setTranscript: (transcript) => set({ transcript }),
      setSttAvailable: (available) => set({ sttAvailable: available }),
      setTtsAvailable: (available) => set({ ttsAvailable: available }),
      setPiperVoice: (voice) => set({ piperVoice: voice }),

      updateVoiceSettings: (settings) => set((state) => ({ ...state, ...settings })),

      resetTransient: () =>
        set({
          isRecording: false,
          isTranscribing: false,
          isSpeaking: false,
          transcript: "",
        }),

      resetVoiceDefaults: () =>
        set({
          sttEnabled: false,
          ttsEnabled: false,
          piperVoice: "en_US-lessac-medium",
          ttsVoice: "",
          ttsRate: 1.0,
          ttsPitch: 1.0,
          ttsMode: "piper",
          externalTtsUrl: "",
          externalTtsVoice: "",
        }),
    }),
    {
      name: "locally-uncensored-voice",
      partialize: (state) => ({
        sttEnabled: state.sttEnabled,
        ttsEnabled: state.ttsEnabled,
        piperVoice: state.piperVoice,
        ttsVoice: state.ttsVoice,
        ttsRate: state.ttsRate,
        ttsPitch: state.ttsPitch,
      }),
    }
  )
);
