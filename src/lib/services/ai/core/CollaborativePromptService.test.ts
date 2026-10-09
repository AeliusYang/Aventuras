import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  context: {
    protagonistName: '林',
    novelCharacterContext: '角色上下文',
    recentNovelProse: '上一段正文',
  } as Record<string, unknown>,
  forStory: vi.fn(),
  forInspection: vi.fn(),
  getStoryPackId: vi.fn(),
  getPackTemplate: vi.fn(),
  inspectTemplate: vi.fn(),
}))

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    apiSettings: { mainNarrativeProfileId: 'system-profile' },
    getServicePresetId: vi.fn(() => 'shared-preset'),
    getPresetConfig: vi.fn(() => ({
      id: 'shared-preset',
      name: '共享导演',
      profileId: 'system-profile',
      model: 'system-model',
      temperature: 0.35,
      maxTokens: 4096,
      reasoningEffort: 'medium',
    })),
    getProfile: vi.fn(() => ({
      id: 'system-profile',
      name: '模型连接',
      providerType: 'openrouter',
      apiKey: 'secret',
    })),
  },
}))
vi.mock('$lib/services/context', () => ({
  ContextBuilder: {
    forStory: mocks.forStory,
    forInspection: mocks.forInspection,
  },
}))

import { CollaborativePromptService } from './CollaborativePromptService'
import { canonicalCollaborativeTemplates } from '$lib/services/prompts/templates/collaborative'
import { templateEngine } from '$lib/services/templates/engine'
import type { TemplateContext } from '$lib/services/templates/types'

describe('CollaborativePromptService', () => {
  it('inspects saved story bindings without a stale Director brief or credential leakage', async () => {
    const context: Record<string, unknown> = {
      novelAgentContext: '上一轮的简报',
      rawInput: '当前输入',
    }
    const baseline = canonicalCollaborativeTemplates.find(
      (template) => template.id === 'collaborative-chinese-writer',
    )!
    mocks.forStory.mockResolvedValue({
      add: (value: Record<string, unknown>) => Object.assign(context, value),
      getContext: () => context,
      inspectTemplate: async () => ({
        ...(await mocks.inspectTemplate(baseline.id)),
        systemTemplate: baseline.content,
        userTemplate: '用户改写过的模板',
        variables: ['novelAgentContext', 'rawInput', 'missing'],
        missingVariables: ['missing'],
        hasDirectorBrief: Boolean(context.novelAgentContext),
      }),
    })
    const result = await CollaborativePromptService.render('story', 'writer', { preview: true })
    expect(result.hasDirectorBrief).toBe(false)
    expect(result.variableValues).toMatchObject({
      novelAgentContext: '',
      rawInput: '当前输入',
      missing: null,
    })
    expect(result.provenance).toMatchObject({ systemCustomized: false, userCustomized: true })
    expect(result.provenance?.sources.length).toBeGreaterThan(0)
    expect(result.system).toContain('运行时叙述人称约束')
    expect(JSON.stringify(result)).not.toContain('apiKey')
  })
  beforeEach(() => {
    vi.clearAllMocks()
    const data = { ...mocks.context }
    mocks.forStory.mockResolvedValue({
      add: (value: Record<string, unknown>) => Object.assign(data, value),
      getContext: () => ({ ...data }),
      inspectTemplate: mocks.inspectTemplate,
    })
    mocks.inspectTemplate.mockImplementation(async (templateId: string) => ({
      templateId,
      packId: 'story-pack',
      system: 'active pack system',
      user: `active pack user: ${data.rawInput ?? ''}`,
      systemResolution: { templateId, packId: 'story-pack' },
      userResolution: { templateId: `${templateId}-user`, packId: 'story-pack' },
      variables: ['rawInput'],
      missingVariables: [],
      renderErrors: [],
      systemSource: 'story-pack',
      userSource: 'story-pack',
      source: 'story-pack',
    }))
  })

  it('uses explicitly supplied branch context for current-story previews', async () => {
    const builder = await mocks.forStory()
    mocks.forInspection.mockResolvedValue(builder)
    const preview = {
      storyId: 'story',
      branchId: 'branch',
      entries: [{ id: 'entry', storyId: 'story', type: 'narration', content: '本分支正文' }],
    } as any
    await CollaborativePromptService.render(
      'story',
      'sceneDirector',
      { preview: true },
      {},
      preview,
    )
    expect(mocks.forInspection).toHaveBeenCalledWith(
      'story',
      'collaborative-scene-director',
      preview,
    )
    expect(builder.getContext()).toMatchObject({
      recent: ['本分支正文'],
      novelAgentContext: '',
      sceneBrief: '',
    })
    await expect(
      CollaborativePromptService.render('another-story', 'writer', { preview: true }, {}, preview),
    ).rejects.toThrow('预览故事已切换')
  })

  it('renders the active story pack and returns the provenance used by Inspector', async () => {
    const result = await CollaborativePromptService.render('story', 'sceneDirector', {
      rawInput: '继续',
    })
    expect(mocks.forStory).toHaveBeenCalledWith('story')
    expect(result.presetId).toBe('shared-preset')
    expect(result.preset.profileId).toBe('system-profile')
    expect(result.preset.model).toBe('system-model')
    expect(result.profile.id).toBe('system-profile')
    expect(result.requestMode).toBe('stream-text')
    expect(result.user).toContain('继续')
    expect(result.packId).toBe('story-pack')
    expect(result.systemSource).toBe('story-pack')
    expect(result.systemTemplateId).toBe('collaborative-scene-director')
    expect(JSON.stringify(result)).not.toContain('apiKey')
  })

  it.each([
    ['first', '第一人称', '以“我”作为旁白对主角的指代'],
    ['second', '第二人称', '以“你”或主角姓名作为旁白对主角的指代'],
    ['third', '第三人称', '旁白严禁以“我”自称主角'],
  ])(
    'applies the configured Writer point of view even with a story Pack: %s',
    async (pov, label, rule) => {
      const result = await CollaborativePromptService.render('story', 'writer', {}, { pov })
      expect(result.system).toContain(`当前故事设置的人称是：${label}`)
      expect(result.system).toContain(rule)
      expect(result.system).toContain('人物实际说出口的对白中的“我”按原意保留')
      expect(result.systemSource).toBe('mixed')
      expect(result.userSource).toBe('story-pack')
    },
  )

  it('keeps legacy variable aliases outside the deduplicated planning input', async () => {
    let context: Record<string, unknown> = {}
    mocks.forStory.mockResolvedValue({
      add: (value: Record<string, unknown>) => {
        context = value
      },
      inspectTemplate: mocks.inspectTemplate,
    })
    await CollaborativePromptService.render(
      'story',
      'narrativePlanner',
      {
        confirmedPlan: '已确认工作计划',
        recentUserInputs: [{ entryId: 'source', text: '暂时保留怀疑' }],
      },
      { planningInput: '过时的重复输入' },
    )
    expect(context.currentConfirmed).toBe('已确认工作计划')
    expect(context.previousPlan).toBe('已确认工作计划')
    expect(context.planningInput).not.toContain('过时')
    expect(String(context.planningInput).split('已确认工作计划')).toHaveLength(2)
    expect(JSON.parse(String(context.planningInput))).not.toHaveProperty('previousPlan')
    await CollaborativePromptService.render('story', 'patternReviewer', {
      confirmedPatternGuidance: '已确认结构指导',
    })
    expect(context.currentConfirmedGuidance).toBe('已确认结构指导')
    expect(context.currentConfirmed).toBe('已确认结构指导')
  })

  it.each([false, true])(
    'excludes archived Directors from runtime and Inspector rendering, reroll supplied by overrides=%s',
    async (fromOverrides) => {
      const context: Record<string, any> = {
        previousDirectorOutput: '自定义变量里的旧导演',
        rejectedDirectorOutput: '自定义变量里的被拒导演',
      }
      mocks.forStory.mockResolvedValue({
        add: (value: Record<string, unknown>) => Object.assign(context, value),
        inspectTemplate: async () => ({
          ...(await mocks.inspectTemplate('collaborative-scene-director')),
          user: templateEngine.render(
            '{{ previousDirectorOutput }}{{ rejectedDirectorOutput }}{{ reroll.rejectedDirectorOutput }}{{ planningInput }}',
            context,
          ),
        }),
      })
      const reroll = { rejectedProse: '被拒正文，仅一次', rejectedDirectorOutput: '被拒导演仍保存' }
      const input = {
        rawInput: '明确的新要求',
        previousDirectorOutput: '已接受旧导演仍保存',
        ...(fromOverrides ? {} : { reroll }),
      }
      const savedInput = JSON.stringify(input)
      const result = await CollaborativePromptService.render('story', 'sceneDirector', input, {
        previousDirectorOutput: '预览覆盖值中的旧导演',
        rejectedDirectorOutput: '预览覆盖值中的被拒导演',
        planningInput: '旧 planningInput 副本',
        reroll,
      })
      expect(result.user).not.toContain('导演')
      expect(result.user).not.toContain('planningInput 副本')
      expect(result.user).toContain('明确的新要求')
      expect(result.user.split('被拒正文，仅一次')).toHaveLength(2)
      expect(JSON.parse(context.planningInput)).not.toHaveProperty('previousDirectorOutput')
      expect(context.reroll).toEqual({ rejectedProse: '被拒正文，仅一次' })
      expect(JSON.stringify(input)).toBe(savedInput)
      expect(reroll.rejectedDirectorOutput).toBe('被拒导演仍保存')
    },
  )

  it.each(['narrativePlanner', 'patternReviewer', 'plotSuggestions'] as const)(
    'renders source-scoped optional inputs once without changing legacy input: %s',
    async (agent) => {
      const context: Record<string, unknown> = {}
      mocks.forStory.mockResolvedValue({
        add: (value: Record<string, unknown>) => Object.assign(context, value),
        inspectTemplate: mocks.inspectTemplate,
      })
      const input = {
        worldState: { location: '唯一当前现场' },
        recent: [{ passage: 1, text: '唯一既成事件' }],
        recentUserInputs: [{ entryId: 'old-user', text: '旧轮次的沉默要求' }],
        previousDirectorOutput: '旧简报，不是事实',
        confirmedPlan: '唯一已确认计划',
        confirmedPatternGuidance: '唯一已确认结构指导',
        currentDraft: '未经确认的草稿',
        request: '本次主动调用任务',
        userFeedback: '这次修改意见',
        lorebookContext: '世界书原文\n  {{ 不改宏 }}\n',
        extensionData: { value: '保留未知输入字段' },
      }
      await CollaborativePromptService.render('story', agent, input, {
        optionalAgentSections: [{ key: 'request', value: '过时覆盖值' }],
      })
      expect(context.planningInput).toBe(JSON.stringify(input))
      const templateId = {
        narrativePlanner: 'collaborative-long-planner',
        patternReviewer: 'collaborative-pattern-reviewer',
        plotSuggestions: 'collaborative-plot-suggestions',
      }[agent]
      const template = canonicalCollaborativeTemplates.find((value) => value.id === templateId)!
      const user = templateEngine.render(template.userContent!, context as TemplateContext)!
      for (const text of [
        '唯一当前现场',
        '唯一既成事件',
        '旧轮次的沉默要求',
        '旧简报，不是事实',
        '唯一已确认计划',
        '唯一已确认结构指导',
        '未经确认的草稿',
        '本次主动调用任务',
        '这次修改意见',
        '保留未知输入字段',
        input.lorebookContext,
      ])
        expect(user.split(text)).toHaveLength(2)
      expect(user).not.toContain('过时覆盖值')
      expect(user).toContain('历史用户原文；已用于各自轮次')
      expect(user).toContain('待修改草稿；尚未确认，不生效')
      expect(user.indexOf('旧轮次的沉默要求')).toBeLessThan(user.indexOf('这次修改意见'))
      expect(input.lorebookContext).toBe('世界书原文\n  {{ 不改宏 }}\n')
    },
  )

  it('does not emit absent optional guidance or apply optional assembly to Director', async () => {
    let context: Record<string, unknown> = {}
    mocks.forStory.mockResolvedValue({
      add: (value: Record<string, unknown>) => {
        context = value
      },
      inspectTemplate: mocks.inspectTemplate,
    })
    await CollaborativePromptService.render('story', 'patternReviewer', {
      request: '分析',
      confirmedPlan: null,
      confirmedPatternGuidance: '',
      recentUserInputs: [],
    })
    expect(context.optionalAgentSections).toEqual([{ key: 'request', value: '分析' }])
    await CollaborativePromptService.render('story', 'sceneDirector', { rawInput: '继续' })
    expect(context).not.toHaveProperty('optionalAgentSections')
  })
})
