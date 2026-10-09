/**
 * PipelineEventHandler - Maps GenerationEvent pipeline events to UI callbacks.
 * Extracted from ActionInput.svelte for reusability and testability.
 */
import type { GenerationEvent } from './types'
import type { NovelTurn } from '$lib/types/collaborative'
import { errorMessage } from '$lib/utils/error'

export interface PipelineUICallbacks {
  startStreaming: (visualProseMode: boolean, streamingEntryId: string) => void
  appendStreamContent: (content: string) => void
  appendReasoningContent: (reasoning: string) => void
  startDirectorStreaming?: () => void
  appendDirectorContent?: (content: string) => void
  collapseDirectorPanel?: () => void
  setGenerationStatus: (status: string) => void
  setNovelUserSummary?: (summary: string) => void
  setNovelTurn?: (turn: NovelTurn) => void
  setSuggestionsLoading: (loading: boolean) => void
  setActionChoicesLoading: (loading: boolean) => void
  setSuggestions: (suggestions: any[], storyId?: string) => void
  setActionChoices: (choices: any[], storyId?: string) => void
  emitResponseStreaming: (chunk: string, accumulated: string) => void
  emitSuggestionsReady: (suggestions: Array<{ text: string; type: string }>) => void
}

export interface PipelineEventState {
  fullResponse: () => string
  fullReasoning: () => string
  streamingEntryId: string
  visualProseMode: boolean
  isCreativeMode: boolean
  storyId?: string
  isScopeCurrent?: () => boolean
  /** Tracks which parallel phases are currently running */
  activeParallelPhases: Set<string>
}

/** Phases that run concurrently after the narrative phase.
 *  Note: BackgroundImagePhase and ImagePhase both emit phase 'image',
 *  but are not tracked here — they run inside imagePipeline or independently. */
const PARALLEL_PHASES = new Set(['classification', 'translation', 'post'])

/** Human-readable labels shown when a single parallel phase remains.
 *  'post' is handled separately in parallelStatusMessage (creative vs adventure). */
const PHASE_LABELS: Record<string, string> = {
  classification: '正在更新故事事实',
  translation: '正在翻译',
}

/** Build the status message based on how many parallel phases are active */
function parallelStatusMessage(activePhases: Set<string>, isCreativeMode: boolean): string {
  if (activePhases.size === 0) return ''
  if (activePhases.size === 1) {
    const phase = activePhases.values().next().value!
    if (phase === 'post') {
      return isCreativeMode ? '正在生成剧情建议' : '正在生成行动选项'
    }
    return PHASE_LABELS[phase] ?? '正在处理'
  }
  return `正在处理 ${activePhases.size} 项任务`
}

export function handleEvent(
  event: GenerationEvent,
  state: PipelineEventState,
  callbacks: PipelineUICallbacks,
): void {
  if (state.isScopeCurrent?.() === false) return
  switch (event.type) {
    case 'phase_progress':
      callbacks.setGenerationStatus(
        {
          interpreting: '正在解释自然输入',
          long_planning: '正在更新长期软规划',
          reviewing_patterns: '正在读取结构规避指导',
          requesting: '正在等待导演响应（最多90秒）',
          received: '已收到导演原文',
          validating: '正在校验导演结果',
          fallback: '导演未返回原文，已记录失败原因，正文继续生成',
          directing: '正在安排本轮场景（等待导演原文）',
        }[event.progress],
      )
      break
    case 'phase_start':
      if (event.phase === 'retrieval') callbacks.setGenerationStatus('正在检索相关上下文')
      if (event.phase === 'scene_director') {
        callbacks.startDirectorStreaming?.()
        callbacks.setGenerationStatus('正在解释自然输入')
      }
      if (event.phase === 'narrative') {
        callbacks.collapseDirectorPanel?.()
        callbacks.startStreaming(state.visualProseMode, state.streamingEntryId)
        callbacks.setGenerationStatus('正在生成中文正文')
      } else if (PARALLEL_PHASES.has(event.phase)) {
        state.activeParallelPhases.add(event.phase)
        callbacks.setGenerationStatus(
          parallelStatusMessage(state.activeParallelPhases, state.isCreativeMode),
        )

        // Keep loading spinners for suggestions/actions
        if (event.phase === 'post') {
          if (state.isCreativeMode) {
            callbacks.setSuggestionsLoading(true)
          } else {
            callbacks.setActionChoicesLoading(true)
          }
        }
      }
      break

    case 'director_chunk':
      if (event.content) callbacks.appendDirectorContent?.(event.content)
      break

    case 'narrative_chunk':
      if (event.content) {
        callbacks.appendStreamContent(event.content)
        callbacks.emitResponseStreaming(event.content, state.fullResponse() + event.content)
      }
      if (event.reasoning) callbacks.appendReasoningContent(event.reasoning)
      break

    case 'phase_complete':
      if (event.phase === 'scene_director') {
        const turn = event.result as NovelTurn
        callbacks.setNovelTurn?.(turn)
        callbacks.setNovelUserSummary?.(
          turn.sceneDirectorOutput ??
            turn.directorDiagnostics?.partialResponse ??
            '本轮 Director 未返回原文。',
        )
      }
      if (PARALLEL_PHASES.has(event.phase)) {
        state.activeParallelPhases.delete(event.phase)
        callbacks.setGenerationStatus(
          parallelStatusMessage(state.activeParallelPhases, state.isCreativeMode),
        )
      }

      if (event.phase === 'post') {
        const postResult = event.result as
          { suggestions: any[] | null; actionChoices: any[] | null } | undefined
        if (postResult?.suggestions) {
          callbacks.setSuggestions(postResult.suggestions, state.storyId)
          callbacks.emitSuggestionsReady(
            postResult.suggestions.map((s: any) => ({ text: s.text, type: s.type })),
          )
          callbacks.setSuggestionsLoading(false)
        } else if (postResult?.actionChoices) {
          callbacks.setActionChoices(postResult.actionChoices, state.storyId)
          callbacks.setActionChoicesLoading(false)
        } else {
          callbacks.setSuggestionsLoading(false)
          callbacks.setActionChoicesLoading(false)
        }
      }
      break
    case 'error':
      callbacks.setGenerationStatus(
        `${event.phase === 'scene_director' ? '本轮导演失败' : '生成失败'}：${errorMessage(event.error)}`,
      )
      break
    case 'aborted':
      callbacks.setGenerationStatus('生成已停止')
      break
  }
}
