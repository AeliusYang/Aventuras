import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextBuilder } from '$lib/services/context/context-builder'
import { CollaborativeService } from '$lib/services/ai/generation/CollaborativeService'
import { NarrativeService } from '$lib/services/ai/generation/NarrativeService'
import type { NovelTurn } from '$lib/types/collaborative'
import type { Story, StoryEntry } from '$lib/types'
import { packService } from './pack-service'
import { CollaborativePromptService } from '$lib/services/ai/core/CollaborativePromptService'
import { PROMPT_TEMPLATES } from '$lib/services/prompts/templates'
import { canonicalCollaborativeTemplates } from '$lib/services/prompts/templates/collaborative'
import type { PackTemplate } from './types'

const { rows, generateStructured, generateCollaborativeText, generateNarrative, database, branch } = vi.hoisted(() => {
  const rows = new Map<string, PackTemplate>()
  const branch = { id: 'main' }
  return {
    rows,
    branch,
    generateStructured: vi.fn().mockResolvedValue({ brief: 'scene' }),
    generateCollaborativeText: vi.fn().mockResolvedValue('scene'),
    generateNarrative: vi.fn().mockResolvedValue('生成正文'),
    database: {
      createPack: vi.fn(async (pack: { id: string; name: string }) => pack),
      getBranch: vi.fn(async (id: string) => ({ id, storyId: 'story', snapshotComplete: true })),
      getStory: vi.fn(async () => ({
        id: 'story',
        currentBranchId: branch.id,
        mode: 'creative-writing',
        settings: { collaborativeNovelWorkflow: {} },
      })),
      getStoryPackId: vi.fn(async () => 'custom'),
      getStoryCustomVariables: vi.fn(async () => ({})),
      getPackVariables: vi.fn(async () => []),
      getRuntimeVariables: vi.fn(async () => []),
      getCharacters: vi.fn(async () => [
        {
          name: 'Lin',
          relationship: 'self',
          branchId: branch.id,
          description: 'Character description',
          traits: ['Patient'],
          metadata: {
            characterCard: {
              scenario: 'Original scene',
              examples: 'Example dialogue',
              history: 'Established history',
            },
          },
        },
      ]),
      getLocations: vi.fn(async () => []),
      getItems: vi.fn(async () => []),
      getStoryBeats: vi.fn(async () => []),
      getPackTemplate: vi.fn(async (pack: string, id: string) => rows.get(`${pack}:${id}`) ?? null),
      getPackTemplates: vi.fn(async (pack: string) =>
        [...rows.values()].filter((r) => r.packId === pack),
      ),
      getDefaultPack: vi.fn(async () => ({ id: 'default-pack' })),
      getAllPacks: vi.fn(async () => [{ id: 'custom' }, { id: 'default-pack' }]),
      setPackTemplateContent: vi.fn(
        async (packId: string, templateId: string, content: string, baseline: boolean) => {
          rows.set(`${packId}:${templateId}`, {
            id: templateId,
            packId,
            templateId,
            content,
            contentHash: content,
            baselineHash: baseline
              ? content
              : (rows.get(`${packId}:${templateId}`)?.baselineHash ?? ''),
            createdAt: 0,
            updatedAt: 0,
          })
        },
      ),
    },
  }
})

vi.mock('$lib/services/database', () => ({ database }))
vi.mock('$lib/services/ai/sdk/generate', () => ({
  generateStructured,
  generateCollaborativeText,
  generateNarrative,
}))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    getServicePresetId: () => 'test-preset',
    getPresetConfig: () => ({ id: 'test-preset', name: '共享配置', profileId: 'profile', model: 'model', temperature: 0.8, maxTokens: 8192, reasoningEffort: 'none', timeoutMs: 360000 }),
    apiSettings: { mainNarrativeProfileId: 'profile', defaultModel: 'model', maxTokens: 4096 },
    getProfile: () => ({ id: 'profile' }),
  },
}))
vi.mock('$lib/services/ai/core/CollaborativePromptService', () => ({
  CollaborativePromptService: {
    render: vi.fn(async () => ({
      agentKey: 'writer',
      templateId: 'collaborative-chinese-writer',
      presetId: 'test-preset',
      preset: {
        id: 'test-preset', name: '共享配置',
        profileId: 'profile', model: 'model', temperature: 0.8, maxTokens: 8192,
        reasoningEffort: 'none', timeoutMs: 360000,
      },
      profile: { id: 'profile', name: 'API', providerType: 'openrouter', apiKey: 'key' },
      system: 'system', user: 'user', variables: [], missingVariables: [], source: 'user',
    })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  Reflect.set(packService, 'initialized', false)
  rows.clear()
  branch.id = 'main'
  vi.mocked(database.getAllPacks).mockResolvedValue([
    { id: 'custom' },
    { id: 'default-pack' },
  ] as any)
})

describe('active pack editor to real service prompt resolution', () => {
  it('adds canonical ST templates to an existing managed collaborative pack', async () => {
    const managed = {
      id: 'managed',
      name: '中文写作',
      author: 'AIRP',
      isDefault: false,
    }
    vi.mocked(database.getAllPacks).mockResolvedValue([managed] as any)
    await database.setPackTemplateContent('managed', 'collaborative-novel', 'legacy writer', true)

    await packService.ensureCollaborativePack()

    const canonical = PROMPT_TEMPLATES.find(
      (template) => template.id === 'collaborative-chinese-writer',
    )!
    expect(rows.get('managed:collaborative-chinese-writer')?.content).toBe(canonical.content)
    expect(rows.get('managed:collaborative-chinese-writer-user')?.content).toBe(
      canonical.userContent,
    )
  })

  it('updates untouched canonical templates but preserves managed-pack edits', async () => {
    const managed = {
      id: 'managed',
      name: '中文写作',
      author: 'AIRP',
      isDefault: false,
    }
    vi.mocked(database.getAllPacks).mockResolvedValue([managed] as any)
    await database.setPackTemplateContent(
      'managed',
      'collaborative-scene-director',
      'old shipped director',
      true,
    )
    await database.setPackTemplateContent(
      'managed',
      'collaborative-chinese-writer',
      'old shipped writer',
      true,
    )
    await database.setPackTemplateContent(
      'managed',
      'collaborative-chinese-writer',
      'my edited writer',
      false,
    )

    await packService.ensureCollaborativePack()

    const director = PROMPT_TEMPLATES.find(
      (template) => template.id === 'collaborative-scene-director',
    )!
    expect(rows.get('managed:collaborative-scene-director')?.content).toBe(director.content)
    expect(rows.get('managed:collaborative-chinese-writer')?.content).toBe('my edited writer')
  })

  it('preserves both halves of iterated Director and Writer prompts across repeated startup refreshes', async () => {
    vi.mocked(database.getAllPacks).mockResolvedValue([
      { id: 'managed', name: '中文写作', author: 'AIRP', isDefault: false },
      { id: 'default-pack' },
    ] as any)
    const ids = ['collaborative-scene-director', 'collaborative-chinese-writer']
      .flatMap((id) => [id, `${id}-user`])
    for (const packId of ['managed', 'default-pack']) {
      for (const id of ids) {
        await database.setPackTemplateContent(packId, id, `baseline ${id}`, true)
        await database.setPackTemplateContent(packId, id, `iteration one ${id}`, false)
        await database.setPackTemplateContent(packId, id, `iteration two ${id}`, false)
      }
    }
    for (let startup = 0; startup < 2; startup++) {
      Reflect.set(packService, 'initialized', false)
      await packService.initialize()
      await packService.ensureCollaborativePack()
      for (const packId of ['managed', 'default-pack']) {
        for (const id of ids) {
          expect(rows.get(`${packId}:${id}`)).toMatchObject({
            content: `iteration two ${id}`,
            baselineHash: `baseline ${id}`,
          })
        }
      }
    }
  })

  it('refreshes all untouched collaborative canonical templates', async () => {
    const managed = {
      id: 'managed',
      name: '中文写作',
      author: 'AIRP',
      isDefault: false,
    }
    vi.mocked(database.getAllPacks).mockResolvedValue([managed] as any)
    for (const template of canonicalCollaborativeTemplates) {
      await database.setPackTemplateContent('managed', template.id, 'old shipped template', true)
      if (template.userContent) {
        await database.setPackTemplateContent(
          'managed',
          template.id + '-user',
          'old shipped user template',
          true,
        )
      }
    }

    await packService.ensureCollaborativePack()

    for (const template of canonicalCollaborativeTemplates) {
      expect(rows.get('managed:' + template.id)?.content).toBe(template.content)
      if (template.userContent) {
        expect(rows.get('managed:' + template.id + '-user')?.content).toBe(template.userContent)
      }
    }
  })

  it('seeds canonical templates into the default pack even when legacy aliases exist', async () => {
    vi.mocked(database.getAllPacks).mockResolvedValue([
      {
        id: 'default-pack',
        name: 'Default',
        author: 'Aventura',
        isDefault: true,
      },
    ] as any)
    await database.setPackTemplateContent('default-pack', 'novel-patterns', 'legacy reviewer', true)

    await packService.initialize()

    const canonical = PROMPT_TEMPLATES.find(
      (template) => template.id === 'collaborative-pattern-reviewer',
    )!
    expect(rows.get('default-pack:collaborative-pattern-reviewer')?.content).toBe(canonical.content)
    expect(rows.get('default-pack:collaborative-pattern-reviewer-user')?.content).toBe(
      canonical.userContent,
    )
    expect(rows.get('default-pack:novel-patterns')?.content).not.toBe('legacy reviewer')
  })

  it('seeds new packs with canonical ST baselines even when the default pack is legacy', async () => {
    await database.setPackTemplateContent(
      'default-pack',
      'collaborative-novel',
      'old default writer',
      true,
    )
    const pack = await packService.createPack('New collaborative story')
    const canonical = PROMPT_TEMPLATES.find(
      (template) => template.id === 'collaborative-chinese-writer',
    )!
    const inspected = await new ContextBuilder(pack.id)
      .add({ recentNovelProse: 'Recent prose', novelAgentContext: 'Current director' })
      .inspectTemplate(canonical.id)
    expect(inspected.systemTemplate).toBe(canonical.content)
    expect(inspected.userTemplate).toBe(canonical.userContent)
    expect(inspected.systemResolution?.templateId).toBe(canonical.id)
    expect(inspected.system).not.toContain('old default writer')
    expect(inspected.user).toContain('Recent prose')
    expect(inspected.user).toContain('Current director')
  })

  it.each(['', '  ', 'writer without director'])(
    'rejects invalid canonical Writer user content %j before saving',
    async (user) => {
      const templateId = 'collaborative-chinese-writer'
      const current = await new ContextBuilder('custom').inspectTemplate(templateId)
      await expect(
        packService.saveTemplatePair(
          'custom',
          templateId,
          { system: 'edited', user },
          { system: current.systemTemplate, user: current.userTemplate },
        ),
      ).rejects.toThrow(/不能为空|novelAgentContext/)
      expect(database.setPackTemplateContent).not.toHaveBeenCalled()
    },
  )

  it('reports explicitly empty imported Writer user content and blocks generation fallback', async () => {
    await database.setPackTemplateContent('custom', 'collaborative-chinese-writer', 'system', false)
    await database.setPackTemplateContent('custom', 'collaborative-chinese-writer-user', '', false)
    const builder = new ContextBuilder('custom')
    const inspected = await builder.inspectTemplate('collaborative-chinese-writer')
    expect(inspected.userTemplateState).toBe('empty')
    expect(inspected.userResolution).not.toBeNull()
    await expect(builder.render('collaborative-chinese-writer')).rejects.toThrow('渲染为空')
  })

  it('uses the collaborative Prompt Service shared with active-pack inspection', async () => {
    const novelTurn = {
      rawInput: '继续',
      requestedLength: '1500-3000',
      scene: {
        intent: {
          facts: [],
          actions: [],
          dialogue: [],
          preservedProse: [],
          requiredResults: [],
          prohibitions: [],
          openSpace: [],
          ongoingConstraints: [],
          protagonistBoundary: '不替主角决定',
          length: '1500-3000',
        },
        brief: '保留怀疑',
        stopBoundary: '停在决定前',
        candidates: [],
        selected: 0,
      },
    } as unknown as NovelTurn
    await new NarrativeService().generate(
      [],
      { characters: [], locations: [], items: [], storyBeats: [] },
      (await database.getStory()) as unknown as Story,
      { novelTurn },
    )
    expect(generateNarrative).toHaveBeenCalledWith(expect.objectContaining({ system: 'system', prompt: 'user' }))
    expect(vi.mocked(CollaborativePromptService.render)).toHaveBeenCalled()
  })

  it('uses the active-pack Prompt Service for control requests', async () => {
    const template = 'collaborative-scene-director'
    const service = new CollaborativeService('collaborativeSceneDirector')
    await service.run('story', template, { action: 'continue' })
    expect(generateCollaborativeText).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'system', prompt: 'user' }),
    )
  })

  it('rejects stale editor saves and invalid Liquid without overwriting either half', async () => {
    await database.setPackTemplateContent('custom', 'test', 'newer system', false)
    await database.setPackTemplateContent('custom', 'test-user', 'newer user', false)
    const next = { system: 'overwrite', user: 'overwrite' }
    await expect(
      packService.saveTemplatePair('custom', 'test', next, {
        system: 'outdated',
        user: 'outdated',
      }),
    ).rejects.toThrow('重新加载')
    await expect(
      packService.saveTemplatePair(
        'custom',
        'test',
        { system: 'valid', user: '{% if broken %}' },
        { system: 'newer system', user: 'newer user' },
      ),
    ).rejects.toThrow()
    expect(rows.get('custom:test')?.content).toBe('newer system')
    expect(rows.get('custom:test-user')?.content).toBe('newer user')
  })

  it('preserves custom legacy stories while refreshing untouched built-in collaborative baselines', async () => {
    await database.setPackTemplateContent('custom', 'novel-scene', 'old story prompt', true)
    await database.setPackTemplateContent('custom', 'novel-scene-user', 'old user', true)
    await database.setPackTemplateContent(
      'default-pack',
      'collaborative-plot-suggestions',
      'old suggestions',
      true,
    )
    await packService.initialize()
    expect(rows.get('custom:novel-scene')?.content).toBe('old story prompt')
    expect(rows.has('custom:collaborative-scene-director')).toBe(false)
    expect(rows.get('default-pack:collaborative-plot-suggestions')?.content).toBe(
      PROMPT_TEMPLATES.find((template) => template.id === 'collaborative-plot-suggestions')!
        .content,
    )
  })

  it('does not send baseline source metadata to the model', async () => {
    const template = PROMPT_TEMPLATES.find((t) => t.id === 'collaborative-chinese-writer')!
    const inspected = await new ContextBuilder('missing')
      .add({ novelAgentContext: 'stop at decision' })
      .inspectTemplate(template.id)
    expect(inspected.systemResolution?.baseline?.metadata).toBeDefined()
    expect(inspected.user).toContain('stop at decision')
    expect(inspected.system).not.toContain('sourceEntry')
    expect(inspected.user).not.toContain('sourceEntry')
  })
})
