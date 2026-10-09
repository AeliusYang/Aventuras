import { describe, expect, it } from 'vitest'
import {
  collaborativeBranchTruncationStatements,
  collaborativeStateRollbackStatements,
  collaborativeSuffixCleanupStatements,
  type ValidatedWorldStateReverseOperation,
} from './collaborativeTransactions'

function operation(label: string): ValidatedWorldStateReverseOperation {
  return {
    previousState: {
      characters: [
        {
          id: `character-${label}`,
          name: `Character ${label}`,
          status: 'inactive',
          relationship: null,
          traits: ['careful'],
          visualDescriptors: { eyes: 'grey' },
          metadata: { z: 1, a: label },
        },
      ],
      locations: [
        {
          id: `location-${label}`,
          name: `Location ${label}`,
          visited: true,
          current: false,
          description: null,
          metadata: { weather: 'rain' },
        },
      ],
      items: [
        {
          id: `item-${label}`,
          name: `Item ${label}`,
          quantity: 2,
          equipped: false,
          location: 'inventory',
          metadata: null,
        },
      ],
      storyBeats: [
        {
          id: `beat-${label}`,
          title: `Beat ${label}`,
          status: 'active',
          description: null,
          resolvedAt: null,
          metadata: { thread: label },
        },
      ],
      currentLocationId: `location-${label}`,
      timeTracker: { years: 1, days: 2, hours: 3, minutes: 4 },
    },
    createdEntities: {
      characterIds: [`created-character-${label}`],
      locationIds: [`created-location-${label}`],
      itemIds: [`created-item-${label}`],
      storyBeatIds: [`created-beat-${label}`],
    },
  }
}

describe('collaborativeBranchTruncationStatements', () => {
  it('guards every entity mutation with story and exact named branch scope', () => {
    const statements = collaborativeBranchTruncationStatements({
      storyId: 'story-1',
      branchId: 'branch-1',
      fromPosition: 8,
      reverseOperations: [operation('newest')],
      updatedAt: 1000,
    })
    const entityStatements = statements.filter((statement) =>
      /(?:characters|locations|items|story_beats)/.test(statement.sql),
    )

    for (const statement of entityStatements) {
      expect(statement.sql).toContain('story_id = ?')
      expect(statement.sql).toContain('branch_id IS ?')
      expect(statement.params).toContain('story-1')
      expect(statement.params).toContain('branch-1')
    }
    expect(statements.every(({ sql }) => !sql.includes(`'branch-1'`))).toBe(true)
  })

  it('uses the same nullable guard for the main branch', () => {
    const statements = collaborativeBranchTruncationStatements({
      storyId: 'story-main',
      branchId: null,
      fromPosition: 4,
      reverseOperations: [operation('main')],
      updatedAt: 2000,
    })

    expect(statements.some(({ sql }) => sql.includes('branch_id IS ?'))).toBe(true)
    expect(statements.some(({ sql }) => sql.includes('branch_id = ?'))).toBe(false)
    expect(
      statements
        .filter(({ sql }) => /branch_id IS \?/.test(sql))
        .every(({ params }) => params.includes(null)),
    ).toBe(true)
    expect(statements.at(-1)).toEqual({
      sql: 'UPDATE stories SET updated_at = ? WHERE id = ? AND current_branch_id IS ?',
      params: [2000, 'story-main', null],
    })
  })

  it('reverses newest first and restores full captured fields with stable metadata JSON', () => {
    const statements = collaborativeBranchTruncationStatements({
      storyId: 'story-1',
      branchId: 'branch-1',
      fromPosition: 8,
      reverseOperations: [operation('newest'), operation('earliest')],
      updatedAt: 1000,
    })
    const characterRestores = statements.filter(({ sql }) => sql.startsWith('UPDATE characters'))
    const firstDelete = statements.findIndex(({ sql }) => sql.startsWith('DELETE FROM characters'))
    const firstRestore = statements.findIndex(({ sql }) => sql.startsWith('UPDATE characters'))

    expect(firstDelete).toBeLessThan(firstRestore)
    expect(characterRestores.map(({ params }) => params[6])).toEqual([
      'character-newest',
      'character-earliest',
    ])
    expect(characterRestores[0].sql).toContain(
      'name = ?, status = ?, relationship = ?, traits = ?, visual_descriptors = ?, metadata = ?',
    )
    expect(characterRestores[0].params[5]).toBe('{"a":"newest","z":1}')

    const positionRestore = statements.find(
      ({ sql }) =>
        sql === 'UPDATE locations SET current = 1 WHERE id = ? AND story_id = ? AND branch_id IS ?',
    )
    const timeRestore = statements.find(({ sql }) => sql.includes('SET time_tracker = ?'))
    expect(positionRestore?.params[0]).toBe('location-earliest')
    expect(timeRestore?.params[0]).toBe('{"days":2,"hours":3,"minutes":4,"years":1}')
  })

  it('clears current location and story time when the earliest state contains nulls', () => {
    const reverse = operation('null')
    reverse.previousState.currentLocationId = null
    reverse.previousState.timeTracker = null
    const statements = collaborativeBranchTruncationStatements({
      storyId: 'story-1',
      branchId: 'branch-1',
      fromPosition: 2,
      reverseOperations: [reverse],
      updatedAt: 3000,
    })

    expect(statements).toContainEqual({
      sql: 'UPDATE locations SET current = 0 WHERE story_id = ? AND branch_id IS ?',
      params: ['story-1', 'branch-1'],
    })
    expect(statements.some(({ sql }) => sql.includes('SET current = 1'))).toBe(false)
    expect(statements.find(({ sql }) => sql.includes('SET time_tracker = ?'))?.params).toEqual([
      null,
      'story-1',
      'branch-1',
    ])
  })

  it('deletes every dependent suffix table before entries and touches the story last', () => {
    const statements = collaborativeBranchTruncationStatements({
      storyId: 'story-1',
      branchId: 'branch-1',
      fromPosition: 12,
      reverseOperations: [],
      updatedAt: 4000,
    })
    const tables = statements
      .filter(({ sql }) => sql.startsWith('DELETE FROM'))
      .map(({ sql }) => /^DELETE FROM (\w+)/.exec(sql)?.[1])

    expect(tables).toEqual([
      'chapters',
      'checkpoints',
      'world_state_snapshots',
      'embedded_images',
      'story_entries',
    ])
    expect(statements.at(-1)?.sql).toContain('UPDATE stories SET updated_at')
  })
})

describe('collaborativeStateRollbackStatements', () => {
  it('builds rollback-only statements without deleting story entries', () => {
    const statements = collaborativeStateRollbackStatements({
      scope: { storyId: 'story-1', branchId: null },
      plan: {
        entries: [],
        operations: [
          { action: 'delete', entity: 'character', id: 'created', entryId: 'e', position: 1 },
          {
            action: 'restore',
            entity: 'location',
            id: 'loc',
            entryId: 'e',
            position: 1,
            before: {
              id: 'loc', name: 'Room', visited: false, current: true, description: null, metadata: null,
            },
          },
        ],
        targetCurrentLocationId: 'loc',
        targetTimeTracker: { years: 0, days: 1, hours: 2, minutes: 3 },
      },
    })
    expect(statements.some((statement) => statement.sql.startsWith('DELETE FROM characters'))).toBe(true)
    expect(statements.some((statement) => statement.sql.startsWith('UPDATE locations SET name'))).toBe(true)
    expect(statements.some((statement) => statement.sql.includes('story_entries'))).toBe(false)
    expect(statements.some((statement) => statement.sql.includes('time_tracker'))).toBe(true)
  })
})

describe('collaborativeSuffixCleanupStatements', () => {
  it('derives checkpoint and image cleanup from exact scoped suffix entries', () => {
    const statements = collaborativeSuffixCleanupStatements(
      { storyId: 'story-1', branchId: null },
      9,
    )
    const checkpoints = statements[1]
    const images = statements[3]

    for (const statement of [checkpoints, images]) {
      expect(statement.sql).toContain(
        'SELECT id FROM story_entries WHERE story_id = ? AND branch_id IS ? AND position >= ?',
      )
      expect(statement.params).toEqual(['story-1', 'story-1', null, 9])
    }
    expect(statements[0].params).toEqual(['story-1', null, 'story-1', null, 9, 'story-1', null, 9])
  })
})
