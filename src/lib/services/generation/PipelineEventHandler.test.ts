import { describe, it, expect, vi } from 'vitest'
import {
  handleEvent,
  type PipelineUICallbacks,
  type PipelineEventState,
} from './PipelineEventHandler'
import type { NovelTurn } from '$lib/types/collaborative'
import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import { transpileModule } from 'typescript'
import { historyKey } from './collaborative'
import { createGenerationScope, isGenerationScopeCurrent } from '$lib/utils/branchScope'

function fixture() {
  const callbacks: PipelineUICallbacks = {
    startStreaming: vi.fn(),
    appendStreamContent: vi.fn(),
    appendReasoningContent: vi.fn(),
    startDirectorStreaming: vi.fn(),
    appendDirectorContent: vi.fn(),
    collapseDirectorPanel: vi.fn(),
    setGenerationStatus: vi.fn(),
    setNovelUserSummary: vi.fn(),
    setNovelTurn: vi.fn(),
    setSuggestionsLoading: vi.fn(),
    setActionChoicesLoading: vi.fn(),
    setSuggestions: vi.fn(),
    setActionChoices: vi.fn(),
    emitResponseStreaming: vi.fn(),
    emitSuggestionsReady: vi.fn(),
  }
  const state: PipelineEventState = {
    fullResponse: () => '',
    fullReasoning: () => '',
    streamingEntryId: 'entry',
    visualProseMode: false,
    isCreativeMode: false,
    activeParallelPhases: new Set(),
    isScopeCurrent: () => true,
  }
  return { callbacks, state }
}

describe('director UI event chain', () => {
  it('keeps saved prose after rejected extraction, reports one warning, and continues postprocessing', async () => {
    const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(source) as any
    let block: any
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (
        node.type === 'IfStatement' &&
        node.test.type === 'LogicalExpression' &&
        node.test.left?.right?.value === 'classification_complete'
      )
        block = node
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(ast.instance)
    expect(block).toBeDefined()
    const code = transpileModule(
      `async function handle(event) {
      let classificationObserved = false, classificationFailed = false, variantClassificationResult = null;
      for (const eventIndex of [0]) { ${source.slice(block.start, block.end)} }
      return { classificationObserved, classificationFailed, variantClassificationResult };
    }`,
      { compilerOptions: { target: 99 } },
    ).outputText
    const narrationEntry = { id: 'saved', content: '已经保存的完整正文' }
    const story = {
      applyClassificationResult: vi.fn().mockRejectedValue(new Error('目标未匹配')),
      updateEntryTimeEnd: vi.fn(),
    }
    const ui = { showToast: vi.fn() }
    const handle = new Function(
      'story',
      'ui',
      'narrationEntry',
      'eventBus',
      'console',
      `
      const generationWriteOptions = {}, isGenerationScopeCurrent = () => true;
      const settings = { translationSettings: {} }, currentStoryRef = { mode: 'creative-writing' };
      ${code}; return handle;
    `,
    )(story, ui, narrationEntry, { emit: vi.fn() }, { error: vi.fn() })
    const result = { _error: '目标未匹配' }
    await expect(handle({ type: 'classification_complete', result })).resolves.toEqual({
      classificationObserved: true,
      classificationFailed: true,
      variantClassificationResult: result,
    })
    expect(narrationEntry.content).toBe('已经保存的完整正文')
    expect(ui.showToast).toHaveBeenCalledOnce()
    expect(story.updateEntryTimeEnd).toHaveBeenCalledWith('saved', {})
  })

  it.each([
    ['failed', true, false, 'creative-writing', true],
    ['no_changes', true, false, 'creative-writing', false],
    ['failed', false, false, 'creative-writing', false],
    ['failed', true, true, 'creative-writing', false],
    ['failed', true, false, 'adventure', false],
  ])(
    'renders standalone retry for %s / enabled=%s / delta=%s / mode=%s',
    (status, enabled, hasDelta, mode, expected) => {
      const source = readFileSync('src/lib/components/story/StoryEntry.svelte', 'utf8')
      const ast = parse(source) as any
      const binding = ast.instance.content.body
        .flatMap((node: any) => node.declarations ?? [])
        .find((node: any) => node.id?.name === 'canRetryStateExtraction')
      const expression = binding.init.arguments[0]
      const canRetry = new Function(
        'entry',
        'story',
        `
      const isCollaborative = story.currentStory.mode === 'creative-writing';
      const currentBranchId = story.currentStory.currentBranchId ?? null;
      const maintenance = entry.metadata.collaborativeStateMaintenance;
      const factStateExtractorEnabled = story.currentStory.settings.collaborativeNovelWorkflow.factStateExtractor.enabled;
      return ${source.slice(expression.start, expression.end)};
    `,
      )
      const entry = {
        id: 'saved',
        type: 'narration',
        metadata: { collaborativeStateMaintenance: { status } },
        worldStateDelta: hasDelta ? { version: 2 } : null,
      }
      const story = {
        currentStory: {
          mode,
          settings: { collaborativeNovelWorkflow: { factStateExtractor: { enabled } } },
        },
        entries: [entry],
      }
      expect(canRetry(entry, story)).toBe(expected)
      expect(canRetry({ ...entry, branchId: 'parent' }, story)).toBe(false)
      expect(
        canRetry(entry, { ...story, entries: [entry, { id: 'later', type: 'narration' }] }),
      ).toBe(false)
    },
  )

  it('records only actual pipeline phases and never claims translation service-call counts', () => {
    const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(source) as any
    let block: any
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (
        node.type === 'IfStatement' &&
        node.test.type === 'Identifier' &&
        node.test.name === 'diagnostics'
      )
        block = node
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(ast.instance)
    expect(block).toBeDefined()
    const code = transpileModule(
      `function record(event, diagnostics) { ${source.slice(block.start, block.end)} }`,
      { compilerOptions: { target: 99 } },
    ).outputText
    const record = new Function(`${code}; return record;`)() as (
      event: Record<string, unknown>,
      diagnostics: Record<string, unknown>,
    ) => void
    const diagnostics = {
      phases: [],
      sceneDirectorCompleted: false,
      writerTemplateId: 'collaborative-chinese-writer',
      translationPhases: 0,
    }
    record({ type: 'phase_start', phase: 'retrieval' }, diagnostics)
    record({ type: 'phase_progress', phase: 'scene_director', progress: 'directing' }, diagnostics)
    record({ type: 'phase_complete', phase: 'scene_director' }, diagnostics)
    record({ type: 'phase_start', phase: 'narrative' }, diagnostics)
    record({ type: 'narrative_chunk', content: '秘密正文' }, diagnostics)
    record({ type: 'phase_start', phase: 'classification' }, diagnostics)
    record({ type: 'phase_start', phase: 'translation' }, diagnostics)
    record({ type: 'phase_complete', phase: 'translation' }, diagnostics)
    expect(diagnostics).toEqual({
      phases: [
        'retrieval',
        'scene_director:directing',
        'narrative',
        'classification',
        'translation',
      ],
      sceneDirectorCompleted: true,
      writerTemplateId: 'collaborative-chinese-writer',
      translationPhases: 1,
    })
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /秘密正文|translationCalls|writerTemplateSource/,
    )
  })

  function submitFixture() {
    const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(source) as any
    const fn = ast.instance.content.body.find(
      (n: any) => n.type === 'FunctionDeclaration' && n.id.name === 'handleSubmit',
    )
    const code = transpileModule(source.slice(fn.start, fn.end), {
      compilerOptions: { target: 99 },
    }).outputText
    const story = {
      currentStory: { id: 'A', currentBranchId: 'branch-A', timeTracker: null },
      entries: [] as any[],
      characters: [],
      locations: [],
      items: [],
      storyBeats: [],
      addEntry: vi.fn(async (..._args: any[]) => {
        const entry = {
          id: 'action-A',
          storyId: 'A',
          branchId: 'branch-A',
          type: 'user_action',
          content: '译文',
        }
        story.entries.push(entry)
        return entry
      }),
      refreshEntry: vi.fn(async () => {}),
    }
    const ui = {
      isGenerating: false,
      submissionScope: null as ReturnType<typeof createGenerationScope> | null,
      generationScope: { turnId: 'previous' },
      clearGenerationError: vi.fn(),
      resetScrollBreak: vi.fn(),
      clearSuggestions: vi.fn(),
      createRetryBackup: vi.fn(),
      showToast: vi.fn(),
    }
    const database = {
      getEmbeddedImageIdsForStory: vi.fn(async () => []),
      updateStoryEntry: vi.fn(async () => {}),
    }
    const translate = vi.fn(async () => ({ promptContent: '译文', originalInput: '原输入' }))
    const tick = vi.fn(async () => {})
    const generate = vi.fn(async () => {})
    const emit = vi.fn()
    const run = new Function(
      'story',
      'ui',
      'database',
      'settings',
      'createGenerationScope',
      'isScopeCurrent',
      'historyKey',
      'translateUserInput',
      'tick',
      'generateResponse',
      'emitUserInput',
      'errMessage',
      `let inputValue = '原输入', isRawActionChoice = false; const recoveryBusy = false, blockGeneration = false, generationConfigError = '', actionType = 'free', isCreativeMode = true, isCollaborative = false, textareaRef = null, actionPrefixes = {}, actionSuffixes = {}; ${code}; return { submit: handleSubmit, input: value => inputValue = value };`,
    )(
      story,
      ui,
      database,
      { translationSettings: { enabled: true }, uiSettings: { disableActionPrefixes: true } },
      createGenerationScope,
      isGenerationScopeCurrent,
      historyKey,
      translate,
      tick,
      generate,
      emit,
      (e: Error) => e.message,
    ) as { submit: () => Promise<void>; input: (value: string) => void }
    return { ...run, story, ui, database, translate, tick, generate, emit }
  }

  it.each(['images', 'translation', 'addEntry', 'updateEntry', 'refreshEntry', 'tick'])(
    'does not continue A submission after switching to B during %s',
    async (stage) => {
      const f = submitFixture()
      const switchStory = () => {
        f.story.currentStory = { id: 'B', currentBranchId: 'branch-B', timeTracker: null }
        f.story.entries = []
      }
      if (stage === 'images')
        f.database.getEmbeddedImageIdsForStory.mockImplementation(async () => {
          switchStory()
          return []
        })
      if (stage === 'translation')
        f.translate.mockImplementation(async () => {
          switchStory()
          return { promptContent: '译文', originalInput: '原输入' }
        })
      if (stage === 'addEntry')
        f.story.addEntry.mockImplementation(async () => {
          switchStory()
          return {
            id: 'action-A',
            storyId: 'A',
            branchId: 'branch-A',
            type: 'user_action',
            content: '译文',
          }
        })
      if (stage === 'updateEntry')
        f.database.updateStoryEntry.mockImplementation(async () => {
          switchStory()
        })
      if (stage === 'refreshEntry')
        f.story.refreshEntry.mockImplementation(async () => {
          switchStory()
        })
      if (stage === 'tick')
        f.tick.mockImplementation(async () => {
          switchStory()
        })
      await f.submit()
      expect(f.database.getEmbeddedImageIdsForStory).toHaveBeenCalledWith('A')
      expect(f.generate).not.toHaveBeenCalled()
      if (stage === 'images' || stage === 'translation')
        expect(f.story.addEntry).not.toHaveBeenCalled()
      if (stage === 'addEntry') expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
      if (stage === 'updateEntry') expect(f.story.refreshEntry).not.toHaveBeenCalled()
      expect(f.ui.showToast).not.toHaveBeenCalled()
    },
  )

  it('locks submission before its first await and rejects duplicate clicks', async () => {
    const f = submitFixture()
    let resume!: (value: never[]) => void
    f.database.getEmbeddedImageIdsForStory.mockReturnValue(
      new Promise((resolve) => {
        resume = resolve
      }),
    )
    const pending = f.submit()
    expect(f.ui.submissionScope?.storyId).toBe('A')
    f.input('第二次输入')
    await f.submit()
    expect(f.database.getEmbeddedImageIdsForStory).toHaveBeenCalledOnce()
    resume([])
    await pending
    expect(f.story.addEntry).toHaveBeenCalledOnce()
    expect(f.generate).toHaveBeenCalledWith('action-A', '译文')
    expect(f.ui.submissionScope).toBeNull()
    expect(f.translate).toHaveBeenCalledWith(
      '原输入',
      { enabled: true },
      expect.objectContaining({ id: 'A' }),
    )
  })

  it('does not clear a new submission lock when an old awaited submission finishes', async () => {
    const f = submitFixture()
    let resume!: (value: never[]) => void
    f.database.getEmbeddedImageIdsForStory.mockReturnValue(
      new Promise((resolve) => {
        resume = resolve
      }),
    )
    const pending = f.submit()
    const replacement = createGenerationScope('A', 'branch-A')
    f.ui.submissionScope = replacement
    resume([])
    await pending
    expect(f.ui.submissionScope).toBe(replacement)
    expect(f.story.addEntry).not.toHaveBeenCalled()
  })

  it('stops a submission if history changes while translation is pending', async () => {
    const f = submitFixture()
    f.translate.mockImplementation(async () => {
      f.story.entries.push({ id: 'concurrent', type: 'narration', content: '并发正文' })
      return { promptContent: '译文', originalInput: '原输入' }
    })
    await f.submit()
    expect(f.story.addEntry).not.toHaveBeenCalled()
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.ui.submissionScope).toBeNull()
  })

  it('releases submission lock and reports an initial lookup failure without writing an action', async () => {
    const f = submitFixture()
    f.database.getEmbeddedImageIdsForStory.mockRejectedValue(new Error('lookup failed'))
    await f.submit()
    expect(f.ui.submissionScope).toBeNull()
    expect(f.ui.showToast).toHaveBeenCalledWith('lookup failed', 'error')
    expect(f.story.addEntry).not.toHaveBeenCalled()
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('passes captured target and a live submission guard into the store write', async () => {
    const f = submitFixture()
    f.story.addEntry.mockImplementation(async (...args: any[]) => {
      const options = args[5]
      expect(options.scope).toMatchObject({ storyId: 'A', branchId: 'branch-A' })
      expect(options.isScopeCurrent()).toBe(true)
      f.story.currentStory = { id: 'B', currentBranchId: 'branch-B', timeTracker: null }
      expect(options.isScopeCurrent()).toBe(false)
      throw new Error('stale write rejected by store')
    })
    await f.submit()
    expect(f.story.addEntry).toHaveBeenCalledOnce()
    expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.ui.showToast).not.toHaveBeenCalled()
  })
  it.each([
    {
      fatalMessage: 'SDK stream failed',
      narrationEntry: null,
      fullResponse: '尚未完成的部分正文。',
      failed: true,
    },
    { fatalMessage: '', narrationEntry: null, fullResponse: '没有完成事件的正文。', failed: true },
    {
      fatalMessage: 'fatal after narration',
      narrationEntry: { id: 'saved' },
      fullResponse: '正文。',
      failed: true,
    },
    {
      fatalMessage: '',
      narrationEntry: { id: 'saved' },
      fullResponse: '完整正文。',
      failed: false,
    },
  ])(
    'only a successfully persisted nonfatal narration may proceed to background tasks: $fatalMessage',
    async (input) => {
      const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
      const ast = parse(source) as any
      let failure: any
      const visit = (node: any) => {
        if (!node || typeof node !== 'object') return
        if (
          node.type === 'IfStatement' &&
          source.slice(node.start, node.end).includes('const errorMessage = fatalMessage ||')
        )
          failure = node
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value === 'object') visit(value)
        }
      }
      visit(ast.instance)
      expect(failure).toBeDefined()
      expect(failure.end).toBeLessThan(
        source.indexOf('const coordinator = new BackgroundTaskCoordinator', failure.end),
      )
      const story = { addEntry: vi.fn(async () => ({ id: 'error-entry' })) }
      const ui = { setGenerationError: vi.fn() }
      const background = vi.fn()
      const notify = vi.fn()
      const execute = new Function(
        'input',
        'story',
        'ui',
        'background',
        'notifyFailureIfBackgrounded',
        `const { fatalMessage, narrationEntry, fullResponse } = input;
       const userActionEntryId = 'action'; const isGenerationScopeCurrent = () => true; const generationMeta = {};
       const generationWriteOptions = { scope: { storyId: 'A', branchId: null }, isScopeCurrent: isGenerationScopeCurrent };
       return (async () => { ${source.slice(failure.start, failure.end)}; background(); })();`,
      )
      await execute(input, story, ui, background, notify)
      if (input.failed) {
        expect(story.addEntry).toHaveBeenCalledWith(
          'system',
          input.fatalMessage || '模型未返回完整正文，请重试。',
          undefined,
          undefined,
          undefined,
          expect.objectContaining({ scope: { storyId: 'A', branchId: null } }),
        )
        expect(ui.setGenerationError).toHaveBeenCalledWith(
          expect.objectContaining({ errorEntryId: 'error-entry', userActionEntryId: 'action' }),
        )
        expect(notify).toHaveBeenCalledOnce()
        expect(background).not.toHaveBeenCalled()
      } else {
        expect(story.addEntry).not.toHaveBeenCalled()
        expect(background).toHaveBeenCalledOnce()
      }
    },
  )
  it('validates shared Profiles for enabled collaborative tasks, not generic task config', () => {
    const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(source) as any
    const fn = ast.instance.content.body.find(
      (node: any) =>
        node.type === 'FunctionDeclaration' && node.id.name === 'generationBlockReason',
    )
    const code = transpileModule(source.slice(fn.start, fn.end), {
      compilerOptions: { target: 99 },
    }).outputText
    const story = {
      currentStory: {
        settings: {
          collaborativeNovelWorkflow: {
            factStateExtractor: { enabled: true },
            sceneDirector: { enabled: true },
          },
        },
      },
    }
    const run = (collaborative = true) =>
      new Function(
        'story',
        'isCollaborative',
        'settings',
        'errMessage',
        'collaborativeServiceIds',
        `${code}; return generationBlockReason();`,
      )(
        story,
        collaborative,
        {
          hasGenerationConfigIssues: true,
          generationPresets: [
            { id: 'control', profileId: 'api', model: '中文模型', maxTokens: 6000 },
            { id: 'writer', profileId: 'api', model: '中文模型', maxTokens: 6000 },
          ],
          apiSettings: { mainNarrativeProfileId: 'api' },
          getServicePresetId: (serviceId: string) =>
            serviceId === 'collaborativeWriter' ? 'writer' : 'control',
          getProfile: () => ({ id: 'api' }),
        },
        (e: Error) => e.message,
        {
          sceneDirector: 'collaborativeSceneDirector',
          writer: 'collaborativeWriter',
          factStateExtractor: 'collaborativeFactStateExtractor',
        },
      )
    expect(run()).toBe('')
    story.currentStory.settings.collaborativeNovelWorkflow.sceneDirector.enabled = true
    story.currentStory.settings.collaborativeNovelWorkflow.factStateExtractor.enabled = false
    expect(run()).toBe('')
    expect(run(false)).toContain('模型配置不完整')
    expect(run()).toBe('')
    story.currentStory.settings.collaborativeNovelWorkflow.sceneDirector.enabled = false
    expect(run()).toBe('')
  })

  it('keeps action choices adventure-only and exposes one collaborative inspiration surface', () => {
    const view = readFileSync('src/lib/components/story/StoryView.svelte', 'utf8')
    const input = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(view) as any
    let condition = ''
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (
        node.type === 'IfBlock' &&
        node.children?.some((child: any) => child.name === 'ActionChoices')
      )
        condition = view.slice(node.expression.start, node.expression.end)
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(ast.html)
    expect(condition).toBeTruthy()
    const visible = (mode: string, disabled = true) =>
      Boolean(
        new Function('story', 'ui', 'settings', `return ${condition}`)(
          { storyMode: mode },
          { isStreaming: false, isGenerating: false },
          { uiSettings: { disableSuggestions: disabled } },
        ),
      )
    expect(visible('creative-writing')).toBe(false)
    expect(visible('creative-writing', false)).toBe(false)
    expect(visible('adventure', false)).toBe(true)
    expect(visible('adventure', true)).toBe(false)
    expect(input).toContain('{#if isCreativeMode || isCollaborative}')
    expect(input).toContain('<Suggestions')
    expect(input).not.toContain('按需生成剧情建议')
    expect(input).toContain('if (!isCollaborative) regenerateActionsAfterDelete()')
  })
  function refreshFixture(
    mode = 'creative-writing',
    settings: object = { collaborativeNovelWorkflow: {} },
  ) {
    const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
    const ast = parse(source) as any
    const fn = ast.instance.content.body.find(
      (node: any) => node.type === 'FunctionDeclaration' && node.id.name === 'refreshSuggestions',
    )
    const currentStory = { id: 'story', mode, currentBranchId: 'branch', settings }
    const story = {
      currentStory,
      storyMode: mode,
      entries: [{ id: 'entry', type: 'narration', content: '正文', branchId: 'branch' }],
      pendingQuests: [],
    }
    const ui = {
      isGenerating: false,
      generationScope: { turnId: 'generation' },
      lastLorebookRetrieval: null,
      setSuggestionsLoading: vi.fn(),
      setSuggestions: vi.fn(),
      clearSuggestions: vi.fn(),
    }
    const database = { updateStoryEntry: vi.fn(async () => {}) }
    const refresh = vi.fn<(...args: any[]) => Promise<any>>()
    const emitSuggestionsReady = vi.fn()
    const run = new Function(
      'story',
      'ui',
      'database',
      'SuggestionsRefreshService',
      'aiService',
      'settings',
      'createGenerationScope',
      'isScopeCurrent',
      'historyKey',
      'emitSuggestionsReady',
      'log',
      `let activeSuggestionsRefreshId = null; return (${source.slice(fn.start, fn.end)});`,
    )(
      story,
      ui,
      database,
      class {
        refresh = refresh
      },
      { generateSuggestions: vi.fn(), translateSuggestions: vi.fn() },
      { translationSettings: { enabled: true } },
      createGenerationScope,
      isGenerationScopeCurrent,
      historyKey,
      emitSuggestionsReady,
      vi.fn(),
    ) as () => Promise<void>
    return { run, story, ui, database, refresh, emitSuggestionsReady }
  }

  it('passes collaborative refresh mode from the authoritative story mode', async () => {
    const f = refreshFixture()
    f.refresh.mockResolvedValue({ suggestions: [{ text: '中文建议', type: 'action' }] })
    await f.run()
    expect(f.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        isCollaborative: true,
        storyId: 'story',
        storyMode: 'creative-writing',
      }),
    )
    expect(f.ui.setSuggestions).toHaveBeenCalledWith(
      [{ text: '中文建议', type: 'action' }],
      'story',
    )
    expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
  })

  it.each(['story', 'branch', 'history', 'turn', 'entry', 'disabled', 'mode'])(
    'discards suggestions after %s scope changes',
    async (change) => {
      const f = refreshFixture()
      let resolve!: (value: any) => void
      f.refresh.mockReturnValue(
        new Promise((done) => {
          resolve = done
        }),
      )
      const pending = f.run()
      if (change === 'story') f.story.currentStory.id = 'other'
      if (change === 'branch') f.story.currentStory.currentBranchId = 'other'
      if (change === 'history') f.story.entries[0].content = '编辑后的正文'
      if (change === 'turn') f.ui.generationScope.turnId = 'new-generation'
      if (change === 'entry') f.story.entries[0].id = 'replacement'
      if (change === 'disabled')
        (f.story.currentStory.settings as any).collaborativeNovelWorkflow.plotSuggestions = {
          enabled: false,
        }
      if (change === 'mode') f.story.currentStory.mode = 'adventure'
      resolve({ suggestions: [{ text: '迟到建议', type: 'action' }] })
      await pending
      expect(f.ui.setSuggestions).not.toHaveBeenCalled()
      expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
      expect(f.emitSuggestionsReady).not.toHaveBeenCalled()
    },
  )

  it('does not let an older refresh overwrite newer results or loading state', async () => {
    const f = refreshFixture()
    let resolve!: (value: any) => void
    f.refresh.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.refresh.mockResolvedValueOnce({ suggestions: [{ text: '新建议', type: 'action' }] })
    const pending = f.run()
    await f.run()
    const loadingCalls = f.ui.setSuggestionsLoading.mock.calls.length
    resolve({ suggestions: [{ text: '旧建议', type: 'action' }] })
    await pending
    expect(f.ui.setSuggestions).toHaveBeenCalledTimes(1)
    expect(f.ui.setSuggestionsLoading.mock.calls).toHaveLength(loadingCalls)
  })

  it('does not mutate inherited ancestor narration while refreshing a child branch', async () => {
    const f = refreshFixture()
    f.story.entries[0].branchId = 'ancestor'
    f.refresh.mockResolvedValue({ suggestions: [{ text: '分支建议', type: 'action' }] })
    await f.run()
    expect(f.ui.setSuggestions).toHaveBeenCalledOnce()
    expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
  })

  it('renders scoped progress even while streaming and keeps an unexpanded saved-entry summary', () => {
    const view = readFileSync('src/lib/components/story/StoryView.svelte', 'utf8')
    const entry = readFileSync('src/lib/components/story/StoryEntry.svelte', 'utf8')
    const viewAst = parse(view) as any
    const entryAst = parse(entry) as any
    const nodes: any[] = []
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (node.type) nodes.push(node)
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(viewAst.html)
    const statusConditions = nodes.filter(
      (n) =>
        n.type === 'IfBlock' &&
        view.slice(n.expression.start, n.expression.end).includes('ui.generationStatus'),
    )
    expect(statusConditions).toHaveLength(1)
    const condition = view.slice(
      statusConditions[0].expression.start,
      statusConditions[0].expression.end,
    )
    expect(condition).not.toContain('!ui.isStreaming')
    expect(condition).toContain('ui.generationScope?.storyId')
    expect(condition).toContain('ui.generationScope?.branchId')
    nodes.length = 0
    visit(entryAst.html)
    const savedSummary = nodes.find(
      (n) =>
        n.type === 'Element' &&
        n.name === 'details' &&
        entry.slice(n.start, n.end).includes('entry.metadata.novelUserSummary'),
    )
    expect(savedSummary).toBeDefined()
    expect(savedSummary.attributes.some((a: any) => a.name === 'open')).toBe(false)
    expect(entry.slice(savedSummary.start, savedSummary.end)).not.toContain('isGenerating')
  })
  it('displays distinct retrieval, interpreting, review, directing, writer and fact stages', () => {
    const { callbacks, state } = fixture()
    handleEvent({ type: 'phase_start', phase: 'retrieval' }, state, callbacks)
    handleEvent({ type: 'phase_start', phase: 'scene_director' }, state, callbacks)
    for (const progress of ['long_planning', 'reviewing_patterns', 'directing'] as const)
      handleEvent({ type: 'phase_progress', phase: 'scene_director', progress }, state, callbacks)
    handleEvent({ type: 'phase_start', phase: 'narrative' }, state, callbacks)
    handleEvent({ type: 'phase_start', phase: 'classification' }, state, callbacks)
    expect(vi.mocked(callbacks.setGenerationStatus).mock.calls.flat()).toEqual([
      '正在检索相关上下文',
      '正在解释自然输入',
      '正在更新长期软规划',
      '正在读取结构规避指导',
      '正在安排本轮场景（等待导演原文）',
      '正在生成中文正文',
      '正在更新故事事实',
    ])
    expect(callbacks.startDirectorStreaming).toHaveBeenCalledOnce()
    expect(callbacks.collapseDirectorPanel).toHaveBeenCalledOnce()
  })
  it('routes Director chunks only to the independent Director buffer', () => {
    const { callbacks, state } = fixture()
    handleEvent({ type: 'director_chunk', content: '  原始\n文字  ' }, state, callbacks)
    expect(callbacks.appendDirectorContent).toHaveBeenCalledWith('  原始\n文字  ')
    expect(callbacks.appendStreamContent).not.toHaveBeenCalled()
    expect(callbacks.emitResponseStreaming).not.toHaveBeenCalled()
  })
  it('passes only a safe summary to UI and the original turn to metadata storage', () => {
    const { callbacks, state } = fixture()
    const turn = {
      sceneDirectorOutput: 'NPC查证',
      confirmedPlan: '秘密长期计划',
      confirmedPatternGuidance: null,
    } as unknown as NovelTurn
    handleEvent({ type: 'phase_complete', phase: 'scene_director', result: turn }, state, callbacks)
    expect(callbacks.setNovelTurn).toHaveBeenCalledWith(turn)
    const summary = vi.mocked(callbacks.setNovelUserSummary!).mock.calls[0][0]
    expect(summary).toContain('NPC查证')
    expect(summary).toContain('NPC查证')
  })
  it('ignores late progress, chunks, summaries and errors when the scope changes', () => {
    const { callbacks, state } = fixture()
    state.isScopeCurrent = () => false
    handleEvent(
      { type: 'phase_progress', phase: 'scene_director', progress: 'directing' },
      state,
      callbacks,
    )
    handleEvent({ type: 'phase_complete', phase: 'scene_director', result: null }, state, callbacks)
    handleEvent({ type: 'director_chunk', content: '迟到导演文字' }, state, callbacks)
    handleEvent({ type: 'narrative_chunk', content: '迟到正文' }, state, callbacks)
    handleEvent(
      { type: 'error', phase: 'scene_director', error: new Error('迟到失败'), fatal: true },
      state,
      callbacks,
    )
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled()
  })
  it('surfaces director failure without starting streaming', () => {
    const { callbacks, state } = fixture()
    handleEvent(
      { type: 'error', phase: 'scene_director', error: new Error('没有简报'), fatal: true },
      state,
      callbacks,
    )
    expect(callbacks.setGenerationStatus).toHaveBeenCalledWith('本轮导演失败：没有简报')
    expect(callbacks.startStreaming).not.toHaveBeenCalled()
  })
})
