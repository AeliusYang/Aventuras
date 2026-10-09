/**
 * ClassificationPhase - Handles world state extraction from narrative
 *
 * Responsibilities:
 * - Call classifier service to extract world state changes
 * - Coordinate entity updates (characters, locations, items, story beats)
 * - Yield classification events
 */

import type {
  GenerationEvent,
  PhaseStartEvent,
  PhaseCompleteEvent,
  AbortedEvent,
  ErrorEvent,
  ClassificationCompleteEvent,
  WorldState,
} from '../types'
import { asError } from '$lib/utils/error'
import type { Story, StoryEntry, TimeTracker } from '$lib/types'
import type { ClassificationResult } from '$lib/services/ai/sdk/schemas/classifier'

/** Dependencies for classification phase - injected to avoid tight coupling */
export interface ClassificationDependencies {
  classifyResponse: (
    narrativeResponse: string,
    userAction: string,
    worldState: WorldState,
    story: Story | null | undefined,
    chatHistoryEntries: StoryEntry[],
    timeTracker: TimeTracker | null | undefined,
  ) => Promise<ClassificationResult>
}

/** Input for the classification phase */
export interface ClassificationInput {
  narrativeContent: string
  narrativeEntryId: string
  userActionContent: string
  worldState: WorldState
  story: Story | null | undefined
  visibleEntries: StoryEntry[]
  abortSignal?: AbortSignal
}

/** Result from classification phase */
export interface ClassificationPhaseResult {
  classificationResult: ClassificationResult
  narrativeEntryId: string
}

/**
 * ClassificationPhase service
 * Extracts world state changes from narrative using AI classifier.
 */
export class ClassificationPhase {
  constructor(private deps: ClassificationDependencies) {}

  /** Execute the classification phase - yields events and returns result */
  async *execute(
    input: ClassificationInput,
  ): AsyncGenerator<GenerationEvent, ClassificationPhaseResult | null> {
    yield { type: 'phase_start', phase: 'classification' } satisfies PhaseStartEvent

    const {
      narrativeContent,
      narrativeEntryId,
      userActionContent,
      worldState,
      story,
      visibleEntries,
      abortSignal,
    } = input

    if (abortSignal?.aborted) {
      yield { type: 'aborted', phase: 'classification' } satisfies AbortedEvent
      return null
    }

    try {
      // Filter out the current narration entry to avoid sending it twice
      // (once in chatHistory, once as narrativeResponse)
      const chatHistoryEntries = visibleEntries.filter(
        (e) =>
          e.id !== narrativeEntryId &&
          (story?.mode !== 'creative-writing' || e.type === 'narration'),
      )

      const classificationResult = await this.deps.classifyResponse(
        narrativeContent,
        story?.mode === 'creative-writing'
          ? '只从已生成正文提取实际发生的事实。作者意图、未来规划和被否决版本不是事实。'
          : userActionContent,
        worldState,
        story,
        chatHistoryEntries,
        story?.timeTracker,
      )

      if (abortSignal?.aborted) {
        yield { type: 'aborted', phase: 'classification' } satisfies AbortedEvent
        return null
      }

      // Emit classification complete event
      yield {
        type: 'classification_complete',
        result: classificationResult,
      } satisfies ClassificationCompleteEvent

      const result: ClassificationPhaseResult = {
        classificationResult,
        narrativeEntryId,
      }

      yield {
        type: 'phase_complete',
        phase: 'classification',
        result,
      } satisfies PhaseCompleteEvent

      return result
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        yield { type: 'aborted', phase: 'classification' } satisfies AbortedEvent
        return null
      }

      // Classification errors are non-fatal - world state just won't be updated
      yield {
        type: 'error',
        phase: 'classification',
        error: asError(error, '事实提取返回了无法识别的错误。'),
        fatal: false,
      } satisfies ErrorEvent

      return null
    }
  }
}
