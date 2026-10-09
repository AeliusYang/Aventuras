import { describe, expect, it } from 'vitest'
import type { StoryEntry, WorldStateDelta } from '$lib/types'
import {
  inspectStateMaintenanceEntry,
  isLegacyWorldStateDelta,
  listStateMaintenanceGaps,
  planStateRollback,
  validateCollaborativeStateMaintenanceV2,
  validateWorldStateDeltaV2,
  type CollaborativeStateMaintenanceV2,
} from './collaborativeStateMaintenance'

function delta(overrides: Partial<WorldStateDelta> = {}): WorldStateDelta {
  return {
    classificationResult: {},
    version: 2,
    previousState: {
      characters: [],
      locations: [],
      items: [],
      storyBeats: [],
      currentLocationId: null,
      timeTracker: null,
    },
    createdEntities: {
      characterIds: [],
      locationIds: [],
      itemIds: [],
      storyBeatIds: [],
    },
    ...overrides,
  }
}

function entry(
  id: string,
  position: number,
  options: {
    type?: StoryEntry['type']
    maintenance?: unknown
    legacyDelta?: WorldStateDelta | null
  } = {},
): StoryEntry {
  const maintenanceWithDelta = options.maintenance as
    (CollaborativeStateMaintenanceV2 & { __delta?: WorldStateDelta | null }) | undefined
  const metadataMaintenance = maintenanceWithDelta
    ? (({ __delta: _delta, ...record }) => record)(maintenanceWithDelta)
    : options.maintenance
  return {
    id,
    storyId: 'story',
    type: options.type ?? 'narration',
    content: id,
    parentId: null,
    position,
    createdAt: position,
    branchId: null,
    metadata:
      options.maintenance === undefined
        ? null
        : ({ collaborativeStateMaintenance: metadataMaintenance } as StoryEntry['metadata']),
    worldStateDelta: options.legacyDelta ?? maintenanceWithDelta?.__delta,
  }
}

function maintenance(
  status: CollaborativeStateMaintenanceV2['status'],
  stateDelta: WorldStateDelta | null = null,
): CollaborativeStateMaintenanceV2 & { __delta?: WorldStateDelta | null } {
  return {
    version: 2,
    status,
    deltaVersion: status === 'applied' ? 2 : null,
    completedAt: 123,
    ...(status === 'applied' ? { __delta: stateDelta } : {}),
    ...(status === 'failed' ? { error: 'classification failed' } : {}),
  }
}

describe('legacy world state delta validation', () => {
  it('accepts a complete delta and tolerates unknown fields', () => {
    expect(isLegacyWorldStateDelta({ ...delta(), futureField: true })).toBe(true)
  })

  it('accepts legacy rollback data without the audit-only classification result', () => {
    const { previousState, createdEntities } = delta()
    const legacy = { previousState, createdEntities }
    expect(isLegacyWorldStateDelta(legacy)).toBe(true)
    expect(validateWorldStateDeltaV2(legacy).valid).toBe(false)
  })

  it.each([
    null,
    {},
    { ...delta(), previousState: { ...delta().previousState, timeTracker: { hours: 1 } } },
    { ...delta(), createdEntities: { ...delta().createdEntities, itemIds: [42] } },
  ])('rejects malformed legacy value %#', (value) => {
    expect(isLegacyWorldStateDelta(value)).toBe(false)
  })

  it('validates all before-state structures conservatively', () => {
    const value = delta({
      previousState: {
        ...delta().previousState,
        characters: [
          {
            id: 'c1',
            name: 'Mira',
            status: 'active',
            relationship: null,
            traits: [],
            visualDescriptors: {},
          },
        ],
      },
    })
    expect(isLegacyWorldStateDelta(value)).toBe(true)
    value.previousState.characters[0].traits = [1 as unknown as string]
    expect(isLegacyWorldStateDelta(value)).toBe(false)
  })
})

describe('current world state delta v2 validation', () => {
  it('requires the current audit payload and rollback body', () => {
    expect(validateWorldStateDeltaV2(delta())).toEqual({ valid: true, value: delta(), issues: [] })
    expect(validateWorldStateDeltaV2({ ...delta(), classificationResult: [] }).valid).toBe(false)
    expect(validateWorldStateDeltaV2(null).valid).toBe(false)
  })
})

describe('v2 state maintenance validation', () => {
  it.each(['no_changes', 'disabled'] as const)('accepts %s with no delta', (status) => {
    expect(validateCollaborativeStateMaintenanceV2(maintenance(status))).toEqual({
      valid: true,
      value: maintenance(status),
      issues: [],
    })
  })

  it('accepts applied with a valid delta and failed with an error', () => {
    expect(validateCollaborativeStateMaintenanceV2(maintenance('applied', delta())).valid).toBe(
      true,
    )
    expect(validateCollaborativeStateMaintenanceV2(maintenance('failed')).valid).toBe(true)
  })

  it.each([
    [
      { version: 1, status: 'no_changes', deltaVersion: null, completedAt: 1 },
      'unsupported_version',
    ],
    [{ version: 2, status: 'unknown', deltaVersion: null, completedAt: 1 }, 'invalid_status'],
    [
      { version: 2, status: 'applied', deltaVersion: null, completedAt: 1 },
      'status_delta_mismatch',
    ],
    [{ version: 2, status: 'disabled', deltaVersion: 2, completedAt: 1 }, 'status_delta_mismatch'],
    [{ version: 2, status: 'failed', deltaVersion: null, completedAt: 1 }, 'missing_error'],
    [
      { version: 2, status: 'no_changes', deltaVersion: null, completedAt: 1, error: 'wrong' },
      'unexpected_error',
    ],
  ])('rejects invalid record %#', (value, code) => {
    const result = validateCollaborativeStateMaintenanceV2(value)
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain(code)
  })
})

describe('entry integrity and gaps', () => {
  it('distinguishes v2, legacy, missing, and irrelevant entries', () => {
    expect(
      inspectStateMaintenanceEntry(entry('v2', 1, { maintenance: maintenance('no_changes') })).kind,
    ).toBe('v2')
    const legacy = inspectStateMaintenanceEntry(entry('legacy', 2, { legacyDelta: delta() }))
    expect(legacy.kind).toBe('legacy')
    expect(legacy.valid).toBe(true)
    expect(legacy.issues[0].code).toBe('legacy_delta')
    expect(inspectStateMaintenanceEntry(entry('missing', 3)).kind).toBe('missing')
    expect(inspectStateMaintenanceEntry(entry('action', 4, { type: 'user_action' })).kind).toBe(
      'not_applicable',
    )
  })

  it('lists only missing and invalid narration entries in position order', () => {
    const gaps = listStateMaintenanceGaps([
      entry('invalid', 4, {
        maintenance: { version: 2, status: 'applied', deltaVersion: 2, completedAt: 1 },
      }),
      entry('action', 2, { type: 'user_action' }),
      entry('valid', 3, { maintenance: maintenance('disabled') }),
      entry('missing', 1),
      entry('legacy', 5, { legacyDelta: delta() }),
    ])
    expect(gaps.map(({ entryId, kind }) => [entryId, kind])).toEqual([
      ['missing', 'missing'],
      ['invalid', 'invalid'],
    ])
  })
})

describe('pure rollback planning', () => {
  it('reverse-folds deltas and takes target state from the earliest applied delta', () => {
    const early = delta({
      previousState: {
        ...delta().previousState,
        characters: [
          {
            id: 'existing',
            name: 'Mira',
            status: 'active',
            relationship: null,
            traits: [],
            visualDescriptors: {},
          },
        ],
        currentLocationId: 'old-location',
        timeTracker: { years: 1, days: 2, hours: 3, minutes: 4 },
      },
      createdEntities: { ...delta().createdEntities, characterIds: ['created-early'] },
    })
    const late = delta({
      previousState: {
        ...delta().previousState,
        locations: [
          {
            id: 'location',
            name: 'Room',
            visited: false,
            current: false,
            description: null,
          },
        ],
        currentLocationId: 'middle-location',
        timeTracker: { years: 1, days: 2, hours: 4, minutes: 0 },
      },
      createdEntities: { ...delta().createdEntities, itemIds: ['created-late'] },
    })
    const entries = [
      entry('early', 2, { maintenance: maintenance('applied', early) }),
      entry('late', 4, { maintenance: maintenance('applied', late) }),
      entry('noop', 3, { maintenance: maintenance('no_changes') }),
      entry('before-range', 1, { maintenance: maintenance('applied', delta()) }),
      entry('action', 5, { type: 'user_action' }),
    ]
    const result = planStateRollback(entries, 2)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.entries.map((item) => item.id)).toEqual(['action', 'late', 'noop', 'early'])
    expect(result.plan.operations.map(({ action, entity, id }) => [action, entity, id])).toEqual([
      ['delete', 'item', 'created-late'],
      ['restore', 'location', 'location'],
      ['delete', 'character', 'created-early'],
      ['restore', 'character', 'existing'],
    ])
    expect(result.plan.targetTimeTracker).toEqual({ years: 1, days: 2, hours: 3, minutes: 4 })
    expect(result.plan.targetCurrentLocationId).toBe('old-location')
    expect(entries.map((item) => item.id)).toEqual([
      'early',
      'late',
      'noop',
      'before-range',
      'action',
    ])
  })

  it('supports valid legacy deltas in rollback plans', () => {
    const result = planStateRollback(
      [
        entry('legacy', 1, {
          legacyDelta: delta({
            createdEntities: { ...delta().createdEntities, locationIds: ['legacy-location'] },
          }),
        }),
      ],
      1,
    )
    expect(result.valid).toBe(true)
    if (result.valid)
      expect(result.plan.operations[0]).toMatchObject({ action: 'delete', id: 'legacy-location' })
  })

  it('returns undefined targets when no applied delta exists', () => {
    const result = planStateRollback(
      [entry('disabled', 1, { maintenance: maintenance('disabled') })],
      1,
    )
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.targetTimeTracker).toBeUndefined()
    expect(result.plan.targetCurrentLocationId).toBeUndefined()
    expect(result.plan.operations).toEqual([])
  })

  it.each([
    [
      'duplicate_created_entity',
      delta({ createdEntities: { ...delta().createdEntities, itemIds: ['i'] } }),
      delta({ createdEntities: { ...delta().createdEntities, itemIds: ['i'] } }),
    ],
    [
      'restored_after_created',
      delta({ createdEntities: { ...delta().createdEntities, itemIds: ['i'] } }),
      delta({
        previousState: {
          ...delta().previousState,
          items: [{ id: 'i', name: 'I', quantity: 1, equipped: false, location: 'room' }],
        },
      }),
    ],
  ])('rejects %s histories', (code, newer, older) => {
    const result = planStateRollback(
      [
        entry('older', 1, { maintenance: maintenance('applied', older) }),
        entry('newer', 2, { maintenance: maintenance('applied', newer) }),
      ],
      1,
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain(code)
  })

  it('allows repeated updates followed by the entity creation in reverse order', () => {
    const before = (quantity: number) => ({
      id: 'i',
      name: 'I',
      quantity,
      equipped: false,
      location: 'room',
    })
    const result = planStateRollback(
      [
        entry('created', 1, {
          maintenance: maintenance(
            'applied',
            delta({ createdEntities: { ...delta().createdEntities, itemIds: ['i'] } }),
          ),
        }),
        entry('updated-once', 2, {
          maintenance: maintenance(
            'applied',
            delta({ previousState: { ...delta().previousState, items: [before(1)] } }),
          ),
        }),
        entry('updated-twice', 3, {
          maintenance: maintenance(
            'applied',
            delta({ previousState: { ...delta().previousState, items: [before(2)] } }),
          ),
        }),
      ],
      1,
    )
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.operations.map(({ action }) => action)).toEqual([
      'restore',
      'restore',
      'delete',
    ])
  })

  it('rejects duplicate restore IDs within one delta', () => {
    const before = { id: 'i', name: 'I', quantity: 1, equipped: false, location: 'room' }
    const result = planStateRollback(
      [
        entry('bad', 1, {
          maintenance: maintenance(
            'applied',
            delta({ previousState: { ...delta().previousState, items: [before, { ...before }] } }),
          ),
        }),
      ],
      1,
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate_restored_entity')
  })

  it('rejects create and restore of one entity in the same delta', () => {
    const inconsistent = delta({
      previousState: {
        ...delta().previousState,
        items: [{ id: 'i', name: 'I', quantity: 1, equipped: false, location: 'room' }],
      },
      createdEntities: { ...delta().createdEntities, itemIds: ['i'] },
    })
    const result = planStateRollback(
      [entry('bad', 1, { maintenance: maintenance('applied', inconsistent) })],
      1,
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain('created_and_restored_in_same_delta')
  })

  it('rejects duplicate positions and malformed narration maintenance before planning', () => {
    const result = planStateRollback(
      [
        entry('one', 1, { maintenance: maintenance('no_changes') }),
        entry('two', 1, {
          maintenance: { version: 2, status: 'applied', deltaVersion: 2, completedAt: 1 },
        }),
      ],
      1,
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['duplicate_entry_position', 'invalid_delta']),
    )
  })
})
