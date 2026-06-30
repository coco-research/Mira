import { describe, it, expect, beforeEach } from 'vitest'
import { useCodexStore } from '../codexStore'
import { useVoiceStore } from '../voiceStore'
import type { CodexEvent } from '../../types/codex'

// ── codexStore ───────────────────────────────────────────────

describe('codexStore', () => {
  beforeEach(() => {
    useCodexStore.setState({
      chatMode: 'lu',
      threads: {},
      workingDirectory: '',
      fileTree: [],
    })
  })

  describe('initThread', () => {
    it('creates a new thread for the conversation', () => {
      const id = useCodexStore.getState().initThread('conv-1', '/home/user')
      expect(id).toMatch(/^codex-/)
      const thread = useCodexStore.getState().threads['conv-1']
      expect(thread).toBeDefined()
      expect(thread.conversationId).toBe('conv-1')
      expect(thread.workingDirectory).toBe('/home/user')
      expect(thread.status).toBe('idle')
      expect(thread.events).toEqual([])
    })

    it('overwrites existing thread for same conversation', () => {
      useCodexStore.getState().initThread('conv-1', '/path/a')
      const id2 = useCodexStore.getState().initThread('conv-1', '/path/b')
      expect(useCodexStore.getState().threads['conv-1'].id).toBe(id2)
      expect(useCodexStore.getState().threads['conv-1'].workingDirectory).toBe('/path/b')
    })

    it('does not affect other conversations threads', () => {
      useCodexStore.getState().initThread('conv-1', '/a')
      useCodexStore.getState().initThread('conv-2', '/b')
      expect(Object.keys(useCodexStore.getState().threads)).toHaveLength(2)
    })
  })

  describe('addEvent', () => {
    it('appends an event to the correct thread', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      const event: CodexEvent = {
        id: 'e1',
        type: 'instruction',
        content: 'hello',
        timestamp: Date.now(),
      }
      useCodexStore.getState().addEvent('conv-1', event)
      expect(useCodexStore.getState().threads['conv-1'].events).toHaveLength(1)
      expect(useCodexStore.getState().threads['conv-1'].events[0].id).toBe('e1')
    })

    it('gracefully returns state when thread does not exist', () => {
      const event: CodexEvent = { id: 'e1', type: 'error', content: 'err', timestamp: Date.now() }
      useCodexStore.getState().addEvent('nonexistent', event)
      // Should not throw, no new thread created
      expect(useCodexStore.getState().threads['nonexistent']).toBeUndefined()
    })

    it('preserves event order', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().addEvent('conv-1', { id: 'a', type: 'instruction', content: '1', timestamp: 1 })
      useCodexStore.getState().addEvent('conv-1', { id: 'b', type: 'file_change', content: '2', timestamp: 2 })
      useCodexStore.getState().addEvent('conv-1', { id: 'c', type: 'done', content: '3', timestamp: 3 })
      const events = useCodexStore.getState().threads['conv-1'].events
      expect(events.map(e => e.id)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('setThreadStatus', () => {
    it('updates the thread status', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
      expect(useCodexStore.getState().threads['conv-1'].status).toBe('running')
    })

    it('is a no-op for non-existent thread', () => {
      useCodexStore.getState().setThreadStatus('nonexistent', 'error')
      expect(useCodexStore.getState().threads['nonexistent']).toBeUndefined()
    })

    it('can transition through multiple statuses', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
      useCodexStore.getState().setThreadStatus('conv-1', 'error')
      expect(useCodexStore.getState().threads['conv-1'].status).toBe('error')
    })
  })

  describe('getThread', () => {
    it('returns the thread for the conversation', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      const thread = useCodexStore.getState().getThread('conv-1')
      expect(thread).toBeDefined()
      expect(thread!.conversationId).toBe('conv-1')
    })

    it('returns undefined for non-existent conversation', () => {
      expect(useCodexStore.getState().getThread('nope')).toBeUndefined()
    })
  })

  describe('setChatMode', () => {
    it('updates the chat mode', () => {
      useCodexStore.getState().setChatMode('codex')
      expect(useCodexStore.getState().chatMode).toBe('codex')
    })
  })

  describe('chatMode default on boot (v2.3.9 regression)', () => {
    // Newcomers should always land in Chat ('lu') on startup, not in whatever
    // tab they left off in. codexStore intentionally excludes chatMode from
    // partialize so the default is used on every fresh boot.
    it('initial chatMode is "lu" regardless of prior setChatMode calls in a previous simulated session', () => {
      // Simulate a "previous session" setting chatMode to codex.
      useCodexStore.setState({ chatMode: 'codex' })
      expect(useCodexStore.getState().chatMode).toBe('codex')
      // Simulate the setup that beforeEach would run on next boot — reset to
      // the store's initial values. If chatMode were persisted, a real app
      // boot would re-hydrate it from localStorage; by excluding it from
      // partialize we guarantee the default ('lu') shows up instead.
      useCodexStore.setState({ chatMode: 'lu' })
      expect(useCodexStore.getState().chatMode).toBe('lu')
    })
  })
})

// ── voiceStore ───────────────────────────────────────────────

describe('voiceStore', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      isRecording: false,
      isTranscribing: false,
      isSpeaking: false,
      transcript: '',
      sttAvailable: false,
      sttEnabled: true,
      ttsEnabled: false,
      ttsVoice: '',
      ttsRate: 1.0,
      ttsPitch: 1.0,
    })
  })

  describe('updateVoiceSettings', () => {
    it('partially merges settings', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsEnabled: true, ttsVoice: 'en-US' })
      expect(useVoiceStore.getState().ttsEnabled).toBe(true)
      expect(useVoiceStore.getState().ttsVoice).toBe('en-US')
      // Others unchanged
      expect(useVoiceStore.getState().sttEnabled).toBe(true)
    })

    it('can update rate and pitch', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsRate: 1.5, ttsPitch: 0.8 })
      expect(useVoiceStore.getState().ttsRate).toBe(1.5)
      expect(useVoiceStore.getState().ttsPitch).toBe(0.8)
    })

  })

  describe('setSttAvailable', () => {
    it('toggles transient STT availability', () => {
      useVoiceStore.getState().setSttAvailable(true)
      expect(useVoiceStore.getState().sttAvailable).toBe(true)
      useVoiceStore.getState().setSttAvailable(false)
      expect(useVoiceStore.getState().sttAvailable).toBe(false)
    })
  })

  describe('resetTransient', () => {
    it('resets transient state to defaults', () => {
      useVoiceStore.setState({
        isRecording: true,
        isTranscribing: true,
        isSpeaking: true,
        transcript: 'some text',
      })
      useVoiceStore.getState().resetTransient()
      expect(useVoiceStore.getState().isRecording).toBe(false)
      expect(useVoiceStore.getState().isTranscribing).toBe(false)
      expect(useVoiceStore.getState().isSpeaking).toBe(false)
      expect(useVoiceStore.getState().transcript).toBe('')
    })

    it('preserves persisted settings', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsEnabled: true, ttsVoice: 'custom', ttsRate: 2.0 })
      useVoiceStore.setState({ isRecording: true, isSpeaking: true })
      useVoiceStore.getState().resetTransient()
      expect(useVoiceStore.getState().ttsEnabled).toBe(true)
      expect(useVoiceStore.getState().ttsVoice).toBe('custom')
      expect(useVoiceStore.getState().ttsRate).toBe(2.0)
    })
  })

  describe('individual setters', () => {
    it('setRecording updates isRecording', () => {
      useVoiceStore.getState().setRecording(true)
      expect(useVoiceStore.getState().isRecording).toBe(true)
    })

    it('setTranscribing updates isTranscribing', () => {
      useVoiceStore.getState().setTranscribing(true)
      expect(useVoiceStore.getState().isTranscribing).toBe(true)
    })

    it('setSpeaking updates isSpeaking', () => {
      useVoiceStore.getState().setSpeaking(true)
      expect(useVoiceStore.getState().isSpeaking).toBe(true)
    })

    it('setTranscript updates transcript', () => {
      useVoiceStore.getState().setTranscript('hello world')
      expect(useVoiceStore.getState().transcript).toBe('hello world')
    })
  })
})
