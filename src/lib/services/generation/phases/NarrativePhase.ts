/**
 * NarrativePhase - Handles streaming narrative generation
 *
 * Responsibilities:
 * - Coordinate streaming narrative generation via AIService
 * - Yield narrative chunks as they arrive
 * - Handle abort signals properly
 * - Retry on empty responses (up to 3 attempts)
 */

import type { NovelTurn } from '$lib/types/collaborative'
import type {
  GenerationEvent,
  PhaseStartEvent,
  PhaseCompleteEvent,
  NarrativeChunkEvent,
  AbortedEvent,
  ErrorEvent,
  WorldState,
  RetrievalResult,
} from '../types'
import type { Story, StoryEntry } from '$lib/types'
import type { StyleReviewResult } from '$lib/services/ai/generation/StyleReviewerService'
import type { StreamChunk } from '$lib/services/ai/core/types'
import { recordNovelOutput } from '../collaborative'
import { asError } from '$lib/utils/error'
import { createRequestDeadline } from '$lib/utils/requestDeadline'
import { LLM_TIMEOUT_DEFAULT } from '$lib/constants/timeout'
import { settings } from '$lib/stores/settings.svelte'

const MAX_EMPTY_RESPONSE_RETRIES = 3

/** Dependencies for narrative phase - injected to avoid tight coupling */
export interface NarrativeDependencies {
  streamNarrative: (
    entries: StoryEntry[],
    worldState: WorldState,
    story: Story | null | undefined,
    styleReview: StyleReviewResult | null | undefined,
    retrievedContext: string | null | undefined,
    signal: AbortSignal | undefined,
    timelineFillResult: RetrievalResult['timelineFillResult'],
    worldStateBlock: string | null | undefined,
    novelTurn?: NovelTurn,
  ) => AsyncIterable<StreamChunk>
}

/** Input for the narrative phase */
export interface NarrativeInput {
  novelTurn?: NovelTurn
  visibleEntries: StoryEntry[]
  worldState: WorldState
  story: Story | null | undefined
  retrievalResult: RetrievalResult
  styleReview: StyleReviewResult | null | undefined
  abortSignal?: AbortSignal
}

/** Result from narrative phase */
export interface NarrativeResult {
  content: string
  reasoning: string
  chunkCount: number
  actualChineseCharacters?: number
  outputTruncated?: boolean
  requestedLength?: string
  shortStopReason?: string
  finishReason?: string
  outputMetricsWarning?: string
}

/**
 * NarrativePhase service
 * Streams narrative generation, yielding chunks as they arrive.
 * Handles automatic retry on empty responses (up to 3 attempts).
 */
export class NarrativePhase {
  constructor(private deps: NarrativeDependencies) {}

  /** Execute the narrative phase - yields chunk events and phase events */
  async *execute(input: NarrativeInput): AsyncGenerator<GenerationEvent, NarrativeResult | null> {
    if (!input.novelTurn) return yield* this.executeNarrative(input)
    const preset = settings.getPresetConfig(
      settings.getServicePresetId('collaborativeWriter'),
      'collaborativeWriter',
    )
    const budget = createRequestDeadline(
      preset?.timeoutMs ?? LLM_TIMEOUT_DEFAULT,
      input.abortSignal,
      'collaborative:writer',
    )
    const iterator = this.executeNarrative({ ...input, abortSignal: budget.signal })
    try {
      while (true) {
        const next = await budget.wait(iterator.next())
        if (next.done) return next.value
        yield next.value
      }
    } catch (error) {
      if (input.abortSignal?.aborted) {
        yield { type: 'aborted', phase: 'narrative' } satisfies AbortedEvent
      } else {
        yield {
          type: 'error',
          phase: 'narrative',
          fatal: true,
          error: asError(error, 'Writer 生成失败。'),
        } satisfies ErrorEvent
      }
      return null
    } finally {
      budget.dispose()
      void iterator.return(null).catch(() => {})
    }
  }

  private async *executeNarrative(
    input: NarrativeInput,
  ): AsyncGenerator<GenerationEvent, NarrativeResult | null> {
    yield { type: 'phase_start', phase: 'narrative' } satisfies PhaseStartEvent

    const { visibleEntries, worldState, story, retrievalResult, styleReview, abortSignal } = input

    let fullResponse = ''
    let fullReasoning = ''
    let chunkCount = 0
    let retryCount = 0
    let finishReason: string | undefined

    while (retryCount < MAX_EMPTY_RESPONSE_RETRIES) {
      if (abortSignal?.aborted) {
        yield { type: 'aborted', phase: 'narrative' } satisfies AbortedEvent
        return null
      }

      fullResponse = ''
      fullReasoning = ''
      chunkCount = 0
      finishReason = undefined

      try {
        for await (const chunk of this.deps.streamNarrative(
          visibleEntries,
          worldState,
          story,
          styleReview,
          retrievalResult.combinedContext,
          abortSignal,
          retrievalResult.timelineFillResult,
          retrievalResult.worldStateBlock,
          ...(input.novelTurn ? [input.novelTurn] : []),
        )) {
          if (abortSignal?.aborted) {
            yield { type: 'aborted', phase: 'narrative' } satisfies AbortedEvent
            return null
          }

          chunkCount++
          if (chunk.finishReason !== undefined) finishReason = chunk.finishReason

          // Accumulate content and reasoning
          if (chunk.content) {
            fullResponse += chunk.content
          }
          if (chunk.reasoning) {
            fullReasoning += chunk.reasoning
          }

          // Yield chunk if there's any content or reasoning to display
          if (chunk.content || chunk.reasoning) {
            yield {
              type: 'narrative_chunk',
              content: chunk.content || '',
              reasoning: chunk.reasoning,
            } satisfies NarrativeChunkEvent
          }

          if (chunk.done) {
            break
          }
        }

        if (fullResponse.trim()) {
          break // Success
        }
        if (input.novelTurn && finishReason === 'length') {
          throw new Error('Writer 输出额度已耗尽，但未返回正文；已停止相同参数的自动重试。')
        }
        retryCount++
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          yield { type: 'aborted', phase: 'narrative' } satisfies AbortedEvent
          return null
        }
        yield {
          type: 'error',
          phase: 'narrative',
          error: asError(error, 'Writer 返回了无法识别的错误。'),
          fatal: true,
        } satisfies ErrorEvent
        return null
      }
    }

    if (abortSignal?.aborted) {
      yield { type: 'aborted', phase: 'narrative' } satisfies AbortedEvent
      return null
    }

    if (!fullResponse.trim()) {
      yield {
        type: 'error',
        phase: 'narrative',
        error: new Error(`Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} attempts`),
        fatal: true,
      } satisfies ErrorEvent
      return null
    }

    const result: NarrativeResult = {
      content: fullResponse,
      reasoning: fullReasoning,
      chunkCount,
      ...(finishReason !== undefined ? { finishReason } : {}),
    }
    if (input.novelTurn) {
      try {
        Object.assign(result, recordNovelOutput(input.novelTurn, fullResponse, finishReason))
      } catch (error) {
        // Diagnostic bookkeeping must not prevent completed prose from being saved.
        const fallback = {
          requestedLength: input.novelTurn.requestedLength,
          actualChineseCharacters: (fullResponse.match(/\p{Script=Han}/gu) ?? []).length,
          outputTruncated:
            finishReason === 'length' ? true : finishReason === 'stop' ? false : undefined,
          shortStopReason:
            finishReason === 'length'
              ? '模型因输出 Token 上限停止，正文可能被截断；未自动扩写。'
              : undefined,
          outputMetricsWarning: `篇幅统计失败，正文已保留：${asError(error, '未知统计错误').message}`,
        }
        Object.assign(result, fallback)
        Object.assign(input.novelTurn, fallback, { finishReason })
      }
    }

    yield {
      type: 'phase_complete',
      phase: 'narrative',
      result,
    } satisfies PhaseCompleteEvent

    return result
  }
}
