<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Switch } from '$lib/components/ui/switch'
  import * as RadioGroup from '$lib/components/ui/radio-group'
  import { ui } from '$lib/stores/ui.svelte'
  import { story } from '$lib/stores/story.svelte'
  import { hasRequiredCredentials } from '$lib/services/ai/image'
  import { templateEngine } from '$lib/services/templates/engine'
  import {
    PROMPT_TEMPLATES,
    LENGTH_INSTRUCTION_VAR,
    templateUsesLengthInstruction,
  } from '$lib/services/prompts/templates'
  import { ContextBuilder } from '$lib/services/context'
  import { database } from '$lib/services/database'
  import { DEFAULT_PACK_ID } from '$lib/services/packs/binding'
  import { missingRequiredVariables } from '$lib/services/packs/pack-service'
  import type { CustomVariable, PresetPack } from '$lib/services/packs/types'
  import WritingStyleFields from '$lib/components/shared/WritingStyleFields.svelte'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import type { POV } from '$lib/types'
  import { aiService } from '$lib/services/ai'
  import {
    collaborativeOptionalContext,
    collaborativePatternFreshness,
    collaborativeRecentPassages,
    historyKey,
  } from '$lib/services/generation/collaborative'

  let generatingPlan = $state(false)
  let basicsStoryId = $state('')
  let basics = $state({ description: '', genre: '', tone: '', themes: '' })
  let basicsSaving = $state(false)
  let basicsError = $state('')
  let basicsSaved = $state(false)
  const basicsBusy = $derived(
    ui.isGenerating || !!ui.submissionScope || story.isRetryInProgress || basicsSaving,
  )
  function resetBasics() {
    const current = story.currentStory
    basics = {
      description: current?.description ?? '',
      genre: current?.genre ?? '',
      tone: current?.settings?.tone ?? '',
      themes: current?.settings?.themes?.join('\n') ?? '',
    }
    basicsError = ''
    basicsSaved = false
  }
  $effect(() => {
    const id = story.currentStory?.id ?? ''
    if (basicsStoryId !== id) {
      basicsStoryId = id
      resetBasics()
    }
  })
  async function saveBasics() {
    if (basicsBusy) return
    const id = story.currentStory?.id
    basicsSaving = true
    basicsError = ''
    basicsSaved = false
    try {
      await story.updateStoryBasics({ ...basics })
      if (story.currentStory?.id === id) {
        resetBasics()
        basicsSaved = true
      }
    } catch (error) {
      if (story.currentStory?.id === id)
        basicsError = error instanceof Error ? error.message : '保存失败，草稿已保留。'
    } finally {
      basicsSaving = false
    }
  }
  let planController: AbortController | null = null
  let planDraftText = $state('')
  let planDraftError = $state('')
  let planFeedback = $state('')
  let generatingPattern = $state(false)
  let patternDraftText = $state('')
  let patternDraftError = $state('')
  let patternFeedback = $state('')
  let targetLengthDraft = $state('')
  let targetLengthError = $state('')
  let patternController: AbortController | null = null
  async function saveCollaborativeTargetLength() {
    const current = story.currentStory
    if (!current) return
    try {
      const { validateCollaborativeLength } = await import('$lib/services/generation/collaborative')
      const targetLength = targetLengthDraft.trim()
        ? validateCollaborativeLength(targetLengthDraft)
        : undefined
      await story.updateStorySettings({
        collaborativeNovelWorkflow: {
          ...(current.settings?.collaborativeNovelWorkflow ?? {}),
          targetLength,
        },
      })
      targetLengthDraft = targetLength ?? ''
      targetLengthError = ''
    } catch (error) {
      targetLengthError = error instanceof Error ? error.message : '中文写作默认篇幅格式无效。'
    }
  }

  function formatPlan(plan: string | null | undefined) {
    return plan ?? ''
  }

  function parsePlanDraft(): string | null {
    const value = planDraftText.trim()
    if (!value) planDraftError = '长期计划原文不能为空。'
    else planDraftError = ''
    return value || null
  }

  async function setLongPlannerEnabled(enabled: boolean) {
    const current = story.currentStory
    if (!current || ui.isGenerating || generatingPlan) return
    const workflow = current.settings?.collaborativeNovelWorkflow ?? {}
    await story.updateStorySettings({
      collaborativeNovelWorkflow: {
        ...workflow,
        narrativePlanner: { ...workflow.narrativePlanner, enabled },
      },
    })
    if (!enabled) {
      planDraftText = ''
      planDraftError = ''
    }
  }

  async function generateLongPlan() {
    const current = story.currentStory
    if (
      !current ||
      current.mode !== 'creative-writing' ||
      generatingPlan ||
      ui.isGenerating ||
      current.settings?.collaborativeNovelWorkflow?.narrativePlanner?.enabled === false
    )
      return
    const storyId = current.id
    const branchId = current.currentBranchId ?? null
    const entriesKey = historyKey(story.entries)
    planController?.abort()
    planController = new AbortController()
    const controller = planController
    generatingPlan = true
    planDraftError = ''
    try {
      const planState = current.settings?.collaborativeNovelPlan
      const previousPlan = planState?.confirmed ?? null
      const currentDraft = planState?.draft ?? null
      const draft = await aiService.generateCollaborativePlan(
        storyId,
        {
          request: planFeedback.trim()
            ? '根据用户意见修订长期软规划草稿'
            : previousPlan
              ? '更新长期软规划草稿'
              : '制定长期软规划草稿',
          ...collaborativeOptionalContext(current, story.entries),
          ...(currentDraft ? { currentDraft } : {}),
          ...(planFeedback.trim() ? { userFeedback: planFeedback.trim() } : {}),
          recent: story.entries
            .filter((entry) => entry.type === 'narration')
            .slice(-8)
            .map((entry) => ({ type: entry.type, text: entry.content })),
          worldState: story.worldStateSnapshot,
        },
        controller.signal,
      )
      if (
        controller.signal.aborted ||
        story.currentStory?.mode !== 'creative-writing' ||
        story.currentStory.settings?.collaborativeNovelWorkflow?.narrativePlanner?.enabled ===
          false ||
        story.currentStory?.id !== storyId ||
        (story.currentStory.currentBranchId ?? null) !== branchId ||
        historyKey(story.entries) !== entriesKey
      ) {
        throw new Error('故事、分支、正文历史或功能开关已变化，长期计划草稿未保存。')
      }
      planDraftText = formatPlan(draft)
      await story.updateStorySettings({
        collaborativeNovelPlan: {
          ...(story.currentStory.settings?.collaborativeNovelPlan ?? {
            draft: null,
            confirmed: null,
          }),
          draft,
          draftGeneratedAt: Date.now(),
        },
      })
    } catch (error) {
      planDraftError = error instanceof Error ? error.message : '无法生成长期计划草稿。'
    } finally {
      if (planController === controller) planController = null
      generatingPlan = false
    }
  }

  async function saveLongPlanDraft() {
    const draft = parsePlanDraft()
    if (!draft) return
    const state = story.currentStory?.settings?.collaborativeNovelPlan
    await story.updateStorySettings({
      collaborativeNovelPlan: {
        ...(state ?? { draft: null, confirmed: null }),
        draft,
      },
    })
  }

  async function confirmLongPlan() {
    const draft = parsePlanDraft()
    if (!draft) return
    await story.updateStorySettings({
      collaborativeNovelPlan: {
        draft: null,
        confirmed: draft,
        confirmedAt: Date.now(),
      },
    })
    planDraftText = ''
  }

  async function clearLongPlanDraft() {
    const state = story.currentStory?.settings?.collaborativeNovelPlan
    await story.updateStorySettings({
      collaborativeNovelPlan: {
        ...(state ?? { confirmed: null }),
        draft: null,
      },
    })
    planDraftText = ''
    planDraftError = ''
  }

  async function editConfirmedLongPlan() {
    const state = story.currentStory?.settings?.collaborativeNovelPlan
    if (!state?.confirmed) return
    planDraftText = formatPlan(state.confirmed)
    await story.updateStorySettings({
      collaborativeNovelPlan: { ...state, draft: state.confirmed },
    })
  }

  function restoreLongPlanDraft() {
    planDraftText = formatPlan(longPlanState?.draft)
    planDraftError = ''
  }

  async function clearConfirmedLongPlan() {
    const state = story.currentStory?.settings?.collaborativeNovelPlan
    await story.updateStorySettings({
      collaborativeNovelPlan: {
        ...(state ?? { draft: null }),
        confirmed: null,
        confirmedAt: undefined,
      },
    })
  }

  function formatPattern(review: string | null | undefined) {
    return review ?? ''
  }

  function parsePatternDraft(): string | null {
    const value = patternDraftText.trim()
    if (!value) patternDraftError = '结构指导原文不能为空。'
    else patternDraftError = ''
    return value || null
  }

  async function setPatternReviewerEnabled(enabled: boolean) {
    const current = story.currentStory
    if (!current || ui.isGenerating || generatingPattern) return
    const workflow = current.settings?.collaborativeNovelWorkflow ?? {}
    await story.updateStorySettings({
      collaborativeNovelWorkflow: {
        ...workflow,
        patternReviewer: { ...workflow.patternReviewer, enabled },
      },
    })
    if (!enabled) {
      patternController?.abort()
      patternDraftText = ''
      patternDraftError = ''
    }
  }

  async function generatePatternDraft() {
    const current = story.currentStory
    if (
      !current ||
      current.mode !== 'creative-writing' ||
      generatingPattern ||
      ui.isGenerating ||
      !patternReviewerEnabled ||
      current.settings?.collaborativeNovelWorkflow?.patternReviewer?.enabled === false
    )
      return
    const storyId = current.id
    const branchId = current.currentBranchId ?? null
    const entriesKey = historyKey(story.entries)
    const narrations = story.entries.filter(
      (entry) => entry.type === 'narration' && entry.content.trim(),
    )
    patternController?.abort()
    patternController = new AbortController()
    const controller = patternController
    generatingPattern = true
    patternDraftError = ''
    try {
      const confirmed = current.settings?.collaborativeNovelPattern?.confirmed ?? null
      const draft = await aiService.generateCollaborativePatternReview(
        storyId,
        {
          request: confirmed ? '更新近期叙事结构规避草稿' : '分析近期叙事结构并生成规避草稿',
          ...collaborativeOptionalContext(current, story.entries),
          ...(current.settings?.collaborativeNovelPattern?.draft
            ? { currentDraft: current.settings.collaborativeNovelPattern.draft }
            : {}),
          ...(patternFeedback.trim() ? { userFeedback: patternFeedback.trim() } : {}),
          recent: collaborativeRecentPassages(story.entries),
          worldState: story.worldStateSnapshot,
          analyzedHistoryKey: entriesKey,
          analyzedNarrationCount: narrations.length,
        },
        controller.signal,
      )
      if (
        controller.signal.aborted ||
        story.currentStory?.mode !== 'creative-writing' ||
        story.currentStory.settings?.collaborativeNovelWorkflow?.patternReviewer?.enabled ===
          false ||
        story.currentStory?.id !== storyId ||
        (story.currentStory.currentBranchId ?? null) !== branchId ||
        historyKey(story.entries) !== entriesKey
      ) {
        throw new Error('故事、分支、正文历史或功能开关已变化，结构规避草稿未保存。')
      }
      patternDraftText = formatPattern(draft)
      await story.updateStorySettings({
        collaborativeNovelPattern: {
          ...(story.currentStory.settings?.collaborativeNovelPattern ?? {
            draft: null,
            confirmed: null,
          }),
          draft,
          draftGeneratedAt: Date.now(),
          draftAnalyzedHistoryKey: entriesKey,
          draftAnalyzedNarrationCount: narrations.length,
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        patternDraftError = error instanceof Error ? error.message : '无法生成结构重复规避草稿。'
      }
    } finally {
      if (patternController === controller) patternController = null
      generatingPattern = false
    }
  }

  async function savePatternDraft() {
    const draft = parsePatternDraft()
    if (!draft) return
    const state = story.currentStory?.settings?.collaborativeNovelPattern
    await story.updateStorySettings({
      collaborativeNovelPattern: { ...(state ?? { confirmed: null }), draft },
    })
  }

  async function confirmPatternDraft() {
    const draft = parsePatternDraft()
    if (!draft) return
    const state = story.currentStory?.settings?.collaborativeNovelPattern
    await story.updateStorySettings({
      collaborativeNovelPattern: {
        ...(state ?? {}),
        draft: null,
        confirmed: draft,
        confirmedAt: Date.now(),
        analyzedHistoryKey: state?.draftAnalyzedHistoryKey,
        analyzedNarrationCount: state?.draftAnalyzedNarrationCount,
        draftAnalyzedHistoryKey: undefined,
        draftAnalyzedNarrationCount: undefined,
        draftGeneratedAt: undefined,
        freshness: undefined,
      },
    })
    patternDraftText = ''
  }

  async function clearPatternDraft() {
    const state = story.currentStory?.settings?.collaborativeNovelPattern
    await story.updateStorySettings({
      collaborativeNovelPattern: {
        ...(state ?? { confirmed: null }),
        draft: null,
        draftGeneratedAt: undefined,
        draftAnalyzedHistoryKey: undefined,
        draftAnalyzedNarrationCount: undefined,
      },
    })
    patternDraftText = ''
    patternDraftError = ''
  }

  async function editConfirmedPattern() {
    const state = story.currentStory?.settings?.collaborativeNovelPattern
    if (!state?.confirmed) return
    patternDraftText = formatPattern(state.confirmed)
    await story.updateStorySettings({
      collaborativeNovelPattern: {
        ...state,
        draft: state.confirmed,
        draftGeneratedAt: undefined,
        draftAnalyzedHistoryKey: state.analyzedHistoryKey,
        draftAnalyzedNarrationCount: state.analyzedNarrationCount,
      },
    })
  }

  function restorePatternDraft() {
    patternDraftText = formatPattern(patternState?.draft)
    patternDraftError = ''
  }

  async function clearConfirmedPattern() {
    const state = story.currentStory?.settings?.collaborativeNovelPattern
    await story.updateStorySettings({
      collaborativeNovelPattern: {
        ...(state ?? { draft: null }),
        confirmed: null,
        confirmedAt: undefined,
      },
    })
  }

  async function setPlotSuggestionsEnabled(enabled: boolean) {
    const current = story.currentStory
    if (!current || ui.isGenerating) return
    const workflow = current.settings?.collaborativeNovelWorkflow ?? {}
    await story.updateStorySettings({
      collaborativeNovelWorkflow: {
        ...workflow,
        plotSuggestions: { ...workflow.plotSuggestions, enabled },
      },
    })
    if (!enabled) ui.clearSuggestions(current.id)
  }

  // Static — defined at module scope so they aren't re-created per component instance
  const KNOWN_VARIABLES = new Set([
    'mode',
    'pov',
    'tense',
    'genre',
    'tone',
    'themes',
    'settingDescription',
    'visualProseMode',
    'inlineImageMode',
    'protagonistName',
    'protagonistDescription',
    'currentLocation',
    'storyTime',
    'tieredContextBlock',
    'retrievedChapterContext',
    'chapterSummaries',
    'styleGuidance',
    'inlineImageInstructions',
    'visualProseInstructions',
    'runtimeVars_characters',
    'runtimeVars_locations',
    'runtimeVars_items',
    'runtimeVars_storyBeats',
    'runtimeVars_protagonist',
  ])

  const VARIABLE_REFERENCE = [
    {
      group: 'Protagonist',
      vars: [
        { name: 'protagonistName', desc: "Protagonist's name as set in World" },
        { name: 'protagonistDescription', desc: "Protagonist's description from World" },
      ],
    },
    {
      group: 'World',
      vars: [
        { name: 'currentLocation', desc: 'Current location name' },
        { name: 'storyTime', desc: 'In-story time (Year, Day, Hour, Minute)' },
        { name: 'genre', desc: 'Story genre' },
        { name: 'tone', desc: 'Writing tone' },
        { name: 'settingDescription', desc: 'World description' },
      ],
    },
    {
      group: 'Memory & Context',
      vars: [
        { name: 'tieredContextBlock', desc: 'Recent story memory injected by the memory system' },
        { name: 'chapterSummaries', desc: 'Summaries of past chapters' },
        { name: 'retrievedChapterContext', desc: 'Retrieved chapter context from memory' },
        { name: 'styleGuidance', desc: 'Style review guidance (when style reviewer is active)' },
      ],
    },
    {
      group: 'Runtime Variables',
      vars: [
        { name: 'runtimeVars_characters', desc: 'Runtime variable values for all characters' },
        { name: 'runtimeVars_protagonist', desc: 'Runtime variable values for the protagonist' },
        { name: 'runtimeVars_locations', desc: 'Runtime variable values for all locations' },
        { name: 'runtimeVars_items', desc: 'Runtime variable values for all items' },
        { name: 'runtimeVars_storyBeats', desc: 'Runtime variable values for all story beats' },
      ],
    },
  ]

  // Defined as a plain const so Svelte doesn't parse {{ }} as template expressions
  const promptPlaceholder =
    'Leave empty to use the default pack template. Use {{ protagonistName }}, {{ currentLocation }}, etc.'

  // ── Reactive state ────────────────────────────────────────────────────────────

  const storySettings = $derived(story.currentStory?.settings ?? {})
  const isCollaborative = $derived(story.currentStory?.mode === 'creative-writing')
  const longPlannerAvailable = $derived(true)
  const longPlannerEnabled = $derived(
    longPlannerAvailable &&
      storySettings.collaborativeNovelWorkflow?.narrativePlanner?.enabled !== false,
  )
  const longPlanState = $derived(storySettings.collaborativeNovelPlan)
  const patternReviewerAvailable = $derived(true)
  const patternReviewerEnabled = $derived(
    patternReviewerAvailable &&
      storySettings.collaborativeNovelWorkflow?.patternReviewer?.enabled !== false,
  )
  const patternState = $derived(storySettings.collaborativeNovelPattern)
  const narrationCount = $derived(
    story.entries.filter((entry) => entry.type === 'narration' && entry.content.trim()).length,
  )
  const patternFreshness = $derived(
    collaborativePatternFreshness(patternState, historyKey(story.entries), narrationCount),
  )
  const plotSuggestionsAvailable = $derived(true)
  const plotSuggestionsEnabled = $derived(
    plotSuggestionsAvailable &&
      storySettings.collaborativeNovelWorkflow?.plotSuggestions?.enabled !== false,
  )
  const factStateExtractorAvailable = $derived(true)
  const factStateExtractorEnabled = $derived(
    factStateExtractorAvailable &&
      storySettings.collaborativeNovelWorkflow?.factStateExtractor?.enabled !== false,
  )
  const imageGenEnabled = $derived(hasRequiredCredentials())
  const backgroundImagesAvailable = $derived(hasRequiredCredentials('background'))
  const portraitReferenceAvailable = $derived(hasRequiredCredentials('reference'))

  // Track only customSystemPrompt so the effect below doesn't fire on unrelated
  // setting changes (tone, pov, etc.) and overwrite an unsaved draft.
  const savedCustomPrompt = $derived(story.currentStory?.settings?.customSystemPrompt)

  // Local draft — initialised and re-synced only when the saved value changes.
  // Two write sources (user input + external sync) make a writable $derived inapplicable.
  // eslint-disable-next-line svelte/prefer-writable-derived
  let customPromptDraft = $state('')
  $effect(() => {
    customPromptDraft = savedCustomPrompt ?? ''
  })

  $effect(() => {
    const savedDraft = patternReviewerEnabled ? patternState?.draft : null
    patternDraftText = formatPattern(savedDraft)
    patternDraftError = ''
  })

  $effect(() => {
    void story.currentStory?.id
    void story.currentStory?.currentBranchId
    return () => patternController?.abort()
  })

  $effect(() => {
    const savedDraft = longPlanState?.draft
    planDraftText = formatPlan(savedDraft)
    planDraftError = ''
  })

  $effect(() => {
    targetLengthDraft = storySettings.collaborativeNovelWorkflow?.targetLength ?? ''
    targetLengthError = ''
  })

  let validationResult = $state<{ success: boolean; error?: string } | null>(null)
  let unknownVars = $state<string[]>([])
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let showVarReference = $state(false)

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
    patternController?.abort()
    planController?.abort()
  })

  // ── Derived flags ─────────────────────────────────────────────────────────────

  const isActive = $derived(!!savedCustomPrompt)

  /** The story's bound pack, for display. `null` until loaded. */
  let boundPack = $state<PresetPack | null>(null)
  let boundPackUsageCount = $state(0)
  let boundPackLoaded = $state(false)
  let availablePacks = $state<PresetPack[]>([])
  let packValues = $state<Record<string, string>>({})
  let pendingPackId = $state<string | null>(null)
  let pendingPackVariables = $state<CustomVariable[]>([])
  let pendingPackValues = $state<Record<string, string>>({})
  let packSwitchError = $state('')
  let packSwitching = $state(false)

  $effect(() => {
    const storyId = story.currentStory?.id
    if (!storyId) return

    boundPack = null
    boundPackUsageCount = 0
    boundPackLoaded = false
    availablePacks = []

    packValues = {}
    pendingPackId = null
    pendingPackVariables = []
    pendingPackValues = {}
    packSwitchError = ''
    let cancelled = false
    void (async () => {
      // Mirrors ContextBuilder.forStory: a NULL column means the built-in pack narrates.
      const packId = (await database.getStoryPackId(storyId)) || DEFAULT_PACK_ID
      const [pack, packs, values] = await Promise.all([
        database.getPack(packId),
        database.getAllPacks(),
        database.getStoryCustomVariables(storyId),
      ])
      const usageCount = await database.getPackUsageCount(packId)
      if (cancelled) return
      boundPack = pack
      boundPackUsageCount = usageCount
      availablePacks = packs

      packValues = values ?? {}
      boundPackLoaded = true
    })()

    return () => {
      cancelled = true
    }
  })

  async function preparePackSwitch(packId: string) {
    const currentPackId = boundPack?.id ?? DEFAULT_PACK_ID
    if (packId === currentPackId) {
      pendingPackId = null
      packSwitchError = ''
      return
    }
    packSwitchError = ''
    try {
      const variables = await database.getPackVariables(packId)
      const values = { ...packValues }
      for (const variable of variables) {
        if (!values[variable.variableName]?.trim() && variable.defaultValue !== undefined) {
          values[variable.variableName] = variable.defaultValue
        }
      }
      pendingPackId = packId
      pendingPackVariables = variables
      pendingPackValues = values
    } catch (error) {
      packSwitchError = error instanceof Error ? error.message : '无法读取目标提示词包。'
    }
  }

  function setPendingPackValue(variableName: string, value: string) {
    pendingPackValues = { ...pendingPackValues, [variableName]: value }
  }

  async function applyPackSwitch() {
    const current = story.currentStory
    if (!current || !pendingPackId || packSwitching) return
    const missing = missingRequiredVariables(pendingPackVariables, pendingPackValues)
    if (missing.length > 0) {
      packSwitchError = `请补充必填变量：${missing.map((variable) => variable.displayName).join('、')}`
      return
    }
    packSwitching = true
    packSwitchError = ''
    try {
      const targetPackId = pendingPackId
      await database.rebindStoryPack(current.id, targetPackId, pendingPackValues)
      boundPack = availablePacks.find((pack) => pack.id === targetPackId) ?? null
      boundPackUsageCount = await database.getPackUsageCount(targetPackId)

      packValues = pendingPackValues
      pendingPackId = null
      pendingPackVariables = []
      pendingPackValues = {}
    } catch (error) {
      packSwitchError = error instanceof Error ? error.message : '无法切换提示词包。'
    } finally {
      packSwitching = false
    }
  }

  function cancelPackSwitch() {
    pendingPackId = null
    pendingPackVariables = []
    pendingPackValues = {}
    packSwitchError = ''
  }

  /**
   * Response Length only does anything if the prompt that will actually run renders
   * `{{ lengthInstruction }}` — a per-story override replaces the pack template outright,
   * and a pack created before the variable existed keeps its own copy of the body.
   */
  let lengthUnavailableReason = $state<string | undefined>(undefined)
  $effect(() => {
    const storyId = story.currentStory?.id
    const override = savedCustomPrompt
    const templateId =
      story.currentStory?.mode === 'creative-writing' ? 'creative-writing' : 'adventure'
    if (!storyId) return

    let cancelled = false
    const resolve = async () => {
      if (override) return templateUsesLengthInstruction(override)
      const packId = (await database.getStoryPackId(storyId)) || DEFAULT_PACK_ID
      const template = await new ContextBuilder(packId).resolveTemplate(templateId)
      return templateUsesLengthInstruction(template?.content)
    }

    resolve().then((supported) => {
      if (cancelled) return
      lengthUnavailableReason = supported
        ? undefined
        : `The active ${override ? 'custom prompt' : 'prompt pack template'} does not use ` +
          `{{ ${LENGTH_INSTRUCTION_VAR} }}, so this setting would have no effect. Add it under ` +
          `# Format${override ? '' : ', or switch the story to a pack that has it'}.`
    })

    return () => {
      cancelled = true
    }
  })
  const isDirty = $derived(customPromptDraft !== (savedCustomPrompt ?? ''))
  const canSave = $derived(
    isDirty && (customPromptDraft.trim() === '' || (validationResult?.success ?? false)),
  )

  // ── Functions ─────────────────────────────────────────────────────────────────

  function validate(value: string) {
    if (!value.trim()) {
      validationResult = null
      unknownVars = []
      return
    }
    const result = templateEngine.parseTemplate(value)
    validationResult = result
    unknownVars = result.success
      ? templateEngine.extractVariableNames(value).filter((v) => !KNOWN_VARIABLES.has(v))
      : []
  }

  function onDraftInput(value: string) {
    customPromptDraft = value
    validationResult = null // clear stale result immediately so canSave goes false until debounce fires
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => validate(value), 300)
  }

  function loadCurrentTemplate() {
    if (debounceTimer) clearTimeout(debounceTimer)
    const mode = story.currentStory?.mode ?? 'adventure'
    const templateId = mode === 'creative-writing' ? 'creative-writing' : 'adventure'
    const template = PROMPT_TEMPLATES.find((t) => t.id === templateId)
    if (template) {
      customPromptDraft = template.content
      validate(template.content)
    }
  }

  async function savePrompt() {
    await story.updateStorySettings({ customSystemPrompt: customPromptDraft.trim() || undefined })
  }

  async function clearOverride() {
    customPromptDraft = ''
    validationResult = null
    unknownVars = []
    await story.updateStorySettings({ customSystemPrompt: undefined })
  }
  async function setImportOrganization(enabled: boolean) {
    const source = story.currentStory?.settings?.importSource
    if (source)
      await story.updateStorySettings({
        importSource: { ...source, organizationEnabled: enabled },
        importOrganizationDismissed: false,
      })
  }
</script>

{#if story.currentStory?.settings?.importSource?.rawCardJson}
  <div class="space-y-2 rounded border p-3">
    <label class="flex items-center justify-between text-sm"
      >AI 导入整理（仅主动请求时调用）
      <Switch
        checked={story.currentStory.settings.importSource.organizationEnabled !== false}
        disabled={basicsBusy}
        onCheckedChange={setImportOrganization}
      />
    </label>
    <Button
      size="sm"
      variant="outline"
      onclick={async () => {
        await story.updateStorySettings({ importOrganizationDismissed: false })
        ui.closeSettings()
      }}>显示故事内整理面板</Button
    >
  </div>
{/if}

<div class="space-y-6">
  <div>
    <h3 class="text-lg font-semibold">{isCollaborative ? '中文写作' : '故事设置'}</h3>
    <p class="text-muted-foreground text-sm">配置当前故事的设置。</p>
  </div>

  <section class="space-y-3 rounded-lg border p-4">
    <h3 class="font-semibold">故事基础设定</h3>
    <p class="text-muted-foreground text-sm">
      保存后用于后续生成，不改写已有正文。自定义 Prompt 模板可通过对应变量引用这些设定。
    </p>
    <Label for="story-background">背景／世界描述</Label>
    <Textarea
      id="story-background"
      bind:value={basics.description}
      disabled={basicsBusy}
      rows={5}
    />
    <Input id="story-genre" label="题材" bind:value={basics.genre} disabled={basicsBusy} />
    <Input id="story-tone" label="叙事基调" bind:value={basics.tone} disabled={basicsBusy} />
    <Label for="story-themes">主题（每行一个）</Label>
    <Textarea id="story-themes" bind:value={basics.themes} disabled={basicsBusy} rows={3} />
    {#if storySettings.collaborativeNovelPlan?.confirmed}<p class="text-muted-foreground text-xs">
        已有长期计划保持不变；修改设定后请按需复核。
      </p>{/if}
    {#if basicsError}<p class="text-destructive text-sm">{basicsError}</p>{/if}
    {#if basicsSaved}<p class="text-sm">已保存，用于后续生成。</p>{/if}
    <div class="flex gap-2">
      <Button disabled={basicsBusy} onclick={saveBasics}>保存</Button><Button
        variant="outline"
        disabled={basicsBusy}
        onclick={resetBasics}>重置</Button
      >
    </div>
  </section>

  {#if isCollaborative}
    <div class="space-y-2 rounded-lg border p-4">
      <Label>中文写作工作流</Label>
      <p class="text-muted-foreground text-sm">
        明确结果优先，保留主角决定权；生成前解释意图、安排场景并避免近期重复。正文流式显示，不做生成后审查。
      </p>
      <p class="text-muted-foreground text-xs">
        当前故事的创作模式固定使用本工作流。篇幅可在自然输入中调整；Writer 使用 active Prompt
        Pack，不注入旧故事级完整系统提示词。系统自动记录可回退的世界状态。
      </p>
      <div class="space-y-2 border-t pt-3">
        <Label>正文叙述人称</Label>
        <RadioGroup.Root
          value={storySettings.pov ?? 'third'}
          onValueChange={(value) => {
            if (value && !ui.isGenerating) void story.updateStorySettings({ pov: value as POV })
          }}
          class="grid grid-cols-3 gap-2"
          disabled={ui.isGenerating}
        >
          {#each [{ value: 'first', label: '第一人称' }, { value: 'second', label: '第二人称' }, { value: 'third', label: '第三人称' }] as option (option.value)}
            <Label
              for={`collaborative-pov-${option.value}`}
              class="border-muted bg-popover hover:bg-accent hover:text-accent-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[:focus-visible]:ring-ring flex cursor-pointer items-center justify-center rounded-md border-2 p-3 text-center has-[:focus-visible]:ring-2"
            >
              <RadioGroup.Item
                id={`collaborative-pov-${option.value}`}
                value={option.value}
                class="sr-only"
                disabled={ui.isGenerating}
              />
              <span>{option.label}</span>
            </Label>
          {/each}
        </RadioGroup.Root>
        <p class="text-muted-foreground text-xs">
          修改后用于后续正文生成，不改写已有正文；现有故事保留已保存的人称选择。
        </p>
      </div>
      <div class="space-y-2 border-t pt-3">
        <Label for="collaborative-target-length">固定字数（可选）</Label>
        <div class="flex gap-2">
          <Input
            id="collaborative-target-length"
            bind:value={targetLengthDraft}
            placeholder="例如 2000 或 1500-3000"
            disabled={ui.isGenerating}
          />
          <Button
            variant="outline"
            onclick={saveCollaborativeTargetLength}
            disabled={ui.isGenerating}>保存</Button
          >
        </div>
        <p class="text-muted-foreground text-xs">
          支持单值或字符范围；清空并保存恢复继承。本轮自然输入明确声明篇幅时优先；人称按故事设置注入
          Writer，时态和稳定写作规则由实际 Agent Prompt 决定。
        </p>
        {#if !storySettings.collaborativeNovelWorkflow?.targetLength}
          <p class="text-muted-foreground text-xs">
            当前继承：{storySettings.targetLength === 'short'
              ? '短篇幅（约 2–4 段）'
              : storySettings.targetLength === 'medium'
                ? '中等篇幅（约 3–6 段）'
                : storySettings.targetLength === 'long'
                  ? '长篇幅（约 5–8 段以上）'
                  : storySettings.targetLength === 'dynamic'
                    ? '动态篇幅，随场景节奏调整'
                    : '1500–3000 字'}
          </p>
        {/if}
        {#if targetLengthError}
          <p class="text-destructive text-xs">{targetLengthError}</p>
        {/if}
      </div>
      <div class="space-y-3 border-t pt-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label for="collaborative-long-plan">长期软规划</Label>
            <p class="text-muted-foreground text-xs">
              仅主动生成草稿；确认后才会参与后续场景规划。
            </p>
          </div>
          <Switch
            id="collaborative-long-plan"
            checked={longPlannerEnabled}
            disabled={ui.isGenerating || generatingPlan || !longPlannerAvailable}
            onCheckedChange={setLongPlannerEnabled}
          />
        </div>

        {#if longPlannerEnabled}
          {#if longPlanState?.confirmed}
            <div class="space-y-2">
              <p class="text-sm font-medium">当前已确认计划</p>
              <pre
                class="bg-muted max-h-48 overflow-auto rounded p-3 text-xs whitespace-pre-wrap">{formatPlan(
                  longPlanState.confirmed,
                )}</pre>
              <div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={editConfirmedLongPlan}>编辑副本</Button
                >
                <Button variant="ghost" size="sm" onclick={restoreLongPlanDraft}
                  >恢复已保存草稿</Button
                >
                <Button
                  variant="outline"
                  size="sm"
                  onclick={generateLongPlan}
                  disabled={generatingPlan}
                >
                  {generatingPlan ? '正在生成…' : 'AI 更新草稿'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:text-destructive"
                  onclick={clearConfirmedLongPlan}>清空已确认计划</Button
                >
              </div>
            </div>
          {:else}
            <Button
              variant="outline"
              size="sm"
              onclick={generateLongPlan}
              disabled={generatingPlan}
            >
              {generatingPlan ? '正在生成…' : 'AI 制定长期计划草稿'}
            </Button>
          {/if}

          {#if longPlanState?.draft || planDraftText}
            <div class="space-y-2">
              <Label for="collaborative-long-plan-draft">未确认草稿</Label>
              <Textarea
                id="collaborative-long-plan-draft"
                bind:value={planDraftText}
                class="min-h-56 font-mono text-xs"
              />
              <Textarea
                aria-label="长期计划用户意见"
                placeholder="对草稿的意见，例如：保留不信任关系，但不要过早揭露真相。"
                bind:value={planFeedback}
                class="min-h-20"
              />
              <p class="text-muted-foreground text-xs">
                草稿保存为 Agent 原文；保存草稿不会影响正文生成。
              </p>
              <div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={saveLongPlanDraft}>保存草稿</Button>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={generateLongPlan}
                  disabled={generatingPlan}
                >
                  根据意见更新草稿
                </Button>
                <Button size="sm" onclick={confirmLongPlan}>确认并使用</Button>
                <Button variant="ghost" size="sm" onclick={clearLongPlanDraft}>清空草稿</Button>
              </div>
            </div>
          {/if}
          {#if planDraftError}
            <p class="text-destructive text-xs">{planDraftError}</p>
          {/if}
        {/if}
      </div>
      <div class="space-y-3 border-t pt-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label for="collaborative-pattern-reviewer">结构重复规避</Label>
            <p class="text-muted-foreground text-xs">
              主动分析近期正文生成草稿；确认后仅供本轮导演选择适用内容。
            </p>
          </div>
          <Switch
            id="collaborative-pattern-reviewer"
            checked={patternReviewerEnabled}
            disabled={ui.isGenerating || generatingPattern || !patternReviewerAvailable}
            onCheckedChange={setPatternReviewerEnabled}
          />
        </div>

        {#if patternReviewerEnabled}
          {#if patternState?.confirmed}
            <div class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="text-sm font-medium">当前已确认指导</p>
                <span class="text-muted-foreground text-xs">
                  {patternFreshness === 'current'
                    ? '分析依据为当前历史'
                    : patternFreshness === 'aging'
                      ? '新增少量正文，指导可能需要更新'
                      : '分析依据较旧，请按需更新草稿'}
                </span>
              </div>
              <pre
                class="bg-muted max-h-48 overflow-auto rounded p-3 text-xs whitespace-pre-wrap">{formatPattern(
                  patternState.confirmed,
                )}</pre>
              <p class="text-muted-foreground text-xs">
                分析正文数：{patternState.analyzedNarrationCount ??
                  '未知'}；确认时间：{patternState.confirmedAt
                  ? new Date(patternState.confirmedAt).toLocaleString()
                  : '未知'}。过期提示不会自动停用或改写指导。
              </p>
              <div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={editConfirmedPattern}>编辑副本</Button>
                <Button variant="ghost" size="sm" onclick={restorePatternDraft}
                  >恢复已保存草稿</Button
                >
                <Button
                  variant="outline"
                  size="sm"
                  onclick={generatePatternDraft}
                  disabled={generatingPattern}
                >
                  {generatingPattern ? '正在分析…' : 'AI 更新草稿'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:text-destructive"
                  onclick={clearConfirmedPattern}>清空已确认指导</Button
                >
              </div>
            </div>
          {:else}
            <Button
              variant="outline"
              size="sm"
              onclick={generatePatternDraft}
              disabled={generatingPattern}
            >
              {generatingPattern ? '正在分析…' : 'AI 分析近期结构'}
            </Button>
          {/if}

          {#if patternState?.draft || patternDraftText}
            <div class="space-y-2">
              <Label for="collaborative-pattern-draft">未确认草稿</Label>
              <Textarea
                id="collaborative-pattern-draft"
                bind:value={patternDraftText}
                class="min-h-56 font-mono text-xs"
              />
              <Textarea
                aria-label="结构规避用户意见"
                placeholder="对草稿的意见，例如：不要把沉默永久列为禁用机制。"
                bind:value={patternFeedback}
                class="min-h-20"
              />
              <p class="text-muted-foreground text-xs">
                保存草稿不会影响正文；确认后才会将完整原文交给 Scene Director。
              </p>
              <div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={savePatternDraft}>保存草稿</Button>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={generatePatternDraft}
                  disabled={generatingPattern}
                >
                  根据意见更新草稿
                </Button>
                <Button size="sm" onclick={confirmPatternDraft}>确认并使用</Button>
                <Button variant="ghost" size="sm" onclick={clearPatternDraft}>清空草稿</Button>
              </div>
            </div>
          {/if}
          {#if patternDraftError}
            <p class="text-destructive text-xs">{patternDraftError}</p>
          {/if}
        {/if}
      </div>
      <div class="flex items-center justify-between gap-4 border-t pt-3">
        <div>
          <Label for="collaborative-plot-suggestions">短期剧情建议</Label>
          <p class="text-muted-foreground text-xs">按需生成剧情方向，不提供玩家行动菜单。</p>
        </div>
        <Switch
          id="collaborative-plot-suggestions"
          checked={plotSuggestionsEnabled}
          disabled={ui.isGenerating || !plotSuggestionsAvailable}
          onCheckedChange={setPlotSuggestionsEnabled}
        />
      </div>
      <div class="flex items-center justify-between gap-4 border-t pt-3">
        <div>
          <Label for="collaborative-fact-extractor">正文事实与状态提取</Label>
          <p class="text-muted-foreground text-xs">正文完成后更新世界状态；失败不会删除正文。</p>
        </div>
        <Switch
          id="collaborative-fact-extractor"
          checked={factStateExtractorEnabled}
          disabled={ui.isGenerating || !factStateExtractorAvailable}
          onCheckedChange={(enabled) =>
            story.updateStorySettings({
              collaborativeNovelWorkflow: {
                ...(storySettings.collaborativeNovelWorkflow ?? {}),
                factStateExtractor: {
                  ...storySettings.collaborativeNovelWorkflow?.factStateExtractor,
                  enabled,
                },
              },
            })}
        />
      </div>
      <div class="space-y-3 border-t pt-3">
        <div>
          <Label for="collaborative-story-prompt-pack">本故事提示词 Pack</Label>
          <p class="text-muted-foreground text-xs">
            可切换当前故事使用的 Pack。同名变量值会保留，目标 Pack
            的默认值会自动填入；缺少必填变量时需要先补齐。
          </p>
        </div>
        {#if boundPack}
          <p class="text-muted-foreground text-xs">
            当前：<span class="text-foreground font-medium">{boundPack.name}</span>
            {#if boundPack.author}（作者：{boundPack.author}）{/if}
            <span class="opacity-70">· {boundPackUsageCount} 个故事使用</span>
          </p>
        {/if}
        {#if availablePacks.length > 0}
          <select
            id="collaborative-story-prompt-pack"
            class="bg-background w-full rounded-md border px-2 py-2 text-sm"
            value={pendingPackId ?? boundPack?.id ?? DEFAULT_PACK_ID}
            onchange={(event) => preparePackSwitch(event.currentTarget.value)}
            disabled={packSwitching}
          >
            {#each availablePacks as pack (pack.id)}
              <option value={pack.id}>{pack.name}{pack.isDefault ? '（内置）' : ''}</option>
            {/each}
          </select>
        {:else if boundPackLoaded}
          <p class="text-destructive text-xs">没有可用的提示词 Pack。</p>
        {/if}
        {#if pendingPackId}
          <div class="bg-muted/30 space-y-3 rounded-md p-3">
            {#each pendingPackVariables as variable (variable.id)}
              <div class="space-y-1">
                <Label for={`collaborative-pending-pack-${variable.id}`}
                  >{variable.displayName}</Label
                >
                {#if variable.variableType === 'textarea'}
                  <Textarea
                    id={`collaborative-pending-pack-${variable.id}`}
                    rows={2}
                    value={pendingPackValues[variable.variableName] ?? ''}
                    oninput={(event) =>
                      setPendingPackValue(variable.variableName, event.currentTarget.value)}
                  />
                {:else if variable.variableType === 'enum' && variable.enumOptions}
                  <select
                    id={`collaborative-pending-pack-${variable.id}`}
                    class="bg-background w-full rounded-md border px-2 py-2 text-sm"
                    value={pendingPackValues[variable.variableName] ?? ''}
                    onchange={(event) =>
                      setPendingPackValue(variable.variableName, event.currentTarget.value)}
                  >
                    <option value="">请选择…</option>
                    {#each variable.enumOptions as option (option.value)}
                      <option value={option.value}>{option.label || option.value}</option>
                    {/each}
                  </select>
                {:else if variable.variableType === 'boolean'}
                  <input
                    id={`collaborative-pending-pack-${variable.id}`}
                    type="checkbox"
                    checked={pendingPackValues[variable.variableName] === 'true'}
                    onchange={(event) =>
                      setPendingPackValue(
                        variable.variableName,
                        event.currentTarget.checked ? 'true' : 'false',
                      )}
                  />
                {:else}
                  <Input
                    id={`collaborative-pending-pack-${variable.id}`}
                    type={variable.variableType === 'number' ? 'number' : 'text'}
                    value={pendingPackValues[variable.variableName] ?? ''}
                    oninput={(event) =>
                      setPendingPackValue(variable.variableName, event.currentTarget.value)}
                  />
                {/if}
              </div>
            {/each}
            <div class="flex gap-2">
              <Button size="sm" onclick={applyPackSwitch} disabled={packSwitching}>
                {packSwitching ? '正在切换…' : '应用提示词 Pack'}
              </Button>
              <Button variant="ghost" size="sm" onclick={cancelPackSwitch}>取消</Button>
            </div>
          </div>
        {/if}
        {#if packSwitchError}
          <p class="text-destructive text-xs whitespace-pre-line">{packSwitchError}</p>
        {/if}
      </div>
      <Button variant="outline" onclick={() => ui.setSettingsTab('prompts')}>提示词管理</Button>
    </div>
  {/if}

  <WritingStyleFields
    showNarrativeControls={!isCollaborative}
    showTone={false}
    selectedPOV={storySettings.pov ?? 'second'}
    selectedTense={storySettings.tense ?? 'present'}
    tone={storySettings.tone ?? ''}
    visualProseMode={storySettings.visualProseMode ?? false}
    imageGenerationEnabled={imageGenEnabled}
    {backgroundImagesAvailable}
    {portraitReferenceAvailable}
    imageGenerationMode={storySettings.imageGenerationMode ?? 'none'}
    backgroundImagesEnabled={storySettings.backgroundImagesEnabled ?? false}
    referenceMode={storySettings.referenceMode ?? false}
    targetLength={storySettings.targetLength ?? 'dynamic'}
    mode={story.currentStory?.mode === 'creative-writing' ? 'creative-writing' : 'adventure'}
    onPOVChange={(v) => story.updateStorySettings({ pov: v })}
    onTenseChange={(v) => story.updateStorySettings({ tense: v })}
    onToneChange={(v) => story.updateStorySettings({ tone: v })}
    onVisualProseModeChange={(v) => story.updateStorySettings({ visualProseMode: v })}
    onImageGenerationModeChange={(v) => story.updateStorySettings({ imageGenerationMode: v })}
    onBackgroundImagesEnabledChange={(v) =>
      story.updateStorySettings({ backgroundImagesEnabled: v })}
    onReferenceModeChange={(v) => story.updateStorySettings({ referenceMode: v })}
    onTargetLengthChange={(v) => story.updateStorySettings({ targetLength: v })}
    targetLengthDisabledReason={lengthUnavailableReason}
    disabledFields={{ pov: true, tense: true, visualProseMode: true }}
    disabledReason="Cannot be changed mid-story. Set during story creation."
  />

  {#if !isCollaborative}
    <!-- ── Custom System Prompt ─────────────────────────────────────────────── -->
    <div class="border-t pt-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Label class="text-sm font-medium">自定义系统提示词</Label>
          {#if isActive}
            <span
              class="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
            >
              活跃
            </span>
          {/if}
        </div>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" onclick={loadCurrentTemplate}>载入默认模板</Button>
          {#if isActive || customPromptDraft}
            <Button
              variant="ghost"
              size="sm"
              class="text-destructive hover:text-destructive"
              onclick={clearOverride}
            >
              取消自定义覆盖
            </Button>
          {/if}
        </div>
      </div>

      <p class="text-muted-foreground mb-3 text-xs">
        仅替换本故事的默认提示词模板，支持 Liquid 模板变量。修改在下一次生成时生效，无需重启。
      </p>

      <!--
      Which pack this story actually narrates through. Nothing else in the app shows it, and
      "the default pack template" above is only true when the story is on the built-in pack —
      for any other pack the sentence names something the reader cannot otherwise identify.
    -->
      <p class="text-muted-foreground mb-3 text-xs">
        提示词包：
        {#if boundPack}
          <span class="text-foreground font-medium">{boundPack.name}</span>
          {#if boundPack.author}<span>作者： {boundPack.author}</span>{/if}
          <span class="opacity-70">· {boundPackUsageCount} 个故事使用</span>
          {#if isActive}
            <span>——本故事已使用下方的自定义提示词覆盖。</span>
          {/if}
        {:else if boundPackLoaded}
          <span class="opacity-70">未找到</span>
        {:else}
          <span class="opacity-70">正在加载…</span>
        {/if}
      </p>

      {#if availablePacks.length > 0}
        <div class="mb-4 space-y-3 rounded-md border p-3">
          <Label for="story-prompt-pack">切换本故事的提示词包</Label>
          <select
            id="story-prompt-pack"
            class="bg-background w-full rounded-md border px-2 py-2 text-sm"
            value={pendingPackId ?? boundPack?.id ?? DEFAULT_PACK_ID}
            onchange={(event) => preparePackSwitch(event.currentTarget.value)}
            disabled={packSwitching}
          >
            {#each availablePacks as pack (pack.id)}
              <option value={pack.id}>{pack.name}{pack.isDefault ? '（内置）' : ''}</option>
            {/each}
          </select>

          {#if pendingPackId}
            <div class="bg-muted/30 space-y-3 rounded-md p-3">
              <p class="text-muted-foreground text-xs">
                同名变量值会保留；新 Pack 的默认值会自动填入。没有默认值的必填变量需要补充。
              </p>
              {#each pendingPackVariables as variable (variable.id)}
                <div class="space-y-1">
                  <Label for={`pending-pack-${variable.id}`}>{variable.displayName}</Label>
                  {#if variable.variableType === 'textarea'}
                    <Textarea
                      id={`pending-pack-${variable.id}`}
                      rows={2}
                      value={pendingPackValues[variable.variableName] ?? ''}
                      oninput={(event) =>
                        setPendingPackValue(variable.variableName, event.currentTarget.value)}
                    />
                  {:else if variable.variableType === 'enum' && variable.enumOptions}
                    <select
                      id={`pending-pack-${variable.id}`}
                      class="bg-background w-full rounded-md border px-2 py-2 text-sm"
                      value={pendingPackValues[variable.variableName] ?? ''}
                      onchange={(event) =>
                        setPendingPackValue(variable.variableName, event.currentTarget.value)}
                    >
                      <option value="">请选择…</option>
                      {#each variable.enumOptions as option (option.value)}
                        <option value={option.value}>{option.label || option.value}</option>
                      {/each}
                    </select>
                  {:else if variable.variableType === 'boolean'}
                    <input
                      id={`pending-pack-${variable.id}`}
                      type="checkbox"
                      checked={pendingPackValues[variable.variableName] === 'true'}
                      onchange={(event) =>
                        setPendingPackValue(
                          variable.variableName,
                          event.currentTarget.checked ? 'true' : 'false',
                        )}
                    />
                  {:else}
                    <Input
                      id={`pending-pack-${variable.id}`}
                      type={variable.variableType === 'number' ? 'number' : 'text'}
                      value={pendingPackValues[variable.variableName] ?? ''}
                      oninput={(event) =>
                        setPendingPackValue(variable.variableName, event.currentTarget.value)}
                    />
                  {/if}
                </div>
              {/each}
              <div class="flex gap-2">
                <Button size="sm" onclick={applyPackSwitch} disabled={packSwitching}>
                  {packSwitching ? '正在切换…' : '应用提示词包'}
                </Button>
                <Button variant="ghost" size="sm" onclick={cancelPackSwitch}>取消</Button>
              </div>
            </div>
          {/if}
          {#if packSwitchError}
            <p class="text-destructive text-xs whitespace-pre-line">{packSwitchError}</p>
          {/if}
          {#if isActive}
            <p class="text-xs text-amber-600 dark:text-amber-400">
              当前故事的自定义系统提示词覆盖仍会保留，可能遮蔽新 Pack 的对应模板。
            </p>
          {/if}
        </div>
      {/if}

      <Textarea
        value={customPromptDraft}
        oninput={(e) => onDraftInput((e.currentTarget as HTMLTextAreaElement).value)}
        class="min-h-[200px] font-mono text-xs"
        placeholder={promptPlaceholder}
      />

      <!-- Validation status -->
      {#if customPromptDraft.trim()}
        <div class="mt-2 space-y-1">
          {#if validationResult === null}
            <p class="text-muted-foreground text-xs">正在验证…</p>
          {:else if validationResult.success}
            <p class="text-xs text-green-600 dark:text-green-400">✓ 模板有效</p>
          {:else}
            <p class="text-destructive text-xs">✕ 语法错误： {validationResult.error}</p>
          {/if}

          {#if unknownVars.length > 0}
            <p class="text-xs text-amber-600 dark:text-amber-400">
              ⚠ 未知变量（将渲染为空）：
              {#each unknownVars as v, i (v)}
                <code class="font-mono">{v}</code>{i < unknownVars.length - 1 ? ', ' : ''}
              {/each}
              ——这些可能是提示词包的自定义变量。
            </p>
          {/if}
        </div>
      {/if}

      <!-- Save / status row -->
      {#if isDirty}
        <div class="mt-3 flex items-center justify-between gap-2">
          <p class="text-muted-foreground text-xs">修改尚未保存</p>
          <Button size="sm" onclick={savePrompt} disabled={!canSave}>保存</Button>
        </div>
      {/if}

      <!-- Variable reference (collapsible) -->
      <div class="mt-4">
        <button
          class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
          onclick={() => (showVarReference = !showVarReference)}
          type="button"
        >
          <span>{showVarReference ? '▾' : '▸'}</span>
          可用模板变量
        </button>

        {#if showVarReference}
          <div class="border-border mt-2 rounded-md border p-3 text-xs">
            {#each VARIABLE_REFERENCE as group (group.group)}
              <div class="mb-3 last:mb-0">
                <p
                  class="text-muted-foreground mb-1 text-[0.65rem] font-semibold tracking-wide uppercase"
                >
                  {group.group}
                </p>
                <div class="space-y-1">
                  {#each group.vars as v (v.name)}
                    <div class="flex gap-2">
                      <code class="text-primary min-w-0 shrink-0 font-mono"
                        >{`{{ ${v.name} }}`}</code
                      >
                      <span class="text-muted-foreground">{v.desc}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Tips -->
      <div class="border-border mt-4 space-y-2 rounded-md border border-dashed p-3 text-xs">
        <p class="font-medium">提示</p>
        <ul class="text-muted-foreground list-disc space-y-1 pl-4">
          <li>此覆盖仅适用于当前故事，其他故事仍使用原提示词包模板。</li>
          <li>
            此处也可使用在“素材库 →
            提示词”中定义的自定义变量。它们可能出现在未知变量提示中，但会在实际生成时解析。
          </li>
          <li>
            如果需要多个模板版本，或在故事之间共享提示词，可以创建 <strong>自定义提示词包</strong> ，位置在素材库中。
          </li>
        </ul>
      </div>
    </div>
  {/if}
</div>
