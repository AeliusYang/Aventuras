import { describe, it, expect, vi } from 'vitest'

vi.mock('$lib/stores/debug.svelte', () => ({
  debug: {
    addDebugRequest: vi.fn(),
    addDebugResponse: vi.fn(),
  },
}))

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    systemServicesSettings: {},
    apiSettings: { profiles: [{ apiKey: 'secret-key' }] },
    getServiceIdForPreset: vi.fn(),
    getServiceConfig: vi.fn(),
    getServicePresetId: () => 'writer',
    getPresetConfig: () => ({ timeoutMs: 360000 }),
  },
}))

import { GenerationPipeline } from './GenerationPipeline'
import type { NovelTurn } from '$lib/types/collaborative'
import { prepareNovelTurn } from './prepareNovelTurn'
import { handleEvent, type PipelineUICallbacks } from './PipelineEventHandler'
import { novelWriterContext } from './collaborative'
import * as collaborative from './collaborative'

const preparedTurn = (): NovelTurn => ({
  version: 2,
  historyKey: '',
  rawInput: '继续',
  sceneDirectorOutput: '符合约束的展开',
  confirmedPlan: null,
  confirmedPatternGuidance: null,
})

describe('GenerationPipeline', () => {
  const novelContext = () =>
    ({
      story: { id: 's', mode: 'creative-writing', settings: { collaborativeNovelWorkflow: {} } },
      allEntries: [],
      visibleEntries: [],
      userAction: { entryId: 'a', content: '继续', rawInput: '继续' },
      worldState: { characters: [], locations: [], items: [], storyBeats: [] },
    }) as any
  const cachedConfig = {
    rawInput: '继续',
    cachedRetrievalResult: { combinedContext: '已发生事实' },
    imageSettings: { backgroundImagesEnabled: false },
  } as any

  it.each(['dynamic', 'short', 'medium', 'long'] as const)(
    'completes %s prose and continues to fact extraction even when extraction fails',
    async (targetLength) => {
      const context = novelContext()
      context.story.settings.targetLength = targetLength
      const prose = '她取出另一封信。\n\n门外的脚步停了下来。'
      const classifyResponse = vi.fn().mockRejectedValue(new Error('事实提取故障'))
      const pipeline = new GenerationPipeline({
        prepareCollaborative: async () => preparedTurn(),
        streamNarrative: async function* () {
          yield { content: prose.slice(0, 8), done: false }
          yield { content: prose.slice(8), done: true, finishReason: 'stop' }
        },
        classifyResponse,
      } as any)
      const events = []
      const iterator = pipeline.execute(context, cachedConfig)
      let next = await iterator.next()
      while (!next.done) {
        events.push(next.value)
        next = await iterator.next()
      }
      expect(next.value.narrative?.content).toBe(prose)
      expect(
        events.find((event) => event.type === 'phase_complete' && event.phase === 'narrative'),
      ).toMatchObject({ result: { content: prose, outputTruncated: false } })
      expect(classifyResponse).toHaveBeenCalledWith(
        prose,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      )
      expect(events.find((event) => event.type === 'error')).toMatchObject({
        phase: 'classification',
        fatal: false,
      })
      expect(next.value.fatalError).toBeNull()
    },
  )

  it('continues after metrics failure while retaining a reroll and its completed prose', async () => {
    const spy = vi.spyOn(collaborative, 'recordNovelOutput').mockImplementation(() => {
      throw new Error('统计故障')
    })
    try {
      const classifyResponse = vi.fn(async () => ({ scene: {} }))
      const result = await drainPipeline(
        new GenerationPipeline({
          prepareCollaborative: async () => preparedTurn(),
          streamNarrative: async function* () {
            yield { content: '不同路线的正文。', done: true, finishReason: 'stop' }
          },
          classifyResponse,
        } as any),
        novelContext(),
        {
          ...cachedConfig,
          novelRetry: {
            mode: 'different',
            rawInput: '继续',
            sourceText: '旧正文',
            historyKey: 'h',
            storyId: 's',
          },
        },
      )
      expect(result.narrative?.content).toBe('不同路线的正文。')
      expect(result.narrative?.outputMetricsWarning).toContain('统计故障')
      expect(classifyResponse).toHaveBeenCalledOnce()
      expect(result.fatalError).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['network', 'timeout', 'empty', 'partial'])(
    'reuses a persisted Director after %s Writer failure without retrieval or planning',
    async (failure) => {
      const turn = preparedTurn()
      const prepareCollaborative = vi.fn(async () => turn)
      const failedWriter = vi.fn(async function* () {
        if (failure === 'partial') yield { content: '未完成片段', done: false }
        if (failure !== 'empty') throw new Error(failure)
        yield { content: '', done: true }
      })
      const firstEvents = []
      for await (const event of new GenerationPipeline({
        streamNarrative: failedWriter,
        prepareCollaborative,
      } as any).execute(novelContext(), cachedConfig))
        firstEvents.push(event)
      expect(prepareCollaborative).toHaveBeenCalledTimes(1)
      expect(firstEvents.some((e) => e.type === 'error' && e.fatal)).toBe(true)
      const recovery = JSON.parse(
        JSON.stringify({
          version: 1,
          storyId: 's',
          branchId: null,
          userActionEntryId: 'a',
          novelTurn: turn,
          retrieval: cachedConfig.cachedRetrievalResult,
        }),
      )
      const writer = vi.fn(async function* () {
        yield { content: '完整的新正文', done: true }
      })
      const pipeline = new GenerationPipeline({
        streamNarrative: writer,
        prepareCollaborative,
      } as any)
      const events = []
      for await (const event of pipeline.execute(novelContext(), {
        ...cachedConfig,
        cachedRetrievalResult: undefined,
        writerRecovery: recovery,
      })) {
        events.push(event)
        if (event.type === 'phase_complete' && event.phase === 'narrative') break
      }
      expect(prepareCollaborative).toHaveBeenCalledTimes(1)
      expect(writer).toHaveBeenCalledTimes(1)
      expect((writer.mock.calls[0] as unknown as any[])[8].sceneDirectorOutput).toBe(
        turn.sceneDirectorOutput,
      )
      expect(
        events
          .filter((e) => e.type === 'narrative_chunk')
          .map((e) => e.content)
          .join(''),
      ).toBe('完整的新正文')
    },
  )

  it('does not invoke the writer when mandatory novel preparation fails', async () => {
    const streamNarrative = vi.fn()
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async () => {
        throw new Error('规划失败')
      },
    } as any)
    const events = []
    for await (const event of pipeline.execute(novelContext(), cachedConfig)) events.push(event)
    expect(streamNarrative).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', phase: 'scene_director', fatal: true }),
    )
  })

  it('passes the prepared turn to the writer only after retrieval and planning', async () => {
    const turn = preparedTurn()
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: false }
      yield { content: '', done: true }
      yield { content: '', done: true }
    })
    const prepareCollaborative = vi.fn(async () => turn)
    const pipeline = new GenerationPipeline({ streamNarrative, prepareCollaborative } as any)
    const events = []
    for await (const event of pipeline.execute(novelContext(), cachedConfig)) {
      events.push(event)
      if (event.type === 'narrative_chunk') break
    }
    expect(events.filter((e) => e.type === 'phase_complete').map((e) => e.phase)).toEqual([
      'pre',
      'retrieval',
      'scene_director',
    ])
    expect(Array.from(streamNarrative.mock.calls[0] ?? [])[8]).toEqual(turn)
    expect(prepareCollaborative.mock.invocationCallOrder[0]).toBeLessThan(
      streamNarrative.mock.invocationCallOrder[0],
    )
  })

  it('enforces current raw-input length after custom collaborative preparation', async () => {
    const turn = preparedTurn()
    turn.requestedLength = '20中文字'
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: true }
    })
    const context = novelContext()
    context.story.settings = {
      collaborativeNovelWorkflow: { targetLength: '2400中文字' },
    }
    const config = { ...cachedConfig, rawInput: '这轮正文写1200字。' }
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async () => turn,
    } as any)
    for await (const _event of pipeline.execute(context, config)) {
      // Drain the pipeline so the writer call can be inspected.
    }
    const writerTurn = Array.from(streamNarrative.mock.calls[0] ?? [])[8] as NovelTurn
    expect(writerTurn.requestedLength).toBe('1200中文字')
  })

  it('never forwards a generic prose quality review into collaborative writer', async () => {
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: true }
    })
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async () => preparedTurn(),
    } as any)
    for await (const event of pipeline.execute(novelContext(), {
      ...cachedConfig,
      styleReview: { forbidden: 'generic post-review' },
    })) {
      if (event.type === 'narrative_chunk') break
    }
    expect((streamNarrative.mock.calls[0] as unknown[])[3]).toBeNull()
  })

  it('can disable fact extraction without disabling mandatory director and writer', async () => {
    const context = novelContext()
    context.story.settings = {
      collaborativeNovelWorkflow: { factStateExtractor: { enabled: false } },
    }
    const classifyResponse = vi.fn()
    const pipeline = new GenerationPipeline({
      classifyResponse,
      prepareCollaborative: async () => preparedTurn(),
      streamNarrative: async function* () {
        yield { content: '正文', done: true }
      },
    } as any)
    const result = await drainPipeline(pipeline, context, cachedConfig)
    expect(result.narrative?.content).toBe('正文')
    expect(classifyResponse).not.toHaveBeenCalled()
    expect(result.fatalError).toBeNull()
  })

  it('keeps adventure mode free of collaborative preparation even with an empty workflow', async () => {
    const context = novelContext()
    context.story.mode = 'adventure'
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: false }
      yield { content: '', done: true }
    })
    const prepareCollaborative = vi.fn(async () => preparedTurn())
    const pipeline = new GenerationPipeline({ streamNarrative, prepareCollaborative } as any)
    for await (const event of pipeline.execute(context, cachedConfig))
      if (event.type === 'narrative_chunk') break
    expect(prepareCollaborative).not.toHaveBeenCalled()
  })

  it('extracts facts and runs background work without generic post processing', async () => {
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: false }
      yield { content: '', done: true }
    })
    const classifyResponse = vi.fn().mockResolvedValue({
      scene: { presentCharacterNames: [] },
      newCharacters: [],
      newLocations: [],
      newItems: [],
      newStoryBeats: [],
      characterUpdates: [],
      locationUpdates: [],
      itemUpdates: [],
      storyBeatUpdates: [],
      relationshipUpdates: [],
      worldStateChanges: [],
    })
    const background = vi.fn(async function* () {
      yield { type: 'phase_start', phase: 'background_image' }
    })
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async () => preparedTurn(),
      classifyResponse,
      backgroundImageService: background,
      translateResponse: vi.fn(),
      generateSuggestions: vi.fn(),
    } as any)
    const context = novelContext()
    context.narrationEntryId = 'n1'
    context.visibleEntries = [
      {
        id: 'old',
        type: 'narration',
        content: '真正发生的旧正文',
        metadata: { novelUserSummary: '未来场景安排', novelTurn: preparedTurn() },
        reasoning: '隐藏分析',
      },
      { id: 'action', type: 'user_action', content: '导演要求' },
    ]
    const result = await drainPipeline(pipeline, context, cachedConfig)
    expect(classifyResponse).toHaveBeenCalled()
    expect(classifyResponse.mock.calls[0][0]).toBe('正文')
    expect(JSON.stringify(classifyResponse.mock.calls[0][4])).not.toMatch(
      /未来场景安排|隐藏分析|导演要求/,
    )
    expect(classifyResponse.mock.calls[0][4]).toEqual([
      expect.objectContaining({
        content: '真正发生的旧正文',
        metadata: null,
        reasoning: undefined,
      }),
    ])
    expect(result.translation).toBeNull()
    expect(result.postGeneration).toBeNull()
    expect(result.fatalError).toBeNull()
    expect(result.background?.skippedReason).toBe('disabled')
  })

  it('does not generate images for a reroll when classification fails', async () => {
    const generateImagesForNarrative = vi.fn()
    const analyzeBackgroundChangeAndGenerateImage = vi.fn()
    const classifyResponse = vi.fn().mockRejectedValue(new Error('classifier unavailable'))
    const pipeline = new GenerationPipeline({
      streamNarrative: async function* () {
        yield { content: '重写正文', done: true }
      },
      prepareCollaborative: async () => preparedTurn(),
      classifyResponse,
      generateImagesForNarrative,
      analyzeBackgroundChangeAndGenerateImage,
      isImageGenerationEnabled: vi.fn(() => true),
      translateNarration: vi.fn(),
    } as any)

    const result = await drainPipeline(pipeline, novelContext(), {
      ...cachedConfig,
      novelRetry: {
        mode: 'different',
        rawInput: '继续',
        sourceText: '被拒正文',
        historyKey: 'history',
        storyId: 's',
        branchId: null,
      },
      imageSettings: { imageGenerationMode: 'agentic' },
    })

    expect(classifyResponse).toHaveBeenCalled()
    expect(generateImagesForNarrative).not.toHaveBeenCalled()
    expect(analyzeBackgroundChangeAndGenerateImage).not.toHaveBeenCalled()
    expect(result.image).toBeNull()
    expect(result.background?.skippedReason).toBe('deferred_until_commit')
  })

  it('defers background-image generation for a reroll until the caller commits state', async () => {
    const analyzeBackgroundChangeAndGenerateImage = vi.fn()
    const classifyResponse = vi.fn().mockResolvedValue({
      scene: { presentCharacterNames: [] },
      newCharacters: [],
      newLocations: [],
      newItems: [],
      newStoryBeats: [],
      characterUpdates: [],
      locationUpdates: [],
      itemUpdates: [],
      storyBeatUpdates: [],
      relationshipUpdates: [],
      worldStateChanges: [],
    })
    const pipeline = new GenerationPipeline({
      streamNarrative: async function* () {
        yield { content: 'reroll prose', done: true }
      },
      prepareCollaborative: async () => preparedTurn(),
      classifyResponse,
      analyzeBackgroundChangeAndGenerateImage,
      isImageGenerationEnabled: vi.fn(() => true),
    } as any)

    const result = await drainPipeline(pipeline, novelContext(), {
      ...cachedConfig,
      novelRetry: {
        mode: 'different',
        rawInput: 'continue',
        sourceText: 'old prose',
        historyKey: 'history',
        storyId: 's',
        branchId: null,
      },
      imageSettings: {
        imageGenerationMode: 'agentic',
        backgroundImagesEnabled: true,
      },
    })

    expect(classifyResponse).toHaveBeenCalledOnce()
    expect(analyzeBackgroundChangeAndGenerateImage).not.toHaveBeenCalled()
    expect(result.background).toEqual({
      started: false,
      skippedReason: 'deferred_until_commit',
    })
  })

  it('cancels while awaiting a director that ignores abort and never starts writer', async () => {
    const controller = new AbortController()
    const context = novelContext()
    context.abortSignal = controller.signal
    const streamNarrative = vi.fn()
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: (_input: unknown, progress: (value: string) => void) => {
        progress('directing')
        return new Promise(() => {})
      },
    } as any)
    const iterator = pipeline.execute(context, cachedConfig)
    let event = await iterator.next()
    while (!event.done && event.value.type !== 'phase_progress') event = await iterator.next()
    const next = iterator.next()
    controller.abort()
    const completed = await next
    expect(completed.done).toBe(true)
    expect(completed.value).toMatchObject({ aborted: true })
    expect(streamNarrative).not.toHaveBeenCalled()
  })

  it('ignores a legacy director disable value because the director is mandatory', async () => {
    const context = novelContext()
    context.story.settings = {
      collaborativeNovelWorkflow: {
        sceneDirector: { enabled: false },
        factStateExtractor: { enabled: false },
      },
    }
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: false }
    })
    const prepareCollaborative = vi.fn(async () => preparedTurn())
    const classifyResponse = vi.fn()
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative,
      classifyResponse,
    } as any)
    const result = await drainPipeline(pipeline, context, cachedConfig)
    expect(prepareCollaborative).toHaveBeenCalledOnce()
    expect(classifyResponse).not.toHaveBeenCalled()
    expect(streamNarrative).toHaveBeenCalledOnce()
    expect(result.narrative?.content).toBe('正文')
    expect(result.fatalError).toBeNull()
  })

  it('does not require application-owned Director fields before writer', async () => {
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: true }
    })
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async () => preparedTurn(),
    } as any)
    const result = await drainPipeline(pipeline, novelContext(), cachedConfig)
    expect(streamNarrative).toHaveBeenCalled()
    expect(result.fatalError).toBeNull()
  })

  it('emits live progress before the director promise completes', async () => {
    let finish!: (turn: NovelTurn) => void
    const streamNarrative = vi.fn()
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: (
        _input: import('./prepareNovelTurn').NovelPreparation,
        progress?: import('./prepareNovelTurn').NovelProgressCallback,
      ) => {
        progress?.('reviewing_patterns')
        return new Promise<NovelTurn>((resolve) => {
          finish = resolve
        })
      },
    } as unknown as import('./GenerationPipeline').PipelineDependencies)
    const iterator = pipeline.execute(novelContext(), cachedConfig)
    let event = await iterator.next()
    while (!event.done && event.value.type !== 'phase_progress') event = await iterator.next()
    expect(event.value).toMatchObject({ type: 'phase_progress', progress: 'reviewing_patterns' })
    expect(streamNarrative).not.toHaveBeenCalled()
    finish(preparedTurn())
    await iterator.return({} as any)
  })

  it('emits raw Director chunks in order before Director completion and Writer start', async () => {
    const streamNarrative = vi.fn(async function* () {
      yield { content: '正文', done: true }
    })
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: async (
        _input: Parameters<
          NonNullable<import('./GenerationPipeline').PipelineDependencies['prepareCollaborative']>
        >[0],
        _progress: Parameters<
          NonNullable<import('./GenerationPipeline').PipelineDependencies['prepareCollaborative']>
        >[1],
        onChunk: Parameters<
          NonNullable<import('./GenerationPipeline').PipelineDependencies['prepareCollaborative']>
        >[2],
      ) => {
        onChunk?.('  第一段')
        onChunk?.('\n\n第二段  ')
        return { ...preparedTurn(), sceneDirectorOutput: '  第一段\n\n第二段  ' }
      },
    } as any)
    const events = []
    for await (const event of pipeline.execute(novelContext(), cachedConfig)) events.push(event)

    const relevant = events
      .filter(
        (event) =>
          event.type === 'director_chunk' ||
          (event.type === 'phase_complete' && event.phase === 'scene_director') ||
          (event.type === 'phase_start' && event.phase === 'narrative'),
      )
      .map((event) => {
        if (event.type === 'director_chunk') return `chunk:${event.content}`
        return 'phase' in event ? `${event.type}:${event.phase}` : event.type
      })
    expect(relevant).toEqual([
      'chunk:  第一段',
      'chunk:\n\n第二段  ',
      'phase_complete:scene_director',
      'phase_start:narrative',
    ])
    expect(streamNarrative).toHaveBeenCalledOnce()
  })

  it('real preparation proceeds directly to the director without invoking reviewer', async () => {
    let finishScene!: (value: any) => void
    const scene = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          finishScene = resolve
        }),
    )
    const streamNarrative = vi.fn(async function* () {
      yield { content: '完整正文。', done: true, finishReason: 'stop' }
    })
    const context = novelContext()
    context.story.settings = {
      collaborativeNovelWorkflow: {
        narrativePlanner: { enabled: false },
        factStateExtractor: { enabled: false },
      },
      collaborativeNovelPattern: {
        draft: null,
        confirmed: '避免旧动作结构',
        analyzedNarrationCount: 4,
      },
    }
    context.worldState.chapters = []
    context.allEntries = Array.from({ length: 4 }, (_, i) => ({
      type: 'narration',
      content: `旧正文${i}`,
    }))
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: (
        input: Parameters<typeof prepareNovelTurn>[0],
        progress: Parameters<typeof prepareNovelTurn>[2],
      ) => prepareNovelTurn(input, { scene }, progress),
    } as any)
    const iterator = pipeline.execute(context, cachedConfig)
    const setGenerationStatus = vi.fn()
    const callbacks = { setGenerationStatus } as unknown as PipelineUICallbacks
    const state = {
      fullResponse: () => '',
      fullReasoning: () => '',
      streamingEntryId: 'n',
      visualProseMode: false,
      isCreativeMode: true,
      activeParallelPhases: new Set<string>(),
    }
    async function until(progress: string) {
      let step = await iterator.next()
      while (!step.done) {
        if (step.value.type === 'phase_progress') {
          handleEvent(step.value, state, callbacks)
          if (step.value.progress === progress) return
        }
        step = await iterator.next()
      }
      throw new Error('Missing live progress')
    }
    await until('directing')
    expect(setGenerationStatus).toHaveBeenLastCalledWith('正在安排本轮场景（等待导演原文）')
    expect(scene).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedPatternGuidance: '避免旧动作结构',
      }),
      expect.any(Function),
      expect.any(Function),
    )
    expect(streamNarrative).not.toHaveBeenCalled()
    finishScene(preparedTurn())
    let step = await iterator.next()
    while (!step.done) step = await iterator.next()
    expect(step.value.narrative?.finishReason).toBe('stop')
    expect(streamNarrative).toHaveBeenCalledOnce()
  })

  it('keeps a Director failure non-fatal, records the real error, and starts Writer once', async () => {
    const scene = vi.fn(async (_input, _diagnostic, onChunk) => {
      onChunk?.('不完整 Director 指令')
      throw new Error('gateway failed for secret-key')
    })
    const streamNarrative = vi.fn(async function* () {
      yield { content: 'Writer 依据原始上下文继续。', done: true, finishReason: 'stop' }
    })
    const context = novelContext()
    context.worldState.chapters = []
    context.story.settings = {
      collaborativeNovelWorkflow: { factStateExtractor: { enabled: false } },
    }
    const pipeline = new GenerationPipeline({
      streamNarrative,
      prepareCollaborative: (
        input: Parameters<typeof prepareNovelTurn>[0],
        progress: Parameters<typeof prepareNovelTurn>[2],
      ) => prepareNovelTurn(input, { scene }, progress),
    } as any)

    const result = await drainPipeline(pipeline, context, cachedConfig)

    expect(scene).toHaveBeenCalledOnce()
    expect(streamNarrative).toHaveBeenCalledOnce()
    expect(result.narrative?.content).toBe('Writer 依据原始上下文继续。')
    const writerTurn = (streamNarrative.mock.calls[0] as unknown[])[8] as NovelTurn
    expect(writerTurn.directorDiagnostics).toMatchObject({
      directorFallback: true,
      errorMessage: 'gateway failed for [REDACTED]',
      rawResponseAvailable: false,
      partialResponse: '不完整 Director 指令',
    })
    expect(writerTurn.sceneDirectorOutput).toBeNull()
    expect(novelWriterContext(writerTurn)).not.toContain('不完整 Director 指令')
    expect(result.fatalError).toBeNull()
  })

  it('does not classify or run background work after partial prose followed by SDK failure', async () => {
    const classifyResponse = vi.fn()
    const analyzeBackgroundChangeAndGenerateImage = vi.fn()
    const pipeline = new GenerationPipeline({
      prepareCollaborative: async () => preparedTurn(),
      classifyResponse,
      analyzeBackgroundChangeAndGenerateImage,
      streamNarrative: async function* () {
        yield { content: '部分正文。', done: false }
        throw new Error('SDK failed')
      },
    } as any)
    const events = []
    for await (const event of pipeline.execute(novelContext(), cachedConfig)) events.push(event)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'narrative_chunk', content: '部分正文。' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', phase: 'narrative', fatal: true }),
    )
    expect(events.some((e) => e.type === 'phase_complete' && e.phase === 'narrative')).toBe(false)
    expect(classifyResponse).not.toHaveBeenCalled()
    expect(analyzeBackgroundChangeAndGenerateImage).not.toHaveBeenCalled()
  })

  it.each([undefined, 'length', 'stop', 'unknown'])(
    'records only provider-supported truncation: %s',
    async (finishReason) => {
      const pipeline = new GenerationPipeline({
        prepareCollaborative: async () => preparedTurn(),
        streamNarrative: async function* () {
          yield { content: '中文𠀀 abc。', done: true, finishReason }
        },
      } as any)
      for await (const event of pipeline.execute(novelContext(), cachedConfig)) {
        if (event.type === 'phase_complete' && event.phase === 'narrative') {
          expect(event.result).toMatchObject({
            requestedLength: '1500-3000中文字',
            actualChineseCharacters: 3,
          })
          const result = event.result as any
          expect(result.finishReason).toBe(finishReason)
          expect(result.outputTruncated).toBe(
            finishReason === 'length' ? true : finishReason === 'stop' ? false : undefined,
          )
          expect(result.shortStopReason).toBeTruthy()
          break
        }
      }
    },
  )

  async function drainPipeline(pipeline: GenerationPipeline, context: any, config: any) {
    const generator = pipeline.execute(context, config)
    let step = await generator.next()
    while (!step.done) step = await generator.next()
    return step.value
  }
  const mockDeps = {
    agenticRetrievalService: { retrieve: vi.fn() } as any,
    entryRetrievalService: { getRelevantEntries: vi.fn() } as any,
    timelineFillService: { execute: vi.fn() } as any,
    narrativeService: { generate: vi.fn() } as any,
    classifierService: { classify: vi.fn() } as any,
    translatorService: { translate: vi.fn() } as any,
    imageService: { generate: vi.fn() } as any,
    suggestionsService: { generate: vi.fn() } as any,
    actionChoicesService: { generate: vi.fn() } as any,
    worldStateService: { update: vi.fn() } as any,
  }

  it('can be instantiated with pipeline dependencies', () => {
    const pipeline = new GenerationPipeline(mockDeps as any)
    expect(pipeline).toBeDefined()
  })

  it('returns an AsyncGenerator when execute() is called', () => {
    const pipeline = new GenerationPipeline(mockDeps as any)
    const gen = pipeline.execute({} as any, {} as any)
    expect(gen[Symbol.asyncIterator]).toBeDefined()
  })
})
