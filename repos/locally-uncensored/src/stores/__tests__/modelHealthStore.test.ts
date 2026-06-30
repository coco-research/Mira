import { describe, it, expect, beforeEach } from 'vitest'
import { useModelHealthStore } from '../modelHealthStore'

describe('useModelHealthStore', () => {
  beforeEach(() => {
    useModelHealthStore.getState().reset()
  })

  it('setStaleModels records models + advances lastScanTime + clears dismissed', () => {
    // Arrange: user had dismissed a previous banner
    useModelHealthStore.setState({ dismissed: true, lastScanTime: 100 })

    useModelHealthStore.getState().setStaleModels(['phi4:14b', 'hermes3:8b'])

    const s = useModelHealthStore.getState()
    expect(s.staleModels).toEqual(['phi4:14b', 'hermes3:8b'])
    expect(s.lastScanTime).toBeGreaterThan(100)
    // A new scan finding stale models must re-show the banner.
    expect(s.dismissed).toBe(false)
  })

  it('markFresh removes a single model from the stale list', () => {
    useModelHealthStore.setState({
      staleModels: ['phi4:14b', 'hermes3:8b', 'dolphin3:8b'],
    })
    useModelHealthStore.getState().markFresh('hermes3:8b')
    expect(useModelHealthStore.getState().staleModels).toEqual(['phi4:14b', 'dolphin3:8b'])
  })

  it('markFresh is a no-op if model was not stale', () => {
    useModelHealthStore.setState({ staleModels: ['phi4:14b'] })
    useModelHealthStore.getState().markFresh('never-installed:7b')
    expect(useModelHealthStore.getState().staleModels).toEqual(['phi4:14b'])
  })

  it('dismiss hides the banner for this session without clearing stale models', () => {
    useModelHealthStore.setState({ staleModels: ['phi4:14b'] })
    useModelHealthStore.getState().dismiss()
    const s = useModelHealthStore.getState()
    expect(s.dismissed).toBe(true)
    expect(s.staleModels).toEqual(['phi4:14b'])
  })

  it('setScanning tracks concurrent scan state', () => {
    expect(useModelHealthStore.getState().scanning).toBe(false)
    useModelHealthStore.getState().setScanning(true)
    expect(useModelHealthStore.getState().scanning).toBe(true)
    useModelHealthStore.getState().setScanning(false)
    expect(useModelHealthStore.getState().scanning).toBe(false)
  })

  it('reset clears everything back to initial state', () => {
    useModelHealthStore.setState({
      staleModels: ['phi4:14b'],
      scanning: true,
      dismissed: true,
      lastScanTime: 12345,
    })
    useModelHealthStore.getState().reset()
    const s = useModelHealthStore.getState()
    expect(s.staleModels).toEqual([])
    expect(s.scanning).toBe(false)
    expect(s.dismissed).toBe(false)
    expect(s.lastScanTime).toBe(0)
  })
})
