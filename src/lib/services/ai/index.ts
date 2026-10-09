import type { ImageEvidence } from '$lib/services/image/generationContext'
import type { ImagePromptDiagnostic } from '$lib/services/image/diagnostics'
import { getImageAnalysisConfigurationIssue } from './image/analysisConfig'
/**
 * AI Service - Main Orchestrator
 *
 * Coordinates AI services for narrative generation, classification, memory, and more.
 *
 * STATUS: Tier 0, 1, 3 Complete
 * WORKING (SDK-migrated):
 * - streamNarrative(), generateNarrative() - NarrativeService
 * - classifyResponse() - ClassifierService
 * - analyzeForChapter(), summarizeChapter(), decideRetrieval() - MemoryService
 * - generateSuggestions() - SuggestionsService
 * - generateActionChoices() - ActionChoicesService
 * - runTimelineFill(), answerChapterQuestion() - TimelineFillService
 * - buildWorldStateContext(), getRelevantLorebookEntries() - WorldStateInjector/EntryRetrievalService
 * - analyzeStyle() - StyleReviewerService
 * - runLoreManagement() - LoreManagementService
 * - generateImagesForNarrative() (both inline and analyzed modes) - ImageAnalysisService
 * - runAgenticRetrieval() - AgenticRetrievalService
 * - translate*() - TranslationService
 */

import { prepareNovelTurn, type NovelPreparation } from '$lib/services/generation/prepareNovelTurn'
import type { NovelTurn } from '$lib/types/collaborative'
import { createLogger } from '$lib/log'
import { settings } from '$lib/stores/settings.svelte'
import { database } from '$lib/services/database'
import { generateCollaborativeJsonText } from './sdk/generate'
import { collaborativeServiceIds } from './core/collaborativeAgentDefaults'
import { CollaborativePromptService } from './core/CollaborativePromptService'
import { getImageConfigurationIssue } from './image/imageUtils'
import { imageContentVersion } from '$lib/services/image/imageScope'
import {
  collaborativeStateRebuildCandidateSchema,
  type CollaborativeStateRebuildRequest,
} from '$lib/services/CollaborativeStateRebuildService'
import {
  emitImageAnalysisStarted,
  emitImageAnalysisComplete,
  emitImageAnalysisFailed,
  emitImageQueued,
  emitBackgroundImageAnalysisStarted,
  emitBackgroundImageAnalysisComplete,
  emitBackgroundImageAnalysisFailed,
  emitBackgroundImageQueued,
  emitBackgroundImageReady,
} from '$lib/services/events'
import type { PromptContext, LoreManagementCallbacks } from '$lib/services/generation'
import type {
  Chapter,
  Character,
  EmbeddedImage,
  Entry,
  ImageProfile,
  LoreChange,
  LoreManagementResult,
  MemoryConfig,
  POV,
  ReasoningEffort,
  Story,
  StoryBeat,
  StoryEntry,
  StoryMode,
  StorySettings,
  SummaryDetail,
  Tense,
  TimeTracker,
} from '$lib/types'
import { normalizeImageDataUrl, expectedPixels, type ImageSpec } from '$lib/utils/image'
import type { StreamChunk } from './core/types'
import { recentStoryBudgetChars } from './core/defaults'
import { MIN_RECENT_ENTRIES_FOR_LORE, splitRecentTail } from './retrieval/recentTail'
import { serviceFactory } from './core/factory'
import {
  inlineImageService,
  isImageGenerationEnabled as isImageGenerationEnabledUtil,
  resolveStylePrompt,
  runImageGeneration,
} from './image'
import type { InlineImageContext, ImageAnalysisContext } from './image'
import {
  MemoryService,
  NarrativeService,
  getWorldStateInjectorConfigFromSettings,
} from './generation'
import type {
  ClassificationContext,
  WorldStateInjectorConfig,
  WorldStateInjectorOptions,
  WorldStateInjectionResult,
  RetrievalContext,
  StyleReviewResult,
  WorldStateContext,
} from './generation'
import { EntryRetrievalService, getEntryRetrievalConfigFromSettings } from './retrieval'
export { clearTier3SelectionCache } from './retrieval'
import type { TimelineFillResult, EntryRetrievalResult, EntryRetrievalOptions } from './retrieval'
import type {
  RetrievalResult as AgenticRetrievalResult,
  RetrievalContext as AgenticRetrievalContext,
} from './retrieval/AgenticRetrievalService'
import type {
  ActionChoicesResult,
  BackgroundImageAnalysisResult,
  ChapterAnalysis,
  ChapterSummaryResult,
  ChapterTimelineEstimate,
  ClassificationResult,
  ImageableScene,
  RetrievalDecision,
  SuggestionsResult,
} from './sdk'
import type { TranslationResult, UITranslationItem } from './utils'
import { recentContent, AS_HAYSTACK, AS_PROSE } from '$lib/utils/recentContent'
import { joinPromptBlocks } from '$lib/utils/promptBlocks'

// Timeline Fill service settings (per design doc section 3.1.4: Static Retrieval)
export interface TimelineFillSettings {
  presetId?: string
  profileId: string | null // API profile to use (null = use default profile)
  enabled: boolean
  mode: 'static' | 'agentic' // 'static' is default, 'agentic' for tool-calling retrieval
  model: string
  temperature: number
  maxQueries: number
  reasoningEffort: ReasoningEffort
  manualBody: string
}

// Image Generation settings (automatic image generation for narrative)
export interface ImageGenerationServiceSettings {
  // Profile-based image generation (profiles must have supportsImageGeneration capability)
  profileId: string | null // API profile for standard image generation
  size: ImageSpec // Regular image size

  // Reference model settings (for image-to-image with portrait references)
  referenceProfileId: string | null // API profile for image-to-image with portrait references
  referenceSize: ImageSpec // Reference image size

  // General story image settings
  styleId: string // Selected image style template
  maxImagesPerMessage: number // Max images per narrative (0 = unlimited, default: 3)

  // Portrait model settings (character reference images)
  portraitProfileId: string | null // API profile for generating character portraits
  portraitStyleId: string // Selected character portrait style template
  portraitSize: ImageSpec // Portrait image size

  // Scene analysis model settings (for identifying imageable scenes)
  promptProfileId: string | null // API profile for scene analysis
  promptModel: string // Model for scene analysis (empty = use profile default)
  promptTemperature: number
  promptMaxTokens: number
  reasoningEffort: ReasoningEffort
  manualBody: string

  // Background image settings
  backgroundProfileId: string | null // API profile for background image generation
  backgroundSize: ImageSpec // Background image size
  backgroundBlur: number // Background blur amount in pixels (default: 0)
}

// Re-export ImageGenerationContext type for backwards compatibility
export interface ImageGenerationContext {
  storyId: string
  entryId: string
  narrativeResponse: string
  userAction: string
  presentCharacters: Character[]
  currentLocation?: string
  chatHistory?: string
  lorebookContext?: string
  translatedNarrative?: string
  translationLanguage?: string
  referenceMode: boolean
  /** Story-level image generation mode — supplied by caller to avoid store access */
  imageGenerationMode?: string | null
  /** All story characters — supplied by caller for portrait/reference lookups */
  allCharacters?: Character[]
  /** System image generation service settings — supplied by caller */
  imageSettings?: ImageGenerationServiceSettings
  /** Image profile lookup — supplied by caller */
  getImageProfile?: (id: string) => ImageProfile | undefined
  evidence?: ImageEvidence
  onDiagnostic?: (diagnostic: ImagePromptDiagnostic) => void
  diagnostic?: ImagePromptDiagnostic
  trigger?: 'manual'
  contentVersion?: string
  /** UI scope check, rechecked after analysis before spending image credits. */
  canContinue?: () => boolean
}

export type ImageGenerationResult = {
  status: 'queued' | 'no-scenes' | 'not-configured' | 'failed' | 'disabled' | 'busy'
  message?: string
  queued?: number
}

const manualImageRequests = new Set<string>()

const log = createLogger('AIService')

interface WorldState extends WorldStateContext {
  memoryConfig?: MemoryConfig
  lorebookEntries?: Entry[]
}

/**
 * Everything `runAgenticRetrieval` needs.
 *
 * One object rather than a parameter list: this had grown to eleven positional
 * parameters, seven of them optional, several of them same-shaped callbacks. `RetrievalPhase`
 * declares its own dependency signature in a different order, so the two were bridged by a
 * hand-written adapter whose only job was to shuffle arguments -- and whose only defence
 * against shuffling them wrong was that two of the types happened to differ.
 */
export interface AgenticRetrievalOptions {
  /** Story whose pack supplies the template; undefined only outside a story. */
  storyId: string | undefined
  userInput: string
  recentEntries: StoryEntry[]
  chapters: Chapter[]
  entries: Entry[]
  /** Live world state, so the agent can be told what the narrator already has. */
  worldState?: WorldState
  /** Where the story stands now, the anchor for reading excerpt timestamps. */
  currentStoryTime?: TimeTracker | null
  /** Summary of what world state and lorebook selection already put in the prompt. */
  alreadyInContext?: string
  onQueryChapter?: (chapterNumber: number, question: string) => Promise<string>
  getChapterEntries?: (chapter: Chapter) => StoryEntry[]
  getUnchapterizedEntries?: () => StoryEntry[]
  signal?: AbortSignal
}

class AIService {
  private narrativeService: NarrativeService

  constructor() {
    this.narrativeService = serviceFactory.createNarrativeService()
  }

  /**
   * Generate a complete narrative response (non-streaming).
   */
  async generateNarrative(
    entries: StoryEntry[],
    worldState: WorldState,
    story?: Story | null,
  ): Promise<string> {
    return this.narrativeService.generate(entries, worldState, story)
  }

  /**
   * Stream a narrative response.
   * This is the primary method for real-time story generation.
   */
  async prepareCollaborative(
    input: NovelPreparation,
    onProgress?: import('$lib/services/generation/prepareNovelTurn').NovelProgressCallback,
    onDirectorChunk?: import('$lib/services/generation/prepareNovelTurn').NovelDirectorChunkCallback,
  ) {
    const { story, abortSignal } = input.context
    return prepareNovelTurn(
      input,
      {
        scene: (data, onDiagnostic, onChunk) =>
          serviceFactory
            .createNovelScenePlanner()
            .run(
              story.id,
              'collaborative-scene-director',
              data,
              abortSignal,
              onDiagnostic,
              onChunk,
            ),
      },
      onProgress,
      onDirectorChunk,
    )
  }

  async generateCollaborativePlan(
    storyId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    return serviceFactory
      .createNovelPlanner()
      .run(storyId, 'collaborative-long-planner', input, signal)
  }

  async generateCollaborativePatternReview(
    storyId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    return serviceFactory
      .createNovelReviewer()
      .run(storyId, 'collaborative-pattern-reviewer', input, signal)
  }

  async generateCollaborativeStateRebuild(
    storyId: string,
    request: CollaborativeStateRebuildRequest,
    signal?: AbortSignal,
  ) {
    const story = await database.getStory(storyId)
    if (!story) throw new Error('中文写作故事不存在。')
    if (story.settings?.collaborativeNovelWorkflow?.factStateExtractor?.enabled === false) {
      throw new Error('正文事实与状态提取已关闭。')
    }
    const rendered = await CollaborativePromptService.render(storyId, 'factStateExtractor', request)
    return generateCollaborativeJsonText(
      {
        presetId: 'collaborative-state-rebuilder',
        presetOverride: settings.getPresetConfig(
          settings.getServicePresetId(collaborativeServiceIds.factStateExtractor),
          collaborativeServiceIds.factStateExtractor,
        ),
        schema: collaborativeStateRebuildCandidateSchema,
        system: rendered.system,
        prompt: rendered.user,
        signal,
      },
      'collaborative-state-rebuilder',
    )
  }

  async *streamNarrative(
    entries: StoryEntry[],
    worldState: WorldState,
    currentStory?: Story | null,
    styleReview?: StyleReviewResult | null,
    retrievedChapterContext?: string | null,
    signal?: AbortSignal,
    timelineFillResult?: TimelineFillResult | null,
    worldStateBlock?: string | null,
    novelTurn?: NovelTurn,
  ): AsyncIterable<StreamChunk> {
    log('streamNarrative called', {
      entriesCount: entries.length,
      hasWorldStateBlock: !!worldStateBlock,
      hasStyleReview: !!styleReview,
      hasRetrievedContext: !!retrievedChapterContext,
      hasTimelineFill: !!timelineFillResult,
    })

    // Both blocks are built in RetrievalPhase now; this only joins them.
    //
    // The narrative template renders one variable and must keep seeing one string: adding a
    // second would leave every pack predating the change without the retrieval block.
    // Always a string, '' when both are empty -- which is what the injector returned before,
    // and what NarrativeService's `if (tieredContextBlock)` guard already expects. Coalescing
    // with `??` here would be wrong: '' is not nullish, so an empty world state would have
    // swallowed the retrieval text instead of concatenating it.
    //
    // Joined with a blank line rather than concatenated raw. Every block in this prompt
    // opens with "\n\n" except the agentic retrieval one, so raw concatenation -- which is
    // what `EntryInjector` did before the split, and what was faithfully preserved here --
    // produced this in a real turn:
    //
    //     ...She is now his devoted pet.[Retrieved Context - I searched for all mentions...
    //
    // `joinPromptBlocks` adds only what is missing, so the static path, where the lorebook
    // block already starts with "\n\n", stays byte-identical.
    const tieredContextBlock = joinPromptBlocks(worldStateBlock, retrievedChapterContext)

    // Delegate to NarrativeService
    yield* this.narrativeService.stream(entries, worldState, currentStory, {
      tieredContextBlock,
      styleReview,
      retrievedChapterContext,
      signal,
      timelineFillResult,
      novelTurn,
    })
  }

  /**
   * Classify a narrative response to extract world state changes.
   */
  async classifyResponse(
    narrativeResponse: string,
    userAction: string,
    worldState: WorldState,
    story?: Story | null,
    visibleEntries?: StoryEntry[],
    currentStoryTime?: TimeTracker | null,
  ): Promise<ClassificationResult> {
    log('classifyResponse called', {
      narrativeLength: narrativeResponse.length,
      userActionLength: userAction.length,
      hasStory: !!story,
      hasVisibleEntries: !!visibleEntries,
    })

    if (!story) {
      log('classifyResponse: No story provided, returning empty result')
      return {
        entryUpdates: {
          characterUpdates: [],
          locationUpdates: [],
          itemUpdates: [],
          storyBeatUpdates: [],
          newCharacters: [],
          newLocations: [],
          newItems: [],
          newStoryBeats: [],
        },
        scene: {
          currentLocationName: null,
          presentCharacterNames: [],
          timeProgression: 'none',
        },
      }
    }

    const classifierService = serviceFactory.createClassifierService()
    const context: ClassificationContext = {
      storyId: story.id,
      story,
      narrativeResponse,
      userAction,
      existingCharacters: worldState.characters,
      existingLocations: worldState.locations,
      existingItems: worldState.items,
      existingStoryBeats: worldState.storyBeats ?? [],
    }

    return classifierService.classify(context, visibleEntries, currentStoryTime)
  }

  /**
   * Generate story direction suggestions for creative writing mode.
   */
  async generateSuggestions(
    entries: StoryEntry[],
    activeThreads: StoryBeat[],
    lorebookEntries: Entry[] | undefined,
    latestNarrativeResponse: string | undefined,
    storyId: string | undefined,
  ): Promise<SuggestionsResult> {
    log('generateSuggestions called', {
      entriesCount: entries.length,
      threadsCount: activeThreads.length,
      lorebookEntriesCount: lorebookEntries?.length ?? 0,
      latestNarrativeLength: latestNarrativeResponse?.length ?? 0,
    })

    const suggestionsService = serviceFactory.createSuggestionsService()
    return await suggestionsService.generateSuggestions(
      entries,
      activeThreads,
      lorebookEntries,
      storyId,
      latestNarrativeResponse,
    )
  }

  /**
   * Generate RPG-style action choices for adventure mode.
   */
  async generateActionChoices(
    entries: StoryEntry[],
    worldState: WorldState,
    narrativeResponse: string,
    lorebookEntries: Entry[] | undefined,
    promptContext: PromptContext | undefined,
    pov: 'first' | 'second' | 'third' | undefined,
    storyId: string | undefined,
  ): Promise<ActionChoicesResult> {
    if (storyId) {
      const currentStory = await database.getStory(storyId)
      if (currentStory?.mode === 'creative-writing') {
        throw new Error('中文写作不提供行动选项。')
      }
    }
    log('generateActionChoices called', {
      entriesCount: entries.length,
      narrativeLength: narrativeResponse.length,
      hasPromptContext: !!promptContext,
      lorebookEntriesCount: lorebookEntries?.length ?? 0,
    })

    const actionChoicesService = serviceFactory.createActionChoicesService()

    // Find protagonist
    const protagonist = worldState.characters?.find((c) => c.relationship === 'self')

    // Find last user action
    const lastUserAction = entries.filter((e) => e.type === 'user_action').pop()

    // Get present characters (NPCs, excluding the protagonist)
    const presentCharacters = worldState.characters?.filter(
      (c) => c.relationship !== 'self' && c.status === 'active',
    )

    // Get inventory items (those that are equipped)
    const inventory = worldState.items?.filter((i) => i.equipped)

    // Build context for the service
    const context = {
      storyId,
      narrativeResponse,
      userAction: lastUserAction?.content ?? '',
      recentEntries: entries.slice(-10),
      protagonistName: protagonist?.name ?? promptContext?.protagonistName ?? 'the protagonist',
      protagonistDescription: protagonist?.description,
      mode: promptContext?.mode ?? 'adventure',
      pov: pov ?? promptContext?.pov ?? 'second',
      tense: promptContext?.tense ?? 'present',
      currentLocation: worldState.currentLocation,
      presentCharacters,
      inventory,
      activeQuests: worldState.storyBeats?.filter(
        (b) => b.status === 'pending' || b.status === 'active',
      ),
      lorebookEntries,
    }

    const choices = await actionChoicesService.generateChoices(context)
    return { choices }
  }

  /**
   * Analyze narration entries for style issues.
   */
  async analyzeStyle(
    storyId: string | undefined,
    entries: StoryEntry[],
    mode: StoryMode = 'adventure',
    pov?: POV,
    tense?: Tense,
    recentEntriesCount?: number,
  ): Promise<StyleReviewResult> {
    const service = serviceFactory.createStyleReviewerService()
    return service.analyzeStyle(storyId, entries, mode, pov, tense, recentEntriesCount)
  }

  /**
   * Analyze if a new chapter should be created.
   */
  async analyzeForChapter(
    storyId: string | undefined,
    entries: StoryEntry[],
    lastChapterEndIndex: number,
    config: MemoryConfig,
    tokensOutsideBuffer: number,
    mode: StoryMode = 'adventure',
    pov?: POV,
    tense?: Tense,
  ): Promise<ChapterAnalysis> {
    const memoryService = serviceFactory.createMemoryService()
    return memoryService.analyzeForChapter(
      storyId,
      entries,
      lastChapterEndIndex,
      tokensOutsideBuffer,
      mode,
      pov,
      tense,
    )
  }

  /**
   * Generate a summary and metadata for a chapter.
   */
  async summarizeChapter(
    storyId: string | undefined,
    entries: StoryEntry[],
    previousChapters?: Chapter[],
    mode: StoryMode = 'adventure',
    pov?: POV,
    tense?: Tense,
    summaryDetail: SummaryDetail = 'auto',
  ): Promise<ChapterSummaryResult> {
    const memoryService = serviceFactory.createMemoryService()
    return memoryService.summarizeChapter(
      storyId,
      entries,
      previousChapters,
      mode,
      pov,
      tense,
      summaryDetail,
    )
  }

  /**
   * Resummarize an existing chapter.
   */
  async resummarizeChapter(
    storyId: string | undefined,
    chapter: Chapter,
    entries: StoryEntry[],
    allChapters: Chapter[],
    mode: StoryMode = 'adventure',
    pov?: POV,
    tense?: Tense,
    summaryDetail: SummaryDetail = 'auto',
  ): Promise<ChapterSummaryResult> {
    const memoryService = serviceFactory.createMemoryService()
    return memoryService.summarizeChapter(
      storyId,
      entries,
      allChapters,
      mode,
      pov,
      tense,
      summaryDetail,
    )
  }

  /**
   * Estimate in-story time elapsed during a chapter, from its summary alone.
   */
  async estimateChapterTimeline(
    storyId: string | undefined,
    summary: string,
  ): Promise<ChapterTimelineEstimate> {
    const memoryService = serviceFactory.createMemoryService()
    return memoryService.estimateChapterTimeline(storyId, summary)
  }

  /**
   * Decide which chapters are relevant for the current context.
   */
  async decideRetrieval(
    storyId: string | undefined,
    userInput: string,
    recentEntries: StoryEntry[],
    chapters: Chapter[],
    config: MemoryConfig,
    mode: StoryMode = 'adventure',
    pov?: POV,
    tense?: Tense,
  ): Promise<RetrievalDecision> {
    const memoryService = serviceFactory.createMemoryService()
    const context: RetrievalContext = {
      userInput,
      recentNarrative: recentContent(recentEntries, recentEntries.length, AS_HAYSTACK),
      availableChapters: chapters,
    }
    return memoryService.decideRetrieval(storyId, context, mode, pov, tense)
  }

  /**
   * Build context block from retrieved chapters.
   * NOTE: This method works - it's just string building.
   */
  buildRetrievedContextBlock(
    chapters: Chapter[],
    decision: RetrievalDecision,
    getChapterEntries: (chapter: Chapter) => StoryEntry[],
  ): string {
    const memory = new MemoryService('memory')
    return memory.buildRetrievedContextBlock(chapters, decision, getChapterEntries)
  }

  /**
   * Build live-WorldState context using the WorldStateInjector.
   */
  async buildWorldStateContext(
    worldState: WorldState,
    userInput: string,
    recentEntries: StoryEntry[],
    config: Partial<WorldStateInjectorConfig> | undefined,
    options: WorldStateInjectorOptions,
  ): Promise<WorldStateInjectionResult> {
    log('buildWorldStateContext called', {
      userInputLength: userInput.length,
      recentEntriesCount: recentEntries.length,
      hasActivationTracker: !!options.activationTracker,
    })

    // Read from settings when the caller does not override, same as
    // getRelevantLorebookEntries does with getEntryRetrievalConfigFromSettings(). Keeps the
    // settings lookup in the service layer so RetrievalPhase can stay injected with a
    // config-free signature.
    const injector = serviceFactory.createWorldStateInjector(
      config ?? getWorldStateInjectorConfigFromSettings(),
    )
    const result = await injector.buildContext(worldState, userInput, recentEntries, options)

    log('buildWorldStateContext complete', {
      tier1: result.tier1.length,
      tier2: result.tier2.length,
      tier3: result.tier3.length,
      total: result.all.length,
    })

    return result
  }

  /**
   * Get relevant lorebook entries using tiered injection.
   */
  async getRelevantLorebookEntries(
    entries: Entry[],
    userInput: string,
    recentStoryEntries: StoryEntry[],
    options: EntryRetrievalOptions,
  ): Promise<EntryRetrievalResult> {
    log('getRelevantLorebookEntries called', {
      totalEntries: entries.length,
      userInputLength: userInput.length,
      hasActivationTracker: !!options.activationTracker,
    })

    const config = getEntryRetrievalConfigFromSettings()
    const entryService = new EntryRetrievalService(config, 'entryRetrieval')
    const result = await entryService.getRelevantEntries(
      entries,
      userInput,
      recentStoryEntries,
      options,
    )

    log('getRelevantLorebookEntries complete', {
      tier1: result.tier1.length,
      tier2: result.tier2.length,
      tier3: result.tier3.length,
      total: result.all.length,
    })

    return result
  }

  /**
   * Run a lore management session.
   * Analyzes recent narrative and updates lorebook entries accordingly.
   */
  async runLoreManagement(
    storyId: string,
    branchId: string | null,
    entries: Entry[],
    recentMessages: StoryEntry[],
    chapters: Chapter[],
    callbacks: LoreManagementCallbacks,
    _mode: StoryMode = 'adventure',
    _pov?: POV,
    _tense?: Tense,
    tokenThreshold?: number,
  ): Promise<LoreManagementResult> {
    // The story since the last chapter — the only unsummarised material the agent has. It
    // used to be the single most recent action and narration, which on a story with no
    // chapters left the agent maintaining a lorebook for a story it could not read.
    //
    // Bounded through the same helper the retrieval tail uses, so both sides measure the
    // same thing the same way. `searchable` is dropped rather than split: there is no grep
    // here to reach what the budget leaves out.
    const { shown } = splitRecentTail(
      recentMessages.filter((m) => m.type === 'narration' || m.type === 'user_action'),
      recentStoryBudgetChars(tokenThreshold),
      MIN_RECENT_ENTRIES_FOR_LORE,
    )
    const recentStory = shown
      .map((m) => `[${m.type === 'user_action' ? 'ACTION' : 'NARRATIVE'}] ${m.content}`)
      .join('\n\n')

    // Number, title and summary only: the keyword and character facets were read by
    // `list_chapters`, which no longer exists.
    // Deep clone to avoid Svelte proxy issues with AI SDK structured cloning
    const chapterInfos = JSON.parse(
      JSON.stringify(
        chapters.map((c) => ({
          number: c.number,
          title: c.title,
          summary: c.summary,
        })),
      ),
    )

    // Create service and run session
    const service = serviceFactory.createLoreManagementService()
    const sessionResult = await service.runSession({
      storyId,
      recentStory,
      existingEntries: entries,
      chapters: chapterInfos,
      queryChapter: callbacks.onQueryChapter,
      keptSeparate: await callbacks.getKeptSeparate?.(),
      onKeepSeparate: callbacks.onKeepSeparate,
    })

    // Build changes array for the result
    const changes: LoreChange[] = []

    // Apply changes via callbacks and build changes array
    for (const entry of sessionResult.createdEntries) {
      // Assign proper ID before creating
      const newEntry: Entry = {
        ...entry,
        id: crypto.randomUUID(),
        branchId,
      }
      await callbacks.onCreateEntry(newEntry)
      changes.push({ type: 'create', entry: newEntry })
    }

    for (const entry of sessionResult.updatedEntries) {
      await callbacks.onUpdateEntry(entry.id, entry)
      changes.push({ type: 'update', entry })
    }

    // Consolidation is what keeps a lorebook from growing without bound, and it used to
    // stop here: merges and deletes were approved, logged, then dropped, so every run
    // re-proposed the same duplicates it had "already" merged.
    for (const { sources, merged } of sessionResult.merges) {
      const mergedEntry = { ...merged, id: crypto.randomUUID(), branchId }
      await callbacks.onMergeEntries(
        sources.map((e) => e.id),
        mergedEntry,
      )
      changes.push({ type: 'merge', entry: mergedEntry, mergedFrom: sources.map((e) => e.id) })
    }

    const mergedAway = new Set(sessionResult.merges.flatMap((m) => m.sources.map((e) => e.id)))
    for (const entry of sessionResult.deletedEntries) {
      if (mergedAway.has(entry.id)) continue
      await callbacks.onDeleteEntry(entry.id)
      changes.push({ type: 'delete', previous: entry })
    }

    log('runLoreManagement complete', {
      created: sessionResult.createdEntries.length,
      updated: sessionResult.updatedEntries.length,
      deleted: sessionResult.deletedEntries.length,
      merged: sessionResult.merges.length,
    })

    return {
      changes,
      summary: sessionResult.reasoning ?? 'Lore management session completed.',
      sessionId: crypto.randomUUID(),
    }
  }

  /**
   * Run agentic retrieval to find relevant lorebook entries and chapter context.
   * Uses an LLM agent with tools to intelligently search and select entries.
   */
  // See AgenticRetrievalOptions for why this takes one object.
  async runAgenticRetrieval(options: AgenticRetrievalOptions): Promise<AgenticRetrievalResult> {
    const { userInput, recentEntries, chapters, entries, worldState, signal } = options

    log('runAgenticRetrieval called', {
      userInputLength: userInput.length,
      recentEntriesCount: recentEntries.length,
      chaptersCount: chapters.length,
      entriesCount: entries.length,
      hasWorldState: !!worldState,
    })

    const service = serviceFactory.createAgenticRetrievalService()

    // Build context for the service
    const context: AgenticRetrievalContext = {
      storyId: options.storyId,
      userInput,
      // Build recent narrative from entries
      recentNarrative: recentContent(recentEntries, recentEntries.length, AS_PROSE),
      availableEntries: entries,
      chapters,
      worldState,
      currentStoryTime: options.currentStoryTime,
      alreadyInContext: options.alreadyInContext,
      // Pass through the chapter query callback directly
      queryChapter: options.onQueryChapter,
      getChapterEntries: options.getChapterEntries,
      getUnchapterizedEntries: options.getUnchapterizedEntries,
    }

    const result = await service.runRetrieval(context, signal)

    log('runAgenticRetrieval complete', { contextLength: result.context.length })

    return result
  }

  /**
   * Determine if agentic retrieval should be used.
   */
  shouldUseAgenticRetrieval(
    timelineFillSettings: Pick<TimelineFillSettings, 'enabled' | 'mode'>,
  ): boolean {
    if (!timelineFillSettings?.enabled) {
      return false
    }
    const mode = timelineFillSettings.mode ?? 'static'
    return mode === 'agentic'
  }

  /**
   * Run timeline fill to gather context from past chapters.
   */
  async runTimelineFill(
    storyId: string | undefined,
    visibleEntries: StoryEntry[],
    chapters: Chapter[],
    getChapterEntries: (chapter: Chapter) => StoryEntry[],
    alreadyInContext?: string,
    /** Budget for each answer prompt's chapter text; see `chapterReadBudget`. */
    maxChapterTokens?: number,
  ): Promise<TimelineFillResult> {
    log('runTimelineFill called', {
      visibleEntriesCount: visibleEntries.length,
      chaptersCount: chapters.length,
      hasAlreadyInContext: !!alreadyInContext,
      maxChapterTokens,
    })

    const timelineFillService = serviceFactory.createTimelineFillService()
    return timelineFillService.runTimelineFill(
      storyId,
      visibleEntries,
      chapters,
      getChapterEntries,
      alreadyInContext,
      maxChapterTokens,
    )
  }

  /**
   * Answer a specific chapter question.
   */
  async answerChapterQuestion(
    storyId: string | undefined,
    chapterNumber: number,
    question: string,
    chapters: Chapter[],
    getChapterEntries: (chapter: Chapter) => StoryEntry[],
    /** Budget for the chapter text; see `chapterReadBudget`. */
    maxChapterTokens?: number,
  ): Promise<string> {
    log('answerChapterQuestion called', {
      chapterNumber,
      question,
      chaptersCount: chapters.length,
      maxChapterTokens,
    })

    const chapterQueryService = serviceFactory.createChapterQueryService()
    const answer = await chapterQueryService.answerQuestion(
      storyId,
      question,
      chapters,
      [chapterNumber],
      getChapterEntries,
      maxChapterTokens,
    )
    return answer.answer
  }

  /**
   * Check if image generation is enabled for a story.
   */
  isImageGenerationEnabled(
    storySettings?: StorySettings,
    type: 'standard' | 'background' | 'portrait' | 'reference' = 'standard',
  ): boolean {
    return isImageGenerationEnabledUtil(storySettings, type)
  }

  /**
   * Generate images for a narrative response.
   * Supports two modes:
   * - Inline mode: Process <pic> tags from AI response
   * - Analyzed mode: Use LLM to identify imageable scenes
   */
  async generateImagesForNarrative(
    context: ImageGenerationContext,
  ): Promise<ImageGenerationResult> {
    log('generateImagesForNarrative called', {
      storyId: context.storyId,
      entryId: context.entryId,
      narrativeLength: context.narrativeResponse.length,
      hasTranslation: !!context.translatedNarrative,
      translationLanguage: context.translationLanguage,
    })

    if (
      context.imageGenerationMode === 'none' ||
      (context.imageGenerationMode === 'manual' && context.trigger !== 'manual')
    )
      return { status: 'disabled' }
    context = {
      ...context,
      contentVersion:
        context.contentVersion ?? imageContentVersion({ content: context.narrativeResponse }),
    }
    const issue =
      getImageConfigurationIssue() ||
      (context.trigger === 'manual' ? getImageAnalysisConfigurationIssue() : null) ||
      (context.referenceMode ? getImageConfigurationIssue('reference') : null)
    if (issue) return { status: 'not-configured', message: issue }
    const requestKey = `${context.storyId}:${context.entryId}`
    const manual = context.trigger === 'manual'
    if (manual && manualImageRequests.has(requestKey))
      return { status: 'busy', message: '此轮插图正在生成。' }
    if (manual) manualImageRequests.add(requestKey)

    // Check if inline image mode is enabled for this story
    const inlineImageMode = context.imageGenerationMode === 'inline'
    try {
      if (manual) {
        if (!(await this.manualImageScopeCurrent(context)))
          return { status: 'disabled', message: '图片开关或正文已变化，请重新操作。' }
        const existing = await database.getEmbeddedImagesForEntry(context.entryId)
        if (existing.some((image) => image.contentVersion === context.contentVersion))
          return { status: 'busy', message: '本版正文已有插图；可打开图片查看或单独重试。' }
      }
      if (inlineImageMode) {
        // Use inline image generation (process <pic> tags from AI response)
        const narrativeToProcess = context.translatedNarrative || context.narrativeResponse
        log('Using inline image mode', {
          usingTranslated: !!context.translatedNarrative,
        })
        const inlineContext: InlineImageContext = {
          storyId: context.storyId,
          entryId: context.entryId,
          narrativeContent: narrativeToProcess,
          contentVersion: context.contentVersion,
          presentCharacters: context.presentCharacters,
          referenceMode: context.referenceMode,
        }
        const queued = await inlineImageService.processNarrativeForInlineImages(inlineContext)
        return { status: queued ? 'queued' : 'no-scenes', queued }
      } else {
        // Analyzed mode: Use LLM to identify imageable scenes
        log('Using analyzed image mode')
        return await this.runAnalyzedImageGeneration(context)
      }
    } catch (error) {
      log('Image generation failed (non-fatal)', error)
      return { status: 'failed', message: error instanceof Error ? error.message : '插图生成失败' }
    } finally {
      if (manual) manualImageRequests.delete(requestKey)
    }
  }

  private async manualImageScopeCurrent(context: ImageGenerationContext): Promise<boolean> {
    if (context.canContinue?.() === false || !context.contentVersion) return false
    const [sourceStory, entry] = await Promise.all([
      database.getStory(context.storyId),
      database.getStoryEntry(context.entryId),
    ])
    return (
      context.canContinue?.() !== false &&
      sourceStory?.settings?.imageGenerationMode === 'manual' &&
      entry?.storyId === context.storyId &&
      imageContentVersion(entry) === context.contentVersion &&
      !getImageConfigurationIssue() &&
      (!context.referenceMode || !getImageConfigurationIssue('reference'))
    )
  }

  /**
   * Run analyzed image generation mode.
   * Uses LLM to identify visually striking moments in narrative text.
   */
  private async runAnalyzedImageGeneration(
    context: ImageGenerationContext,
  ): Promise<ImageGenerationResult> {
    const imageSettings = context.imageSettings
    if (!imageSettings) {
      log('No image settings in context, skipping analyzed image generation')
      return { status: 'not-configured', message: '尚未配置故事插图。' }
    }
    const referenceMode = context.referenceMode ?? false
    const allCharacters = context.allCharacters ?? []

    // Get characters with/without portraits
    const presentCharacterNames = context.presentCharacters.map((c) => c.name.toLowerCase())
    const charactersWithPortraits = allCharacters
      .filter((c) => presentCharacterNames.includes(c.name.toLowerCase()) && c.portrait)
      .map((c) => c.name)
    const charactersWithoutPortraits = allCharacters
      .filter((c) => presentCharacterNames.includes(c.name.toLowerCase()) && !c.portrait)
      .map((c) => c.name)

    // Build style prompt
    const stylePrompt = await resolveStylePrompt(context.storyId, imageSettings.styleId)

    // Build analysis context
    const analysisContext: ImageAnalysisContext = {
      storyId: context.storyId,
      narrativeResponse: context.narrativeResponse,
      userAction: context.userAction,
      presentCharacters: context.presentCharacters.map((c) => ({
        name: c.name,
        visualDescriptors: c.visualDescriptors,
        isProtagonist: c.relationship === 'self',
      })),
      currentLocation: context.currentLocation,
      stylePrompt,
      maxImages: context.trigger === 'manual' ? 1 : (imageSettings.maxImagesPerMessage ?? 3),
      manual: context.trigger === 'manual',
      evidence: context.evidence,
      onDiagnostic: (value) => {
        context.diagnostic = value
        context.onDiagnostic?.(value)
      },
      chatHistory: context.chatHistory,
      lorebookContext: context.lorebookContext,
      charactersWithPortraits,
      charactersWithoutPortraits,
      referenceMode,
      translatedNarrative: context.translatedNarrative,
      translationLanguage: context.translationLanguage,
    }

    if (context.canContinue?.() === false) return { status: 'disabled' }

    // Emit analysis started
    emitImageAnalysisStarted(context.entryId)

    // The analysis phase and the queueing that follows it get their own try/catch: they
    // are one `Started` and one `Complete`, and the progress counter reads that pair. A
    // single catch spanning both emitted `Failed` after `Complete` had already fired for
    // a throw while queueing, closing an analysis phase twice. `Failed` stays a
    // notification only (`StoryEntry` toasts on it) — it never ends the phase.
    let scenes: ImageableScene[]
    try {
      // Create service and identify scenes
      const analysisService = serviceFactory.createImageAnalysisService()
      scenes = await analysisService.identifyScenes(analysisContext)
      if (context.trigger === 'manual')
        scenes = scenes
          .filter(
            (scene) =>
              !scene.generatePortrait &&
              scene.prompt.trim() &&
              scene.sourceText.trim() &&
              context.narrativeResponse.includes(scene.sourceText),
          )
          .slice(0, 1)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      log('Scene analysis failed', error)
      emitImageAnalysisComplete(context.entryId, 0, 0)
      if (context.trigger !== 'manual') emitImageAnalysisFailed(context.entryId, errorMessage)
      return { status: 'failed', message: `画面分析失败：${errorMessage}` }
    }

    // Count portrait generations
    const portraitCount = scenes.filter((s) => s.generatePortrait).length
    const sceneCount = scenes.length - portraitCount

    if (scenes.length === 0) {
      log('No imageable scenes identified')
    } else {
      log('Scenes identified', {
        total: scenes.length,
        scenes: sceneCount,
        portraits: portraitCount,
      })
    }
    emitImageAnalysisComplete(context.entryId, sceneCount, portraitCount)
    if (!scenes.length) return { status: 'no-scenes', message: '未选出适合的画面，可以再次尝试。' }

    try {
      if (context.trigger === 'manual' && !(await this.manualImageScopeCurrent(context)))
        return { status: 'disabled', message: '图片开关或正文已变化，本次未继续生图。' }
      // Queue image generation for each scene
      const getImageProfile = context.getImageProfile ?? (() => undefined)
      let queued = 0
      for (const scene of scenes) {
        const started = await this.queueAnalyzedImageGeneration(
          context.storyId,
          context.entryId,
          scene,
          imageSettings,
          context.presentCharacters,
          referenceMode,
          getImageProfile,
          context,
        )
        if (started) queued++
      }
      return { status: queued ? 'queued' : 'disabled', queued }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      log('Queueing analyzed image generation failed', error)
      if (context.trigger !== 'manual') emitImageAnalysisFailed(context.entryId, errorMessage)
      return { status: 'failed', message: `插图排队失败：${errorMessage}` }
    }
  }

  /**
   * Queue image generation for an analyzed scene.
   */
  private async queueAnalyzedImageGeneration(
    storyId: string,
    entryId: string,
    scene: ImageableScene,
    imageSettings: ImageGenerationServiceSettings,
    presentCharacters: Character[],
    referenceMode: boolean,
    getImageProfile: (id: string) => ImageProfile | undefined,
    context: ImageGenerationContext,
  ): Promise<boolean> {
    const imageId = crypto.randomUUID()

    // Determine profile and model
    let profileId = imageSettings.profileId
    let modelToUse = getImageProfile(profileId ?? '')?.model ?? ''
    let sizeToUse = imageSettings.size
    let referenceImageUrls: string[] | undefined
    let styleId: string | undefined = imageSettings.styleId

    // If reference mode and scene has characters, look for reference images
    if (referenceMode && scene.characters.length > 0 && !scene.generatePortrait) {
      const portraitUrls: string[] = []

      for (const charName of scene.characters.slice(0, 3)) {
        const character = presentCharacters.find(
          (c) => c.name.toLowerCase() === charName.toLowerCase(),
        )
        const portraitUrl = normalizeImageDataUrl(character?.portrait)
        if (portraitUrl) {
          portraitUrls.push(portraitUrl)
        }
      }

      if (portraitUrls.length > 0) {
        if (!this.isImageGenerationEnabled(undefined, 'reference')) {
          log('Reference image generation not configured')
          return false
        }
        // Use reference profile and model for img2img
        profileId = imageSettings.referenceProfileId
        modelToUse = getImageProfile(profileId ?? '')?.model ?? ''
        sizeToUse = imageSettings.referenceSize
        referenceImageUrls = portraitUrls
        styleId = imageSettings.styleId
        log('Using character portraits as reference', {
          characters: scene.characters,
          count: portraitUrls.length,
        })
      }
    }

    // For portrait generation, use portrait-specific settings
    if (scene.generatePortrait) {
      if (!this.isImageGenerationEnabled(undefined, 'portrait')) {
        log('Portrait image generation not configured')
        return false
      }
      profileId = imageSettings.portraitProfileId
      modelToUse = getImageProfile(profileId ?? '')?.model ?? ''
      sizeToUse = imageSettings.portraitSize
      styleId = imageSettings.portraitStyleId
    }

    if (!profileId) {
      log('No image profile configured, skipping scene')
      return false
    }

    // Build full prompt with style
    const stylePrompt = await resolveStylePrompt(storyId, styleId)
    const fullPrompt = `${scene.prompt}. ${stylePrompt}`
    if (context.trigger === 'manual' && !(await this.manualImageScopeCurrent(context))) return false

    const { width, height } = expectedPixels(sizeToUse)
    // Create pending record in database
    const embeddedImage: Omit<EmbeddedImage, 'createdAt'> = {
      id: imageId,
      storyId,
      entryId,
      sourceText: scene.sourceText,
      contentVersion: context.contentVersion,
      prompt: fullPrompt,
      styleId: styleId,
      model: modelToUse,
      imageData: '',
      width,
      height,
      status: 'pending',
      generationMode: 'analyzed',
    }

    await database.createEmbeddedImage(embeddedImage)
    if (context.trigger === 'manual' && !(await this.manualImageScopeCurrent(context))) {
      await database.deleteEmbeddedImage(imageId)
      return false
    }
    log('Created pending analyzed image record', {
      imageId,
      sceneType: scene.sceneType,
      priority: scene.priority,
      isPortrait: scene.generatePortrait,
    })

    if (context.diagnostic)
      context.onDiagnostic?.({
        ...context.diagnostic,
        finalPrompt: fullPrompt,
        imageModel: modelToUse,
        imageProfile: getImageProfile(profileId)?.name,
      })

    // Emit queued event
    emitImageQueued(imageId, entryId)

    // Start async generation (fire-and-forget)
    this.generateAnalyzedImage(
      imageId,
      fullPrompt,
      profileId!,
      modelToUse!,
      sizeToUse,
      entryId,
      scene,
      presentCharacters,
      referenceImageUrls,
      context.trigger === 'manual',
    ).catch((error) => {
      log('Async analyzed image generation failed', { imageId, error })
    })
    return true
  }

  /**
   * Generate a single analyzed image using the SDK (runs asynchronously).
   */
  private async generateAnalyzedImage(
    imageId: string,
    prompt: string,
    profileId: string,
    model: string,
    size: ImageSpec,
    entryId: string,
    scene: ImageableScene,
    presentCharacters: Character[],
    referenceImageUrls?: string[],
    notifyFailure = false,
  ): Promise<void> {
    try {
      log('Generating analyzed image', {
        imageId,
        profileId,
        model,
        sceneType: scene.sceneType,
        hasReference: !!referenceImageUrls?.length,
      })

      const base64 = await runImageGeneration({
        imageId,
        entryId,
        prompt,
        profileId,
        model,
        size,
        referenceImages: referenceImageUrls,
        notifyFailure,
      })

      if (!base64) return

      // If this was a portrait generation, save to character
      if (scene.generatePortrait && scene.characters.length > 0) {
        const charName = scene.characters[0]
        const character = presentCharacters.find(
          (c) => c.name.toLowerCase() === charName.toLowerCase(),
        )
        if (character) {
          await database.updateCharacter(character.id, {
            portrait: base64,
          })
          log('Saved portrait to character', { characterId: character.id, name: charName })
        }
      }

      log('Analyzed image generated successfully', { imageId })
    } catch (error) {
      // `runImageGeneration` records its own outcome and balances the queued count, so
      // anything thrown past it comes from saving the portrait onto its character.
      log('Saving the generated portrait failed', { imageId, error })
    }
  }

  /**
   * Analyze the difference between two story responses and generate a new background image if needed.
   * This is used to detect when the scene has changed enough to warrant a new background image and generate it.
   */
  async analyzeBackgroundChangeAndGenerateImage(
    storyId: string,
    visibleEntries: StoryEntry[],
    onBackgroundImageUpdate: (image: string) => void,
  ): Promise<void> {
    const sourceStory = await database.getStory(storyId).catch(() => null)
    if (!sourceStory?.settings?.backgroundImagesEnabled || getImageConfigurationIssue('background'))
      return
    const backgroundStillEnabled = async () => {
      const current = await database.getStory(storyId).catch(() => null)
      return (
        current?.settings?.backgroundImagesEnabled === true &&
        current.currentBranchId === sourceStory.currentBranchId &&
        !getImageConfigurationIssue('background')
      )
    }
    // Two phases, two separate pairs, each closed in a `finally`: the progress counters
    // read `Started`/`Complete` and `Queued`/`Ready`, and a single try/catch around both
    // left them open. A throw while generating reported an analysis failure for a phase
    // that had already completed, and a generation that simply returned nothing never
    // balanced its `Queued` at all — the header then showed "1 image" until restart.
    // `createBackgroundImageService` throws when no background profile is configured, so it
    // stays inside the try: this is called fire-and-forget from `story.svelte.ts`, where a
    // rejected promise is an unhandled rejection rather than a logged failure.
    emitBackgroundImageAnalysisStarted()
    let service: ReturnType<typeof serviceFactory.createBackgroundImageService> | null = null
    let result: BackgroundImageAnalysisResult | null = null
    try {
      service = serviceFactory.createBackgroundImageService()
      result = await service.analyzeResponsesForBackgroundImage(storyId, visibleEntries)
    } catch (error) {
      emitBackgroundImageAnalysisFailed()
      log('Background image analysis failed', error)
    } finally {
      emitBackgroundImageAnalysisComplete()
    }

    // Ai returns empty string or short response if no change, otherwise the image prompt
    if (!service || !result?.changeNecessary || !(await backgroundStillEnabled())) return

    log('Background change detected, prompt:', result.prompt)
    emitBackgroundImageQueued()
    try {
      const image = await service.generateBackgroundImage(result.prompt)

      if (image && (await backgroundStillEnabled())) {
        log('Background image generated successfully', { image })
        onBackgroundImageUpdate(image)
      } else {
        log('Background image generation failed')
        emitBackgroundImageAnalysisFailed()
      }
    } catch (error) {
      emitBackgroundImageAnalysisFailed()
      log('Background image generation failed', error)
    } finally {
      emitBackgroundImageReady()
    }
  }

  // ===== Translation Methods =====

  /**
   * Translate narrative content.
   */
  async translateNarration(
    content: string,
    targetLanguage: string,
    isVisualProse: boolean,
    storyId: string | undefined,
  ): Promise<TranslationResult> {
    const service = serviceFactory.createTranslationService('narration')
    return service.translateNarration(content, targetLanguage, isVisualProse, storyId)
  }

  /**
   * Translate user input to English.
   */
  async translateInput(
    content: string,
    sourceLanguage: string,
    storyId: string | undefined,
  ): Promise<TranslationResult> {
    const service = serviceFactory.createTranslationService('input')
    return service.translateInput(content, sourceLanguage, storyId)
  }

  /**
   * Batch translate UI elements.
   */
  async translateUIElements(
    items: UITranslationItem[],
    targetLanguage: string,
    storyId: string | undefined,
  ): Promise<UITranslationItem[]> {
    const service = serviceFactory.createTranslationService('ui')
    return service.translateUIElements(items, targetLanguage, storyId)
  }

  /**
   * Translate suggestions.
   */
  async translateSuggestions<T extends { text: string; type?: string }>(
    suggestions: T[],
    targetLanguage: string,
    storyId: string | undefined,
  ): Promise<T[]> {
    const service = serviceFactory.createTranslationService('suggestions')
    return service.translateSuggestions(suggestions, targetLanguage, storyId)
  }

  /**
   * Translate action choices.
   */
  async translateActionChoices<T extends { text: string; type?: string }>(
    choices: T[],
    targetLanguage: string,
    storyId: string | undefined,
  ): Promise<T[]> {
    const service = serviceFactory.createTranslationService('actionChoices')
    return service.translateActionChoices(choices, targetLanguage, storyId)
  }

  /**
   * Translate wizard content.
   */
  async translateWizardContent(
    content: string,
    targetLanguage: string,
    packId: string | undefined,
  ): Promise<TranslationResult> {
    const service = serviceFactory.createTranslationService('wizard')
    return service.translateWizardContent(content, targetLanguage, packId)
  }

  /**
   * Batch translate wizard content.
   */
  async translateWizardBatch(
    fields: Record<string, string>,
    targetLanguage: string,
    packId: string | undefined,
  ): Promise<Record<string, string>> {
    const service = serviceFactory.createTranslationService('wizard')
    return service.translateWizardBatch(fields, targetLanguage, packId)
  }
}

export const aiService = new AIService()
