import type { StoryEntry } from '$lib/types'
import type { CollaborativeWriterRecovery } from '$lib/types/collaborative'
import type { GenerationContext } from './types'

export const WRITER_RECOVERY_SOURCE = 'collaborative-writer-recovery'

// A sorted content representation avoids false invalidations from timestamps or key order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(
        ([key]) =>
          !['createdAt', 'updatedAt', 'tokenCount', 'writerRecovery', 'writerRecoveryId'].includes(
            key,
          ),
      )
      .map(([key, child]) => [key, canonical(child)]),
  )
}

export async function recoveryFingerprint(
  ctx: GenerationContext,
  binding: { packId: string | null; variables: Record<string, string> | null },
): Promise<string> {
  const settings = ctx.story.settings
  const content = JSON.stringify(
    canonical({
      storyId: ctx.story.id,
      branchId: ctx.story.currentBranchId ?? null,
      mode: ctx.story.mode,
      description: ctx.story.description,
      genre: ctx.story.genre,
      settings: {
        pov: settings?.pov,
        tense: settings?.tense,
        tone: settings?.tone,
        themes: settings?.themes,
        targetLength: settings?.targetLength,
        referenceMode: settings?.referenceMode,
        visualProseMode: settings?.visualProseMode,
        workflow: settings?.collaborativeNovelWorkflow,
        plan: settings?.collaborativeNovelPlan?.confirmed,
        pattern: settings?.collaborativeNovelPattern?.confirmed,
      },
      time: ctx.story.timeTracker ?? { years: 0, days: 0, hours: 0, minutes: 0 },
      binding,
      userAction: ctx.userAction,
      history: ctx.allEntries
        .filter((e) => e.type === 'user_action' || e.type === 'narration')
        .map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          branchId: e.branchId,
          variantId: e.metadata?.variantSet?.activeVariantId,
        })),
      worldState: ctx.worldState,
    }),
  )
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function recoveryWasSaved(
  record: CollaborativeWriterRecovery,
  entry: StoryEntry | null,
): boolean {
  if (!entry || entry.type !== 'narration') return false
  if (entry.metadata?.writerRecoveryId === record.id) return true
  return !!entry.metadata?.variantSet?.variants.some(
    (v) => v.metadata?.writerRecoveryId === record.id,
  )
}

export function recoveryScopeMatches(
  record: CollaborativeWriterRecovery,
  ctx: GenerationContext,
): boolean {
  return (
    record.version === 1 &&
    ctx.story.mode === 'creative-writing' &&
    record.storyId === ctx.story.id &&
    record.branchId === (ctx.story.currentBranchId ?? null) &&
    record.userActionEntryId === ctx.userAction.entryId &&
    record.novelTurn.rawInput === ctx.userAction.rawInput &&
    !!record.novelTurn.sceneDirectorOutput?.trim() &&
    !record.novelTurn.directorDiagnostics?.directorFallback
  )
}
