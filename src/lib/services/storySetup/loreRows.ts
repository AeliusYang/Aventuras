import type { Entry } from '$lib/types'

export const loreColumns = [
  'id',
  'story_id',
  'name',
  'type',
  'description',
  'hidden_info',
  'aliases',
  'state',
  'adventure_state',
  'creative_state',
  'injection',
  'created_by',
  'created_at',
  'updated_at',
  'lore_management_blacklisted',
  'branch_id',
  'overrides_id',
  'deleted',
] as const

export function loreValues(entry: Entry): unknown[] {
  return [
    entry.id,
    entry.storyId,
    entry.name,
    entry.type,
    entry.description,
    entry.hiddenInfo,
    JSON.stringify(entry.aliases),
    JSON.stringify(entry.state),
    entry.adventureState ? JSON.stringify(entry.adventureState) : null,
    entry.creativeState ? JSON.stringify(entry.creativeState) : null,
    JSON.stringify(entry.injection),
    entry.createdBy,
    entry.createdAt,
    entry.updatedAt,
    entry.loreManagementBlacklisted ? 1 : 0,
    entry.branchId || null,
    entry.overridesId || null,
    entry.deleted ? 1 : 0,
  ]
}

/** Conservative bind limit also works with older SQLite builds. */
export function loreInsertStatements(entries: Entry[], bindLimit = 900) {
  const batchSize = Math.max(1, Math.floor(bindLimit / loreColumns.length))
  const tuple = `(${loreColumns.map(() => '?').join(',')})`
  const statements: { sql: string; params: unknown[] }[] = []
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    statements.push({
      sql: `INSERT INTO entries (${loreColumns.join(',')}) VALUES ${batch.map(() => tuple).join(',')}`,
      params: batch.flatMap(loreValues),
    })
  }
  return statements
}
