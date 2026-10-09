import { describe, expect, it, vi } from 'vitest'
import type { Story, StoryEntry } from '$lib/types'
import type { NovelTurn } from '$lib/types/collaborative'
import type { GenerationContext, RetrievalResult } from './types'
import { prepareNovelTurn } from './prepareNovelTurn'
import { createDefaultCollaborativeWorkflow } from './collaborativeWorkflow'
import {
  collaborativeOptionalContext,
  collaborativeUserContext,
  novelRetry,
  novelWriterContext,
  previousNovelTurn,
} from './collaborative'
import { canonicalCollaborativeTemplates } from '../prompts/templates/collaborative'
import { templateEngine } from '../templates/engine'
import { RetrievalPhase, type RetrievalDependencies } from './phases/RetrievalPhase'

vi.mock('$lib/stores/settings.svelte', () => ({ settings: { apiSettings: { profiles: [] } } }))

const savedTurn = (output: string): NovelTurn => ({
  version: 2,
  historyKey: '',
  rawInput: '继续',
  sceneDirectorOutput: output,
  confirmedPlan: null,
  confirmedPatternGuidance: null,
})
const entry = (
  id: string,
  type: StoryEntry['type'],
  content: string,
  branchId: string | null = null,
): StoryEntry => ({
  id,
  type,
  content,
  branchId,
  storyId: 'story',
  parentId: null,
  position: 0,
  createdAt: 0,
  metadata: null,
})
function fixture(rawInput = '继续。', entries: StoryEntry[] = []) {
  const current = entry('current-input', 'user_action', rawInput, 'branch')
  const story = {
    id: 'story',
    mode: 'creative-writing',
    currentBranchId: 'branch',
    settings: {
      collaborativeNovelWorkflow: { targetLength: '1600-2400中文字' },
      collaborativeNovelPlan: { confirmed: '确认计划', draft: '未确认计划' },
      collaborativeNovelPattern: { confirmed: '确认结构指导', draft: '未确认结构指导' },
    },
  } as Story
  const context = {
    story,
    allEntries: [...entries, current],
    visibleEntries: [...entries, current],
    userAction: { entryId: current.id, content: rawInput, rawInput },
    worldState: {
      chapters: Array.from({ length: 15 }, (_, index) => ({
        title: `章节-${index}`,
        summary: `完整摘要-${index}`,
      })),
      storyBeats: [],
    },
  } as unknown as GenerationContext
  return {
    context,
    retrieval: {
      worldStateBlock: '唯一当前状态',
      combinedContext: '唯一检索证据',
    } as RetrievalResult,
    rawInput,
  }
}

describe('collaborative input assembly', () => {
  it('does not store a default length before a turn needs one', () => {
    expect(createDefaultCollaborativeWorkflow().targetLength).toBeUndefined()
  })

  it.each([
    ['继续。', '1600-2400中文字', '1600-2400中文字'],
    ['继续。', undefined, '1500-3000中文字'],
    ['继续。', '600中文字', '600中文字'],
    ['继续。', '3000-5000中文字', '3000-5000中文字'],
    ['本轮写1800字。继续。', '1600-2400中文字', '1800中文字'],
  ])(
    'shares the resolved prose length with Director and Writer: %s',
    async (rawInput, targetLength, expected) => {
      const input = fixture(rawInput)
      input.context.story.settings!.collaborativeNovelWorkflow!.targetLength = targetLength
      const scene = vi.fn(
        async (_fields: unknown) => '用户意图：继续。场景安排：现场发现新的问题。',
      )
      const turn = await prepareNovelTurn(input, { scene })
      const fields = scene.mock.calls[0][0] as { rawInput: string; requestedLength: string }
      const rendered = templateEngine.render(
        canonicalCollaborativeTemplates[0].userContent!,
        fields,
      )!
      expect(fields.requestedLength).toBe(expected)
      expect(rendered).toContain(`调用方正文篇幅：${expected}`)
      expect(turn.requestedLength).toBe(expected)
      expect(novelWriterContext(turn)).toContain(
        `【调用方权威篇幅 requestedLength】\n\n${expected}`,
      )
    },
  )

  it.each([false, true])(
    'passes actual timeline retrieval into Director beyond the raw-input and summary windows, with lore=%s',
    async (withLore) => {
      const history = Array.from({ length: 11 }, (_, index) => [
        entry(
          `author-${index}`,
          'user_action',
          index === 0 ? '在我解除之前，不让其他人得知她打算辞职。' : '继续。',
        ),
        entry(`prose-${index}`, 'narration', `已经发生的正文-${index}`),
      ]).flat()
      const input = fixture('继续。', history)
      input.context.worldState.memoryConfig = {
        enableRetrieval: true,
      } as GenerationContext['worldState']['memoryConfig']
      input.context.worldState.lorebookEntries = withLore ? [{ id: 'lore' } as any] : []
      input.context.visibleEntries = history.slice(-4)
      const timeline = {
        queries: [],
        responses: [
          {
            query: '第1章尚有效的作者限制是什么？',
            answer: '第1章用户原话：在我解除之前，不让其他人得知她打算辞职。尚无解除。',
            chapterNumbers: [1],
          },
        ],
      }
      const dependencies = {
        shouldUseAgenticRetrieval: () => false,
        runTimelineFill: vi.fn(async () => timeline),
        runAgenticRetrieval: vi.fn(),
        answerChapterQuestion: vi.fn(),
        buildWorldStateContext: vi.fn(async () => ({
          tier1: [],
          tier2: [],
          tier3: [],
          all: [],
          contextBlock: '当前事实',
        })),
        getRelevantLorebookEntries: vi.fn(async () => ({
          tier1: [],
          tier2: [],
          tier3: [],
          all: [],
          contextBlock: '既有世界资料',
        })),
      } as RetrievalDependencies
      const retrieval = new RetrievalPhase().execute({
        context: input.context,
        dependencies,
        memoryRetrievalEnabled: true,
      })
      let next = await retrieval.next()
      while (!next.done) next = await retrieval.next()
      input.retrieval = next.value
      expect(input.retrieval.chapterContext).toBeNull()
      expect(input.retrieval.timelineFillResult).toBe(timeline)
      expect(dependencies.runTimelineFill).toHaveBeenCalledOnce()
      const scene = vi.fn(async (_fields: unknown) => '完整自由导演文本，不按标题解析')
      const turn = await prepareNovelTurn(input, { scene })
      const fields = scene.mock.calls[0][0] as any
      expect(fields.recentUserInputs).toHaveLength(8)
      expect(fields.recent).toHaveLength(8)
      expect(fields.chapters).toHaveLength(12)
      expect(JSON.stringify(fields.recentUserInputs)).not.toContain('辞职')
      const rendered = templateEngine.render(
        canonicalCollaborativeTemplates[0].userContent!,
        fields,
      )!
      expect(fields.retrievedMemory).toContain(timeline.responses[0].answer)
      expect(rendered.split(timeline.responses[0].answer)).toHaveLength(2)
      expect(rendered).toContain('Chapter 1')
      expect(rendered.includes('既有世界资料')).toBe(withLore)
      expect(turn.sceneDirectorOutput).toBe('完整自由导演文本，不按标题解析')
      expect(scene).toHaveBeenCalledOnce()
    },
  )

  it('does not duplicate an already composed timeline block or invent answers for empty retrieval', async () => {
    const input = fixture()
    const timeline = {
      queries: [],
      responses: [{ query: '来源？', answer: '第一章的旧事实', chapterNumbers: [1] }],
    }
    const block =
      '## Relevant Story Data\nThe following information was retrieved from past chapters and is relevant to the current scene:\n\n**Chapter 1**\nQ: 来源？\nA: 第一章的旧事实\n\n'
    input.retrieval = {
      ...input.retrieval,
      combinedContext: `其他检索证据\n\n${block}`,
      timelineFillResult: timeline,
    }
    const scene = vi.fn(async () => '导演原文')
    await prepareNovelTurn(input, { scene })
    expect((scene.mock.calls[0] as any)[0].retrievedMemory).toBe(input.retrieval.combinedContext)
    input.retrieval = {
      ...input.retrieval,
      combinedContext: null,
      timelineFillResult: { queries: [], responses: [] },
    }
    await prepareNovelTurn(input, { scene })
    expect((scene.mock.calls[1] as any)[0]).not.toHaveProperty('retrievedMemory')
  })

  it('does not treat an unconfirmed new analysis as fresh confirmed guidance', async () => {
    const input = fixture('继续。', [entry('prose', 'narration', '目前正文')])
    input.context.story.settings!.collaborativeNovelPattern = {
      confirmed: '旧确认指导原文',
      draft: '尚未确认的新分析',
      analyzedHistoryKey: 'older',
      analyzedNarrationCount: 0,
      draftAnalyzedHistoryKey: 'newer',
      draftAnalyzedNarrationCount: 1,
    }
    const scene = vi.fn(async (fields: any) => {
      const rendered = templateEngine.render(
        canonicalCollaborativeTemplates[0].userContent!,
        fields,
      )!
      expect(fields.confirmedPatternGuidance).toBe('旧确认指导原文')
      expect(fields.patternFreshness).toBe('aging')
      expect(rendered).not.toContain('尚未确认的新分析')
      expect(rendered).toContain('分析时效：aging')
      return '本轮导演原文'
    })
    await prepareNovelTurn(input, { scene })
    expect(scene).toHaveBeenCalledOnce()
  })

  it('avoids same-source thread duplication using the actual injection inventory', async () => {
    const input = fixture()
    input.context.worldState.storyBeats = [
      { id: 'included', title: '已注入', description: '完整线程证据', status: 'active' },
      { id: 'additional', title: '补充', description: '完整已结线程', status: 'completed' },
    ] as any
    input.retrieval.worldStateBlock = '[ACTIVE THREADS]\n已注入：完整线程证据'
    input.retrieval.worldStateRetrievalResult = {
      all: [{ id: 'included', type: 'storyBeat' }],
    } as any
    const scene = vi.fn(async (fields: any) => {
      const rendered = templateEngine.render(
        canonicalCollaborativeTemplates[0].userContent!,
        fields,
      )!
      expect(fields.storyBeats).toEqual([
        { title: '补充', description: '完整已结线程', status: 'completed' },
      ])
      expect(rendered.split('完整线程证据')).toHaveLength(2)
      expect(rendered.split('完整已结线程')).toHaveLength(2)
      return '原文交接'
    })
    await prepareNovelTurn(input, { scene })
  })

  it('keeps complete selected chapters and threads once when injection is unavailable', async () => {
    const input = fixture()
    input.retrieval.worldStateBlock = null
    input.retrieval.worldStateRetrievalResult = {
      all: [{ id: 'thread', type: 'storyBeat' }],
    } as any
    input.context.worldState.storyBeats = [
      { id: 'thread', title: '线索', description: '未截断证据', status: 'active' },
    ] as any
    const scene = vi.fn(async (fields: any) => {
      const rendered = templateEngine.render(
        canonicalCollaborativeTemplates[0].userContent!,
        fields,
      )!
      expect(JSON.parse(fields.worldState)).not.toHaveProperty('chapters')
      expect(JSON.parse(fields.worldState)).not.toHaveProperty('storyBeats')
      expect(fields.chapters).toHaveLength(12)
      expect(rendered.split('完整摘要-14')).toHaveLength(2)
      expect(rendered.split('未截断证据')).toHaveLength(2)
      return '原文交接'
    })
    await prepareNovelTurn(input, { scene })
  })

  it('carries historical user sources and eight recent complete passages without current-input duplication', async () => {
    const history = Array.from({ length: 10 }, (_, index) => [
      entry(`input-${index}`, 'user_action', `来源原句-${index}`),
      entry(`prose-${index}`, 'narration', `完整正文-${index}`),
    ]).flat()
    history[17].metadata = {
      novelTurn: savedTurn('用户意图：来源原句-0，持续；场景安排：旧路线不是事实'),
    }
    history[19].metadata = {
      novelTurn: { ...savedTurn('失败的残片'), directorDiagnostics: { directorFallback: true } },
    }
    const input = fixture('本轮写1800字。继续。', history)
    const scene = vi.fn(async (fields: unknown) => {
      const template = canonicalCollaborativeTemplates[0]
      const rendered = templateEngine.render(template.userContent!, {
        ...(fields as Record<string, unknown>),
        planningInput: JSON.stringify(fields),
      })!
      const request = fields as Record<string, any>
      expect(request.recentUserInputs).toEqual(
        history
          .filter((item) => item.type === 'user_action')
          .slice(-8)
          .map((item) => ({ entryId: item.id, text: item.content })),
      )
      expect(request.recent).toEqual(
        history
          .filter((item) => item.type === 'narration')
          .slice(-8)
          .map(
            (item, index) =>
              `【正文 ${index + 3} · entryId=${item.id} · 对应历史用户输入=input-${index + 2}】\n${item.content}`,
          ),
      )
      expect(request.previousDirectorOutput).toBe(
        history[17].metadata!.novelTurn!.sceneDirectorOutput,
      )
      expect(request.chapters).toHaveLength(12)
      expect(request.chapters[0].summary).toBe('完整摘要-3')
      expect(request.requestedLength).toBe('1800中文字')
      expect(rendered).toContain('调用方正文篇幅：1800中文字')
      expect(rendered.split(input.rawInput)).toHaveLength(2)
      expect(rendered.split('唯一检索证据')).toHaveLength(2)
      for (const passage of request.recent) expect(rendered.split(passage)).toHaveLength(2)
      expect(rendered.indexOf(request.previousDirectorOutput)).toBeLessThan(
        rendered.indexOf('【历史用户原文'),
      )
      expect(rendered.indexOf('【历史用户原文')).toBeLessThan(
        rendered.indexOf('【本轮最新用户原文】'),
      )
      expect(rendered).not.toContain('未确认')
      return '用户意图\n原样  \n场景安排\n含自定义格式，篇幅999字'
    })
    const turn = await prepareNovelTurn(input, { scene })
    expect(scene).toHaveBeenCalledOnce()
    const writer = novelWriterContext(turn)
    expect(writer).toContain('调用方权威篇幅 requestedLength】\n\n1800中文字')
    expect(writer).toContain(turn.sceneDirectorOutput)
    expect(writer.indexOf(turn.sceneDirectorOutput!)).toBeLessThan(
      writer.indexOf('【用户本轮原始输入】'),
    )
    expect(writer).not.toContain('确认计划')
    expect(writer).not.toContain('确认结构指导')
    expect(writer).not.toContain('来源原句')
  })

  it('retains repeated user actions as distinct sources and supports release beyond the raw window via saved Director text', () => {
    const older = entry('old', 'narration', '已经发生')
    older.metadata = { novelTurn: savedTurn('来源 user-0：“直到我解除都不许揭露”；持续') }
    const history = [
      older,
      ...Array.from({ length: 9 }, (_, index) => entry(`user-${index + 1}`, 'user_action', '继续')),
    ]
    history.push(entry('release', 'user_action', '现在解除不许揭露的限制'))
    const fields = collaborativeUserContext(history)
    expect(fields.recentUserInputs).toHaveLength(8)
    expect(fields.recentUserInputs!.at(-1)?.text).toContain('解除')
    expect(fields.previousDirectorOutput).toContain('user-0')
    expect(previousNovelTurn(history)?.sceneDirectorOutput).toBe(fields.previousDirectorOutput)
  })

  it('uses edited reroll input, not rejected constraints, while isolating the rejected route from history', async () => {
    const inherited = entry('root-prose', 'narration', '继承的已发生正文')
    inherited.metadata = { novelTurn: savedTurn('有效旧导演') }
    const rejectedSecret = '陈禾其实是旧账的持有人，林已得知这一秘密。'
    const rejected = entry('rejected', 'narration', rejectedSecret, 'branch')
    rejected.metadata = { novelTurn: savedTurn('被拒导演及其虚构约束') }
    const input = fixture('改为她暂时合作但不信任', [inherited, rejected])
    const retry = novelRetry(rejected, '旧的用户输入')
    const scene = vi.fn(async (_input: unknown) => '新路线')
    const turn = await prepareNovelTurn({ ...input, retry }, { scene })
    expect(scene.mock.calls[0][0]).toMatchObject({
      rawInput: input.rawInput,
      recent: ['【正文 1 · entryId=root-prose】\n继承的已发生正文'],
      reroll: { rejectedProse: rejectedSecret },
    })
    expect(scene.mock.calls[0][0]).not.toHaveProperty('previousDirectorOutput')
    expect(JSON.stringify(scene.mock.calls[0][0])).not.toContain('有效旧导演')
    expect(JSON.stringify(scene.mock.calls[0][0])).not.toContain('被拒导演及其虚构约束')
    expect(turn.reroll?.rejectedDirectorOutput).toBe('被拒导演及其虚构约束')
    expect(novelWriterContext(turn)).not.toContain('被拒')
    expect(novelWriterContext(turn)).not.toContain(rejectedSecret)
    const { reroll: _rejectedRoute, ...acceptedContext } = scene.mock.calls[0][0] as Record<
      string,
      unknown
    >
    // Rejected inventions may guide route avoidance, but never join accepted history,
    // current state or the successful Writer handoff as an established secret.
    expect(JSON.stringify(acceptedContext)).not.toContain(rejectedSecret)
    for (const invalid of [
      { ...retry, storyId: 'other-story' },
      { ...retry, branchId: 'sibling' },
    ]) {
      const capture = vi.fn(async (_input: unknown) => '新路线')
      await prepareNovelTurn(
        { ...input, context: { ...input.context, allEntries: [inherited] }, retry: invalid },
        { scene: capture },
      )
      expect(capture.mock.calls[0][0]).not.toHaveProperty('reroll')
    }
  })

  it('restores sources and enabled guidance only on failure, without persisted copies or format retries', async () => {
    const older = entry('source', 'user_action', '后面别让她知道来源，直到解除')
    const input = fixture('继续', [older])
    const rejected = entry('rejected', 'narration', '被拒版本', 'branch')
    rejected.metadata = { novelTurn: savedTurn('被拒导演，不可传回模型') }
    const accepted = entry('accepted', 'narration', '已接受事实', 'branch')
    accepted.metadata = { novelTurn: savedTurn('已接受旧导演，不可传回模型') }
    input.context.allEntries.unshift(accepted)
    const scene = vi.fn(
      async (_input: unknown, _diagnostic?: unknown, onChunk?: (text: string) => void) => {
        onChunk?.('不完整导演')
        throw new Error('temporary network failure')
      },
    )
    const turn = await prepareNovelTurn(
      { ...input, retry: novelRetry(rejected, input.rawInput) },
      { scene },
    )
    expect(scene).toHaveBeenCalledOnce()
    const context = novelWriterContext(turn)
    for (const value of [older.content, '确认计划', '确认结构指导', '被拒版本', '非事实'])
      expect(context).toContain(value)
    expect(context).not.toContain('不完整导演')
    expect(context).not.toContain('被拒导演，不可传回模型')
    expect(context).not.toContain('已接受旧导演，不可传回模型')
    expect(context.split('被拒版本')).toHaveLength(2)
    expect(context).not.toContain('未确认')
    expect(JSON.stringify(turn)).not.toContain(older.content)
    const plainText = vi.fn(async () => '完全自由的文本，未采用推荐标题')
    const result = await prepareNovelTurn(input, { scene: plainText })
    expect(result.sceneDirectorOutput).toBe('完全自由的文本，未采用推荐标题')
    expect(plainText).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'keeps retrieved older user constraints and their current release on reroll, released=%s',
    async (released) => {
      const history = Array.from({ length: 10 }, (_, index) => [
        entry(
          `author-${index}`,
          'user_action',
          index === 0 ? '直到我解除，不许透露身份。' : '继续。',
        ),
        entry(`prose-${index}`, 'narration', `已发生-${index}`),
      ]).flat()
      history.at(-1)!.metadata = { novelTurn: savedTurn('旧导演仍然禁止透露，不能当成命令') }
      const rejected = entry('rejected', 'narration', '被拒版本：已经透露身份', 'branch')
      rejected.metadata = { novelTurn: savedTurn('被拒导演编造了许可') }
      const input = fixture(released ? '现在解除之前不许透露身份的限制。' : '继续。', [
        ...history,
        rejected,
      ])
      input.retrieval.timelineFillResult = {
        queries: [],
        responses: [
          {
            query: '持续要求',
            answer: '用户 author-0 原文：直到我解除，不许透露身份。',
            chapterNumbers: [1],
          },
        ],
      }
      const scene = vi.fn(async (_fields: unknown) => '本轮安排')
      await prepareNovelTurn({ ...input, retry: novelRetry(rejected, input.rawInput) }, { scene })
      const fields = scene.mock.calls[0][0] as Record<string, any>
      expect(JSON.stringify(fields.recentUserInputs)).not.toContain('author-0')
      expect(fields.retrievedMemory).toContain('用户 author-0 原文：直到我解除，不许透露身份。')
      expect(fields.rawInput).toBe(input.rawInput)
      expect(fields).not.toHaveProperty('previousDirectorOutput')
      expect(JSON.stringify(fields)).not.toContain('旧导演仍然禁止')
      expect(JSON.stringify(fields)).not.toContain('被拒导演编造')
      expect(JSON.stringify(fields.recent)).not.toContain('被拒版本')
      expect(JSON.stringify(fields).split('被拒版本：已经透露身份')).toHaveLength(2)
    },
  )

  it('omits disabled guidance and drafts from Director, fallback and optional inputs', async () => {
    const input = fixture()
    input.context.story.settings!.collaborativeNovelWorkflow = {
      narrativePlanner: { enabled: false },
      patternReviewer: { enabled: false },
      plotSuggestions: { enabled: false },
    }
    const scene = vi.fn(async (_input: unknown) => {
      throw new Error('unavailable')
    })
    const turn = await prepareNovelTurn(input, { scene })
    expect(scene.mock.calls[0][0]).not.toHaveProperty('confirmedPlan')
    expect(scene.mock.calls[0][0]).not.toHaveProperty('confirmedPatternGuidance')
    expect(novelWriterContext(turn)).not.toContain('确认计划')
    const optional = collaborativeOptionalContext(input.context.story, input.context.allEntries)
    expect(optional).not.toHaveProperty('confirmedPlan')
    expect(optional).not.toHaveProperty('confirmedPatternGuidance')
    expect(JSON.stringify(optional)).not.toContain('未确认')
  })
})
