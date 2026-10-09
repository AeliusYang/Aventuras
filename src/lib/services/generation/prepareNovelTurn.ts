import type { GenerationContext, RetrievalResult } from './types'
import type { NovelRetry, NovelTurn } from '$lib/types/collaborative'
import {
  collaborativePatternFreshness,
  collaborativeRecentPassages,
  collaborativeUserContext,
  historyKey,
  resolveCollaborativeLength,
  setNovelFallbackContext,
} from './collaborative'
import { settings } from '$lib/stores/settings.svelte'
import { errorMessage } from '$lib/utils/error'
import { buildTimelineFillBlock } from '$lib/services/ai/retrieval/timelineFillContext'
import { joinPromptBlocks } from '$lib/utils/promptBlocks'

export interface NovelPreparation {
  context: GenerationContext
  retrieval: RetrievalResult
  retry?: NovelRetry
  rawInput?: string
}

export interface NovelPreparationDependencies {
  plan?: (input: unknown) => Promise<string>
  scene: (
    input: unknown,
    onDiagnostic?: (diagnostic: Record<string, unknown>) => void,
    onChunk?: (chunk: string) => void,
  ) => Promise<string>
}

export type NovelPreparationProgress =
  | 'interpreting'
  | 'long_planning'
  | 'reviewing_patterns'
  | 'requesting'
  | 'received'
  | 'fallback'
  | 'directing'
export type NovelProgressCallback = (progress: NovelPreparationProgress) => void
export type NovelDirectorChunkCallback = (chunk: string) => void

export async function prepareNovelTurn(
  input: NovelPreparation,
  deps: NovelPreparationDependencies,
  onProgress?: NovelProgressCallback,
  onDirectorChunk?: NovelDirectorChunkCallback,
): Promise<NovelTurn> {
  const { context: ctx, retrieval } = input
  const workflow = ctx.story.settings?.collaborativeNovelWorkflow ?? {}
  const rawInput = input.rawInput ?? ctx.userAction.rawInput
  if (!rawInput.trim()) throw new Error('中文写作缺少用户原始输入，已停止生成。')
  const check = () => ctx.abortSignal?.throwIfAborted()
  check()
  if (workflow.sceneDirector?.enabled === false)
    throw new Error('中文写作必须启用本轮导演，不能绕过导演直接生成正文。')

  onProgress?.('interpreting')
  const retry =
    input.retry &&
    (!input.retry.storyId || input.retry.storyId === ctx.story.id) &&
    (input.retry.branchId === undefined ||
      input.retry.branchId === (ctx.story.currentBranchId ?? null))
      ? input.retry
      : undefined
  const historyEntries = ctx.allEntries.filter(
    (entry) => !retry?.sourceEntryId || entry.id !== retry.sourceEntryId,
  )
  const narrations = historyEntries.filter(
    (entry) => entry.type === 'narration' && entry.content.trim(),
  )
  const currentHistoryKey = historyKey(historyEntries)
  const userContext = collaborativeUserContext(historyEntries, ctx.userAction.entryId, !retry)
  const requestedLength = resolveCollaborativeLength(rawInput, workflow.targetLength, ctx.story.settings?.targetLength)
  const planState = ctx.story.settings?.collaborativeNovelPlan
  const patternState = ctx.story.settings?.collaborativeNovelPattern
  const confirmedPlan =
    workflow.narrativePlanner?.enabled === false ? null : (planState?.confirmed ?? null)
  const confirmedPatternGuidance =
    workflow.patternReviewer?.enabled === false ? null : (patternState?.confirmed ?? null)
  const patternFreshness = collaborativePatternFreshness(
    patternState,
    currentHistoryKey,
    narrations.length,
  )
  const { chapters, storyBeats, ...remainingWorldState } = ctx.worldState
  const injectedBeatIds = new Set(
    (retrieval.worldStateBlock ? retrieval.worldStateRetrievalResult?.all : undefined)
      ?.filter((entity) => entity.type === 'storyBeat')
      .map((entity) => entity.id) ?? [],
  )
  const additionalBeats = storyBeats.filter((beat) => !injectedBeatIds.has(beat.id))
  const timelineBlock = buildTimelineFillBlock(retrieval.timelineFillResult)
  const retrievedMemory = joinPromptBlocks(
    retrieval.combinedContext,
    timelineBlock && !retrieval.combinedContext?.includes(timelineBlock) ? timelineBlock : null,
  )
  const directorInput = {
    rawInput,
    requestedLength,
    ...userContext,
    ...(narrations.length
      ? {
          recent: collaborativeRecentPassages(historyEntries).map(
            (entry) =>
              `【正文 ${entry.passage} · entryId=${entry.entryId}${entry.userInputEntryId ? ` · 对应历史用户输入=${entry.userInputEntryId}` : ''}】\n${entry.text}`,
          ),
        }
      : {}),
    worldState: retrieval.worldStateBlock ?? JSON.stringify(remainingWorldState),
    ...(retrievedMemory ? { retrievedMemory } : {}),
    ...(chapters.length
      ? {
          chapters: chapters
            .slice(-12)
            .map((chapter) => ({ title: chapter.title, summary: chapter.summary })),
        }
      : {}),
    ...(additionalBeats.length
      ? {
          storyBeats: additionalBeats.map((beat) => ({
            title: beat.title,
            description: beat.description,
            status: beat.status,
          })),
        }
      : {}),
    ...(confirmedPlan ? { confirmedPlan } : {}),
    ...(confirmedPatternGuidance ? { confirmedPatternGuidance, patternFreshness } : {}),
    ...(retry
      ? {
          reroll: {
            rejectedProse: retry.sourceText,
          },
        }
      : {}),
  }

  check()
  onProgress?.('requesting')
  onProgress?.('directing')
  let sceneDirectorOutput: string | null = null
  let directorFallback = false
  let reason: NonNullable<NovelTurn['directorDiagnostics']>['reason']
  let directorErrorMessage: string | undefined
  let partialResponse = ''
  const streamDiagnostic: NonNullable<NovelTurn['directorDiagnostics']> = {
    directorFallback: false,
    requestStarted: false,
    streamOpened: false,
    firstChunkReceived: false,
    streamCompleted: false,
    responseLength: 0,
    stage: 'scene_director',
  }
  const startedAt = Date.now()
  try {
    sceneDirectorOutput = await deps.scene(
      directorInput,
      (diagnostic) => {
        Object.assign(streamDiagnostic, diagnostic)
      },
      (chunk) => {
        partialResponse += chunk
        onDirectorChunk?.(chunk)
      },
    )
    onProgress?.('received')
  } catch (error) {
    check()
    directorFallback = true
    reason = classifyDirectorFailure(error)
    directorErrorMessage = redactDirectorError(errorMessage(error))
    onProgress?.('fallback')
  }

  check()
  const turn: NovelTurn = {
    version: 2,
    historyKey: currentHistoryKey,
    rawInput,
    sceneDirectorOutput,
    confirmedPlan,
    confirmedPatternGuidance,
    reroll: retry
      ? {
          rejectedProse: retry.sourceText,
          rejectedDirectorOutput: retry.rejectedDirectorOutput ?? null,
        }
      : undefined,
    requestedLength,
    directorDiagnostics: {
      ...streamDiagnostic,
      directorFallback,
      ...(reason ? { reason } : {}),
      ...(directorErrorMessage ? { errorMessage: directorErrorMessage } : {}),
      ...(directorFallback && partialResponse ? { partialResponse } : {}),
      rawResponseAvailable: sceneDirectorOutput !== null,
      responseLength: sceneDirectorOutput?.length ?? partialResponse.length,
      stage: 'scene_director',
      elapsedMs: Date.now() - startedAt,
    },
  }
  if (directorFallback) setNovelFallbackContext(turn, userContext)
  return turn
}

function redactDirectorError(message: string): string {
  let redacted = message.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  for (const profile of settings.apiSettings.profiles) {
    if (profile.apiKey) redacted = redacted.split(profile.apiKey).join('[REDACTED]')
  }
  return redacted
}

function classifyDirectorFailure(
  error: unknown,
): NonNullable<NovelTurn['directorDiagnostics']>['reason'] {
  const value = error as { statusCode?: number; name?: string; message?: string }
  const text = `${value?.name ?? ''} ${value?.message ?? ''}`.toLowerCase()
  if (value?.statusCode === 429 || text.includes('429') || text.includes('rate limit'))
    return 'rate_limit'
  if (value?.name === 'TimeoutError' || text.includes('timeout') || text.includes('abort'))
    return 'timeout'
  if (value?.name === 'TypeError' || text.includes('network')) return 'network'
  return 'invalid_response'
}
