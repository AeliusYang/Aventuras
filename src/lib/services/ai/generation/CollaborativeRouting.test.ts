import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter, Character, Item, StoryBeat, Story, StoryEntry } from '$lib/types'
import type { NovelTurn } from '$lib/types/collaborative'
import type { StreamChunk } from '../core/types'
import { streamText } from 'ai'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'

const mocks = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  story: {
    id: 'story',
    mode: 'creative-writing',
    settings: { collaborativeNovelWorkflow: {} },
  } as unknown as Story,
  render: vi.fn(),
  structured: vi.fn(),
  collaborativeJson: vi.fn(),
  stream: vi.fn(),
  generate: vi.fn(),
}))
vi.mock('../core/CollaborativePromptService', () => ({
  CollaborativePromptService: {
    render: vi.fn(async (_storyId: string, agent: string) => ({
      agentKey: agent,
      templateId: agent === 'writer' ? 'collaborative-chinese-writer' : `collaborative-${agent}`,
      presetId: 'generic',
      preset: {
        id: 'generic',
        name: '共享配置',
        description: '',
        profileId: 'story-profile',
        model: 'story-model',
        temperature: 0.8,
        maxTokens: 4096,
        reasoningEffort: 'none',
        timeoutMs: 360000,
        manualBody: '',
      },
      profile: { id: 'story-profile', name: '故事 API', providerType: 'openrouter' },
      system: '可编辑系统模板',
      user: '可编辑用户模板',
      variables: [],
      missingVariables: [],
      source: 'user',
      requestMode: 'stream-text',
    })),
  },
}))
vi.mock('$lib/services/context', () => ({
  ContextBuilder: class {
    static async forStory() {
      return new this()
    }
    add(value: Record<string, unknown>) {
      Object.assign(mocks.data, value)
      return this
    }
    getContext() {
      return { ...mocks.data }
    }
    render(id: string) {
      return mocks.render(id)
    }
  },
}))
vi.mock('$lib/services/database', () => ({
  database: { getStory: async () => mocks.story, getStoryPackId: async () => null },
}))
vi.mock('../sdk/generate', () => ({
  generateStructured: mocks.structured,
  generateCollaborativeJsonText: mocks.collaborativeJson,
  generateCollaborativeWriterStream: mocks.stream,
  streamNarrative: mocks.stream,
  generateNarrative: mocks.generate,
}))
vi.mock('../core/config', () => ({
  getContextConfig: () => ({ recentEntriesForSuggestions: 5, recentEntriesForChoices: 5 }),
  getLorebookConfig: () => ({ maxForSuggestions: 5 }),
}))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    getServicePresetId: () => 'generic',
    getPresetConfig: () => ({
      id: 'generic',
      name: '共享配置',
      profileId: 'story-profile',
      model: 'story-model',
      temperature: 0.8,
      maxTokens: 8192,
      reasoningEffort: 'none',
      timeoutMs: 360000,
    }),
  },
}))
vi.mock('$lib/services/generation/collaborative', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/generation/collaborative')>()),
  novelWriterContext: () => 'Scene Director 原始输出：先核对证据，保留决定。',
}))

import { SuggestionsService } from './SuggestionsService'
import { buildTimelineFillBlock } from './NarrativeService'
import { ActionChoicesService } from './ActionChoicesService'
import { NarrativeService } from './NarrativeService'
import { ClassifierService } from './ClassifierService'
import { assertNoDiscardedFactFields } from '../sdk/factFieldValidation'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.data = {}
  mocks.story.mode = 'creative-writing'
  mocks.story.settings = { collaborativeNovelWorkflow: {} }
  mocks.render.mockImplementation(async () => ({
    system: '可编辑系统模板',
    user: '可编辑用户模板',
  }))
  mocks.generate.mockResolvedValue('中文正文')
  mocks.structured.mockResolvedValue({
    suggestions: [{ text: '先检查凭据', type: 'action' }],
    choices: [],
  })
  mocks.collaborativeJson.mockResolvedValue({
    suggestions: [{ text: '先检查凭据', type: 'action' }],
  })
})

describe('collaborative production service routing', () => {
  it.each(['1500-3000中文字', '600中文字'] as const)(
    'passes the resolved Writer length into editable system templates: %s',
    async (requestedLength) => {
      const promptService = await import('../core/CollaborativePromptService')
      await new NarrativeService().generate(
        [],
        { characters: [], locations: [], items: [], storyBeats: [] },
        mocks.story,
        { novelTurn: { requestedLength } as NovelTurn },
      )
      expect(promptService.CollaborativePromptService.render).toHaveBeenCalledWith(
        'story',
        'writer',
        expect.objectContaining({ requestedLength }),
        expect.any(Object),
      )
    },
  )

  it('bounds whole Writer passages and chapters and does not repeat the same retrieved timeline block', async () => {
    const passages = Array.from(
      { length: 11 },
      (_, index) =>
        ({ type: 'narration', content: `正文-${index}-` + '完整材料'.repeat(200) }) as StoryEntry,
    )
    const chapters = Array.from(
      { length: 15 },
      (_, index) => ({ number: index + 1, summary: `摘要-${index}-完整`, title: null }) as Chapter,
    )
    const timeline = {
      queries: [],
      responses: [{ query: '唯一检索问题', answer: '唯一检索证据', chapterNumbers: [1] }],
    }
    const retrieval = buildTimelineFillBlock(timeline)
    mocks.stream.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '正文' }
        yield { type: 'finish', finishReason: 'stop' }
      })(),
    })
    for await (const chunk of new NarrativeService().stream(
      passages,
      {
        characters: [],
        locations: [],
        items: [],
        storyBeats: [],
        chapters,
      },
      mocks.story,
      { novelTurn: {} as NovelTurn, tieredContextBlock: retrieval, timelineFillResult: timeline },
    ))
      void chunk
    expect(mocks.data.recentNovelProse).toBe(
      passages
        .slice(-8)
        .map((entry) => entry.content)
        .join('\n\n'),
    )
    expect(mocks.data.chapterSummaries).not.toContain('摘要-2-完整')
    expect(mocks.data.chapterSummaries).toContain('摘要-3-完整')
    expect(mocks.data.chapterSummaries).toContain('摘要-14-完整')
    expect(mocks.data.chapterSummaries).not.toContain('唯一检索证据')
    expect(mocks.data.tieredContextBlock).toBe(retrieval)
  })

  it('passes source constraints and enabled confirmed guidance to suggestions exactly once', async () => {
    mocks.story.settings = {
      collaborativeNovelWorkflow: {},
      collaborativeNovelPlan: { confirmed: '唯一确认计划', draft: '不得注入的草稿' },
      collaborativeNovelPattern: { confirmed: '唯一确认指导', draft: '不得注入的草稿' },
    }
    const entries = [
      { id: 'source', type: 'user_action', content: '持续用户约束原句' },
      { id: 'prose', type: 'narration', content: '实际正文' },
    ] as StoryEntry[]
    await new SuggestionsService('suggestions').generateSuggestions(entries, [], [], 'story')
    const input = String(mocks.data.planningInput)
    for (const text of ['持续用户约束原句', '唯一确认计划', '唯一确认指导', '实际正文'])
      expect(input.split(text)).toHaveLength(2)
    expect(input).not.toContain('不得注入的草稿')
    mocks.story.settings.collaborativeNovelWorkflow = {
      narrativePlanner: { enabled: false },
      patternReviewer: { enabled: false },
    }
    await new SuggestionsService('suggestions').generateSuggestions(entries, [], [], 'story')
    expect(mocks.data.planningInput).not.toContain('唯一确认')
    mocks.story.settings.collaborativeNovelWorkflow.plotSuggestions = { enabled: false }
    mocks.collaborativeJson.mockClear()
    await expect(
      new SuggestionsService('suggestions').generateSuggestions(entries, [], [], 'story'),
    ).rejects.toThrow('已关闭')
    expect(mocks.collaborativeJson).not.toHaveBeenCalled()
  })

  it('keeps ordinary narrative generation independent of collaborative Agents', async () => {
    mocks.story.mode = 'adventure'
    mocks.story.settings = {}
    const text = await new NarrativeService().generate(
      [
        { type: 'narration', content: 'The old scene.' },
        { type: 'user_action', content: 'Continue.' },
      ] as StoryEntry[],
      { characters: [], locations: [], items: [], storyBeats: [] },
      mocks.story,
    )
    expect(text).toBe('中文正文')
    expect(mocks.render).toHaveBeenCalledWith('adventure')
    expect(mocks.generate.mock.calls[0][0].presetOverride).toBeUndefined()
    expect(mocks.generate.mock.calls[0][0].prompt).toContain('Continue.')
  })
  it('leaves ordinary suggestions on the generic template and task preset', async () => {
    mocks.story.mode = 'adventure'
    mocks.story.settings = {}
    await new SuggestionsService('suggestions').generateSuggestions(
      [{ type: 'narration', content: 'ordinary story' } as StoryEntry],
      [],
      [],
      'story',
    )
    expect(mocks.render).toHaveBeenCalledWith('suggestions')
    expect(mocks.structured.mock.calls[0][0]).toMatchObject({ presetId: 'generic' })
    expect(mocks.structured.mock.calls[0][0]).not.toHaveProperty('presetOverride')
  })
  it('reports actual stream finish reason without exposing writer reasoning', async () => {
    mocks.stream.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'reasoning-delta', text: '内部推理不进入正文或UI' }
        yield { type: 'text-delta', text: '门缝透进一线光。' }
        yield { type: 'finish', finishReason: 'length' }
      })(),
    })
    const chunks = []
    for await (const chunk of new NarrativeService().stream(
      [],
      {
        characters: [],
        locations: [],
        items: [],
        storyBeats: [],
      },
      mocks.story as Story,
      { novelTurn: {} as NovelTurn },
    ))
      chunks.push(chunk)
    expect(chunks).toEqual([
      { content: '门缝透进一线光。', done: false },
      { content: '', done: true, finishReason: 'length' },
    ])
  })

  it('does not turn an SDK error event into a successfully completed short output', async () => {
    mocks.stream.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '未完' }
        yield { type: 'error', error: new Error('provider failed') }
      })(),
    })
    const execute = async () => {
      for await (const chunk of new NarrativeService().stream(
        [],
        {
          characters: [],
          locations: [],
          items: [],
          storyBeats: [],
        },
        mocks.story as Story,
        { novelTurn: {} as NovelTurn },
      ))
        void chunk
    }
    await expect(execute()).rejects.toThrow('provider failed')
  })

  it.each(['abort', 'other', 'missing'] as const)(
    'does not complete collaborative prose after an SDK %s event',
    async (completion) => {
      mocks.stream.mockReturnValue({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: '未完成的正文' }
          if (completion === 'abort') yield { type: 'abort', reason: '取消写作' }
          if (completion === 'other') yield { type: 'finish', finishReason: 'other' }
        })(),
      })
      const chunks: StreamChunk[] = []
      const execute = async () => {
        for await (const chunk of new NarrativeService().stream(
          [],
          { characters: [], locations: [], items: [], storyBeats: [] },
          mocks.story as Story,
          { novelTurn: {} as NovelTurn },
        ))
          chunks.push(chunk)
      }
      await expect(execute()).rejects.toMatchObject(
        completion === 'abort' ? { name: 'AbortError' } : { name: 'Error' },
      )
      expect(chunks).toEqual([{ content: '未完成的正文', done: false }])
    },
  )

  it.each(['stop', 'length', 'other', 'missing', 'error'] as const)(
    'uses the installed SDK finish and error events for Writer: %s',
    async (completion) => {
      const providerError = new Error('Writer provider failure')
      const doStream = vi.fn(async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 'prose' })
            controller.enqueue({ type: 'text-delta', id: 'prose', delta: '当场正文' })
            controller.enqueue({ type: 'text-end', id: 'prose' })
            if (completion === 'error') controller.enqueue({ type: 'error', error: providerError })
            if (completion !== 'missing')
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: completion, raw: completion },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 2, text: 2, reasoning: 0 },
                },
              })
            controller.close()
          },
        }),
      }))
      const model: LanguageModelV4 = {
        specificationVersion: 'v4',
        provider: 'fixture',
        modelId: 'fixture',
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream,
      }
      mocks.stream.mockReturnValue(streamText({ model, prompt: '继续', onError: () => {} }))
      const execute = async () => {
        const chunks = []
        for await (const chunk of new NarrativeService().stream(
          [],
          { characters: [], locations: [], items: [], storyBeats: [] },
          mocks.story as Story,
          { novelTurn: {} as NovelTurn },
        ))
          chunks.push(chunk)
        return chunks
      }
      if (completion === 'stop' || completion === 'length')
        await expect(execute()).resolves.toEqual([
          { content: '当场正文', done: false },
          { content: '', done: true, finishReason: completion },
        ])
      else if (completion === 'error') await expect(execute()).rejects.toBe(providerError)
      else await expect(execute()).rejects.toThrow('Writer 未正常完成')
      expect(doStream).toHaveBeenCalledOnce()
    },
  )
  it('extracts facts only from prose using the collaborative config and template', async () => {
    mocks.structured.mockResolvedValue({
      entryUpdates: {
        characterUpdates: [],
        newCharacters: [],
        locationUpdates: [],
        newLocations: [],
        itemUpdates: [],
        newItems: [],
        storyBeatUpdates: [],
        newStoryBeats: [],
      },
      scene: { timeProgression: 'none' },
    })
    await new ClassifierService('classifier').classify(
      {
        storyId: 'story',
        story: mocks.story as Story,
        narrativeResponse: '她把信封放下。',
        userAction: '未来应当答应合作',
        existingCharacters: [],
        existingLocations: [],
        existingItems: [],
        existingStoryBeats: [],
      },
      [
        { type: 'narration', content: '已经发生的正文' },
        { type: 'user_action', content: '候选未来动作' },
        { type: 'retry', content: '被否决路线' },
      ] as StoryEntry[],
    )
    expect(mocks.collaborativeJson).toHaveBeenCalled()
    expect(mocks.data.userAction).toBe('')
    expect(mocks.data.chatHistoryBlock).toContain('已经发生的正文')
    expect(mocks.data.chatHistoryBlock).not.toContain('候选未来动作')
    expect(mocks.data.chatHistoryBlock).not.toContain('被否决路线')
  })

  it.each(['creative-writing', 'adventure'] as const)(
    'preserves existing fact identity for %s without broadening ordinary RPG input',
    async (mode) => {
      mocks.story.mode = mode
      const empty = {
        entryUpdates: {
          characterUpdates: [],
          newCharacters: [],
          locationUpdates: [],
          newLocations: [],
          itemUpdates: [],
          newItems: [],
          storyBeatUpdates: [],
          newStoryBeats: [],
        },
        scene: {
          currentLocationName: null,
          presentCharacterNames: ['罗婶'],
          timeProgression: 'none',
        },
      }
      const request = mode === 'creative-writing' ? mocks.collaborativeJson : mocks.structured
      request.mockResolvedValueOnce(empty)
      await new ClassifierService('classifier').classify({
        storyId: 'story',
        story: mocks.story,
        narrativeResponse: '她指着已经熄火的炉灶说，之前垫粮的账仍记在梁叔名下。',
        userAction: '继续',
        existingCharacters: [
          {
            name: '罗婶',
            status: 'active',
            relationship: '邻里',
            description: '祭礼筹办人，垫粮尚未获偿',
            traits: ['务实', '要面子'],
          },
        ] as Character[],
        existingLocations: [],
        existingItems: [
          {
            name: '旧签条',
            description: '梁叔自称去年签下的纸条，未经旁人确认',
            location: '桌边',
            quantity: 1,
          },
        ] as Item[],
        existingStoryBeats: [
          {
            title: '今晚供饭',
            status: 'completed',
            description: '罗婶垫粮，帮工已经吃完',
            type: 'event',
          },
          { title: '旧灶借用', status: 'failed', description: '灶已拆，不能再借', type: 'event' },
          { title: '垫粮偿付', status: 'active', description: '尚未承诺偿付', type: 'event' },
        ] as StoryBeat[],
      })
      expect(mocks.data.existingCharacters).toContain('- 罗婶\n')
      expect(mocks.data.existingCharacters).toContain('relationship: 邻里')
      expect(mocks.data.existingBeats).toContain('垫粮偿付')
      for (const text of ['祭礼筹办人，垫粮尚未获偿', '务实', '要面子']) {
        if (mode === 'creative-writing') expect(mocks.data.existingCharacters).toContain(text)
        else expect(mocks.data.existingCharacters).not.toContain(text)
      }
      if (mode === 'creative-writing') {
        expect(mocks.data.existingItems).toContain('梁叔自称去年签下的纸条，未经旁人确认')
        expect(mocks.data.existingBeats).toContain('status: completed')
        expect(mocks.data.existingBeats).toContain('status: failed')
        expect(mocks.data.existingBeats).toContain('罗婶垫粮，帮工已经吃完')
      } else {
        expect(mocks.data.existingItems).not.toContain('梁叔自称')
        expect(mocks.data.existingBeats).not.toContain('今晚供饭')
        expect(mocks.data.existingBeats).not.toContain('旧灶借用')
      }
    },
  )

  it('reports discarded fact fields without salvage, partial success or automatic retry', async () => {
    mocks.collaborativeJson.mockImplementationOnce(async () => {
      assertNoDiscardedFactFields(
        {
          entryUpdates: {
            characterUpdates: [{ name: '罗婶', changes: { description: '尚未偿付' } }],
          },
        },
        { entryUpdates: { characterUpdates: [{ name: '罗婶', changes: {} }] } },
      )
    })
    const returned = await new ClassifierService('classifier').classify({
      storyId: 'story',
      story: mocks.story,
      narrativeResponse: '已保存正文。',
      userAction: '继续',
      existingCharacters: [],
      existingLocations: [],
      existingItems: [],
      existingStoryBeats: [],
    })
    expect(returned._error).toContain('entryUpdates.characterUpdates[0].changes.description')
    expect(Object.values(returned.entryUpdates).every((entries) => entries.length === 0)).toBe(true)
    expect(returned.scene.timeProgression).toBe('none')
    expect(mocks.collaborativeJson).toHaveBeenCalledOnce()
  })

  it.each(['character', 'location', 'item', 'storyBeat'] as const)(
    'reports an undeclared %s update target instead of accepting a new inferred entity',
    async (kind) => {
      const result = {
        entryUpdates: {
          characterUpdates: [],
          newCharacters: [],
          locationUpdates: [],
          newLocations: [],
          itemUpdates: [],
          newItems: [],
          storyBeatUpdates: [],
          newStoryBeats: [],
        },
        scene: { currentLocationName: null, presentCharacterNames: [], timeProgression: 'none' },
      }
      Object.assign(result.entryUpdates, {
        [`${kind}Updates`]: [
          { [kind === 'storyBeat' ? 'title' : 'name']: '未匹配的名称', changes: {} },
        ],
      })
      mocks.collaborativeJson.mockResolvedValueOnce(result)
      const returned = await new ClassifierService('classifier').classify({
        storyId: 'story',
        story: mocks.story,
        narrativeResponse: '已保存的正文不变。',
        userAction: '继续',
        existingCharacters: [],
        existingLocations: [],
        existingItems: [],
        existingStoryBeats: [],
      })
      expect(returned._error).toContain('未匹配的名称')
      expect(returned._error).toContain('未匹配')
      expect(returned.entryUpdates[`${kind}Updates`]).toEqual([])
      expect(mocks.collaborativeJson).toHaveBeenCalledOnce()
    },
  )

  it.each([true, false])(
    'allows exact existing or explicitly new targets, existing=%s',
    async (existing) => {
      const result = {
        entryUpdates: {
          characterUpdates: [{ name: '罗婶', changes: { status: 'inactive' } }],
          newCharacters: existing ? [] : [{ name: '罗婶', description: '祭礼筹办人' }],
          locationUpdates: [],
          newLocations: [],
          itemUpdates: [],
          newItems: [],
          storyBeatUpdates: [
            { title: '今晚供饭', changes: { description: '旧事又被提及，仍已完成' } },
          ],
          newStoryBeats: existing ? [] : [{ title: '今晚供饭', status: 'completed' }],
        },
        scene: { currentLocationName: null, presentCharacterNames: [], timeProgression: 'none' },
      }
      mocks.collaborativeJson.mockResolvedValueOnce(result)
      const returned = await new ClassifierService('classifier').classify({
        storyId: 'story',
        story: mocks.story,
        narrativeResponse: '正文',
        userAction: '继续',
        existingCharacters: existing ? [{ name: '罗婶', traits: [] } as unknown as Character] : [],
        existingLocations: [],
        existingItems: [],
        existingStoryBeats: existing
          ? [{ title: '今晚供饭', status: 'completed' } as StoryBeat]
          : [],
      })
      expect(returned).toBe(result)
      expect(returned._error).toBeUndefined()
    },
  )

  it('uses existing spelling normalization without semantic or prefix matching', async () => {
    const result = {
      entryUpdates: {
        characterUpdates: [{ name: 'Elenore', changes: { status: 'inactive' } }],
        newCharacters: [],
        locationUpdates: [{ name: 'kaelens rest', changes: { visited: true } }],
        newLocations: [],
        itemUpdates: [],
        newItems: [],
        storyBeatUpdates: [
          { title: '旧约定', changes: { description: '已结束的旧约定被再次提及' } },
        ],
        newStoryBeats: [],
      },
      scene: { presentCharacterNames: [], timeProgression: 'none' },
    }
    mocks.collaborativeJson.mockResolvedValueOnce(result)
    const returned = await new ClassifierService('classifier').classify({
      storyId: 'story',
      story: mocks.story,
      narrativeResponse: '旧约定被再次提及，没有重新开启。',
      userAction: '继续',
      existingCharacters: [{ name: 'Elénore', traits: [] }],
      existingLocations: [{ name: 'Kaelen’s Rest' }],
      existingItems: [],
      existingStoryBeats: [{ title: '旧约定', status: 'completed' }],
    } as unknown as Parameters<ClassifierService['classify']>[0])
    expect(returned._error).toBeUndefined()
    expect(returned).toBe(result)
  })
  it('blocks collaborative fact extraction at the service boundary when disabled', async () => {
    mocks.story.settings = {
      collaborativeNovelWorkflow: { factStateExtractor: { enabled: false } },
    }
    await expect(
      new ClassifierService('classifier').classify(
        {
          storyId: 'story',
          story: mocks.story as Story,
          narrativeResponse: '她把信封放下。',
          userAction: '',
          existingCharacters: [],
          existingLocations: [],
          existingItems: [],
          existingStoryBeats: [],
        },
        [],
      ),
    ).rejects.toThrow('正文事实与状态提取已关闭')
    expect(mocks.collaborativeJson).not.toHaveBeenCalled()
  })
  it('sends current story context through the dedicated suggestion template and config', async () => {
    await new SuggestionsService('suggestions').generateSuggestions(
      [
        { type: 'narration', content: '门闩已经落下。' } as StoryEntry,
        { type: 'retry', content: '不得当成事实' } as StoryEntry,
      ],
      [],
      [],
      'story',
    )
    expect(mocks.data.planningInput).toContain('门闩已经落下')
    expect(mocks.data.planningInput).not.toContain('不得当成事实')
    expect(mocks.collaborativeJson.mock.calls[0][0]).toMatchObject({
      system: '可编辑系统模板',
      prompt: '可编辑用户模板',
    })
    const schema = mocks.collaborativeJson.mock.calls[0][0].schema
    expect(
      schema.safeParse({ suggestions: [{ text: 'Ask her about the letter', type: 'dialogue' }] })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({ suggestions: [{ text: '从旧信的来源追查矛盾', type: 'revelation' }] })
        .success,
    ).toBe(true)
  })

  it('keeps action choices on the ordinary adventure template', async () => {
    await new ActionChoicesService('actionChoices').generateChoices({
      storyId: 'story',
      narrativeResponse: '她将信封留在桌角。',
      userAction: '继续',
      recentEntries: [{ type: 'user_action', content: '继续' } as StoryEntry],
      protagonistName: '主角',
      mode: 'creative-writing',
      pov: 'first',
      tense: 'present',
    })
    expect(mocks.render).toHaveBeenCalledWith('action-choices')
    expect(mocks.data.planningInput).toContain('她将信封留在桌角')
    expect(mocks.data.planningInput).not.toContain('TERSE')
    expect(mocks.structured).toHaveBeenCalledOnce()
  })

  it('blocks a workflow-only story without a director before any writer call', async () => {
    const service = new NarrativeService()
    const world = { characters: [], locations: [], items: [], storyBeats: [] }
    await expect(service.generate([], world, mocks.story as Story)).rejects.toThrow(
      '缺少本轮场景安排',
    )
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('uses edited system and user templates on the next writer call', async () => {
    const service = new NarrativeService()
    const world = { characters: [], locations: [], items: [], storyBeats: [] }
    const turn = {} as NovelTurn
    const entries = [
      { type: 'narration', content: '先前正文' },
      { type: 'user_action', content: '继续' },
    ] as StoryEntry[]
    await service.generate(entries, world, mocks.story as Story, { novelTurn: turn })
    expect(mocks.data.novelAgentContext).toContain('Scene Director 原始输出')
    expect(mocks.generate.mock.calls[0][0].prompt).toContain('可编辑用户模板')
    const promptService = await import('../core/CollaborativePromptService')
    vi.mocked(promptService.CollaborativePromptService.render).mockResolvedValueOnce({
      ...(await promptService.CollaborativePromptService.render('story', 'writer')),
      system: '修改后的系统',
      user: '修改后的用户执行规则',
    })
    await service.generate(entries, world, mocks.story as Story, { novelTurn: turn })
    expect(mocks.generate.mock.calls[1][0]).toMatchObject({
      system: '修改后的系统',
      presetOverride: { id: 'generic' },
    })
    expect(mocks.generate.mock.calls[1][0].prompt).toContain('修改后的用户执行规则')
    expect(mocks.generate.mock.calls[1][0].prompt).not.toContain('可编辑用户模板')
    expect(mocks.generate.mock.calls[1][0].prompt).toBe('修改后的用户执行规则')
    expect(mocks.data.recentNovelProse).toBe('先前正文')
  })

  it('records the provenance returned by the same render used for generation', async () => {
    const promptService = await import('../core/CollaborativePromptService')
    vi.mocked(promptService.CollaborativePromptService.render).mockResolvedValueOnce({
      agentKey: 'writer',
      templateId: 'collaborative-chinese-writer',
      system: '实际系统模板',
      user: '实际用户模板',
      presetId: 'generic',
      preset: {
        id: 'generic',
        name: '共享配置',
        description: '',
        profileId: 'story-profile',
        model: 'story-model',
        temperature: 0.8,
        maxTokens: 8192,
        reasoningEffort: 'none',
        timeoutMs: 360000,
        manualBody: '',
      },
      profile: { id: 'story-profile', name: '故事 API', providerType: 'openrouter' },
      variables: [],
      missingVariables: [],
      source: 'user',
      requestMode: 'stream-text',
      systemSource: 'user',
      userSource: 'user',
      systemTemplateId: 'collaborative-chinese-writer',
      userTemplateId: 'collaborative-chinese-writer-user',
      packId: undefined,
    })
    const turn = {} as NovelTurn
    await new NarrativeService().generate(
      [],
      {
        characters: [],
        locations: [],
        items: [],
        storyBeats: [],
      },
      mocks.story,
      { novelTurn: turn },
    )
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(turn.writerPrompt).toEqual({
      templateId: 'collaborative-chinese-writer',
      systemSource: 'user',
      userSource: 'user',
      systemTemplateId: 'collaborative-chinese-writer',
      userTemplateId: 'collaborative-chinese-writer-user',
      packId: undefined,
    })
    expect(JSON.stringify(turn.writerPrompt)).not.toContain('实际系统模板')
  })
})
