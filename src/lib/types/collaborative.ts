export interface CollaborativeAgentTextResult {
  agentKey: CollaborativeAgentKey
  rawText: string
  elapsedMs: number
  rawResponseAvailable: boolean
}

export interface CollaborativeNovelPlanState {
  draft: string | null
  confirmed: string | null
  draftGeneratedAt?: number
  confirmedAt?: number
  needsReview?: boolean
}

export interface CollaborativeNovelPatternState {
  draft: string | null
  confirmed: string | null
  draftGeneratedAt?: number
  draftAnalyzedHistoryKey?: string
  draftAnalyzedNarrationCount?: number
  confirmedAt?: number
  analyzedHistoryKey?: string
  analyzedNarrationCount?: number
  freshness?: CollaborativeNovelPatternFreshness
  needsReview?: boolean
}

export interface NovelRetry {
  mode: 'different'
  rawInput: string
  sourceText: string
  sourceEntryId?: string
  rejectedDirectorOutput?: string
  historyKey?: string
  storyId?: string
  branchId?: string | null
}

/** A local, branch-scoped checkpoint, never story prose or an accepted variant. */
export interface CollaborativeWriterRecovery {
  version: 1
  id: string
  storyId: string
  branchId: string | null
  userActionEntryId: string
  narrationEntryId: string
  variantBaseEntryId?: string
  previousVariantId?: string
  generatedVariantId?: string
  novelRetry?: NovelRetry
  novelTurn: NovelTurn
  retrieval: import('$lib/services/generation/types').RetrievalResult
  contextFingerprint: string
  /** Rerolls validate the restored visible state before undoing it again. */
  settledFingerprint?: string
  createdAt: number
  /** Older prose has Director text but no original retrieval checkpoint. */
  legacyContext?: boolean
}

export interface NovelTurn {
  version: 2
  historyKey: string
  outputKey?: string
  rawInput: string
  sceneDirectorOutput: string | null
  confirmedPlan: string | null
  confirmedPatternGuidance: string | null
  reroll?: {
    rejectedProse: string
    rejectedDirectorOutput: string | null
  }
  requestedLength?: string
  actualChineseCharacters?: number
  outputMetricsWarning?: string
  shortStopReason?: string
  outputTruncated?: boolean
  finishReason?: string
  writerPrompt?: {
    templateId: string
    systemSource: string
    userSource: string
    systemTemplateId?: string
    userTemplateId?: string
    packId?: string | null
  }
  directorDiagnostics?: {
    directorFallback: boolean
    reason?: 'rate_limit' | 'timeout' | 'network' | 'invalid_response' | 'unknown'
    errorMessage?: string
    rawResponseAvailable?: boolean
    responseLength?: number
    chunkCount?: number
    requestStarted?: boolean
    streamOpened?: boolean
    firstChunkReceived?: boolean
    streamCompleted?: boolean
    finishReason?: string
    presetId?: string
    profileId?: string
    profileName?: string
    model?: string
    /** Incomplete raw text received before a failed Director stream. Never sent to Writer. */
    partialResponse?: string
    stage?: 'scene_director'
    elapsedMs?: number
  }
}

export type CollaborativeNovelPatternFreshness = 'current' | 'aging' | 'stale'
export type CollaborativeRequestMode = 'json-text' | 'stream-text'

export interface CollaborativeAgentBinding {
  enabled?: boolean
}

export type CollaborativeWriterBinding = CollaborativeAgentBinding

export interface CollaborativeNovelWorkflow {
  sceneDirector?: CollaborativeAgentBinding
  narrativePlanner?: CollaborativeAgentBinding
  patternReviewer?: CollaborativeAgentBinding
  writer?: CollaborativeWriterBinding
  factStateExtractor?: CollaborativeAgentBinding
  plotSuggestions?: CollaborativeAgentBinding
  planEvery?: number
  reviewEvery?: number
  language?: 'zh-CN'
  targetLength?: CollaborativeNovelLength | string
  translationsEnabled?: false
}

export type CollaborativeAgentKey =
  | 'sceneDirector'
  | 'narrativePlanner'
  | 'patternReviewer'
  | 'writer'
  | 'factStateExtractor'
  | 'plotSuggestions'

export type CollaborativeNovelLength = `${number}中文字` | `${number}-${number}中文字`
