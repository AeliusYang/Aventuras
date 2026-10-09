import { z } from 'zod'
import type { Character, Item, Location, StoryBeat, StoryEntry, TimeTracker } from '$lib/types'

const nullableMetadataSchema = z.record(z.string(), z.unknown()).nullable()
const nullableIdSchema = z.string().min(1).nullable()

export const collaborativeRebuildCharacterSchema = z
  .object({
    id: nullableIdSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    relationship: z.string().nullable(),
    traits: z.array(z.string()),
    visualDescriptors: z
      .object({
        face: z.string().optional(),
        hair: z.string().optional(),
        eyes: z.string().optional(),
        build: z.string().optional(),
        clothing: z.string().optional(),
        accessories: z.string().optional(),
        distinguishing: z.string().optional(),
      })
      .strict(),
    status: z.enum(['active', 'inactive', 'deceased']),
    metadata: nullableMetadataSchema,
  })
  .strict()

export const collaborativeRebuildLocationSchema = z
  .object({
    id: nullableIdSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    visited: z.boolean(),
    current: z.boolean(),
    connections: z.array(z.string()),
    metadata: nullableMetadataSchema,
  })
  .strict()

export const collaborativeRebuildItemSchema = z
  .object({
    id: nullableIdSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    quantity: z.number().finite(),
    equipped: z.boolean(),
    location: z.string(),
    metadata: nullableMetadataSchema,
  })
  .strict()

export const collaborativeRebuildStoryBeatSchema = z
  .object({
    id: nullableIdSchema,
    title: z.string().min(1),
    description: z.string().nullable(),
    type: z.enum(['milestone', 'quest', 'revelation', 'event', 'plot_point']),
    status: z.enum(['pending', 'active', 'completed', 'failed']),
    triggeredAt: z.number().finite().nullable(),
    resolvedAt: z.number().finite().nullable(),
    metadata: nullableMetadataSchema,
  })
  .strict()

export const collaborativeRebuildStoryTimeSchema = z
  .object({
    years: z.number().finite(),
    days: z.number().finite(),
    hours: z.number().finite(),
    minutes: z.number().finite(),
  })
  .strict()
  .nullable()

export const collaborativeStateRebuildCandidateSchema = z
  .object({
    characters: z.array(collaborativeRebuildCharacterSchema),
    locations: z.array(collaborativeRebuildLocationSchema),
    items: z.array(collaborativeRebuildItemSchema),
    storyBeats: z.array(collaborativeRebuildStoryBeatSchema),
    currentLocationId: nullableIdSchema,
    storyTime: collaborativeRebuildStoryTimeSchema,
  })
  .strict()

export type CollaborativeRebuildCharacter = z.infer<typeof collaborativeRebuildCharacterSchema>
export type CollaborativeRebuildLocation = z.infer<typeof collaborativeRebuildLocationSchema>
export type CollaborativeRebuildItem = z.infer<typeof collaborativeRebuildItemSchema>
export type CollaborativeRebuildStoryBeat = z.infer<typeof collaborativeRebuildStoryBeatSchema>
export type CollaborativeStateRebuildCandidate = z.infer<
  typeof collaborativeStateRebuildCandidateSchema
>

export interface CollaborativeStateRebuildScope {
  storyId: string
  branchId: string | null
  targetEntryId: string
  targetPosition: number
}

export interface CollaborativeStateRebuildHistoryEntry {
  id: string
  type: 'user_action' | 'narration'
  content: string
  position: number
  createdAt: number
  branchId: string | null
}

export interface CollaborativeStateRebuildRequest extends CollaborativeStateRebuildScope {
  historyHash: string
  history: CollaborativeStateRebuildHistoryEntry[]
  storyInitial?: unknown
  manualLorebook?: readonly unknown[]
}

export interface CollaborativeStateRebuildCurrentState {
  characters: readonly Character[]
  locations: readonly Location[]
  items: readonly Item[]
  storyBeats: readonly StoryBeat[]
  currentLocationId: string | null
  storyTime: TimeTracker | null
}

export type CollaborativeRebuildEntityKind = 'character' | 'location' | 'item' | 'storyBeat'

export interface CollaborativeRebuildCreate {
  kind: CollaborativeRebuildEntityKind
  candidate: CollaborativeRebuildEntity
}

export interface CollaborativeRebuildUpdate {
  kind: CollaborativeRebuildEntityKind
  targetId: string
  before: CollaborativeRebuildEntity
  after: CollaborativeRebuildEntity
}

export interface CollaborativeRebuildDelete {
  kind: CollaborativeRebuildEntityKind
  targetId: string
  current: CollaborativeRebuildEntity
}

export interface CollaborativeRebuildUncertain {
  kind: CollaborativeRebuildEntityKind
  reason: 'ambiguous_name' | 'duplicate_candidate_identity' | 'unknown_identity'
  candidate: CollaborativeRebuildEntity
  possibleTargetIds: string[]
}

export type CollaborativeRebuildEntity =
  | CollaborativeRebuildCharacter
  | CollaborativeRebuildLocation
  | CollaborativeRebuildItem
  | CollaborativeRebuildStoryBeat

export interface CollaborativeStateRebuildDiff {
  create: CollaborativeRebuildCreate[]
  update: CollaborativeRebuildUpdate[]
  delete: CollaborativeRebuildDelete[]
  uncertain: CollaborativeRebuildUncertain[]
  currentLocation: { before: string | null; after: string | null } | null
  storyTime: { before: TimeTracker | null; after: TimeTracker | null } | null
}

export interface CollaborativeStateRebuildDraft extends CollaborativeStateRebuildScope {
  historyHash: string
  createdAt: number
  candidate: CollaborativeStateRebuildCandidate
  diff: CollaborativeStateRebuildDiff
}

export interface BuildCollaborativeStateRebuildRequestInput extends CollaborativeStateRebuildScope {
  entries: readonly StoryEntry[]
  storyInitial?: unknown
  manualLorebook?: readonly unknown[]
  /** Ordered branch lineage visible at the target. Defaults to main plus the selected branch. */
  visibleBranchIds?: readonly (string | null)[]
}

export interface CreateCollaborativeStateRebuildDraftInput extends BuildCollaborativeStateRebuildRequestInput {
  currentState: CollaborativeStateRebuildCurrentState
}

export type CollaborativeStateRebuildGenerator = (
  request: CollaborativeStateRebuildRequest,
) => unknown | Promise<unknown>

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

/** Browser-compatible synchronous FNV-1a hash over canonical UTF-16 input. */
export function collaborativeHistoryHash(
  history: readonly CollaborativeStateRebuildHistoryEntry[],
): string {
  let hash = 2166136261
  const portableHistory = history.map(({ type, content, position, createdAt }) => ({
    type,
    content,
    position,
    createdAt,
  }))
  for (const char of stableJson(portableHistory)) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function visibleBranches(input: BuildCollaborativeStateRebuildRequestInput): Set<string | null> {
  return new Set(input.visibleBranchIds ?? [null, input.branchId])
}

export function createCollaborativeStateRebuildRequest(
  input: BuildCollaborativeStateRebuildRequestInput,
): CollaborativeStateRebuildRequest {
  const target = input.entries.find((entry) => entry.id === input.targetEntryId)
  if (
    !target ||
    target.storyId !== input.storyId ||
    target.type !== 'narration' ||
    target.position !== input.targetPosition ||
    !visibleBranches(input).has(target.branchId)
  ) {
    throw new Error('Rebuild target must be a narration in the requested story and branch scope.')
  }

  const branches = visibleBranches(input)
  const history = input.entries
    .filter(
      (entry): entry is StoryEntry & { type: 'user_action' | 'narration' } =>
        entry.storyId === input.storyId &&
        branches.has(entry.branchId) &&
        (entry.position < input.targetPosition || entry.id === input.targetEntryId) &&
        (entry.type === 'user_action' || entry.type === 'narration'),
    )
    .sort((left, right) =>
      left.position !== right.position
        ? left.position - right.position
        : left.createdAt !== right.createdAt
          ? left.createdAt - right.createdAt
          : left.id.localeCompare(right.id),
    )
    .map(({ id, type, content, position, createdAt, branchId }) => ({
      id,
      type,
      content,
      position,
      createdAt,
      branchId,
    }))

  if (!history.some((entry) => entry.id === input.targetEntryId)) {
    throw new Error('Rebuild target is not present in the filtered history.')
  }

  return {
    storyId: input.storyId,
    branchId: input.branchId,
    targetEntryId: input.targetEntryId,
    targetPosition: input.targetPosition,
    historyHash: collaborativeHistoryHash(history),
    history,
    storyInitial: input.storyInitial,
    manualLorebook: input.manualLorebook ? structuredClone(input.manualLorebook) : undefined,
  }
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function projectCharacter(entity: Character): CollaborativeRebuildCharacter {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    relationship: entity.relationship,
    traits: [...entity.traits],
    visualDescriptors: { ...entity.visualDescriptors },
    status: entity.status,
    metadata: entity.metadata ? { ...entity.metadata } : null,
  }
}

function projectLocation(entity: Location): CollaborativeRebuildLocation {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    visited: entity.visited,
    current: entity.current,
    connections: [...entity.connections],
    metadata: entity.metadata ? { ...entity.metadata } : null,
  }
}

function projectItem(entity: Item): CollaborativeRebuildItem {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    quantity: entity.quantity,
    equipped: entity.equipped,
    location: entity.location,
    metadata: entity.metadata ? { ...entity.metadata } : null,
  }
}

function projectStoryBeat(entity: StoryBeat): CollaborativeRebuildStoryBeat {
  return {
    id: entity.id,
    title: entity.title,
    description: entity.description,
    type: entity.type,
    status: entity.status,
    triggeredAt: entity.triggeredAt,
    resolvedAt: entity.resolvedAt ?? null,
    metadata: entity.metadata ? { ...entity.metadata } : null,
  }
}

function diffEntities<T extends CollaborativeRebuildEntity>(
  kind: CollaborativeRebuildEntityKind,
  current: readonly T[],
  candidate: readonly T[],
  name: (entity: T) => string,
  diff: CollaborativeStateRebuildDiff,
): void {
  const currentById = new Map(current.map((entity) => [entity.id, entity]))
  const currentByName = new Map<string, T[]>()
  for (const entity of current) {
    const key = normalizedName(name(entity))
    currentByName.set(key, [...(currentByName.get(key) ?? []), entity])
  }

  const candidateIdCounts = new Map<string, number>()
  for (const entity of candidate) {
    if (entity.id) candidateIdCounts.set(entity.id, (candidateIdCounts.get(entity.id) ?? 0) + 1)
  }

  const matched = new Set<string>()
  const protectedIds = new Set<string>()
  for (const entity of candidate) {
    let existing: T | undefined
    if (entity.id) {
      if ((candidateIdCounts.get(entity.id) ?? 0) > 1) {
        const possible = currentById.has(entity.id) ? [entity.id] : []
        possible.forEach((id) => protectedIds.add(id))
        diff.uncertain.push({
          kind,
          reason: 'duplicate_candidate_identity',
          candidate: entity,
          possibleTargetIds: possible,
        })
        continue
      }
      existing = currentById.get(entity.id)
      if (!existing) {
        diff.uncertain.push({
          kind,
          reason: 'unknown_identity',
          candidate: entity,
          possibleTargetIds: [],
        })
        continue
      }
    } else {
      const possible = (currentByName.get(normalizedName(name(entity))) ?? []).filter(
        (item) => item.id && !matched.has(item.id),
      )
      if (possible.length > 1) {
        possible.forEach((item) => item.id && protectedIds.add(item.id))
        diff.uncertain.push({
          kind,
          reason: 'ambiguous_name',
          candidate: entity,
          possibleTargetIds: possible.flatMap((item) => (item.id ? [item.id] : [])),
        })
        continue
      }
      existing = possible[0]
      if (!existing) {
        diff.create.push({ kind, candidate: entity })
        continue
      }
    }

    if (!existing.id || matched.has(existing.id)) {
      diff.uncertain.push({
        kind,
        reason: 'duplicate_candidate_identity',
        candidate: entity,
        possibleTargetIds: existing.id ? [existing.id] : [],
      })
      if (existing.id) protectedIds.add(existing.id)
      continue
    }
    matched.add(existing.id)
    const after = { ...entity, id: existing.id } as T
    if (stableJson(existing) !== stableJson(after)) {
      diff.update.push({ kind, targetId: existing.id, before: existing, after })
    }
  }

  for (const entity of current) {
    if (entity.id && !matched.has(entity.id) && !protectedIds.has(entity.id)) {
      diff.delete.push({ kind, targetId: entity.id, current: entity })
    }
  }
}

export function diffCollaborativeState(
  current: CollaborativeStateRebuildCurrentState,
  candidateInput: CollaborativeStateRebuildCandidate,
): CollaborativeStateRebuildDiff {
  const candidate = collaborativeStateRebuildCandidateSchema.parse(candidateInput)
  const diff: CollaborativeStateRebuildDiff = {
    create: [],
    update: [],
    delete: [],
    uncertain: [],
    currentLocation:
      current.currentLocationId === candidate.currentLocationId
        ? null
        : { before: current.currentLocationId, after: candidate.currentLocationId },
    storyTime:
      stableJson(current.storyTime) === stableJson(candidate.storyTime)
        ? null
        : {
            before: current.storyTime ? { ...current.storyTime } : null,
            after: candidate.storyTime,
          },
  }

  diffEntities(
    'character',
    current.characters.map(projectCharacter),
    candidate.characters,
    (e) => e.name,
    diff,
  )
  diffEntities(
    'location',
    current.locations.map(projectLocation),
    candidate.locations,
    (e) => e.name,
    diff,
  )
  diffEntities('item', current.items.map(projectItem), candidate.items, (e) => e.name, diff)
  diffEntities(
    'storyBeat',
    current.storyBeats.map(projectStoryBeat),
    candidate.storyBeats,
    (e) => e.title,
    diff,
  )
  return diff
}

export async function createCollaborativeStateRebuildDraft(
  input: CreateCollaborativeStateRebuildDraftInput,
  generate: CollaborativeStateRebuildGenerator,
  now: () => number = Date.now,
): Promise<CollaborativeStateRebuildDraft> {
  const request = createCollaborativeStateRebuildRequest(input)
  const candidate = collaborativeStateRebuildCandidateSchema.parse(await generate(request))
  return {
    storyId: request.storyId,
    branchId: request.branchId,
    targetEntryId: request.targetEntryId,
    targetPosition: request.targetPosition,
    historyHash: request.historyHash,
    createdAt: now(),
    candidate,
    diff: diffCollaborativeState(input.currentState, candidate),
  }
}

export type CollaborativeStateRebuildConfirmation =
  | { valid: true; request: CollaborativeStateRebuildRequest }
  | { valid: false; reason: 'scope_changed' | 'history_changed' | 'target_missing' }

export function checkCollaborativeStateRebuildConfirmation(
  draft: CollaborativeStateRebuildDraft,
  input: BuildCollaborativeStateRebuildRequestInput,
): CollaborativeStateRebuildConfirmation {
  if (
    draft.storyId !== input.storyId ||
    draft.branchId !== input.branchId ||
    draft.targetEntryId !== input.targetEntryId ||
    draft.targetPosition !== input.targetPosition
  ) {
    return { valid: false, reason: 'scope_changed' }
  }
  try {
    const request = createCollaborativeStateRebuildRequest(input)
    return request.historyHash === draft.historyHash
      ? { valid: true, request }
      : { valid: false, reason: 'history_changed' }
  } catch {
    return { valid: false, reason: 'target_missing' }
  }
}

export class CollaborativeStateRebuildService {
  constructor(
    private readonly generate: CollaborativeStateRebuildGenerator,
    private readonly now: () => number = Date.now,
  ) {}

  createRequest(input: BuildCollaborativeStateRebuildRequestInput) {
    return createCollaborativeStateRebuildRequest(input)
  }

  createDraft(input: CreateCollaborativeStateRebuildDraftInput) {
    return createCollaborativeStateRebuildDraft(input, this.generate, this.now)
  }

  checkConfirmation(
    draft: CollaborativeStateRebuildDraft,
    input: BuildCollaborativeStateRebuildRequestInput,
  ) {
    return checkCollaborativeStateRebuildConfirmation(draft, input)
  }
}
