import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    apiSettings: {
      mainNarrativeProfileId: 'profile',
      defaultModel: 'model',
      maxTokens: 4096,
      temperature: 0.3,
      reasoningEffort: 'medium',
      llmTimeoutMs: 300000,
    },
    getProfile: vi.fn(() => ({ id: 'profile', providerType: 'openrouter', apiKey: 'key' })),
  },
}))
vi.mock('$lib/services/database', () => ({
  database: { getStory: vi.fn(async () => ({ id: 'story' })) },
}))
vi.mock('../core/CollaborativePromptService', () => ({
  CollaborativePromptService: {
    render: vi.fn(async () => ({
      presetId: 'director-preset',
      system: 'system',
      user: 'user',
      preset: {
        id: 'director-preset',
        name: '导演',
        profileId: 'director-profile',
        model: 'director-model',
        temperature: 0.4,
        maxTokens: 5000,
        reasoningEffort: 'high',
        timeoutMs: 123000,
      },
      profile: { id: 'director-profile', name: 'Director API' },
    })),
  },
}))
vi.mock('../sdk/generate', () => ({
  generateCollaborativeText: vi.fn(async () => '原始导演文本\n未定义段落'),
}))

import { CollaborativeService } from './CollaborativeService'
import { generateCollaborativeText } from '../sdk/generate'
import { database } from '$lib/services/database'
import { collaborativeServiceIds } from '../core/collaborativeAgentDefaults'
import { CollaborativePromptService } from '../core/CollaborativePromptService'

describe('raw collaborative Agent output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(database.getStory).mockResolvedValue({ id: 'story' } as any)
  })

  it.each(['narrativePlanner', 'patternReviewer'] as const)(
    'blocks disabled %s even when stored drafts and confirmations exist',
    async (agent) => {
      const story = {
        id: 'story',
        mode: 'creative-writing',
        settings: {
          collaborativeNovelWorkflow: { [agent]: { enabled: false } },
          collaborativeNovelPlan: { confirmed: '旧确认计划', draft: '旧计划草稿' },
          collaborativeNovelPattern: { confirmed: '旧确认指导', draft: '旧指导草稿' },
        },
      }
      vi.mocked(database.getStory).mockResolvedValueOnce(story as any)
      const before = structuredClone(story)
      await expect(
        new CollaborativeService(collaborativeServiceIds[agent]).run('story', 'unused', {
          request: '生成新草稿',
        }),
      ).rejects.toThrow('已关闭')
      expect(generateCollaborativeText).not.toHaveBeenCalled()
      expect(story).toEqual(before)
    },
  )

  it.each(['narrativePlanner', 'patternReviewer'] as const)(
    'returns %s drafts without confirming or modifying saved guidance',
    async (agent) => {
      const story = {
        id: 'story',
        mode: 'creative-writing',
        settings: {
          collaborativeNovelWorkflow: { [agent]: { enabled: true } },
          collaborativeNovelPlan: { confirmed: '用户确认的计划', draft: null },
          collaborativeNovelPattern: { confirmed: '用户确认的指导', draft: null },
        },
      }
      vi.mocked(database.getStory).mockResolvedValueOnce(story as any)
      const before = structuredClone(story)
      const output = await new CollaborativeService(collaborativeServiceIds[agent]).run(
        'story',
        'unused',
        { request: '生成新草稿' },
      )
      expect(output).toBe('原始导演文本\n未定义段落')
      expect(generateCollaborativeText).toHaveBeenCalledOnce()
      expect(story).toEqual(before)
    },
  )

  it('returns the Agent text without schema parsing or field reconstruction', async () => {
    const output = await new CollaborativeService('collaborativeSceneDirector').run(
      'story',
      'unused',
      {
        rawInput: '继续',
      },
    )
    expect(output).toBe('原始导演文本\n未定义段落')
    expect(generateCollaborativeText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'system',
        prompt: 'user',
        requestBudgetMs: 123000,
        presetId: 'director-preset',
        presetOverride: expect.objectContaining({
          profileId: 'director-profile',
          model: 'director-model',
          maxTokens: 5000,
          reasoningEffort: 'high',
        }),
      }),
    )
  })

  it.each([30000, 180000, 600000])(
    'honors the saved Director timeout of %s ms',
    async (timeoutMs) => {
      const rendered = await CollaborativePromptService.render('story', 'sceneDirector', {})
      vi.mocked(CollaborativePromptService.render).mockResolvedValueOnce({
        ...rendered,
        preset: { ...rendered.preset, timeoutMs },
      })
      await new CollaborativeService('collaborativeSceneDirector').run('story', 'unused', {})
      expect(generateCollaborativeText).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestBudgetMs: timeoutMs }),
      )
    },
  )

  it('ignores legacy Director disable values because Director is mandatory', async () => {
    vi.mocked(database.getStory).mockResolvedValueOnce({
      id: 'story',
      mode: 'creative-writing',
      settings: { collaborativeNovelWorkflow: { sceneDirector: { enabled: false } } },
    } as any)
    await expect(
      new CollaborativeService('collaborativeSceneDirector').run('story', 'unused', {
        rawInput: '继续',
      }),
    ).resolves.toBe('原始导演文本\n未定义段落')
    expect(generateCollaborativeText).toHaveBeenCalledOnce()
  })

  it('inherits the global timeout only when the Director preset has no timeout', async () => {
    const rendered = await CollaborativePromptService.render('story', 'sceneDirector', {})
    vi.mocked(CollaborativePromptService.render).mockResolvedValueOnce({
      ...rendered,
      preset: { ...rendered.preset, timeoutMs: undefined },
    })
    await new CollaborativeService('collaborativeSceneDirector').run('story', 'unused', {})
    expect(generateCollaborativeText).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestBudgetMs: 300000 }),
    )
  })
})
