<script lang="ts">
  import type { NovelRetry, CollaborativeWriterRecovery } from '$lib/types/collaborative'
  import {
    recoveryFingerprint,
    recoveryScopeMatches,
    recoveryWasSaved,
  } from '$lib/services/generation/writerRecovery'
  import { novelRetry, historyKey } from '$lib/services/generation/collaborative'
  import { createStateMaintenanceRecord } from '$lib/services/collaborativeStateMaintenance'
  import { tick } from 'svelte'
  import { ui, type RetrievalCacheKey } from '$lib/stores/ui.svelte'
  import { toRetrievalSnapshot } from '$lib/services/ai/retrieval'
  import { buildTimelineFillBlock } from '$lib/services/ai/generation'
  import { joinPromptBlocks } from '$lib/utils/promptBlocks'
  import { countTokens } from '$lib/services/tokenizer'
  import { story } from '$lib/stores/story.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import type { EntryMetadata, Story } from '$lib/types'
  import { aiService } from '$lib/services/ai'
  import { collaborativeServiceIds } from '$lib/services/ai/core/collaborativeAgentDefaults'
  import { database } from '$lib/services/database'
  import { SimpleActivationTracker } from '$lib/services/ai/retrieval/EntryRetrievalService'
  import { TranslationService } from '$lib/services/ai/utils/TranslationService'
  import {
    Send,
    Wand2,
    MessageSquare,
    Brain,
    Sparkles,
    RefreshCw,
    X,
    PenLine,
    Square,
  } from '@lucide/svelte'
  import Suggestions from './Suggestions.svelte'
  import GrammarCheck from './GrammarCheck.svelte'
  import {
    emitUserInput,
    emitNarrativeResponse,
    emitSuggestionsReady,
    emitTTSQueued,
    eventBus,
    type ResponseStreamingEvent,
    type ClassificationCompleteEvent,
  } from '$lib/services/events'
  import { isTouchDevice } from '$lib/utils/swipe'
  import { isAndroid } from '$lib/utils/platform'
  import { findPrecedingUserAction } from '$lib/utils/storyEntries'
  import { errMessage } from '$lib/utils/error'
  import {
    GenerationPipeline,
    retryService,
    BackgroundTaskCoordinator,
    WorldStateTranslationService,
    handleEvent,
    SuggestionsRefreshService,
    buildLoreManagementCallbacks,
    buildLoreManagementUICallbacks,
    type PipelineDependencies,
    type PipelineConfig,
    type GenerationContext,
    type RetrievalResult,
    type BackgroundTaskDependencies,
    type BackgroundTaskInput,
    type PipelineUICallbacks,
    type PipelineEventState,
  } from '$lib/services/generation'
  import { InlineImageTracker } from '$lib/services/ai/image'
  import {
    createGenerationScope,
    isGenerationScopeCurrent as isScopeCurrent,
  } from '$lib/utils/branchScope'

  function log(...args: any[]) {
    console.log('[ActionInput]', ...args)
  }

  // ============================================================================
  // Translation Helper
  // ============================================================================

  async function translateUserInput(
    content: string,
    translationSettings: typeof settings.translationSettings,
    targetStory = story.currentStory,
  ): Promise<{ promptContent: string; originalInput: string | undefined }> {
    if (
      targetStory?.mode === 'creative-writing' ||
      !TranslationService.shouldTranslateInput(translationSettings)
    ) {
      return { promptContent: content, originalInput: undefined }
    }

    try {
      log('Translating user input', {
        sourceLanguage: translationSettings.sourceLanguage,
      })
      const result = await aiService.translateInput(
        content,
        translationSettings.sourceLanguage,
        targetStory?.id,
      )
      log('Input translated', {
        originalLength: content.length,
        translatedLength: result.translatedContent.length,
      })
      return { promptContent: result.translatedContent, originalInput: content }
    } catch (error) {
      log('Input translation failed (non-fatal), using original', error)
      return { promptContent: content, originalInput: undefined }
    }
  }

  // ============================================================================
  // UI State
  // ============================================================================

  let inputValue = $state('')
  let actionType = $state<'do' | 'say' | 'think' | 'story' | 'free'>('do')
  let isRawActionChoice = $state(false)
  let stopRequested = false
  let activeAbortController: AbortController | null = null
  let activeRerollScope: ReturnType<typeof createGenerationScope> | null = null
  let activeTurnId: string | null = null
  let activeSuggestionsRefreshId: string | null = null
  let textareaRef: HTMLTextAreaElement | null = $state(null)

  // ============================================================================
  // Derived State
  // ============================================================================

  const isCreativeMode = $derived(story.storyMode === 'creative-writing')
  const isCollaborative = $derived(story.currentStory?.mode === 'creative-writing')
  const collaborativeSuggestionsEnabled = $derived(
    !isCollaborative ||
      story.currentStory?.settings?.collaborativeNovelWorkflow?.plotSuggestions?.enabled !== false,
  )

  const sendKeyHint = $derived(
    isTouchDevice() ? 'Shift+Enter 发送' : 'Enter 发送，Shift+Enter 换行',
  )

  function generationBlockReason(writerOnly = false) {
    const current = story.currentStory
    if (!isCollaborative || !current)
      return settings.hasGenerationConfigIssues ? '模型配置不完整，请检查设置' : ''
    const workflow = current.settings?.collaborativeNovelWorkflow
    try {
      for (const agent of ['sceneDirector', 'writer', 'factStateExtractor'] as const) {
        if (writerOnly && agent === 'sceneDirector') continue
        if (agent === 'factStateExtractor' && workflow?.factStateExtractor?.enabled === false)
          continue
        const serviceId = collaborativeServiceIds[agent]
        const presetId = settings.getServicePresetId(serviceId)
        const preset = settings.generationPresets.find((candidate) => candidate.id === presetId)
        if (!preset) return `中文写作 ${agent} 未绑定有效 Agent Profile`
        const profileId = preset.profileId ?? settings.apiSettings.mainNarrativeProfileId
        if (!settings.getProfile(profileId)) return `中文写作 ${agent} 的模型连接不存在`
        if (!preset.model?.trim()) return `中文写作 ${agent} 未配置模型`
        if (!Number.isFinite(preset.maxTokens) || preset.maxTokens <= 0)
          return `中文写作 ${agent} 输出 Token 上限无效`
      }
      return ''
    } catch (error) {
      return errMessage(error)
    }
  }
  const generationConfigError = $derived(generationBlockReason())
  const blockGeneration = $derived(Boolean(generationConfigError))

  let writerRecovery = $state<CollaborativeWriterRecovery | null>(null)
  let recoveryHidden = $state(false)
  let recoveryBusy = $state(false)
  let recoveryMessage = $state('')
  let recoveryLoadKey = ''
  $effect(() => {
    const current = story.currentStory
    const key = current ? `${current.id}:${current.currentBranchId ?? 'main'}` : ''
    if (key === recoveryLoadKey) return
    recoveryLoadKey = key
    writerRecovery = null
    recoveryHidden = false
    recoveryMessage = ''
    if (!current || current.mode !== 'creative-writing') return
    void database
      .getWriterRecovery(current.id, current.currentBranchId ?? null)
      .then(async (record) => {
        if (key !== recoveryLoadKey || !record) return
        if (recoveryWasSaved(record, await database.getStoryEntry(record.narrationEntryId))) {
          await database.clearWriterRecovery(record.storyId, record.branchId, record.id)
          return
        }
        if (key === recoveryLoadKey) writerRecovery = record
      })
      .catch((error) => ui.showToast(`无法读取正文恢复记录：${errMessage(error)}`, 'warning'))
  })

  async function currentRecoveryFingerprint(
    record: CollaborativeWriterRecovery,
    excludeVariant = false,
  ) {
    const current = story.currentStory
    const action = story.entries.find((entry) => entry.id === record.userActionEntryId)
    if (!current || !action) throw new Error('原用户输入不存在，请重新提交本轮要求。')
    const entries = excludeVariant
      ? story.entries.filter((e) => e.id !== record.variantBaseEntryId)
      : story.entries
    const ctx: GenerationContext = {
      story: current,
      visibleEntries: entries,
      allEntries: entries,
      worldState: story.worldStateSnapshot,
      userAction: { entryId: action.id, content: action.content, rawInput: action.content },
    }
    if (!recoveryScopeMatches(record, ctx))
      throw new Error('故事、分支或原用户输入已变化，请重新运行整轮。')
    return recoveryFingerprint(ctx, {
      packId: await database.getStoryPackId(current.id),
      variables: await database.getStoryCustomVariables(current.id),
    })
  }

  async function resumeWriterRecovery(fullTurn = false) {
    const record = writerRecovery
    if (!record || recoveryBusy || ui.isGenerating || ui.submissionScope) return
    recoveryBusy = true
    recoveryMessage = ''
    try {
      if (
        story.currentStory?.id !== record.storyId ||
        (story.currentStory.currentBranchId ?? null) !== record.branchId
      )
        throw new Error('当前故事或分支已变化，请返回原分支恢复。')
      if (!fullTurn) {
        const fingerprint = await currentRecoveryFingerprint(record)
        // A process interruption can leave the old variant visible with its state already
        // undone. In that window only the original pre-Writer fingerprint is valid.
        const interruptedRerollMatches =
          !!record.variantBaseEntryId &&
          !record.settledFingerprint &&
          (await currentRecoveryFingerprint(record, true)) === record.contextFingerprint
        if (
          fingerprint !== (record.settledFingerprint ?? record.contextFingerprint) &&
          !interruptedRerollMatches
        )
          throw new Error('故事历史、状态或设定已变化，原导演结果已过期，请重新运行整轮。')
      }
      if (record.variantBaseEntryId) {
        await handleRegenerateNarration(record.variantBaseEntryId, fullTurn ? undefined : record)
      } else {
        const action = story.entries.find((e) => e.id === record.userActionEntryId)!
        const latest = story.entries.findLast(
          (e) => e.type === 'user_action' || e.type === 'narration',
        )
        if (!action || latest?.id !== action.id)
          throw new Error('本轮已不是最新输入，请在当前故事末尾重新提交要求。')
        await generateResponse(action.id, action.content, {
          writerRecovery: fullTurn ? undefined : record,
        })
      }
    } catch (error) {
      recoveryMessage = errMessage(error)
    } finally {
      recoveryBusy = false
    }
  }

  // ============================================================================
  // Action Type Configuration
  // ============================================================================

  type ActionType = 'do' | 'say' | 'think' | 'story' | 'free'

  const actionIcons = {
    do: Wand2,
    say: MessageSquare,
    think: Brain,
    story: Sparkles,
    free: PenLine,
  }
  const actionLabels: Record<ActionType, string> = {
    do: '行动',
    say: '对白',
    think: '想法',
    story: '剧情',
    free: '自由输入',
  }
  const actionBorderColors: Record<ActionType, string> = {
    do: 'border-l-emerald-500',
    say: 'border-l-blue-500',
    think: 'border-l-purple-500',
    story: 'border-l-amber-500',
    free: 'border-l-surface-600',
  }
  const actionActiveStyles: Record<ActionType, string> = {
    do: 'bg-emerald-500/15 text-emerald-400',
    say: 'bg-blue-500/15 text-blue-400',
    think: 'bg-purple-500/15 text-purple-400',
    story: 'bg-amber-500/15 text-amber-400',
    free: 'bg-surface-600/30 text-surface-300',
  }
  const actionButtonStyles: Record<ActionType, string> = {
    do: 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10',
    say: 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10',
    think: 'text-purple-400 hover:text-purple-300 hover:bg-purple-500/10',
    story: 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10',
    free: 'text-surface-400 hover:text-surface-200 hover:bg-surface-500/10',
  }
  const actionTypes: ActionType[] = ['do', 'say', 'think', 'story', 'free']

  // POV-based prefixes/suffixes
  const protagonistName = $derived.by(
    () => story.characters.find((c) => c.relationship === 'self')?.name ?? 'The protagonist',
  )
  const pov = $derived(story.pov)

  const actionPrefixes = $derived.by(() => {
    switch (pov) {
      case 'third':
        return {
          do: `${protagonistName} `,
          say: `${protagonistName} says, "`,
          think: `${protagonistName} thinks, "`,
          story: '',
          free: '',
        }
      default:
        return {
          do: 'I ',
          say: 'I say, "',
          think: 'I think to myself, "',
          story: '',
          free: '',
        }
    }
  })
  const actionSuffixes = { do: '', say: '"', think: '"', story: '', free: '' }

  // ============================================================================
  // Effects
  // ============================================================================

  const activeStoryId = $derived(story.currentStory?.id)
  const activeBranchId = $derived(story.currentStory?.currentBranchId ?? null)

  $effect(() => {
    const storyId = activeStoryId
    const branchId = activeBranchId
    return () => {
      if (activeRerollScope?.storyId === storyId && activeRerollScope?.branchId === branchId)
        activeRerollScope = null
      if (ui.submissionScope?.storyId === storyId && ui.submissionScope?.branchId === branchId)
        ui.submissionScope = null
      if (activeSuggestionsRefreshId) {
        activeSuggestionsRefreshId = null
        ui.setSuggestionsLoading(false)
      }
      const scope = ui.generationScope
      if (
        scope?.storyId === storyId &&
        scope?.branchId === branchId &&
        scope?.turnId === activeTurnId
      ) {
        activeAbortController?.abort()
        ui.setNovelUserSummary(null, scope)
        ui.clearDirectorStreaming(scope)
        ui.endStreaming()
        ui.setGenerating(false)
      }
    }
  })

  $effect(() => {
    ui.setRetryCallback(handleRetry)
    return () => ui.setRetryCallback(null)
  })

  $effect(() => {
    ui.setRetryLastMessageCallback(handleRetryLastMessage)
    return () => ui.setRetryLastMessageCallback(null)
  })

  $effect(() => {
    ui.setRegenerateNarrationCallback(handleRegenerateNarration)
    return () => ui.setRegenerateNarrationCallback(null)
  })

  $effect(() => {
    ui.setRetryWriterCallback(handleWriterOnlyNarration)
    return () => ui.setRetryWriterCallback(null)
  })

  $effect(() => {
    const pendingAction = ui.pendingActionChoice
    if (pendingAction && !ui.isGenerating) {
      inputValue = pendingAction
      isRawActionChoice = true
      ui.clearPendingActionChoice()
    }
  })

  $effect(() => {
    const storyId = activeStoryId
    if (!storyId || inputValue.trim() || ui.isGenerating) return
    const pending = ui.consumePendingCreativeInput(storyId)
    if (pending) {
      inputValue = pending
      requestAnimationFrame(() => textareaRef?.focus())
    } else if (ui.consumeCreativeInputFocus(storyId)) {
      requestAnimationFrame(() => textareaRef?.focus())
    }
  })

  // Auto-regenerate suggestions/actions after time-travel delete when no saved actions found
  $effect(() => {
    if (ui.suggestionsRegenerationNeeded && !ui.isGenerating && story.entries.length > 0) {
      ui.suggestionsRegenerationNeeded = false
      if (!isCollaborative) regenerateActionsAfterDelete()
    }
  })

  // ============================================================================
  // Builder Functions
  // ============================================================================

  /**
   * `storyId` is the turn's, captured by the caller, not `story.currentStory` read live:
   * these run across the whole generation, and a story switch mid-turn would otherwise
   * point the rest of it at another story's pack.
   */
  function buildPipelineDependencies(storyId: string): PipelineDependencies {
    return {
      shouldUseAgenticRetrieval: () =>
        aiService.shouldUseAgenticRetrieval(settings.systemServicesSettings.timelineFill),
      runAgenticRetrieval: (options) =>
        aiService.runAgenticRetrieval({
          ...options,
          storyId,
          getChapterEntries: story.getChapterEntries.bind(story),
          getUnchapterizedEntries: story.getUnchapterizedEntries.bind(story),
        }),
      // The chapter-read budget is derived from this story's own chapterization threshold, so
      // it is bound here with the rest of the store rather than read from settings: a chapter
      // is about `tokenThreshold` tokens by construction. See `story.chapterReadBudget`.
      runTimelineFill: (visibleEntries, chapters, alreadyInContext) =>
        aiService.runTimelineFill(
          storyId,
          visibleEntries,
          chapters,
          story.getChapterEntries.bind(story),
          alreadyInContext,
          story.chapterReadBudget,
        ),
      answerChapterQuestion: (chapterNumber, question, chapters) =>
        aiService.answerChapterQuestion(
          storyId,
          chapterNumber,
          question,
          chapters,
          story.getChapterEntries.bind(story),
          story.chapterReadBudget,
        ),
      buildWorldStateContext: (worldState, userInput, recentEntries, options) =>
        aiService.buildWorldStateContext(worldState, userInput, recentEntries, undefined, options),
      getRelevantLorebookEntries: aiService.getRelevantLorebookEntries.bind(aiService),
      streamNarrative: aiService.streamNarrative.bind(aiService),
      classifyResponse: aiService.classifyResponse.bind(aiService),
      translateNarration: aiService.translateNarration.bind(aiService),
      generateImagesForNarrative: (ctx) =>
        aiService.generateImagesForNarrative({
          ...ctx,
          imageGenerationMode: story.currentStory?.settings?.imageGenerationMode,
          allCharacters: story.characters,
          imageSettings: settings.systemServicesSettings.imageGeneration,
          getImageProfile: (id) => settings.getImageProfile(id),
        }),
      isImageGenerationEnabled: (storySettings, type) =>
        aiService.isImageGenerationEnabled(storySettings, type),
      generateSuggestions: aiService.generateSuggestions.bind(aiService),
      translateSuggestions: aiService.translateSuggestions.bind(aiService),
      generateActionChoices: aiService.generateActionChoices.bind(aiService),
      translateActionChoices: aiService.translateActionChoices.bind(aiService),
      analyzeBackgroundChangeAndGenerateImage: (storyId, visibleEntries) =>
        aiService.analyzeBackgroundChangeAndGenerateImage(storyId, visibleEntries, (image) => {
          if (
            story.currentStory?.id === storyId &&
            story.currentStory.settings?.backgroundImagesEnabled
          )
            void story.updateCurrentBackgroundImage(image)
        }),
    }
  }

  function buildBackgroundTaskDependencies(storyId: string): BackgroundTaskDependencies {
    return {
      chapterService: {
        analyzeForChapter: aiService.analyzeForChapter.bind(aiService),
        summarizeChapter: aiService.summarizeChapter.bind(aiService),
        getNextChapterNumber: story.getNextChapterNumber.bind(story),
        addChapter: story.addChapter.bind(story),
      },
      loreManagement: {
        runLoreManagement: aiService.runLoreManagement.bind(aiService),
      },
      styleReview: {
        analyzeStyle: (entries, mode, pov, tense, recentEntriesCount) =>
          aiService.analyzeStyle(storyId, entries, mode, pov, tense, recentEntriesCount),
      },
    }
  }

  function buildBackgroundTaskInput(
    currentStory: Story,
    countStyleReview: boolean,
    styleReviewSource: string,
  ): BackgroundTaskInput {
    const storyId = currentStory.id
    const branchId = currentStory.currentBranchId ?? null
    const mode = currentStory.mode ?? 'adventure'

    return {
      styleReview: {
        storyId,
        entries: story.entries,
        mode,
        pov: story.pov,
        tense: story.tense,
        enabled:
          currentStory.mode !== 'creative-writing' &&
          settings.systemServicesSettings.styleReviewer.enabled,
        triggerInterval: settings.systemServicesSettings.styleReviewer.triggerInterval,
        recentEntriesCount: settings.systemServicesSettings.styleReviewer.recentEntriesCount,
        currentCounter: ui.messagesSinceLastStyleReview,
        shouldIncrement: countStyleReview,
        source: styleReviewSource,
      },
      styleReviewCallbacks: {
        incrementCounter: ui.incrementStyleReviewCounter.bind(ui),
        setLoading: ui.setStyleReviewLoading.bind(ui),
        setResult: ui.setStyleReview.bind(ui),
      },
      chapterCheck: {
        storyId,
        currentBranchId: branchId,
        entries: story.entries,
        lastChapterEndIndex: story.lastChapterEndIndex,
        tokensSinceLastChapter: story.tokensSinceLastChapter,
        tokensOutsideBuffer: story.tokensOutsideBuffer,
        messagesSinceLastChapter: story.messagesSinceLastChapter,
        memoryConfig: story.memoryConfig,
        currentBranchChapters: story.currentBranchChapters,
        mode,
        pov: story.pov,
        tense: story.tense,
      },
      // A thunk: read when the session starts, after the classifier and the chapter check
      // have run. See BackgroundTaskInput.loreSession. The scope is the turn's, matching the
      // callbacks below, so a story switch refuses the session instead of misdirecting it.
      loreSession: () => ({
        storyId,
        currentBranchId: branchId,
        lorebookEntries: story.lorebookEntries,
        chapters: story.currentBranchChapters,
        recentEntries: story.getUnchapterizedEntries(),
        mode,
        pov: story.pov,
        tense: story.tense,
        tokenThreshold: story.memoryConfig.tokenThreshold,
      }),
      loreCallbacks: buildLoreManagementCallbacks({ storyId, branchId }),
      loreUICallbacks: buildLoreManagementUICallbacks(),
    }
  }

  // ============================================================================
  // Core Generation
  // ============================================================================

  /**
   * Send an OS notification when generation completes/fails while the app is backgrounded.
   * Only called on Android when the generationNotifications experimental feature is enabled.
   * Both body and largeBody are set so Android BigTextStyle keeps preview text
   * visible in collapsed, expanded, and grouped notification states.
   */
  async function sendGenerationNotification(responseText: string, success: boolean) {
    try {
      const { sendNotification, isPermissionGranted } =
        await import('@tauri-apps/plugin-notification')
      const permitted = await isPermissionGranted()
      if (!permitted) return

      if (success) {
        const previewText =
          settings.experimentalFeatures.notificationPreview && responseText.length > 0
            ? responseText.slice(0, 120).replace(/[<>]/g, '') +
              (responseText.length > 120 ? '…' : '')
            : 'Tap to return to your story.'
        sendNotification({
          title: '故事生成完成',
          body: previewText,
          largeBody: previewText,
        })
      } else {
        sendNotification({
          title: '故事生成失败',
          body: 'Tap to return and retry.',
          largeBody: 'Tap to return and retry.',
        })
      }
    } catch (e) {
      console.warn('[ActionInput] Failed to send notification:', e)
    }
  }

  /** Send a failure notification if the user was backgrounded during this generation. */
  async function notifyFailureIfBackgrounded() {
    if (
      ui.wasBackgroundedDuringGeneration &&
      settings.experimentalFeatures.generationNotifications
    ) {
      await sendGenerationNotification('', false)
    }
  }

  /**
   * The key a retrieval result would be stored under right now.
   *
   * Call it once the entries are in the state generation will run from, which always means
   * *after* the user action row exists: the write site captures `story.entries.length`
   * inside `generateResponse`, by which point `addEntry` (fresh turn) or the restore
   * (retry, regenerate) has already put it there. Called any earlier it computes a position
   * one lower than the stored key and can never match.
   */
  function retrievalKeyFor(actionContent: string): RetrievalCacheKey | null {
    const current = story.currentStory
    if (!current) return null
    return {
      storyId: current.id,
      branchId: current.currentBranchId ?? null,
      position: story.entries.length,
      actionContent,
    }
  }

  async function generateResponse(
    userActionEntryId: string,
    userActionContent: string,
    options?: {
      writerRecovery?: CollaborativeWriterRecovery
      countStyleReview?: boolean
      styleReviewSource?: string
      novelRetry?: NovelRetry
      cachedRetrievalResult?: RetrievalResult | null
      /** Existing narration row to receive a new same-turn variant (creative reroll). */
      variantBaseEntryId?: string
    },
  ) {
    const countStyleReview = options?.countStyleReview ?? true
    const styleReviewSource =
      options?.styleReviewSource ?? (countStyleReview ? 'new' : 'regenerate')

    if (!story.currentStory) return

    stopRequested = false
    const configError = generationBlockReason(!!options?.writerRecovery)
    if (configError) {
      ui.showToast(configError, 'error')
      return
    }
    activeAbortController?.abort()
    const abortController = new AbortController()
    activeAbortController = abortController

    const visualProseMode = story.currentStory.settings?.visualProseMode ?? false
    const inlineImageMode = story.currentStory.settings?.imageGenerationMode === 'inline'
    const streamingEntryId = crypto.randomUUID()
    const narrationEntryId =
      options?.writerRecovery?.narrationEntryId ??
      options?.variantBaseEntryId ??
      crypto.randomUUID()
    const previousVariantId = options?.variantBaseEntryId
      ? story.entries.find((entry) => entry.id === options.variantBaseEntryId)?.metadata?.variantSet
          ?.activeVariantId
      : undefined

    // Snapshot the narrative generation config so we can record which model/profile/effort
    // produced this response. Captured at start to reflect the settings used for the request.
    let writerBinding: import('$lib/types').GenerationPreset | undefined
    if (story.currentStory.mode === 'creative-writing') {
      try {
        writerBinding = settings.getPresetConfig(
          settings.getServicePresetId(collaborativeServiceIds.writer),
          collaborativeServiceIds.writer,
        )
      } catch (error) {
        ui.showToast(errMessage(error), 'error')
        if (activeAbortController === abortController) activeAbortController = null
        return
      }
    }
    const narrativeProfile = writerBinding?.profileId
      ? settings.getProfile(writerBinding.profileId)
      : settings.getMainNarrativeProfile()
    const generationStartedAt = Date.now()
    const generationMeta: EntryMetadata = {
      model: writerBinding?.model ?? settings.apiSettings.defaultModel,
      profileId: narrativeProfile?.id,
      profileName: narrativeProfile?.name,
      reasoningEffort:
        writerBinding?.reasoningEffort ?? settings.apiSettings.reasoningEffort ?? 'none',
      temperature: writerBinding?.temperature ?? settings.apiSettings.temperature,
      maxTokens: writerBinding?.maxTokens ?? settings.apiSettings.maxTokens,
      ...(writerBinding
        ? {
            collaborativeDiagnostics: {
              phases: [],
              sceneDirectorCompleted: false,
              writerTemplateId: 'collaborative-chinese-writer',
              translationPhases: 0,
            },
          }
        : {}),
    }

    ui.setGenerating(true)
    activeSuggestionsRefreshId = null
    ui.setSuggestionsLoading(false)
    ui.clearGenerationError()
    ui.clearActionChoices(story.currentStory.id)
    ui.startStreaming(visualProseMode, streamingEntryId)

    const currentStoryRef = story.currentStory
    const generationScope = createGenerationScope(
      currentStoryRef.id,
      currentStoryRef.currentBranchId ?? null,
    )
    activeTurnId = generationScope.turnId
    ui.beginGenerationScope(generationScope)
    const isGenerationScopeCurrent = () =>
      activeTurnId === generationScope.turnId &&
      ui.generationScope?.turnId === generationScope.turnId &&
      !abortController.signal.aborted &&
      isScopeCurrent(generationScope, story.currentStory)
    const generationWriteOptions = {
      scope: generationScope,
      isScopeCurrent: isGenerationScopeCurrent,
    }

    let inlineImageTracker: InlineImageTracker | null = null
    if (inlineImageMode) {
      inlineImageTracker = new InlineImageTracker(
        currentStoryRef.id,
        narrationEntryId,
        () => story.characters,
      )
    }

    // Android: start foreground service to keep process alive when backgrounded
    const useBackgroundService = isAndroid() && settings.experimentalFeatures.backgroundGeneration
    if (useBackgroundService) {
      try {
        window.AndroidBridge?.startGenerationService()
      } catch (e) {
        console.warn('[ActionInput] Failed to start generation foreground service:', e)
      }
    }
    ui.resetBackgroundedFlag()

    try {
      if (!options?.writerRecovery) {
        const previousRecovery = await database.getWriterRecovery(
          currentStoryRef.id,
          currentStoryRef.currentBranchId ?? null,
        )
        if (!isGenerationScopeCurrent()) return
        if (previousRecovery)
          await database.clearWriterRecovery(
            previousRecovery.storyId,
            previousRecovery.branchId,
            previousRecovery.id,
          )
        if (!isGenerationScopeCurrent()) return
        writerRecovery = null
      }
      const worldState = story.worldStateSnapshot

      const storyPosition = options?.variantBaseEntryId
        ? story.entries.filter((entry) => entry.id !== options.variantBaseEntryId).length
        : story.entries.length
      const activationTracker = ui.getActivationTracker(storyPosition) as SimpleActivationTracker
      const protagonist = story.characters.find((c) => c.relationship === 'self')

      const ctx: GenerationContext = {
        story: currentStoryRef,
        visibleEntries: options?.variantBaseEntryId
          ? story.visibleEntries.filter((entry) => entry.id !== options.variantBaseEntryId)
          : story.visibleEntries,
        allEntries: options?.variantBaseEntryId
          ? story.entries.filter((entry) => entry.id !== options.variantBaseEntryId)
          : story.entries,
        worldState,
        userAction: {
          entryId: userActionEntryId,
          content: userActionContent,
          rawInput: userActionContent,
        },
        narrationEntryId,
        abortSignal: abortController.signal,
      }

      if (
        options?.writerRecovery &&
        (await currentRecoveryFingerprint(options.writerRecovery, !!options.variantBaseEntryId)) !==
          options.writerRecovery.contextFingerprint
      )
        throw new Error('生成上下文已变化，不能复用旧 Director；请重新运行整轮。')
      const cfg: PipelineConfig = {
        writerRecovery: options?.writerRecovery,
        novelRetry:
          options?.novelRetry ??
          story.entries.find((e) => e.id === userActionEntryId)?.metadata?.novelRetry ??
          story.entries.findLast(
            (e) =>
              e.type === 'retry' &&
              e.position >
                (story.entries.find((a) => a.id === userActionEntryId)?.position ?? Infinity),
          )?.metadata?.novelRetry,
        rawInput: userActionContent,
        actionType,
        wasRawActionChoice: false,
        memoryRetrievalEnabled: settings.systemServicesSettings.timelineFill?.enabled ?? true,
        storyMode: currentStoryRef.mode ?? 'adventure',
        pov: story.pov,
        tense: story.tense,
        // Gated on the setting, not just on the scheduler: `lastStyleReview` is persisted
        // and restored on load, so a review produced before the feature was switched off
        // would otherwise keep reaching the narrator prompt forever.
        styleReview:
          currentStoryRef.mode !== 'creative-writing' &&
          settings.systemServicesSettings.styleReviewer.enabled
            ? ui.lastStyleReview
            : null,
        activationTracker,
        translationSettings: settings.translationSettings,
        imageSettings: {
          imageGenerationMode: currentStoryRef.settings?.imageGenerationMode ?? 'agentic',
          backgroundImagesEnabled: currentStoryRef.settings?.backgroundImagesEnabled ?? false,
          referenceMode: currentStoryRef.settings?.referenceMode ?? false,
        },
        promptContext: {
          mode: story.storyMode,
          pov: story.pov,
          tense: story.tense,
          protagonistName: protagonist?.name || 'the protagonist',
          genre: currentStoryRef.genre ?? undefined,
          settingDescription: currentStoryRef.description ?? undefined,
          tone: currentStoryRef.settings?.tone ?? undefined,
          themes: currentStoryRef.settings?.themes ?? undefined,
        },
        disableSuggestions:
          currentStoryRef.mode === 'creative-writing' || settings.uiSettings.disableSuggestions,
        activeThreads: story.pendingQuests,
        cachedRetrievalResult: options?.cachedRetrievalResult ?? null,
      }

      const deps = {
        ...buildPipelineDependencies(currentStoryRef.id),
        prepareCollaborative: aiService.prepareCollaborative.bind(aiService),
      }
      const pipeline = new GenerationPipeline(deps)

      let fatalMessage = ''
      let fullResponse = ''
      let fullReasoning = ''
      let narrationEntry: Awaited<ReturnType<typeof story.addEntry>> | null = null
      let generatedVariantId: string | null = null
      let classificationFailed = false
      let classificationObserved = false
      let variantClassificationResult:
        import('$lib/services/ai/sdk/schemas/classifier').ClassificationResult | null = null
      let deferredBackgroundImageStarted = false
      let turnRecovery = options?.writerRecovery
      let turnRetrieval: RetrievalResult | undefined

      const eventState: PipelineEventState = {
        fullResponse: () => fullResponse,
        fullReasoning: () => fullReasoning,
        streamingEntryId,
        visualProseMode,
        isCreativeMode,
        storyId: currentStoryRef.id,
        isScopeCurrent: isGenerationScopeCurrent,
        activeParallelPhases: new Set(),
      }

      const persistSuggestedActions = (actions: unknown[], type: 'suggestions' | 'choices') => {
        if (!isCollaborative && narrationEntry && actions.length > 0) {
          database
            .updateStoryEntry(narrationEntry.id, {
              suggestedActions: JSON.stringify(actions),
            })
            .catch((err) =>
              console.warn(`[ActionInput] Failed to save suggested ${type} to entry:`, err),
            )
        }
      }

      const eventCallbacks: PipelineUICallbacks = {
        startStreaming: ui.startStreaming.bind(ui),
        appendStreamContent: ui.appendStreamContent.bind(ui),
        appendReasoningContent: ui.appendReasoningContent.bind(ui),
        startDirectorStreaming: () => ui.startDirectorStreaming(generationScope),
        appendDirectorContent: (content) =>
          ui.appendDirectorStreamContent(content, generationScope),
        collapseDirectorPanel: () => ui.collapseDirectorPanel(generationScope),
        setGenerationStatus: ui.setGenerationStatus.bind(ui),
        setNovelTurn: (turn) => {
          generationMeta.novelTurn = turn
        },
        setNovelUserSummary: (summary) => {
          generationMeta.novelUserSummary = summary
          ui.setNovelUserSummary(summary, generationScope)
        },
        setSuggestionsLoading: ui.setSuggestionsLoading.bind(ui),
        setActionChoicesLoading: ui.setActionChoicesLoading.bind(ui),
        setSuggestions: (suggestions, storyId) => {
          ui.setSuggestions(suggestions, storyId)
          persistSuggestedActions(suggestions, 'suggestions')
        },
        setActionChoices: (choices, storyId) => {
          ui.setActionChoices(choices, storyId)
          persistSuggestedActions(choices, 'choices')
        },
        emitResponseStreaming: (chunk, accumulated) => {
          eventBus.emit<ResponseStreamingEvent>({
            type: 'ResponseStreaming',
            chunk,
            accumulated,
          })
        },
        emitSuggestionsReady: (suggestions) => {
          emitSuggestionsReady(suggestions)
        },
      }

      for await (const event of pipeline.execute(ctx, cfg)) {
        if (stopRequested) break

        if (!isGenerationScopeCurrent()) {
          abortController.abort()
          break
        }
        const diagnostics = generationMeta.collaborativeDiagnostics
        if (diagnostics) {
          if (event.type === 'phase_start') {
            diagnostics.phases.push(event.phase)
            if (event.phase === 'translation') diagnostics.translationPhases++
          } else if (event.type === 'phase_progress') {
            diagnostics.phases.push(`${event.phase}:${event.progress}`)
          } else if (event.type === 'phase_complete' && event.phase === 'scene_director') {
            diagnostics.sceneDirectorCompleted = true
            if (
              event.result &&
              typeof event.result === 'object' &&
              'directorDiagnostics' in event.result
            ) {
              diagnostics.sceneDirector = (
                event.result as { directorDiagnostics?: typeof diagnostics.sceneDirector }
              ).directorDiagnostics
              if (diagnostics.sceneDirector?.directorFallback) {
                ui.showToast(
                  `Director 调用失败，Writer 已按原始上下文继续：${diagnostics.sceneDirector.errorMessage ?? diagnostics.sceneDirector.reason ?? '未知错误'}`,
                  'warning',
                  10000,
                )
              }
            }
          }
        }
        handleEvent(event, eventState, eventCallbacks)

        if (event.type === 'phase_complete' && event.phase === 'scene_director') {
          const turn = generationMeta.novelTurn
          if (turn?.sceneDirectorOutput?.trim() && !turn.directorDiagnostics?.directorFallback) {
            turnRecovery = options?.writerRecovery ?? {
              version: 1,
              id: crypto.randomUUID(),
              storyId: currentStoryRef.id,
              branchId: currentStoryRef.currentBranchId ?? null,
              userActionEntryId,
              narrationEntryId,
              variantBaseEntryId: options?.variantBaseEntryId,
              previousVariantId,
              generatedVariantId: options?.variantBaseEntryId ? crypto.randomUUID() : undefined,
              novelRetry: cfg.novelRetry,
              novelTurn: JSON.parse(JSON.stringify(turn)),
              retrieval: JSON.parse(JSON.stringify(turnRetrieval)),
              contextFingerprint: await recoveryFingerprint(ctx, {
                packId: await database.getStoryPackId(currentStoryRef.id),
                variables: await database.getStoryCustomVariables(currentStoryRef.id),
              }),
              createdAt: Date.now(),
            }
            if (!isGenerationScopeCurrent()) break
            await database.saveWriterRecovery(turnRecovery)
            if (!isGenerationScopeCurrent()) break
            writerRecovery = turnRecovery
            recoveryHidden = false
            generationMeta.writerRecoveryId = turnRecovery.id
            generationMeta.writerReplay = JSON.parse(JSON.stringify(turnRecovery))
          }
        }

        if (event.type === 'phase_complete' && event.phase === 'retrieval') {
          const retrievalResult = event.result as RetrievalResult | undefined
          turnRetrieval = retrievalResult
          ui.setLastLorebookRetrieval(
            retrievalResult?.lorebookRetrievalResult ?? null,
            retrievalResult?.worldStateRetrievalResult ?? null,
            // Whichever memory mode ran: agentic fills `chapterContext`, static the Q&A.
            joinPromptBlocks(
              retrievalResult?.chapterContext ?? null,
              buildTimelineFillBlock(retrievalResult?.timelineFillResult),
            ) || null,
          )
          // Kept for the narration entry below: the in-memory copy dies with the session.
          generationMeta.retrievalSnapshot =
            toRetrievalSnapshot(
              retrievalResult?.lorebookRetrievalResult,
              retrievalResult?.worldStateRetrievalResult,
              countTokens,
            ) ?? undefined
          ui.setLastRetrievalResult(retrievalResult ?? null, {
            storyId: currentStoryRef.id,
            branchId: currentStoryRef.currentBranchId ?? null,
            position: storyPosition,
            actionContent: userActionContent,
          })
        }

        if (event.type === 'narrative_chunk') {
          fullResponse += event.content
          if (event.reasoning) fullReasoning += event.reasoning
          if (inlineImageTracker && !options?.variantBaseEntryId)
            inlineImageTracker.processChunk(
              fullResponse,
              currentStoryRef.settings?.referenceMode ?? false,
            )
        }

        if (event.type === 'phase_complete' && event.phase === 'narrative' && fullResponse.trim()) {
          if (generationMeta.novelTurn) {
            const result = event.result as import('$lib/services/generation/phases').NarrativeResult
            Object.assign(generationMeta.novelTurn, {
              requestedLength: result.requestedLength,
              actualChineseCharacters: result.actualChineseCharacters,
              outputMetricsWarning: result.outputMetricsWarning,
              shortStopReason: result.shortStopReason,
              outputTruncated: result.outputTruncated,
              finishReason: result.finishReason,
            })
            generationMeta.novelTurn.outputKey = historyKey([
              { type: 'narration', content: fullResponse } as import('$lib/types').StoryEntry,
            ])
            const writerPrompt = generationMeta.novelTurn.writerPrompt
            if (diagnostics && writerPrompt) {
              diagnostics.writerTemplateId = writerPrompt.templateId
              diagnostics.writerTemplateSource = `system: ${writerPrompt.systemSource}; user: ${writerPrompt.userSource}`
            }
          }
          if (diagnostics && import.meta.env.DEV) {
            console.debug('[ActionInput] collaborative generation diagnostics', {
              phases: diagnostics.phases,
              length: generationMeta.novelTurn?.actualChineseCharacters,
              directorOutputLength: generationMeta.novelTurn?.sceneDirectorOutput?.length ?? 0,
            })
          }
          generationMeta.generationTime = Date.now() - generationStartedAt
          if (isCollaborative)
            generationMeta.collaborativeStateMaintenance = createStateMaintenanceRecord(
              currentStoryRef.settings?.collaborativeNovelWorkflow?.factStateExtractor?.enabled ===
                false
                ? 'disabled'
                : 'failed',
              { error: '正文已保存，事实与状态提取尚未完成。' },
            )
          if (options?.variantBaseEntryId) {
            generatedVariantId = turnRecovery?.generatedVariantId ?? crypto.randomUUID()
            narrationEntry = await story.appendNarrationVariant(
              narrationEntryId,
              {
                id: generatedVariantId,
                content: fullResponse,
                reasoning: fullReasoning || undefined,
                metadata: generationMeta,
                classificationResult: null,
                worldStateDelta: null,
                suggestedActions: null,
                createdAt: Date.now(),
              },
              { activate: false },
            )
            // The variant is kept pending until the narrative stream has completed. Once
            // classification starts it becomes the working entry so the existing state
            // maintenance pipeline records its delta against the correct variant.
            narrationEntry = await story.activateNarrationVariant(
              narrationEntryId,
              generatedVariantId,
            )
          } else {
            narrationEntry = await story.addEntry(
              'narration',
              fullResponse,
              generationMeta,
              fullReasoning || undefined,
              narrationEntryId,
              generationWriteOptions,
            )
          }
          if (!isGenerationScopeCurrent()) break
          if (turnRecovery) {
            await database
              .clearWriterRecovery(turnRecovery.storyId, turnRecovery.branchId, turnRecovery.id)
              .catch((error) => log('Recovery cleanup deferred until next load', error))
            writerRecovery = null
          }
          if (isCollaborative && !options?.variantBaseEntryId) {
            // Materialize a one-item variant set for the first generated turn so
            // subsequent rerolls append to the same logical narration row.
            await story.updateNarrationVariant(narrationEntry.id, {})
          }
          ui.endStreaming()
          ui.setNovelUserSummary(null, generationScope)
          ui.clearDirectorStreaming(generationScope)
          emitNarrativeResponse(narrationEntry.id, fullResponse)
          // For rerolls, defer image persistence until fact/state maintenance has
          // committed the new variant. Otherwise images generated for a rejected
          // variant would be attached to the shared narration entry and survive after
          // the visible version is restored.
          if (!options?.variantBaseEntryId && inlineImageTracker?.hasPendingImages)
            await inlineImageTracker.flushToDatabase(narrationEntry.content)
        }

        if (event.type === 'classification_complete' && narrationEntry) {
          classificationObserved = true
          variantClassificationResult = event.result
          eventBus.emit<ClassificationCompleteEvent>({
            type: 'ClassificationComplete',
            messageId: narrationEntry.id,
            result: event.result,
          })
          // A world update that failed used to be indistinguishable from a turn that
          // changed nothing: same empty result, no error, no toast. Say it happened —
          // the alternative is the player noticing a missing location three turns later.
          if (event.result._error) {
            classificationFailed = true
            console.error('[ActionInput] World update failed:', event.result._error)
            ui.showToast('事实与状态提取未完全成功。正文已保留，可单独重试提取。', 'warning')
          }
          try {
            await story.applyClassificationResult(
              event.result,
              narrationEntry.id,
              generationWriteOptions,
            )
          } catch (error) {
            classificationFailed = true
            console.error('[ActionInput] Fact/state maintenance failed:', error)
            if (!event.result._error)
              ui.showToast('状态写入失败，正文已保留。可单独重试提取。', 'warning')
          }
          if (!isGenerationScopeCurrent()) break
          await story.updateEntryTimeEnd(narrationEntry.id, generationWriteOptions)
          if (!isGenerationScopeCurrent()) break

          const translationSettings = settings.translationSettings
          if (
            currentStoryRef.mode !== 'creative-writing' &&
            TranslationService.shouldTranslateWorldState(translationSettings)
          ) {
            const translationService = new WorldStateTranslationService({
              translateUIElements: aiService.translateUIElements.bind(aiService),
            })
            translationService
              .translateEntities(
                {
                  storyId: currentStoryRef.id,
                  isCollaborative: false,
                  classificationResult: {
                    newCharacters: event.result.entryUpdates.newCharacters,
                    newLocations: event.result.entryUpdates.newLocations,
                    newItems: event.result.entryUpdates.newItems,
                    newStoryBeats: event.result.entryUpdates.newStoryBeats,
                  },
                  worldState: {
                    characters: story.characters,
                    locations: story.locations,
                    items: story.items,
                    storyBeats: story.storyBeats,
                  },
                  targetLanguage: translationSettings.targetLanguage,
                  isScopeCurrent: isGenerationScopeCurrent,
                },
                {
                  updateCharacter: (id, data) => database.updateCharacter(id, data as any),
                  updateLocation: (id, data) => database.updateLocation(id, data as any),
                  updateItem: (id, data) => database.updateItem(id, data as any),
                  updateStoryBeat: (id, data) => database.updateStoryBeat(id, data as any),
                  refreshWorldState: story.refreshWorldState.bind(story),
                },
              )
              .catch((err) => log('World state translation failed (non-fatal)', err))
          }
        }

        if (event.type === 'phase_complete' && event.phase === 'translation' && narrationEntry) {
          const translationResult = event.result as
            | {
                translated: boolean
                translatedContent: string | null
                targetLanguage: string | null
              }
            | undefined
          if (translationResult?.translated && translationResult.translatedContent) {
            await database.updateStoryEntry(narrationEntry.id, {
              translatedContent: translationResult.translatedContent,
              translationLanguage: translationResult.targetLanguage,
            })
            if (!isGenerationScopeCurrent()) break
            await story.refreshEntry(narrationEntry.id)
          }
        }

        if (event.type === 'error' && event.fatal) {
          fatalMessage = event.error.message
          console.error('[ActionInput] Fatal pipeline error:', event.error)
          break
        }
      }

      if (!isGenerationScopeCurrent()) return
      if (isCollaborative && narrationEntry && !classificationObserved) {
        const extractorEnabled =
          currentStoryRef.settings?.collaborativeNovelWorkflow?.factStateExtractor?.enabled
        if (extractorEnabled !== false) classificationFailed = true
        const savedEntry = story.entries.find((entry) => entry.id === narrationEntry!.id)
        if (savedEntry) {
          const metadata = {
            ...savedEntry.metadata,
            collaborativeStateMaintenance: createStateMaintenanceRecord(
              extractorEnabled === false ? 'disabled' : 'failed',
              extractorEnabled === false ? undefined : { error: '事实与状态提取未完成。' },
            ),
          }
          await database.updateStoryEntry(savedEntry.id, { metadata, worldStateDelta: null })
          await story.refreshEntry(savedEntry.id)
        }
      }
      ui.updateActivationData(activationTracker, currentStoryRef.id)

      if (narrationEntry && generationMeta.collaborativeDiagnostics) {
        const savedEntry = story.entries.find((entry) => entry.id === narrationEntry.id)
        if (savedEntry) {
          await database.updateStoryEntry(savedEntry.id, {
            metadata: {
              ...savedEntry.metadata,
              collaborativeDiagnostics: generationMeta.collaborativeDiagnostics,
            },
          })
          if (!isGenerationScopeCurrent()) return
          await story.refreshEntry(savedEntry.id)
          if (!isGenerationScopeCurrent()) return
        }
      }

      // Keep all post-generation fields attached to the same-turn variant. The
      // top-level entry remains the compatibility mirror used by existing readers.
      if (options?.variantBaseEntryId && narrationEntry) {
        // Preserve the generated variant's diagnostic metadata before restoring the
        // previous visible version. `applyClassificationResult` writes the failure
        // record to the currently mirrored entry; after restoration that record must
        // be copied back to the pending generated variant, not read from the old one.
        const failedVariantSnapshot =
          classificationFailed && generatedVariantId
            ? story.entries.find((candidate) => candidate.id === narrationEntry!.id)?.metadata
            : undefined
        if (classificationFailed && previousVariantId && previousVariantId !== generatedVariantId) {
          try {
            // Classification failures are rolled back by the scoped maintenance pipeline;
            // restore only the visible compatibility mirror while keeping the generated
            // variant available as pending for a later state-extraction retry.
            await story.activateNarrationVariant(narrationEntry.id, previousVariantId)
          } catch (restoreError) {
            console.error(
              '[ActionInput] Failed to restore previous variant after state failure',
              restoreError,
            )
          }
        }
        const saved = story.entries.find((candidate) => candidate.id === narrationEntry!.id)
        if (saved) {
          await story.updateNarrationVariant(
            narrationEntry.id,
            {
              state: classificationFailed ? 'pending' : 'stored',
              ...(classificationFailed
                ? { metadata: failedVariantSnapshot ?? saved.metadata }
                : {
                    metadata: saved.metadata,
                    worldStateDelta: saved.worldStateDelta,
                    suggestedActions: saved.suggestedActions,
                    classificationResult: variantClassificationResult,
                  }),
            },
            generatedVariantId ? { variantId: generatedVariantId } : undefined,
          )
        }
        if (!classificationFailed && inlineImageTracker) {
          inlineImageTracker.processChunk(
            fullResponse,
            currentStoryRef.settings?.referenceMode ?? false,
          )
        }
        if (!classificationFailed && inlineImageTracker?.hasPendingImages) {
          await inlineImageTracker.flushToDatabase(narrationEntry.content)
        }

        // Creative rerolls defer background-image analysis until the generated
        // variant, its world-state delta, and the compatibility mirror have all
        // committed. The pipeline reports this phase as deferred; starting it here
        // prevents a later variant-write failure from leaving an image generated for
        // prose that was restored.
        if (
          isCollaborative &&
          !classificationFailed &&
          !deferredBackgroundImageStarted &&
          cfg.imageSettings.backgroundImagesEnabled !== false &&
          cfg.imageSettings.imageGenerationMode !== 'inline' &&
          deps.isImageGenerationEnabled(cfg.imageSettings, 'background')
        ) {
          deferredBackgroundImageStarted = true
          try {
            await deps.analyzeBackgroundChangeAndGenerateImage(currentStoryRef.id, story.entries)
          } catch (error) {
            // Background generation is non-fatal, matching the normal phase.
            log('Deferred reroll background image failed (non-fatal)', error)
          }
        }
      }

      if (fatalMessage || !narrationEntry) {
        const errorMessage = fatalMessage || '模型未返回完整正文，请重试。'
        if (typeof options !== 'undefined' && options?.variantBaseEntryId && generatedVariantId) {
          try {
            await story.discardNarrationVariant(
              options.variantBaseEntryId,
              generatedVariantId,
              previousVariantId,
            )
            if (previousVariantId) {
              await story.restoreNarrationVariantState(
                options.variantBaseEntryId,
                previousVariantId,
              )
            }
          } catch (restoreError) {
            console.error(
              '[ActionInput] Failed to restore reroll after generation failure',
              restoreError,
            )
          }
        }
        const errorEntry = await story.addEntry(
          'system',
          errorMessage,
          generationMeta.collaborativeDiagnostics
            ? { collaborativeDiagnostics: generationMeta.collaborativeDiagnostics }
            : undefined,
          undefined,
          undefined,
          generationWriteOptions,
        )
        if (!isGenerationScopeCurrent()) return
        ui.setGenerationError({
          message: errorMessage,
          errorEntryId: errorEntry.id,
          userActionEntryId,
          timestamp: Date.now(),
        })

        await notifyFailureIfBackgrounded()
        return
      }

      if (
        narrationEntry &&
        settings.systemServicesSettings.tts.enabled &&
        settings.systemServicesSettings.tts.autoPlay &&
        (!options?.variantBaseEntryId || !classificationFailed)
      ) {
        emitTTSQueued(narrationEntry.id, fullResponse)
      }

      // A failed reroll is restored to the previous active variant. Do not launch
      // background summarization/retrieval work for the rejected prose in that case.
      const skipPostGenerationTasks = Boolean(options?.variantBaseEntryId && classificationFailed)
      if (skipPostGenerationTasks) return

      const coordinator = new BackgroundTaskCoordinator(
        buildBackgroundTaskDependencies(currentStoryRef.id),
      )
      const input = buildBackgroundTaskInput(currentStoryRef, countStyleReview, styleReviewSource)
      input.scope = generationScope
      input.isScopeCurrent = isGenerationScopeCurrent
      if (!story.memoryConfig.autoSummarize) input.chapterCheck.tokensOutsideBuffer = 0
      // Deliberately not awaited — but the flag has to outlive the call, or the Memory
      // view will offer to create a chapter while this one is being created.
      const bgStoryId = currentStoryRef.id
      const bgBranchId = currentStoryRef.currentBranchId ?? null
      ui.setBackgroundTasksActive(bgStoryId, bgBranchId, true)
      coordinator
        .runBackgroundTasks(input)
        .catch((err) => log('Background tasks failed (non-fatal)', err))
        .finally(() => ui.setBackgroundTasksActive(bgStoryId, bgBranchId, false))

      // Android: notify user that generation completed while app is still backgrounded.
      // Awaited so the foreground service isn't torn down before the notification fires.
      if (
        ui.wasBackgroundedDuringGeneration &&
        ui.isAppBackgrounded &&
        settings.experimentalFeatures.generationNotifications
      ) {
        await sendGenerationNotification(fullResponse, true)
      }
    } catch (error) {
      // Only suppress handling when the user explicitly requested a stop.
      // An AbortError that arrives with stopRequested=false means the request
      // was cancelled externally (e.g. connection loss), so we still want to
      // record the error entry and send a failure notification.
      if (stopRequested) return
      console.error('[ActionInput] Generation error:', error)
      const baseMessage =
        error instanceof Error ? error.message : 'Failed to generate response. Please try again.'
      const errorMessage = ui.wasBackgroundedDuringGeneration
        ? `Generation may have been interrupted while the app was in the background. ${baseMessage}`
        : baseMessage
      if (!isGenerationScopeCurrent()) return
      const errorEntry = await story.addEntry(
        'system',
        `Generation failed: ${errorMessage}`,
        generationMeta.collaborativeDiagnostics
          ? { collaborativeDiagnostics: generationMeta.collaborativeDiagnostics }
          : undefined,
        undefined,
        undefined,
        generationWriteOptions,
      )
      if (!isGenerationScopeCurrent()) return
      ui.setGenerationError({
        message: errorMessage,
        errorEntryId: errorEntry.id,
        userActionEntryId,
        timestamp: Date.now(),
      })

      await notifyFailureIfBackgrounded()
    } finally {
      if (
        activeAbortController !== abortController ||
        ui.generationScope?.turnId !== generationScope.turnId
      )
        return
      ui.endStreaming()
      if (!activeRerollScope || !isScopeCurrent(activeRerollScope, story.currentStory))
        ui.setGenerating(false)
      ui.setGenerationStatus('')
      ui.setNovelUserSummary(null, generationScope)
      ui.clearDirectorStreaming(generationScope)
      if (stopRequested) {
        try {
          const record = await database.getWriterRecovery(
            currentStoryRef.id,
            currentStoryRef.currentBranchId ?? null,
          )
          if (record) await database.clearWriterRecovery(record.storyId, record.branchId, record.id)
          if (isScopeCurrent(generationScope, story.currentStory)) writerRecovery = null
        } catch (error) {
          log('Stopped Writer recovery cleanup failed', error)
        }
      }
      activeAbortController = null

      // Android: always stop the foreground service when generation ends
      if (useBackgroundService) {
        try {
          window.AndroidBridge?.stopGenerationService()
        } catch (e) {
          console.warn('[ActionInput] Failed to stop generation foreground service:', e)
        }
      }
    }
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Regenerate suggestions or action choices after a time-travel delete
   * when no previously saved actions were found on the restored entry.
   */
  async function regenerateActionsAfterDelete() {
    if (isCollaborative || !story.currentStory || story.entries.length === 0) return

    const storyMode = story.storyMode

    if (storyMode === 'creative-writing') {
      // For creative-writing mode, use the existing refresh mechanism
      await refreshSuggestions()
    } else if (storyMode === 'adventure') {
      // For adventure mode, generate new action choices
      if (settings.uiSettings.disableSuggestions) return

      ui.setActionChoicesLoading(true)
      try {
        const lastNarration = [...story.entries].reverse().find((e) => e.type === 'narration')
        if (!lastNarration) {
          ui.setActionChoicesLoading(false)
          return
        }

        const protagonist = story.characters.find((c) => c.relationship === 'self')
        const promptContext: import('$lib/services/generation/phases/PostGenerationPhase').PromptContext =
          {
            mode: 'adventure',
            pov: story.pov,
            tense: story.tense,
            protagonistName: protagonist?.name || 'the protagonist',
            genre: story.currentStory.genre ?? undefined,
            settingDescription: story.currentStory.description ?? undefined,
            tone: story.currentStory.settings?.tone ?? undefined,
            themes: story.currentStory.settings?.themes ?? undefined,
          }

        const worldState = {
          characters: story.characters,
          locations: story.locations,
          items: story.items,
          storyBeats: story.storyBeats,
        }

        const lorebookEntries = story.lorebookEntries
        const result = await aiService.generateActionChoices(
          story.entries,
          worldState,
          lastNarration.content,
          lorebookEntries,
          promptContext,
          story.pov,
          story.currentStory?.id,
        )

        if (result.choices.length > 0) {
          ui.setActionChoices(result.choices, story.currentStory!.id)
          // Also save to the last narration entry for future time-travel
          database
            .updateStoryEntry(lastNarration.id, {
              suggestedActions: JSON.stringify(result.choices),
            })
            .catch((err) =>
              console.warn('[ActionInput] Failed to save regenerated action choices:', err),
            )
        }
      } catch (error) {
        console.warn('[ActionInput] Failed to regenerate action choices after delete:', error)
      } finally {
        ui.setActionChoicesLoading(false)
      }
    }
  }

  async function refreshSuggestions() {
    if (!story.currentStory || ui.isGenerating) return
    const current = story.currentStory
    const mode = current.mode
    const isCollaborative = mode === 'creative-writing'
    if (
      isCollaborative &&
      current.settings?.collaborativeNovelWorkflow?.plotSuggestions?.enabled === false
    ) {
      ui.clearSuggestions(current.id)
      return
    }

    if (
      (!isCollaborative && story.storyMode !== 'creative-writing') ||
      story.entries.length === 0
    ) {
      ui.clearSuggestions(current.id)
      return
    }

    const scope = createGenerationScope(current.id, current.currentBranchId ?? null)
    activeSuggestionsRefreshId = scope.turnId
    const entries = story.entries.map((entry) => ({ ...entry }))
    const lastNarration = entries.findLast((e) => e.type === 'narration')
    const inputHistoryKey = historyKey(entries)
    const generationTurnId = ui.generationScope?.turnId
    const ownsRefresh = () =>
      activeSuggestionsRefreshId === scope.turnId && isScopeCurrent(scope, story.currentStory)
    const isCurrent = () =>
      ownsRefresh() &&
      !ui.isGenerating &&
      story.currentStory?.mode === mode &&
      (!isCollaborative ||
        story.currentStory?.settings?.collaborativeNovelWorkflow?.plotSuggestions?.enabled !==
          false) &&
      ui.generationScope?.turnId === generationTurnId &&
      historyKey(story.entries) === inputHistoryKey &&
      story.entries.findLast((e) => e.type === 'narration')?.id === lastNarration?.id
    ui.setSuggestionsLoading(true)
    try {
      const service = new SuggestionsRefreshService({
        generateSuggestions: aiService.generateSuggestions.bind(aiService),
        translateSuggestions: aiService.translateSuggestions.bind(aiService),
      })
      const result = await service.refresh({
        storyId: scope.storyId,
        isCollaborative,
        entries,
        pendingQuests: story.pendingQuests,
        storyMode: story.storyMode,
        lastLorebookRetrieval: ui.lastLorebookRetrieval?.all ?? null,
        translationSettings: settings.translationSettings,
      })
      if (!isCurrent()) return
      ui.setSuggestions(result.suggestions, scope.storyId)
      emitSuggestionsReady(result.suggestions.map((s) => ({ text: s.text, type: s.type })))
      // The legacy entry field has one shape per story mode. Collaborative inspiration uses
      // its story-scoped cache and must not compete with RPG choices for that field.
      if (
        !isCollaborative &&
        lastNarration &&
        (lastNarration.branchId ?? null) === scope.branchId &&
        result.suggestions.length > 0
      ) {
        database
          .updateStoryEntry(lastNarration.id, {
            suggestedActions: JSON.stringify(result.suggestions),
          })
          .catch((err) =>
            console.warn('[ActionInput] Failed to save refreshed suggestions to entry:', err),
          )
      }
    } catch (error) {
      log('Failed to generate suggestions:', error)
      if (isCurrent()) ui.clearSuggestions(scope.storyId)
    } finally {
      if (ownsRefresh()) {
        activeSuggestionsRefreshId = null
        ui.setSuggestionsLoading(false)
      }
    }
  }

  function handleSuggestionSelect(text: string) {
    inputValue = text
    document.querySelector('textarea')?.focus()
  }

  async function handleSubmit() {
    if (recoveryBusy) return
    if (!inputValue.trim() || ui.isGenerating || ui.submissionScope || !story.currentStory) return
    if (blockGeneration) {
      ui.showToast(generationConfigError, 'error')
      return
    }

    const current = story.currentStory
    const scope = createGenerationScope(current.id, current.currentBranchId ?? null)
    ui.submissionScope = scope
    const isCurrent = () =>
      ui.submissionScope?.turnId === scope.turnId && isScopeCurrent(scope, story.currentStory)
    const submittedActionType = actionType
    const submittedCreativeMode = isCreativeMode || isCollaborative
    const translationSettings = { ...settings.translationSettings }
    const initialEntries = [...story.entries]
    const initialHistory = historyKey(initialEntries)
    const generationTurnId = ui.generationScope?.turnId
    const historyUnchanged = () =>
      isCurrent() &&
      !ui.isGenerating &&
      ui.generationScope?.turnId === generationTurnId &&
      historyKey(story.entries) === initialHistory
    const world = {
      characters: [...story.characters],
      locations: [...story.locations],
      items: [...story.items],
      storyBeats: [...story.storyBeats],
      timeTracker: current.timeTracker ? { ...current.timeTracker } : null,
    }
    ui.clearGenerationError()
    ui.resetScrollBreak()
    ui.clearSuggestions(scope.storyId)

    const rawInput = inputValue.trim()
    const wasRawActionChoice = isRawActionChoice
    const forceFreeMode = settings.uiSettings.disableActionPrefixes

    let content: string
    if (isCollaborative || isCreativeMode || wasRawActionChoice || forceFreeMode) content = rawInput
    else content = actionPrefixes[actionType] + rawInput + actionSuffixes[actionType]

    isRawActionChoice = false
    inputValue = ''
    if (textareaRef) textareaRef.scrollTop = 0

    let actionSaved = false
    try {
      const embeddedImageIds = await database.getEmbeddedImageIdsForStory(scope.storyId)
      if (!historyUnchanged()) return
      ui.createRetryBackup(
        scope.storyId,
        initialEntries,
        world.characters,
        world.locations,
        world.items,
        world.storyBeats,
        embeddedImageIds,
        content,
        rawInput,
        submittedActionType,
        wasRawActionChoice,
        world.timeTracker,
      )

      const { promptContent, originalInput } = await translateUserInput(
        content,
        translationSettings,
        current,
      )
      if (!historyUnchanged()) return

      const userActionEntry = await story.addEntry(
        'user_action',
        promptContent,
        undefined,
        undefined,
        undefined,
        { scope, isScopeCurrent: isCurrent },
      )
      actionSaved = true
      if (!isCurrent()) return
      if (
        userActionEntry.storyId !== scope.storyId ||
        (userActionEntry.branchId ?? null) !== scope.branchId
      )
        throw new Error('提交写入目标与捕获的故事分支不一致，已停止生成。')

      if (originalInput) {
        await database.updateStoryEntry(userActionEntry.id, { originalInput })
        if (!isCurrent()) return
        await story.refreshEntry(userActionEntry.id)
        if (!isCurrent()) return
      }

      emitUserInput(
        content,
        submittedCreativeMode ? 'direction' : forceFreeMode ? 'free' : submittedActionType,
      )
      await tick()
      if (
        !isCurrent() ||
        ui.isGenerating ||
        ui.generationScope?.turnId !== generationTurnId ||
        story.entries.at(-1)?.id !== userActionEntry.id
      )
        return

      // `promptContent`, not the raw `content`: with translation on the two differ, and the
      // entry the narrator reads holds `promptContent`. Passing the raw text here left
      // retrieval and classification working from a different wording than the narration —
      // and the retry path already passes `promptContent`, so the two disagreed.
      await generateResponse(userActionEntry.id, promptContent)
    } catch (error) {
      if (isCurrent()) {
        if (!actionSaved && !inputValue) inputValue = rawInput
        ui.showToast(errMessage(error), 'error')
      }
    } finally {
      if (ui.submissionScope?.turnId === scope.turnId) ui.submissionScope = null
    }
  }

  async function handleStopGeneration() {
    if (stopRequested || ui.isRetryingLastMessage) return

    stopRequested = true
    activeAbortController?.abort()
    ui.endStreaming()
    if (activeRerollScope && isScopeCurrent(activeRerollScope, story.currentStory)) {
      ui.setGenerationStatus('正在结束重写并恢复状态…')
      return
    }
    ui.setGenerating(false)

    if (writerRecovery) {
      const record = writerRecovery
      await database.clearWriterRecovery(record.storyId, record.branchId, record.id)
      writerRecovery = null
    }
    const backup = ui.retryBackup
    if (!backup || !story.currentStory || backup.storyId !== story.currentStory.id) {
      if (backup) ui.clearRetryBackup()
      return
    }

    ui.setLastLorebookRetrieval(null)
    ui.setLastRetrievalResult(null)

    const result = await retryService.handleStopGeneration(
      backup,
      {
        restoreFromRetryBackup: story.restoreFromRetryBackup.bind(story),
        deleteEntriesFromPosition: story.deleteEntriesFromPosition.bind(story),
        deleteEntitiesCreatedAfterBackup: story.deleteEntitiesCreatedAfterBackup.bind(story),
        restoreCharacterSnapshots: story.restoreCharacterSnapshots.bind(story),
        restoreTimeTrackerSnapshot: story.restoreTimeTrackerSnapshot.bind(story),
        assertEntriesRemovable: story.assertEntriesRemovable.bind(story),
        lockRetryInProgress: story.lockRetryInProgress.bind(story),
        unlockRetryInProgress: story.unlockRetryInProgress.bind(story),
        restoreActivationData: ui.restoreActivationData.bind(ui),
        clearActivationData: () => ui.clearActivationData(),
        setLastLorebookRetrieval: ui.setLastLorebookRetrieval.bind(ui),
      },
      {
        clearGenerationError: () => ui.clearGenerationError(),
        clearSuggestions: () => ui.clearSuggestions(story.currentStory!.id),
        clearActionChoices: () => ui.clearActionChoices(story.currentStory!.id),
      },
    )

    if (!result.success) {
      // The backup is the only way back to the pre-action story, so a refused restore keeps it.
      ui.showToast(result.error ?? '无法恢复故事', 'error')
      return
    }

    await tick()
    actionType = (result.restoredActionType as ActionType) ?? actionType
    isRawActionChoice = result.restoredWasRawActionChoice ?? false
    inputValue = result.restoredRawInput ?? ''
    ui.clearRetryBackup(true)
  }

  async function handleRetry() {
    if (writerRecovery) return resumeWriterRecovery(true)
    const error = ui.lastGenerationError
    if (!error || ui.isGenerating) return

    const userActionEntry = story.entries.find((e) => e.id === error.userActionEntryId)
    if (!userActionEntry) {
      ui.clearGenerationError()
      return
    }

    try {
      await story.deleteEntry(error.errorEntryId)
    } catch (err) {
      // Regenerating over an entry that could not be removed would leave the failed one above
      // the new narration, so the retry stops here.
      ui.showToast(errMessage(err), 'error')
      return
    }
    ui.clearGenerationError()

    await generateResponse(userActionEntry.id, userActionEntry.content, {
      countStyleReview: false,
      styleReviewSource: 'retry-error',
    })
  }

  function dismissError() {
    ui.clearGenerationError()
  }

  /**
   * Regenerate a narration that has no matching retry backup. That is not the rare case
   * the name suggests: `ui.retryBackup` lives in an in-memory SvelteMap, so it is gone
   * after any app restart or story switch, and this is then the only regenerate available
   * for the last narration.
   *
   * Unlike `handleRetryLastMessage`, there is no pre-generation snapshot to restore from,
   * so the world state has to be unwound from what the entry itself recorded --
   * `undoNarrationForRegenerate`. Skipping that step let the discarded narration's
   * classification stay applied while the replacement's was added on top: story time
   * advanced twice for one user action, and entities it invented outlived it.
   */
  async function handleWriterOnlyNarration(entryId: string) {
    if (recoveryBusy || ui.isGenerating || ui.submissionScope) return
    const entry = story.entries.find((value) => value.id === entryId)
    const turn = entry?.metadata?.novelTurn
    const current = story.currentStory
    const action = entry && findPrecedingUserAction(story.entries, entry.id)
    if (
      !entry ||
      !current ||
      !action ||
      !turn?.sceneDirectorOutput?.trim() ||
      turn.directorDiagnostics?.directorFallback
    ) {
      ui.showToast('这条正文没有完整成功的 Director 输出，请使用重新展开。', 'warning')
      return
    }
    if (
      story.entries.findLast((e) => e.type === 'narration' || e.type === 'user_action')?.id !==
      entryId
    ) {
      ui.showToast('请先从这条正文创建分支，再单独重试 Writer。', 'warning')
      return
    }
    if (
      turn.rawInput !== action.content ||
      (turn.historyKey &&
        turn.historyKey !== historyKey(story.entries.filter((e) => e.id !== entryId)))
    ) {
      ui.showToast('用户输入或正文历史已变化，原 Director 已过期，请重新展开。', 'warning')
      return
    }
    const replay = entry.metadata?.writerReplay
    const record: CollaborativeWriterRecovery = {
      ...(replay
        ? JSON.parse(JSON.stringify(replay))
        : {
            version: 1,
            storyId: current.id,
            branchId: current.currentBranchId ?? null,
            userActionEntryId: action.id,
            novelTurn: JSON.parse(JSON.stringify(turn)),
            retrieval: {
              worldStateBlock: null,
              chapterContext: null,
              lorebookContext: null,
              lorebookRetrievalResult: null,
              worldStateRetrievalResult: null,
              timelineFillResult: null,
              combinedContext: null,
            },
            contextFingerprint: '',
            legacyContext: true,
          }),
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      narrationEntryId: entry.id,
      variantBaseEntryId: entry.id,
      previousVariantId: entry.metadata?.variantSet?.activeVariantId ?? `legacy-${entry.id}`,
      generatedVariantId: crypto.randomUUID(),
      settledFingerprint: undefined,
    }
    recoveryBusy = true
    try {
      if (record.legacyContext)
        ui.showToast(
          '旧版正文的原检索快照不完整：沿用已保存 Director，使用回退后的当前场景资料。',
          'warning',
          10000,
        )
      await handleRegenerateNarration(entryId, record)
    } finally {
      recoveryBusy = false
    }
  }

  async function handleRegenerateNarration(
    entryId: string,
    recovery?: CollaborativeWriterRecovery,
  ) {
    if (ui.isGenerating || ui.submissionScope || activeRerollScope || !story.currentStory) return
    const configError = generationBlockReason(!!recovery)
    if (configError) {
      ui.showToast(configError, 'error')
      return
    }
    const retryScope = createGenerationScope(
      story.currentStory.id,
      story.currentStory.currentBranchId ?? null,
    )

    const userActionEntry = findPrecedingUserAction(story.entries, entryId)
    if (!userActionEntry) return

    const rejectedEntry = story.entries.find((e) => e.id === entryId)
    const previousVariantId =
      rejectedEntry?.metadata?.variantSet?.activeVariantId ?? `legacy-${entryId}`
    const collaborative = story.currentStory.mode === 'creative-writing'
    const retry = recovery
      ? recovery.novelRetry
      : story.currentStory?.mode === 'creative-writing' && rejectedEntry
        ? novelRetry(rejectedEntry, userActionEntry.content)
        : undefined
    // A visible ancestor entry can be rerolled into the active child branch.
    if (retry) retry.branchId = retryScope.branchId
    const originalUserActionMetadata = userActionEntry.metadata
      ? { ...userActionEntry.metadata }
      : undefined
    let retryStoredOnUserAction = false
    let prepared = false
    stopRequested = false
    activeRerollScope = retryScope
    ui.submissionScope = retryScope
    const ownsReroll = () =>
      activeRerollScope === retryScope && isScopeCurrent(retryScope, story.currentStory)
    try {
      const undo = await story.undoNarrationForRegenerate(entryId, { preserveEntry: true })
      prepared = true
      if (!ownsReroll()) return
      if (recovery?.legacyContext && !recovery.contextFingerprint)
        recovery.contextFingerprint = await currentRecoveryFingerprint(recovery, true)
      if (!ownsReroll()) return
      ui.setGenerating(true)
      if (!undo.entitiesUndone) {
        ui.showToast('正文时间已回退，但旧版本的实体变化缺少可逆记录，未能撤销。', 'warning')
      }
      if (retry && userActionEntry.branchId === (story.currentStory?.currentBranchId ?? null)) {
        await database.updateStoryEntry(userActionEntry.id, {
          metadata: { ...userActionEntry.metadata, novelRetry: retry },
        })
        retryStoredOnUserAction = true
        if (!ownsReroll()) return
        await story.refreshEntry(userActionEntry.id)
      } else if (retry) {
        await story.addEntry(
          'retry',
          '本轮重写记录（不属于故事事实）',
          { novelRetry: retry },
          undefined,
          undefined,
          { scope: retryScope, isScopeCurrent: ownsReroll },
        )
      }
      if (!ownsReroll() || stopRequested) return
      const cachedRetrieval = retrievalKeyFor(userActionEntry.content)
      await generateResponse(userActionEntry.id, userActionEntry.content, {
        writerRecovery: recovery,
        countStyleReview: false,
        styleReviewSource: 'regenerate',
        novelRetry: retry,
        cachedRetrievalResult: cachedRetrieval ? ui.retrievalResultFor(cachedRetrieval) : null,
        variantBaseEntryId: entryId,
      })
    } catch (error) {
      const message = errMessage(error)
      console.error('[ActionInput] Reroll generation failed', {
        entryId,
        storyId: retryScope.storyId,
        branchId: retryScope.branchId,
        message,
        error,
      })
      ui.showToast(`${recovery ? 'Writer 重试' : '重roll'}失败：${message}`, 'error')
    } finally {
      try {
        if (prepared && collaborative && ownsReroll()) {
          await story.settleNarrationReroll(entryId, previousVariantId)
          if (writerRecovery?.variantBaseEntryId === entryId) {
            if (stopRequested) {
              await database.clearWriterRecovery(
                writerRecovery.storyId,
                writerRecovery.branchId,
                writerRecovery.id,
              )
              writerRecovery = null
            } else {
              const record = writerRecovery
              record.settledFingerprint = await currentRecoveryFingerprint(record)
              await database.saveWriterRecovery(record)
            }
          }
        }
      } catch (error) {
        console.error('[ActionInput] Reroll state recovery failed', error)
        if (ownsReroll())
          ui.showToast('正文已保留，状态恢复未完成；请单独重试事实与状态提取。', 'warning')
      } finally {
        try {
          if (retryStoredOnUserAction && ownsReroll()) {
            await database.updateStoryEntry(userActionEntry.id, {
              metadata: originalUserActionMetadata ?? null,
            })
            if (ownsReroll()) await story.refreshEntry(userActionEntry.id)
          }
        } finally {
          if (ownsReroll()) {
            ui.endStreaming()
            ui.setGenerating(false)
            ui.setGenerationStatus('')
            activeRerollScope = null
          }
          if (ui.submissionScope?.turnId === retryScope.turnId) ui.submissionScope = null
        }
      }
    }
  }

  async function handleRetryLastMessage() {
    const backup = ui.retryBackup
    console.log('[handleRetryLastMessage] called', {
      hasBackup: !!backup,
      isGenerating: ui.isGenerating,
    })
    if (!backup || ui.isGenerating || !story.currentStory) return
    if (backup.storyId !== story.currentStory.id) {
      ui.clearRetryBackup(false)
      return
    }

    if (story.currentStory.mode === 'creative-writing') {
      const last = story.entries.findLast((e) => e.type === 'narration')
      if (last) await handleRegenerateNarration(last.id)
      return
    }
    const storyId = story.currentStory.id

    const result = await retryService.handleRetryLastMessage(
      backup,
      {
        restoreFromRetryBackup: story.restoreFromRetryBackup.bind(story),
        deleteEntriesFromPosition: story.deleteEntriesFromPosition.bind(story),
        deleteEntitiesCreatedAfterBackup: story.deleteEntitiesCreatedAfterBackup.bind(story),
        restoreCharacterSnapshots: story.restoreCharacterSnapshots.bind(story),
        restoreTimeTrackerSnapshot: story.restoreTimeTrackerSnapshot.bind(story),
        assertEntriesRemovable: story.assertEntriesRemovable.bind(story),
        lockRetryInProgress: story.lockRetryInProgress.bind(story),
        unlockRetryInProgress: story.unlockRetryInProgress.bind(story),
        restoreActivationData: ui.restoreActivationData.bind(ui),
        clearActivationData: () => ui.clearActivationData(),
        setLastLorebookRetrieval: ui.setLastLorebookRetrieval.bind(ui),
      },
      {
        clearGenerationError: () => ui.clearGenerationError(),
        clearSuggestions: () => ui.clearSuggestions(storyId),
        clearActionChoices: () => ui.clearActionChoices(storyId),
      },
    )

    if (!result.success) {
      ui.showToast(result.error ?? '无法恢复故事', 'error')
      return
    }

    await tick()

    const { promptContent, originalInput } = await translateUserInput(
      backup.userActionContent,
      settings.translationSettings,
    )
    const userActionEntry = await story.addEntry('user_action', promptContent)

    if (originalInput) {
      await database.updateStoryEntry(userActionEntry.id, { originalInput })
      await story.refreshEntry(userActionEntry.id)
    }

    emitUserInput(backup.userActionContent, isCreativeMode ? 'direction' : backup.actionType)
    await tick()

    // Read here rather than before the rewind: the key carries the position, so it only
    // matches once the restore has put the story back where retrieval ran.
    const cacheKey = retrievalKeyFor(promptContent)

    ui.setRetryingLastMessage(true)
    try {
      await generateResponse(userActionEntry.id, promptContent, {
        countStyleReview: false,
        styleReviewSource: 'retry-last-message',
        cachedRetrievalResult: cacheKey ? ui.retrievalResultFor(cacheKey) : null,
      })
    } finally {
      ui.setRetryingLastMessage(false)
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    const isMobile = isTouchDevice()
    const shouldSubmit = isMobile
      ? event.key === 'Enter' && event.shiftKey
      : event.key === 'Enter' && !event.shiftKey
    if (shouldSubmit) {
      event.preventDefault()
      handleSubmit()
    }
  }

  function autoResize(node: HTMLTextAreaElement, _value?: string) {
    function resize() {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight}px`
    }
    resize()
    node.addEventListener('input', resize)
    return {
      update(_newValue?: string) {
        resize()
      },
      destroy() {
        node.removeEventListener('input', resize)
      },
    }
  }
</script>

<div class="ml-1 space-y-3">
  {#if writerRecovery && !ui.isGenerating}
    {#if recoveryHidden}
      <button class="text-sm underline" onclick={() => (recoveryHidden = false)}
        >显示未完成正文的恢复入口</button
      >
    {:else}
      <div class="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm">
        <p>Director 已完成，正文尚未保存。可沿用本轮安排，仅重试 Writer。</p>
        {#if recoveryMessage}<p class="text-destructive">{recoveryMessage}</p>{/if}
        <details>
          <summary class="cursor-pointer">查看已保存的 Director 结果</summary>
          <pre class="mt-2 font-sans whitespace-pre-wrap">{writerRecovery.novelTurn
              .sceneDirectorOutput}</pre>
        </details>
        <div class="flex flex-wrap gap-3">
          <button
            class="btn"
            disabled={recoveryBusy || !!ui.submissionScope}
            onclick={() => resumeWriterRecovery()}>仅重试正文</button
          >
          <button
            class="btn"
            disabled={recoveryBusy || !!ui.submissionScope}
            onclick={() => resumeWriterRecovery(true)}>重新运行整轮</button
          >
          <button disabled={recoveryBusy} onclick={() => (recoveryHidden = true)}>关闭提示</button>
        </div>
      </div>
    {/if}
  {/if}
  {#if ui.lastGenerationError && !ui.isGenerating && !writerRecovery}
    <div
      class="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3"
    >
      <div class="flex items-center gap-2 text-sm text-red-400">
        <span>生成失败：{ui.lastGenerationError.message}</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          onclick={handleRetry}
          class="btn flex items-center gap-1.5 bg-red-500/20 text-sm text-red-400 hover:bg-red-500/30"
          ><RefreshCw class="h-4 w-4" />重试</button
        >
        <button
          onclick={dismissError}
          class="text-surface-400 hover:bg-surface-700 hover:text-surface-200 rounded p-1.5"
          title="关闭提示"><X class="h-4 w-4" /></button
        >
      </div>
    </div>
  {/if}

  <GrammarCheck text={inputValue} onApplySuggestion={(newText) => (inputValue = newText)} />

  {#if isCreativeMode || isCollaborative}
    <div
      class="sm:border-border rounded-lg border-l-0 sm:border sm:border-l-4 sm:shadow-sm {ui.isGenerating
        ? 'sm:border-l-surface-600 bg-surface-400/5'
        : 'border-l-accent-500 bg-card'} relative transition-colors duration-200"
    >
      {#if settings.uiSettings.showWordCount}<div
          class="absolute -top-[2.05rem] -right-3 sm:hidden"
        >
          <div
            class="bg-surface-800 border-surface-500/30 text-surface-400 rounded-tl-md border border-b-0 px-2 py-0.5 text-sm"
          >
            {story.wordCount} 字
          </div>
        </div>{/if}
      {#if collaborativeSuggestionsEnabled && (isCollaborative || !settings.uiSettings.disableSuggestions)}<div
          class="border-surface-700/30 sm:border-b"
        >
          <Suggestions
            suggestions={ui.suggestions}
            loading={ui.suggestionsLoading}
            onSelect={handleSuggestionSelect}
            onRefresh={refreshSuggestions}
          />
        </div>{/if}
      <div class="mb-3 flex items-center gap-1 sm:mb-0 sm:items-end sm:p-1">
        <div class="relative min-w-0 flex-1">
          <textarea
            bind:value={inputValue}
            bind:this={textareaRef}
            use:autoResize={inputValue}
            onkeydown={handleKeydown}
            placeholder="输入希望发生的事、角色行动、对白，或继续创作…"
            class="text-surface-200 placeholder-surface-500 max-h-40 min-h-6 w-full resize-none border-none bg-transparent px-2 text-base leading-relaxed focus:ring-0 focus:outline-none sm:min-h-6"
            rows="1"></textarea>
        </div>
        {#if ui.isGenerating}
          {#if !ui.isRetryingLastMessage}<button
              onclick={handleStopGeneration}
              class="flex h-11 w-11 flex-shrink-0 -translate-y-0.5 animate-pulse items-center justify-center rounded-lg p-0 text-red-400 transition-all hover:text-red-300 active:scale-95 sm:translate-y-0"
              title="停止生成"><Square class="h-6 w-6" /></button
            >
          {:else}<button
              disabled
              class="flex h-11 w-11 flex-shrink-0 cursor-not-allowed items-center justify-center rounded-lg p-0 text-red-400 opacity-50"
              title="重试期间暂不可停止"><Square class="h-6 w-6" /></button
            >{/if}
        {:else}<button
            onclick={handleSubmit}
            disabled={!inputValue.trim() || blockGeneration || !!ui.submissionScope}
            class="text-accent-400 hover:text-accent-300 hover:bg-accent-500/10 flex h-11 w-11 flex-shrink-0 -translate-y-0.5 items-center justify-center rounded-lg p-0 transition-all active:scale-95 disabled:opacity-50 sm:translate-y-0"
            title={blockGeneration ? generationConfigError : `发送创作要求（${sendKeyHint}）`}
            ><Send class="h-6 w-6" /></button
          >{/if}
      </div>
    </div>
  {:else}
    <div
      class="sm:border-border rounded-lg border-l-0 sm:border sm:border-l-4 sm:shadow-sm {ui.isGenerating
        ? 'sm:border-l-surface-60'
        : `${actionBorderColors[actionType]}`} bg-card relative transition-colors duration-200"
    >
      {#if settings.uiSettings.showWordCount}<div
          class="absolute -top-[2.05rem] -right-3 sm:hidden"
        >
          <div
            class="bg-surface-800 border-surface-500/30 text-surface-400 rounded-tl-md border border-b-0 px-2 py-0.5 text-sm"
          >
            {story.wordCount} 字
          </div>
        </div>{/if}
      {#if !settings.uiSettings.disableActionPrefixes}
        <div
          class="border-surface-700/30 flex items-center gap-1 px-1 pt-0 pb-0 sm:border-b sm:px-2 sm:py-1"
        >
          {#each actionTypes as type (type)}{@const Icon = actionIcons[type]}<button
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[10px] font-medium transition-all duration-150 sm:flex-none sm:px-3 sm:py-1 sm:text-xs {actionType ===
              type
                ? actionActiveStyles[type]
                : `text-surface-500 hover:${actionButtonStyles[type]}`}"
              onclick={() => (actionType = type)}
              ><Icon class="h-3 w-3 sm:h-3.5 sm:w-3.5" /><span>{actionLabels[type]}</span></button
            >{/each}
        </div>
      {/if}
      <div class="mb-3 flex items-center gap-1 sm:mb-0 sm:items-end sm:p-1">
        <div class="relative min-w-0 flex-1 self-center">
          <textarea
            bind:value={inputValue}
            bind:this={textareaRef}
            use:autoResize={inputValue}
            onkeydown={handleKeydown}
            placeholder={actionType === 'story'
              ? '描述发生的事情…'
              : actionType === 'say'
                ? '输入角色对白…'
                : actionType === 'think'
                  ? '输入角色的想法…'
                  : actionType === 'free'
                    ? '自由输入行动、对白或剧情要求…'
                    : '你打算怎么做？'}
            class="text-surface-200 placeholder-surface-500 max-h-[160px] min-h-[24px] w-full resize-none border-none bg-transparent px-2 text-base leading-relaxed focus:ring-0 focus:outline-none sm:min-h-[24px]"
            rows="1"></textarea>
        </div>
        {#if ui.isGenerating}
          {#if !ui.isRetryingLastMessage}<button
              onclick={handleStopGeneration}
              class="flex h-11 w-11 shrink-0 -translate-y-0.5 animate-pulse items-center justify-center rounded-lg p-0 text-red-400 transition-all hover:text-red-300 active:scale-95 sm:translate-y-0"
              title="停止生成"><Square class="h-6 w-6" /></button
            >
          {:else}<button
              disabled
              class="flex h-11 w-11 shrink-0 cursor-not-allowed items-center justify-center rounded-lg p-0 text-red-400 opacity-50"
              title="重试期间暂不可停止"><Square class="h-6 w-6" /></button
            >{/if}
        {:else}<button
            onclick={handleSubmit}
            disabled={!inputValue.trim() || blockGeneration || !!ui.submissionScope}
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg p-0 transition-all active:scale-95 disabled:opacity-50 {actionButtonStyles[
              actionType
            ]} -translate-y-0.5 sm:translate-y-0"
            title={blockGeneration ? generationConfigError : `发送（${sendKeyHint}）`}
            ><Send class="h-6 w-6" /></button
          >{/if}
      </div>
    </div>
  {/if}
</div>
