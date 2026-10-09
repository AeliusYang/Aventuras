import type {
  CharacterBeforeState,
  ItemBeforeState,
  LocationBeforeState,
  StoryBeatBeforeState,
  StoryEntry,
  TimeTracker,
  WorldStateDelta,
} from '$lib/types'

export const COLLABORATIVE_STATE_MAINTENANCE_VERSION = 2 as const

export type CollaborativeStateMaintenanceStatus = 'applied' | 'no_changes' | 'disabled' | 'failed'

export interface CollaborativeStateMaintenanceV2 {
  version: typeof COLLABORATIVE_STATE_MAINTENANCE_VERSION
  status: CollaborativeStateMaintenanceStatus
  deltaVersion: 2 | null
  completedAt: number
  error?: string
  warning?: string
}

export function createStateMaintenanceRecord(
  status: CollaborativeStateMaintenanceStatus,
  options: { completedAt?: number; error?: string; warning?: string } = {},
): CollaborativeStateMaintenanceV2 {
  return {
    version: COLLABORATIVE_STATE_MAINTENANCE_VERSION,
    status,
    deltaVersion: status === 'applied' ? 2 : null,
    completedAt: options.completedAt ?? Date.now(),
    ...(options.error ? { error: options.error } : {}),
    ...(options.warning ? { warning: options.warning } : {}),
  }
}

export type StateMaintenanceIssueCode =
  | 'invalid_record'
  | 'unsupported_version'
  | 'invalid_status'
  | 'invalid_delta'
  | 'status_delta_mismatch'
  | 'missing_error'
  | 'unexpected_error'
  | 'missing_maintenance'
  | 'legacy_delta'
  | 'duplicate_entry_position'
  | 'duplicate_created_entity'
  | 'duplicate_restored_entity'
  | 'created_and_restored_in_same_delta'
  | 'restored_after_created'

export interface StateMaintenanceIssue {
  code: StateMaintenanceIssueCode
  message: string
  entryId?: string
  position?: number
  path?: string
}

export type StateMaintenanceValidation<T> =
  { valid: true; value: T; issues: [] } | { valid: false; issues: StateMaintenanceIssue[] }

export type EntryStateMaintenanceIntegrity =
  | {
      kind: 'v2'
      entry: StoryEntry
      maintenance: CollaborativeStateMaintenanceV2
      valid: boolean
      issues: StateMaintenanceIssue[]
    }
  | {
      kind: 'legacy'
      entry: StoryEntry
      delta: WorldStateDelta
      valid: boolean
      issues: StateMaintenanceIssue[]
    }
  | {
      kind: 'missing'
      entry: StoryEntry
      valid: boolean
      issues: StateMaintenanceIssue[]
    }
  | {
      kind: 'not_applicable'
      entry: StoryEntry
      valid: true
      issues: []
    }

export interface StateMaintenanceGap {
  entryId: string
  position: number
  kind: 'missing' | 'invalid'
  issues: StateMaintenanceIssue[]
}

export type RollbackEntityKind = 'character' | 'location' | 'item' | 'storyBeat'

export type StateRollbackOperation =
  | {
      action: 'delete'
      entity: RollbackEntityKind
      id: string
      entryId: string
      position: number
    }
  | {
      action: 'restore'
      entity: 'character'
      id: string
      before: CharacterBeforeState
      entryId: string
      position: number
    }
  | {
      action: 'restore'
      entity: 'location'
      id: string
      before: LocationBeforeState
      entryId: string
      position: number
    }
  | {
      action: 'restore'
      entity: 'item'
      id: string
      before: ItemBeforeState
      entryId: string
      position: number
    }
  | {
      action: 'restore'
      entity: 'storyBeat'
      id: string
      before: StoryBeatBeforeState
      entryId: string
      position: number
    }

export interface StateRollbackPlan {
  entries: StoryEntry[]
  operations: StateRollbackOperation[]
  targetTimeTracker: TimeTracker | null | undefined
  targetCurrentLocationId: string | null | undefined
}

export type StateRollbackPlanResult =
  | { valid: true; plan: StateRollbackPlan; issues: [] }
  | { valid: false; issues: StateMaintenanceIssue[] }

type UnknownRecord = Record<string, unknown>

export type WorldStateDeltaValidation = StateMaintenanceValidation<WorldStateDelta>

const statuses = new Set<CollaborativeStateMaintenanceStatus>([
  'applied',
  'no_changes',
  'disabled',
  'failed',
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isMetadata(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value)
}

function isTimeTracker(value: unknown): value is TimeTracker | null {
  return (
    value === null ||
    (isRecord(value) &&
      ['years', 'days', 'hours', 'minutes'].every(
        (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
      ))
  )
}

function validCharacter(value: unknown): value is CharacterBeforeState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    isNullableString(value.relationship) &&
    isStringArray(value.traits) &&
    isRecord(value.visualDescriptors) &&
    isMetadata(value.metadata)
  )
}

function validLocation(value: unknown): value is LocationBeforeState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.visited === 'boolean' &&
    typeof value.current === 'boolean' &&
    isNullableString(value.description) &&
    isMetadata(value.metadata)
  )
}

function validItem(value: unknown): value is ItemBeforeState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.quantity === 'number' &&
    Number.isFinite(value.quantity) &&
    typeof value.equipped === 'boolean' &&
    typeof value.location === 'string' &&
    isMetadata(value.metadata)
  )
}

function validStoryBeat(value: unknown): value is StoryBeatBeforeState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    isNullableString(value.description) &&
    (value.resolvedAt === null ||
      (typeof value.resolvedAt === 'number' && Number.isFinite(value.resolvedAt))) &&
    isMetadata(value.metadata)
  )
}

function hasDeltaBody(value: unknown): value is UnknownRecord & {
  previousState: UnknownRecord
  createdEntities: UnknownRecord
} {
  if (!isRecord(value)) return false
  if (!isRecord(value.previousState) || !isRecord(value.createdEntities)) return false

  const previous = value.previousState
  const created = value.createdEntities
  return (
    Array.isArray(previous.characters) &&
    previous.characters.every(validCharacter) &&
    Array.isArray(previous.locations) &&
    previous.locations.every(validLocation) &&
    Array.isArray(previous.items) &&
    previous.items.every(validItem) &&
    Array.isArray(previous.storyBeats) &&
    previous.storyBeats.every(validStoryBeat) &&
    isNullableString(previous.currentLocationId) &&
    isTimeTracker(previous.timeTracker) &&
    isStringArray(created.characterIds) &&
    isStringArray(created.locationIds) &&
    isStringArray(created.itemIds) &&
    isStringArray(created.storyBeatIds)
  )
}

/** Strict validation for the current WorldStateDelta shape stored by new maintenance records. */
export function validateWorldStateDeltaV2(value: unknown): WorldStateDeltaValidation {
  const valid =
    isRecord(value) &&
    value.version === 2 &&
    isRecord(value.classificationResult) &&
    hasDeltaBody(value)
  return valid
    ? { valid: true, value: value as unknown as WorldStateDelta, issues: [] }
    : {
        valid: false,
        issues: [
          {
            code: 'invalid_delta',
            message: 'World state delta does not match the current v2 structure.',
          },
        ],
      }
}

/**
 * Conservative validation for unversioned persisted deltas. Older rows may omit the audit-only
 * classification result, but must contain every field needed to reverse state safely.
 */
export function isLegacyWorldStateDelta(value: unknown): value is WorldStateDelta {
  return hasDeltaBody(value)
}

export function validateCollaborativeStateMaintenanceV2(
  value: unknown,
): StateMaintenanceValidation<CollaborativeStateMaintenanceV2> {
  const issues: StateMaintenanceIssue[] = []
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ code: 'invalid_record', message: 'State maintenance record must be an object.' }],
    }
  }
  if (value.version !== COLLABORATIVE_STATE_MAINTENANCE_VERSION) {
    issues.push({
      code: 'unsupported_version',
      message: `Expected state maintenance version ${COLLABORATIVE_STATE_MAINTENANCE_VERSION}.`,
      path: 'version',
    })
  }
  if (
    typeof value.status !== 'string' ||
    !statuses.has(value.status as CollaborativeStateMaintenanceStatus)
  ) {
    issues.push({
      code: 'invalid_status',
      message: 'Unknown state maintenance status.',
      path: 'status',
    })
  }

  const status = value.status as CollaborativeStateMaintenanceStatus
  if (status === 'applied' && value.deltaVersion !== 2) {
    issues.push({
      code: 'status_delta_mismatch',
      message: 'Applied state maintenance requires delta version 2.',
      path: 'deltaVersion',
    })
  } else if (statuses.has(status) && status !== 'applied' && value.deltaVersion !== null) {
    issues.push({
      code: 'status_delta_mismatch',
      message: `${status} state maintenance must not reference a delta.`,
      path: 'deltaVersion',
    })
  }
  if (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt)) {
    issues.push({
      code: 'invalid_record',
      message: 'State maintenance requires a finite completion timestamp.',
      path: 'completedAt',
    })
  }

  if (status === 'failed') {
    if (typeof value.error !== 'string' || value.error.trim() === '') {
      issues.push({
        code: 'missing_error',
        message: 'Failed state maintenance requires a non-empty error.',
        path: 'error',
      })
    }
  } else if (statuses.has(status) && value.error !== undefined) {
    issues.push({
      code: 'unexpected_error',
      message: 'Only failed state maintenance may include an error.',
      path: 'error',
    })
  }
  if (value.warning !== undefined && (typeof value.warning !== 'string' || !value.warning.trim())) {
    issues.push({
      code: 'invalid_record',
      message: 'State maintenance warning must be a non-empty string.',
      path: 'warning',
    })
  }

  return issues.length === 0
    ? { valid: true, value: value as unknown as CollaborativeStateMaintenanceV2, issues: [] }
    : { valid: false, issues }
}

function maintenanceCandidate(entry: StoryEntry): unknown {
  return (entry.metadata as UnknownRecord | null)?.collaborativeStateMaintenance
}

function atEntry(issue: StateMaintenanceIssue, entry: StoryEntry): StateMaintenanceIssue {
  return { ...issue, entryId: entry.id, position: entry.position }
}

export function inspectStateMaintenanceEntry(entry: StoryEntry): EntryStateMaintenanceIntegrity {
  if (entry.type !== 'narration') {
    return { kind: 'not_applicable', entry, valid: true, issues: [] }
  }

  const candidate = maintenanceCandidate(entry)
  if (candidate !== undefined) {
    const validation = validateCollaborativeStateMaintenanceV2(candidate)
    if (validation.valid && validation.value.status === 'applied') {
      const delta = validateWorldStateDeltaV2(entry.worldStateDelta)
      if (!delta.valid) {
        return {
          kind: 'v2',
          entry,
          maintenance: validation.value,
          valid: false,
          issues: delta.issues.map((issue) => atEntry(issue, entry)),
        }
      }
    }
    return validation.valid
      ? { kind: 'v2', entry, maintenance: validation.value, valid: true, issues: [] }
      : {
          kind: 'v2',
          entry,
          maintenance: candidate as CollaborativeStateMaintenanceV2,
          valid: false,
          issues: validation.issues.map((issue) => atEntry(issue, entry)),
        }
  }

  if (entry.worldStateDelta != null) {
    const valid = isLegacyWorldStateDelta(entry.worldStateDelta)
    return {
      kind: 'legacy',
      entry,
      delta: entry.worldStateDelta,
      valid,
      issues: valid
        ? [
            {
              code: 'legacy_delta',
              message: 'Narration uses an unversioned legacy world state delta.',
              entryId: entry.id,
              position: entry.position,
            },
          ]
        : [
            {
              code: 'invalid_delta',
              message: 'Legacy world state delta is structurally invalid.',
              entryId: entry.id,
              position: entry.position,
              path: 'worldStateDelta',
            },
          ],
    }
  }

  return {
    kind: 'missing',
    entry,
    valid: false,
    issues: [
      {
        code: 'missing_maintenance',
        message: 'Narration has no state maintenance result.',
        entryId: entry.id,
        position: entry.position,
      },
    ],
  }
}

export function listStateMaintenanceGaps(entries: readonly StoryEntry[]): StateMaintenanceGap[] {
  return entries
    .filter((entry) => entry.type === 'narration')
    .map(inspectStateMaintenanceEntry)
    .filter((result) => result.kind === 'missing' || !result.valid)
    .map((result) => ({
      entryId: result.entry.id,
      position: result.entry.position,
      kind: (result.kind === 'missing' ? 'missing' : 'invalid') as StateMaintenanceGap['kind'],
      issues: result.issues,
    }))
    .sort((a, b) => a.position - b.position || a.entryId.localeCompare(b.entryId))
}

function deltaForRollback(
  inspection: EntryStateMaintenanceIntegrity,
): WorldStateDelta | null | undefined {
  if (!inspection.valid) return undefined
  if (inspection.kind === 'legacy') return inspection.delta
  if (inspection.kind === 'v2')
    return inspection.maintenance.status === 'applied' ? inspection.entry.worldStateDelta : null
  return null
}

function entityKey(entity: RollbackEntityKind, id: string): string {
  return `${entity}:${id}`
}

/**
 * Builds a database-neutral rollback plan. It never mutates entries, deltas, or entity snapshots.
 */
export function planStateRollback(
  entries: readonly StoryEntry[],
  fromPosition: number,
): StateRollbackPlanResult {
  const selected = entries
    .filter((entry) => entry.position >= fromPosition)
    .slice()
    .sort(
      (a, b) => b.position - a.position || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
  const issues: StateMaintenanceIssue[] = []
  const positions = new Map<number, StoryEntry>()

  for (const entry of selected) {
    const duplicate = positions.get(entry.position)
    if (duplicate) {
      issues.push({
        code: 'duplicate_entry_position',
        message: `Entries ${duplicate.id} and ${entry.id} share rollback position ${entry.position}.`,
        entryId: entry.id,
        position: entry.position,
      })
    } else {
      positions.set(entry.position, entry)
    }
  }

  const inspected = selected.map(inspectStateMaintenanceEntry)
  for (const inspection of inspected) {
    if (!inspection.valid) issues.push(...inspection.issues)
  }
  if (issues.length > 0) return { valid: false, issues }

  const operations: StateRollbackOperation[] = []
  const createdAt = new Map<string, StoryEntry>()
  let targetTimeTracker: TimeTracker | null | undefined
  let targetCurrentLocationId: string | null | undefined

  const pushDelete = (entity: RollbackEntityKind, id: string, entry: StoryEntry): void => {
    const key = entityKey(entity, id)
    const duplicate = createdAt.get(key)
    if (duplicate) {
      issues.push({
        code: 'duplicate_created_entity',
        message: `${entity} ${id} is recorded as created by entries ${duplicate.id} and ${entry.id}.`,
        entryId: entry.id,
        position: entry.position,
      })
      return
    }
    createdAt.set(key, entry)
    operations.push({ action: 'delete', entity, id, entryId: entry.id, position: entry.position })
  }

  const pushRestore = <
    T extends CharacterBeforeState | LocationBeforeState | ItemBeforeState | StoryBeatBeforeState,
  >(
    entity: RollbackEntityKind,
    before: T,
    entry: StoryEntry,
    restoredInEntry: Set<string>,
  ): void => {
    const key = entityKey(entity, before.id)
    if (restoredInEntry.has(key)) {
      issues.push({
        code: 'duplicate_restored_entity',
        message: `${entity} ${before.id} is restored more than once by entry ${entry.id}.`,
        entryId: entry.id,
        position: entry.position,
      })
      return
    }
    const creator = createdAt.get(key)
    if (creator === entry) {
      issues.push({
        code: 'created_and_restored_in_same_delta',
        message: `${entity} ${before.id} is both created and restored by entry ${entry.id}.`,
        entryId: entry.id,
        position: entry.position,
      })
      return
    }
    if (creator) {
      issues.push({
        code: 'restored_after_created',
        message: `${entity} ${before.id} is restored by entry ${entry.id}, before its creation by ${creator.id}.`,
        entryId: entry.id,
        position: entry.position,
      })
      return
    }
    restoredInEntry.add(key)
    operations.push({
      action: 'restore',
      entity,
      id: before.id,
      before,
      entryId: entry.id,
      position: entry.position,
    } as StateRollbackOperation)
  }

  for (let index = 0; index < selected.length; index++) {
    const entry = selected[index]
    const delta = deltaForRollback(inspected[index])
    if (!delta) continue
    const restoredInEntry = new Set<string>()

    delta.createdEntities.characterIds.forEach((id) => pushDelete('character', id, entry))
    delta.createdEntities.locationIds.forEach((id) => pushDelete('location', id, entry))
    delta.createdEntities.itemIds.forEach((id) => pushDelete('item', id, entry))
    delta.createdEntities.storyBeatIds.forEach((id) => pushDelete('storyBeat', id, entry))
    delta.previousState.characters.forEach((before) =>
      pushRestore('character', before, entry, restoredInEntry),
    )
    delta.previousState.locations.forEach((before) =>
      pushRestore('location', before, entry, restoredInEntry),
    )
    delta.previousState.items.forEach((before) =>
      pushRestore('item', before, entry, restoredInEntry),
    )
    delta.previousState.storyBeats.forEach((before) =>
      pushRestore('storyBeat', before, entry, restoredInEntry),
    )

    targetTimeTracker = delta.previousState.timeTracker
    targetCurrentLocationId = delta.previousState.currentLocationId
  }

  return issues.length > 0
    ? { valid: false, issues }
    : {
        valid: true,
        plan: { entries: selected, operations, targetTimeTracker, targetCurrentLocationId },
        issues: [],
      }
}
