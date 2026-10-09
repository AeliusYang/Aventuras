import type {
  CharacterBeforeState,
  ItemBeforeState,
  LocationBeforeState,
  StoryBeatBeforeState,
  TimeTracker,
  WorldStateDelta,
} from '$lib/types'
import type { StateRollbackOperation, StateRollbackPlan } from './collaborativeStateMaintenance'

/** A statement accepted by `database.transaction`. */
export interface CollaborativeTransactionStatement {
  sql: string
  params: unknown[]
  expectedRows?: number
}

export interface CollaborativeBranchScope {
  storyId: string
  branchId: string | null
}

/**
 * Deltas must be validated before reaching this module and ordered newest first. Metadata is
 * required after validation because omitting it cannot faithfully restore an entity.
 */
export interface ValidatedWorldStateReverseOperation {
  previousState: {
    characters: Array<CharacterBeforeState & { metadata: Record<string, unknown> | null }>
    locations: Array<LocationBeforeState & { metadata: Record<string, unknown> | null }>
    items: Array<ItemBeforeState & { metadata: Record<string, unknown> | null }>
    storyBeats: Array<StoryBeatBeforeState & { metadata: Record<string, unknown> | null }>
    currentLocationId: string | null
    timeTracker: TimeTracker | null
  }
  createdEntities: WorldStateDelta['createdEntities']
}

export interface CollaborativeBranchTruncationInput extends CollaborativeBranchScope {
  /** Inclusive first position removed from this branch. */
  fromPosition: number
  /** Validated reverse operations in newest-to-oldest order. */
  reverseOperations: readonly ValidatedWorldStateReverseOperation[]
  updatedAt: number
}

function stableJson(value: unknown): string {
  const seen = new Set<object>()

  const normalize = (candidate: unknown): unknown => {
    if (candidate === undefined) return null
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('Cannot bind non-finite JSON number')
      return candidate
    }
    if (Array.isArray(candidate)) return candidate.map(normalize)
    if (typeof candidate !== 'object') {
      throw new Error(`Cannot serialize ${String(candidate)} in transaction JSON`)
    }
    if (seen.has(candidate)) throw new Error('Cannot serialize circular transaction JSON')

    seen.add(candidate)
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
      const value = (candidate as Record<string, unknown>)[key]
      // SQLite JSON columns follow JSON.stringify semantics: undefined object
      // properties are omitted rather than being valid JSON values. Runtime
      // state can contain optional fields from older entries, so do that
      // normalization here instead of aborting an otherwise safe rollback.
      if (value === undefined) continue
      normalized[key] = normalize(value)
    }
    seen.delete(candidate)
    return normalized
  }

  return JSON.stringify(normalize(value))
}

function scopeParams(scope: CollaborativeBranchScope): [string, string | null] {
  return [scope.storyId, scope.branchId]
}

function deleteCreatedStatement(
  table: 'characters' | 'locations' | 'items' | 'story_beats',
  id: string,
  scope: CollaborativeBranchScope,
): CollaborativeTransactionStatement {
  return {
    sql: `DELETE FROM ${table} WHERE id = ? AND story_id = ? AND branch_id IS ?`,
    params: [id, ...scopeParams(scope)],
    expectedRows: 1,
  }
}

export function restoreCharacterStatement(
  scope: CollaborativeBranchScope,
  state: ValidatedWorldStateReverseOperation['previousState']['characters'][number],
): CollaborativeTransactionStatement {
  return {
    sql: 'UPDATE characters SET name = ?, status = ?, relationship = ?, traits = ?, visual_descriptors = ?, metadata = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
    params: [
      state.name,
      state.status,
      state.relationship,
      stableJson(state.traits),
      stableJson(state.visualDescriptors),
      state.metadata === null ? null : stableJson(state.metadata),
      state.id,
      ...scopeParams(scope),
    ],
    expectedRows: 1,
  }
}

export function restoreLocationStatement(
  scope: CollaborativeBranchScope,
  state: ValidatedWorldStateReverseOperation['previousState']['locations'][number],
): CollaborativeTransactionStatement {
  return {
    sql: 'UPDATE locations SET name = ?, visited = ?, current = ?, description = ?, metadata = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
    params: [
      state.name,
      state.visited ? 1 : 0,
      state.current ? 1 : 0,
      state.description,
      state.metadata === null ? null : stableJson(state.metadata),
      state.id,
      ...scopeParams(scope),
    ],
    expectedRows: 1,
  }
}

export function restoreItemStatement(
  scope: CollaborativeBranchScope,
  state: ValidatedWorldStateReverseOperation['previousState']['items'][number],
): CollaborativeTransactionStatement {
  return {
    sql: 'UPDATE items SET name = ?, quantity = ?, equipped = ?, location = ?, metadata = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
    params: [
      state.name,
      state.quantity,
      state.equipped ? 1 : 0,
      state.location,
      state.metadata === null ? null : stableJson(state.metadata),
      state.id,
      ...scopeParams(scope),
    ],
    expectedRows: 1,
  }
}

export function restoreStoryBeatStatement(
  scope: CollaborativeBranchScope,
  state: ValidatedWorldStateReverseOperation['previousState']['storyBeats'][number],
): CollaborativeTransactionStatement {
  return {
    sql: 'UPDATE story_beats SET title = ?, status = ?, description = ?, resolved_at = ?, metadata = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
    params: [
      state.title,
      state.status,
      state.description,
      state.resolvedAt,
      state.metadata === null ? null : stableJson(state.metadata),
      state.id,
      ...scopeParams(scope),
    ],
    expectedRows: 1,
  }
}

/** Build one delta's inverse. Calling order is significant and is left unchanged. */
export function collaborativeReverseOperationStatements(
  scope: CollaborativeBranchScope,
  operation: ValidatedWorldStateReverseOperation,
): CollaborativeTransactionStatement[] {
  const statements: CollaborativeTransactionStatement[] = []

  for (const id of operation.createdEntities.characterIds) {
    statements.push(deleteCreatedStatement('characters', id, scope))
  }
  for (const id of operation.createdEntities.locationIds) {
    statements.push(deleteCreatedStatement('locations', id, scope))
  }
  for (const id of operation.createdEntities.itemIds) {
    statements.push(deleteCreatedStatement('items', id, scope))
  }
  for (const id of operation.createdEntities.storyBeatIds) {
    statements.push(deleteCreatedStatement('story_beats', id, scope))
  }
  for (const state of operation.previousState.characters) {
    statements.push(restoreCharacterStatement(scope, state))
  }
  for (const state of operation.previousState.locations) {
    statements.push(restoreLocationStatement(scope, state))
  }
  for (const state of operation.previousState.items) {
    statements.push(restoreItemStatement(scope, state))
  }
  for (const state of operation.previousState.storyBeats) {
    statements.push(restoreStoryBeatStatement(scope, state))
  }

  return statements
}

export function restoreBranchPositionStatements(
  scope: CollaborativeBranchScope,
  currentLocationId: string | null,
  timeTracker: TimeTracker | null,
): CollaborativeTransactionStatement[] {
  const statements: CollaborativeTransactionStatement[] = [
    {
      sql: 'UPDATE locations SET current = 0 WHERE story_id = ? AND branch_id IS ?',
      params: scopeParams(scope),
    },
  ]

  if (currentLocationId !== null) {
    statements.push({
      sql: 'UPDATE locations SET current = 1 WHERE id = ? AND story_id = ? AND branch_id IS ?',
      params: [currentLocationId, ...scopeParams(scope)],
    })
  }

  statements.push({
    sql: 'UPDATE stories SET time_tracker = ? WHERE id = ? AND current_branch_id IS ?',
    params: [timeTracker === null ? null : stableJson(timeTracker), ...scopeParams(scope)],
  })
  return statements
}

/** Delete every row that depends on the scoped suffix, before deleting the suffix itself. */
export function collaborativeSuffixCleanupStatements(
  scope: CollaborativeBranchScope,
  fromPosition: number,
  preservedEntryId?: string,
): CollaborativeTransactionStatement[] {
  const entryScope =
    'SELECT id FROM story_entries WHERE story_id = ? AND branch_id IS ? AND position >= ?'
  const params = (): unknown[] => [...scopeParams(scope), fromPosition]

  return [
    {
      sql: `DELETE FROM chapters WHERE story_id = ? AND branch_id IS ? AND (start_entry_id IN (${entryScope}) OR end_entry_id IN (${entryScope}))`,
      params: [...scopeParams(scope), ...params(), ...params()],
    },
    {
      sql: `DELETE FROM checkpoints WHERE story_id = ? AND last_entry_id IN (${entryScope})`,
      params: [scope.storyId, ...params()],
    },
    {
      sql: 'DELETE FROM world_state_snapshots WHERE story_id = ? AND branch_id IS ? AND entry_position >= ?',
      params: params(),
    },
    {
      sql: `DELETE FROM embedded_images WHERE story_id = ? AND entry_id IN (${entryScope})${preservedEntryId ? ' AND entry_id != ?' : ''}`,
      params: [scope.storyId, ...params(), ...(preservedEntryId ? [preservedEntryId] : [])],
    },
    {
      sql: `DELETE FROM story_entries WHERE story_id = ? AND branch_id IS ? AND position >= ?${preservedEntryId ? ' AND id != ?' : ''}`,
      params: [...params(), ...(preservedEntryId ? [preservedEntryId] : [])],
    },
  ]
}

/**
 * Build the complete ordered batch for one atomic collaborative branch truncation.
 * The earliest operation supplies the branch position that existed before the removed suffix.
 */
export function collaborativeBranchTruncationStatements(
  input: CollaborativeBranchTruncationInput,
): CollaborativeTransactionStatement[] {
  const { storyId, branchId, fromPosition, reverseOperations, updatedAt } = input
  const scope = { storyId, branchId }
  const statements = reverseOperations.flatMap((operation) =>
    collaborativeReverseOperationStatements(scope, operation),
  )
  const earliest = reverseOperations.at(-1)

  if (earliest) {
    statements.push(
      ...restoreBranchPositionStatements(
        scope,
        earliest.previousState.currentLocationId,
        earliest.previousState.timeTracker,
      ),
    )
  }

  statements.push(...collaborativeSuffixCleanupStatements(scope, fromPosition))
  statements.push({
    sql: 'UPDATE stories SET updated_at = ? WHERE id = ? AND current_branch_id IS ?',
    params: [updatedAt, storyId, branchId],
  })
  return statements
}

export const buildCollaborativeBranchTruncationStatements = collaborativeBranchTruncationStatements

function restorePlannedOperationStatement(
  scope: CollaborativeBranchScope,
  operation: Extract<StateRollbackOperation, { action: 'restore' }>,
): CollaborativeTransactionStatement {
  const metadata = operation.before.metadata
  switch (operation.entity) {
    case 'character':
      return restoreCharacterStatement(scope, {
        ...operation.before,
        metadata: metadata ?? null,
      })
    case 'location':
      return restoreLocationStatement(scope, { ...operation.before, metadata: metadata ?? null })
    case 'item':
      return restoreItemStatement(scope, { ...operation.before, metadata: metadata ?? null })
    case 'storyBeat':
      return restoreStoryBeatStatement(scope, { ...operation.before, metadata: metadata ?? null })
  }
}

/** Build the atomic truncation batch from the validated pure rollback plan. */
export function collaborativeTruncationPlanStatements(input: {
  scope: CollaborativeBranchScope
  fromPosition: number
  plan: StateRollbackPlan
  updatedAt: number
  settings?: unknown
  preservedEntryId?: string
}): CollaborativeTransactionStatement[] {
  const { scope, fromPosition, plan, updatedAt } = input
  const statements = plan.operations.map((operation) => {
    if (operation.action === 'restore') return restorePlannedOperationStatement(scope, operation)
    const table = {
      character: 'characters',
      location: 'locations',
      item: 'items',
      storyBeat: 'story_beats',
    }[operation.entity] as 'characters' | 'locations' | 'items' | 'story_beats'
    return deleteCreatedStatement(table, operation.id, scope)
  })
  if (plan.targetCurrentLocationId !== undefined && plan.targetTimeTracker !== undefined) {
    statements.push(
      ...restoreBranchPositionStatements(
        scope,
        plan.targetCurrentLocationId,
        plan.targetTimeTracker,
      ),
    )
  }
  statements.push(
    ...collaborativeSuffixCleanupStatements(scope, fromPosition, input.preservedEntryId),
  )
  statements.push({
    sql:
      input.settings === undefined
        ? 'UPDATE stories SET updated_at = ? WHERE id = ? AND current_branch_id IS ?'
        : 'UPDATE stories SET updated_at = ?, settings = ? WHERE id = ? AND current_branch_id IS ?',
    params:
      input.settings === undefined
        ? [updatedAt, scope.storyId, scope.branchId]
        : [updatedAt, stableJson(input.settings), scope.storyId, scope.branchId],
    expectedRows: 1,
  })
  return statements
}

/** Build only the world-state rollback portion of a validated plan. Unlike truncation,
 * this intentionally leaves story entries and their dependents intact for variant swipes. */
export function collaborativeStateRollbackStatements(input: {
  scope: CollaborativeBranchScope
  plan: StateRollbackPlan
}): CollaborativeTransactionStatement[] {
  const statements = input.plan.operations.map((operation) => {
    if (operation.action === 'restore')
      return restorePlannedOperationStatement(input.scope, operation)
    const table = {
      character: 'characters',
      location: 'locations',
      item: 'items',
      storyBeat: 'story_beats',
    }[operation.entity] as 'characters' | 'locations' | 'items' | 'story_beats'
    return deleteCreatedStatement(table, operation.id, input.scope)
  })
  if (
    input.plan.targetCurrentLocationId !== undefined &&
    input.plan.targetTimeTracker !== undefined
  ) {
    statements.push(
      ...restoreBranchPositionStatements(
        input.scope,
        input.plan.targetCurrentLocationId,
        input.plan.targetTimeTracker,
      ),
    )
  }
  return statements
}
