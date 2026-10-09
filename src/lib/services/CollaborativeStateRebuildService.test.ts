import { describe, expect, it, vi } from 'vitest'
import type { Character, StoryEntry } from '$lib/types'
import {
  checkCollaborativeStateRebuildConfirmation,
  collaborativeStateRebuildCandidateSchema,
  createCollaborativeStateRebuildDraft,
  createCollaborativeStateRebuildRequest,
  diffCollaborativeState,
  type CollaborativeStateRebuildCandidate,
  type CollaborativeStateRebuildCurrentState,
  type CollaborativeStateRebuildRequest,
} from './CollaborativeStateRebuildService'

function entry(
  id: string,
  position: number,
  type: StoryEntry['type'],
  content = id,
  branchId: string | null = null,
): StoryEntry {
  return {
    id,
    storyId: 'story',
    type,
    content,
    parentId: null,
    position,
    createdAt: position,
    metadata:
      type === 'retry'
        ? ({
            novelRetry: { mode: 'different', rawInput: '', sourceText: content, rejected: [] },
          } as StoryEntry['metadata'])
        : type === 'narration'
          ? ({ novelTurn: { version: 2, historyKey: '', rawInput: '', sceneDirectorOutput: '', confirmedPlan: 'future secret', confirmedPatternGuidance: null } } as StoryEntry['metadata'])
          : null,
    branchId,
  }
}

function character(id: string, name: string, description = name): Character {
  return {
    id,
    storyId: 'story',
    branchId: null,
    name,
    description,
    relationship: null,
    traits: [],
    visualDescriptors: {},
    portrait: null,
    status: 'active',
    metadata: null,
  }
}

function candidateCharacter(id: string | null, name: string, description = name) {
  return {
    id,
    name,
    description,
    relationship: null,
    traits: [],
    visualDescriptors: {},
    status: 'active' as const,
    metadata: null,
  }
}

function candidate(overrides: Partial<CollaborativeStateRebuildCandidate> = {}) {
  return {
    characters: [],
    locations: [],
    items: [],
    storyBeats: [],
    currentLocationId: null,
    storyTime: null,
    ...overrides,
  }
}

function current(characters: Character[] = []): CollaborativeStateRebuildCurrentState {
  return {
    characters,
    locations: [],
    items: [],
    storyBeats: [],
    currentLocationId: null,
    storyTime: null,
  }
}

const scope = {
  storyId: 'story',
  branchId: null,
  targetEntryId: 'target',
  targetPosition: 3,
}

describe('rebuild history request', () => {
  it('includes the target narration but excludes future entries, retry text, and plan metadata', () => {
    const request = createCollaborativeStateRebuildRequest({
      ...scope,
      entries: [
        entry('future', 4, 'narration', 'future fact'),
        entry('target', 3, 'narration', 'accepted narration'),
        entry('rejected', 2, 'retry', 'rejected reroll'),
        entry('action', 1, 'user_action', 'accepted action'),
      ],
    })

    expect(request.history.map((item) => item.id)).toEqual(['action', 'target'])
    expect(JSON.stringify(request)).not.toContain('future fact')
    expect(JSON.stringify(request)).not.toContain('rejected reroll')
    expect(JSON.stringify(request)).not.toContain('future secret')
  })

  it('changes the hash when accepted history changes and rejects stale confirmation', () => {
    const entries = [entry('action', 1, 'user_action', 'one'), entry('target', 3, 'narration')]
    const first = createCollaborativeStateRebuildRequest({ ...scope, entries })
    const changed = entries.map((item) =>
      item.id === 'action' ? { ...item, content: 'two' } : item,
    )
    const second = createCollaborativeStateRebuildRequest({ ...scope, entries: changed })
    expect(first.historyHash).not.toBe(second.historyHash)

    const draft = {
      ...scope,
      historyHash: first.historyHash,
      createdAt: 1,
      candidate: candidate(),
      diff: diffCollaborativeState(current(), candidate()),
    }
    expect(
      checkCollaborativeStateRebuildConfirmation(draft, { ...scope, entries: changed }),
    ).toEqual({ valid: false, reason: 'history_changed' })
  })
})

describe('candidate validation and draft creation', () => {
  it('rejects incomplete generated state', async () => {
    expect(() => collaborativeStateRebuildCandidateSchema.parse({ characters: [] })).toThrow()
    await expect(
      createCollaborativeStateRebuildDraft(
        { ...scope, entries: [entry('target', 3, 'narration')], currentState: current() },
        async () => ({ characters: [] }),
      ),
    ).rejects.toThrow()
  })

  it('passes only the filtered request to the injected generator', async () => {
    const generate = vi.fn(async (_request: CollaborativeStateRebuildRequest) => candidate())
    const draft = await createCollaborativeStateRebuildDraft(
      {
        ...scope,
        entries: [entry('target', 3, 'narration'), entry('future', 4, 'narration')],
        currentState: current(),
      },
      generate,
      () => 42,
    )
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]![0].history.map((item) => item.id)).toEqual(['target'])
    expect(draft.createdAt).toBe(42)
  })
})

describe('pure entity diff', () => {
  it('classifies creates, updates, deletes, and ambiguous names', () => {
    const state = current([
      character('update', 'Mira', 'old'),
      character('delete', 'Gone'),
      character('same-a', 'Echo'),
      character('same-b', ' echo '),
    ])
    const result = diffCollaborativeState(
      state,
      candidate({
        characters: [
          candidateCharacter('update', 'Mira', 'new'),
          candidateCharacter(null, 'New'),
          candidateCharacter(null, 'ECHO'),
        ],
      }),
    )

    expect(result.create).toEqual([
      expect.objectContaining({
        kind: 'character',
        candidate: expect.objectContaining({ name: 'New' }),
      }),
    ])
    expect(result.update.map((item) => item.targetId)).toEqual(['update'])
    expect(result.delete.map((item) => item.targetId)).toEqual(['delete'])
    expect(result.uncertain).toEqual([
      expect.objectContaining({
        reason: 'ambiguous_name',
        possibleTargetIds: ['same-a', 'same-b'],
      }),
    ])
  })

  it('does not mutate current state or candidate input', () => {
    const state = current([character('existing', 'Mira', 'old')])
    const proposed = candidate({ characters: [candidateCharacter('existing', 'Mira', 'new')] })
    const stateBefore = JSON.stringify(state)
    const candidateBefore = JSON.stringify(proposed)

    diffCollaborativeState(state, proposed)

    expect(JSON.stringify(state)).toBe(stateBefore)
    expect(JSON.stringify(proposed)).toBe(candidateBefore)
  })
})
