import { describe, it, expect, beforeEach } from 'vitest'
import { useStagedChangesStore } from '../stagedChangesStore'

describe('stagedChangesStore', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ byChat: {} })
  })

  it('starts empty', () => {
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
  })

  it('stages a change and returns an id', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'new',
      diff: 'diff body',
    })
    expect(typeof id).toBe('string')
    const list = useStagedChangesStore.getState().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0].path).toBe('src/a.ts')
    expect(list[0].id).toBe(id)
    expect(list[0].stagedAt).toBeGreaterThan(0)
  })

  it('staging the same path twice keeps only the latest (path-keyed dedupe)', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'v1',
      diff: 'd1',
    })
    useStagedChangesStore.getState().stage('c1', {
      path: 'src/a.ts',
      oldContent: 'old',
      newContent: 'v2',
      diff: 'd2',
    })
    const list = useStagedChangesStore.getState().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0].newContent).toBe('v2')
  })

  it('queues across chats are isolated', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().stage('c2', {
      path: 'b',
      oldContent: '',
      newContent: 'y',
      diff: '',
    })
    expect(useStagedChangesStore.getState().list('c1').map((c) => c.path)).toEqual(['a'])
    expect(useStagedChangesStore.getState().list('c2').map((c) => c.path)).toEqual(['b'])
  })

  it('remove drops a single entry and is a no-op for unknown ids', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().remove('c1', 'nonexistent-id')
    expect(useStagedChangesStore.getState().list('c1')).toHaveLength(1)
    useStagedChangesStore.getState().remove('c1', id)
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
  })

  it('clear empties a chat queue without touching others', () => {
    useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().stage('c2', {
      path: 'b',
      oldContent: '',
      newContent: 'y',
      diff: '',
    })
    useStagedChangesStore.getState().clear('c1')
    expect(useStagedChangesStore.getState().list('c1')).toEqual([])
    expect(useStagedChangesStore.getState().list('c2')).toHaveLength(1)
  })

  it('clearing the last entry deletes the chat key entirely', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    useStagedChangesStore.getState().remove('c1', id)
    expect(useStagedChangesStore.getState().byChat['c1']).toBeUndefined()
  })

  it('get returns the entry by id', () => {
    const id = useStagedChangesStore.getState().stage('c1', {
      path: 'a',
      oldContent: '',
      newContent: 'x',
      diff: '',
    })
    const found = useStagedChangesStore.getState().get('c1', id)
    expect(found?.path).toBe('a')
    expect(useStagedChangesStore.getState().get('c1', 'unknown')).toBeUndefined()
  })
})
