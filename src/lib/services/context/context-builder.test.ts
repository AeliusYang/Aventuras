import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextBuilder } from './context-builder'

vi.mock('$lib/services/database', () => ({
  database: {
    getStory: vi.fn(),
    getBranch: vi.fn(),
    getCharactersResolved: vi.fn(),
    getStoryPackId: vi.fn(),
    getCharacters: vi.fn(),
    getLocations: vi.fn(),
    getItems: vi.fn(),
    getStoryBeats: vi.fn(),
    getStoryCustomVariables: vi.fn(),
    getPackVariables: vi.fn(),
    getRuntimeVariables: vi.fn(),
    getPackTemplate: vi.fn(),
  },
}))

import { database } from '$lib/services/database'
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: { experimentalFeatures: { lightweightBranches: true } },
}))

describe('ContextBuilder', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('accumulates variables via add() and supports method chaining', () => {
    const builder = new ContextBuilder()
    builder.add({ mode: 'adventure' }).add({ pov: 'second', tense: 'present' })

    const ctx = builder.getContext()
    expect(ctx.mode).toBe('adventure')
    expect(ctx.pov).toBe('second')
    expect(ctx.tense).toBe('present')
  })

  it('returns a copy of context in getContext()', () => {
    const builder = new ContextBuilder()
    builder.add({ key: 'value' })
    const copy = builder.getContext()
    copy.key = 'modified'

    expect(builder.getContext().key).toBe('value')
  })

  it('resolves fallback code baseline when pack template is missing', async () => {
    vi.mocked(database.getPackTemplate).mockResolvedValue(null)

    const builder = new ContextBuilder('test-pack')
    const res = await builder.render('main-narrative')

    expect(res).toBeDefined()
    expect(typeof res.system).toBe('string')
    expect(typeof res.user).toBe('string')
  })

  it('reports the actual template precedence for inspection', async () => {
    vi.mocked(database.getPackTemplate)
      .mockResolvedValueOnce({ templateId: 'novel-plan', content: 'custom' } as any)
      .mockResolvedValueOnce(null)

    const resolved = await new ContextBuilder('story-pack').resolveTemplateWithSource('novel-plan')

    expect(resolved).toMatchObject({
      content: 'custom',
      source: 'story-pack',
      packId: 'story-pack',
      templateId: 'novel-plan',
    })
  })

  it('inspects system and user prompt sources without invoking an AI service', async () => {
    vi.mocked(database.getPackTemplate).mockImplementation(async (packId, templateId) => {
      if (packId === 'default-pack' && templateId === 'novel-plan')
        return { content: 'system' } as any
      if (packId === 'story-pack' && templateId === 'novel-plan-user')
        return { content: 'user' } as any
      return null
    })

    const inspected = await new ContextBuilder('story-pack').inspectTemplate('novel-plan')

    expect(inspected).toMatchObject({
      system: 'system',
      user: 'user',
      systemSource: 'default-pack',
      userSource: 'story-pack',
      source: 'mixed',
    })
  })

  it('keeps legacy pack edits ahead of canonical default templates', async () => {
    vi.mocked(database.getPackTemplate).mockImplementation(async (packId, templateId) => {
      if (packId === 'old-pack' && templateId === 'novel-scene')
        return { content: 'old {{ protagonistName }}' } as any
      if (packId === 'old-pack' && templateId === 'novel-scene-user')
        return { content: '{{ planningInput }}' } as any
      if (packId === 'default-pack') return { content: 'new baseline' } as any
      return null
    })
    const builder = new ContextBuilder('old-pack').add({
      protagonistName: 'Lin',
      planningInput: 'Continue',
    })
    const inspected = await builder.inspectTemplate('collaborative-scene-director')
    expect(inspected.systemResolution?.templateId).toBe('novel-scene')
    expect(inspected.systemTemplate).toBe('old {{ protagonistName }}')
    vi.mocked(database.getPackTemplate).mockClear()
    expect(await builder.render('collaborative-scene-director')).toMatchObject({
      system: inspected.system,
      user: inspected.user,
      templateId: 'collaborative-scene-director',
      packId: 'old-pack',
      systemSource: 'story-pack',
      userSource: 'story-pack',
      systemTemplateId: 'novel-scene',
      userTemplateId: 'novel-scene-user',
      systemPackId: 'old-pack',
      userPackId: 'old-pack',
      userTemplateState: 'present',
    })
    expect(database.getPackTemplate).toHaveBeenCalledTimes(4)
    expect(inspected.system).toBe('old Lin')
    expect(inspected.user).toBe('Continue')
  })

  it('preserves intentionally blank active pack content and flags missing preview variables', async () => {
    vi.mocked(database.getPackTemplate).mockImplementation(async (packId, id) => {
      if (packId === 'pack')
        return { content: id.endsWith('-user') ? '{{ novelAgentContext }}' : '' } as any
      return { content: 'do not use' } as any
    })
    const inspected = await new ContextBuilder('pack').inspectTemplate(
      'collaborative-chinese-writer',
    )
    expect(inspected.system).toBe('')
    expect(inspected.missingVariables).toContain('novelAgentContext')
    expect(inspected.source).toBe('story-pack')
  })

  it('does not mix a new user baseline into a legacy system-only Writer', async () => {
    vi.mocked(database.getPackTemplate).mockImplementation(async (pack, id) => {
      if (pack === 'old' && id === 'collaborative-novel') return { content: 'old writer' } as any
      if (pack === 'default-pack' && id === 'collaborative-chinese-writer-user')
        return { content: 'new user' } as any
      return null
    })
    const inspected = await new ContextBuilder('old').inspectTemplate(
      'collaborative-chinese-writer',
    )
    expect(inspected.system).toBe('old writer')
    expect(inspected.userResolution).toBeNull()
    expect(inspected.user).toBe('')
    expect(await new ContextBuilder('old').render('collaborative-chinese-writer')).toMatchObject({
      systemTemplateId: 'collaborative-novel',
      userTemplateId: null,
      userSource: null,
      userTemplateState: 'missing',
    })
  })

  it('pre-populates context for a story via forStory factory', async () => {
    vi.mocked(database.getStory).mockResolvedValue({
      id: 'story-1',
      mode: 'adventure',
      genre: 'Fantasy',
      description: 'An epic quest.',
      settings: { pov: 'second', tense: 'present', tone: 'dark' },
    } as any)

    vi.mocked(database.getStoryPackId).mockResolvedValue('default-pack')
    vi.mocked(database.getCharacters).mockResolvedValue([
      { id: 'c1', name: 'Hero', relationship: 'self', description: 'Brave hero' },
    ] as any)
    vi.mocked(database.getLocations).mockResolvedValue([
      { id: 'l1', name: 'Oakvale', current: true },
    ] as any)
    vi.mocked(database.getItems).mockResolvedValue([])
    vi.mocked(database.getStoryBeats).mockResolvedValue([])
    vi.mocked(database.getPackVariables).mockResolvedValue([])
    vi.mocked(database.getRuntimeVariables).mockResolvedValue([])

    const builder = await ContextBuilder.forStory('story-1')
    const ctx = builder.getContext()

    expect(ctx.mode).toBe('adventure')
    expect(ctx.pov).toBe('second')
    expect(ctx.protagonistName).toBe('Hero')
    expect(ctx.currentLocation).toBe('Oakvale')

    vi.mocked(database.getStory).mockResolvedValue({
      id: 'story-1',
      mode: 'creative-writing',
      settings: { collaborativeNovelWorkflow: {} },
    } as any)
    expect((await ContextBuilder.forStory('story-1')).getContext().pov).toBe('third')

    vi.mocked(database.getStory).mockResolvedValue({
      id: 'story-1',
      mode: 'creative-writing',
      settings: { pov: 'second', collaborativeNovelWorkflow: {} },
    } as any)
    expect((await ContextBuilder.forStory('story-1')).getContext().pov).toBe('second')
  })

  it('preserves all saved character fields in generation and Inspector without custom-variable overrides', async () => {
    vi.mocked(database.getStory).mockResolvedValue({
      id: 'cards',
      mode: 'creative-writing',
      settings: { collaborativeNovelWorkflow: {} },
    } as any)
    vi.mocked(database.getStoryPackId).mockResolvedValue('pack')
    vi.mocked(database.getCharacters).mockResolvedValue([
      {
        id: 'hero',
        name: 'Hero',
        description: 'Current edited description',
        relationship: 'self',
        traits: ['Patient'],
        metadata: {
          characterCard: {
            description: 'Old description',
            personality: 'Reserved personality',
            scenario: 'Original scenario',
            examples: 'Example dialogue {{ user }}',
            history: 'Established history',
            system_prompt: 'DO NOT INJECT',
          },
        },
      },
      {
        id: 'npc',
        name: 'NPC',
        description: 'NPC description',
        traits: ['Wary'],
        metadata: { background: 'NPC background' },
      },
      { id: 'other', name: 'Sibling secret', branchId: 'sibling', description: 'Do not leak' },
      { id: 'deleted', name: 'Deleted', deleted: true },
    ] as any)
    vi.mocked(database.getLocations).mockResolvedValue([])
    vi.mocked(database.getItems).mockResolvedValue([])
    vi.mocked(database.getStoryBeats).mockResolvedValue([])
    vi.mocked(database.getRuntimeVariables).mockResolvedValue([])
    vi.mocked(database.getPackVariables).mockResolvedValue([
      { variableName: 'novelCharacterContext', defaultValue: 'pack override' },
    ] as any)
    vi.mocked(database.getStoryCustomVariables).mockResolvedValue({
      novelCharacterContext: 'story override',
    })
    vi.mocked(database.getPackTemplate).mockImplementation(
      async (_, id) =>
        ({ content: id.endsWith('-user') ? '{{ novelCharacterContext }}' : 'Writer' }) as any,
    )
    const builder = await ContextBuilder.forStory('cards', undefined, false)
    builder.add({
      tieredContextBlock: 'Existing world facts',
      chapterSummaries: 'Existing chapter facts',
    })
    const rendered = await builder.render('collaborative-chinese-writer')
    for (const value of [
      'Current edited description',
      'Reserved personality',
      'Original scenario',
      'Example dialogue {{ user }}',
      'Established history',
      'NPC description',
      'Wary',
      'NPC background',
    ])
      expect(rendered.user).toContain(value)
    for (const value of [
      'Old description',
      'Sibling secret',
      'Deleted',
      'DO NOT INJECT',
      'pack override',
      'story override',
    ])
      expect(rendered.user).not.toContain(value)
    expect(rendered.user).toContain('missingFields')
    expect(builder.getContext().tieredContextBlock).toBe('Existing world facts')
    expect(database.getStoryPackId).not.toHaveBeenCalled()
    expect(database.getStoryCustomVariables).not.toHaveBeenCalled()
    expect(database.getPackVariables).not.toHaveBeenCalled()
    expect(builder.getContext().novelCharacterContext).toContain('Current edited description')
  })

  it('uses COW resolved characters instead of sibling branch copies', async () => {
    vi.mocked(database.getStory).mockResolvedValue({
      id: 'cow',
      currentBranchId: 'child',
      mode: 'creative-writing',
      settings: { collaborativeNovelWorkflow: {} },
    } as any)
    vi.mocked(database.getCharacters).mockResolvedValue([
      { name: 'Sibling leak', branchId: 'other' },
    ] as any)
    vi.mocked(database.getBranch).mockImplementation(
      async (id) =>
        ({ id, storyId: 'cow', parentBranchId: id === 'child' ? 'parent' : null }) as any,
    )
    vi.mocked(database.getCharactersResolved).mockResolvedValue([
      { name: 'Inherited NPC', traits: [], metadata: null },
    ] as any)
    vi.mocked(database.getLocations).mockResolvedValue([])
    vi.mocked(database.getItems).mockResolvedValue([])
    vi.mocked(database.getStoryBeats).mockResolvedValue([])
    vi.mocked(database.getRuntimeVariables).mockResolvedValue([])
    vi.mocked(database.getPackVariables).mockResolvedValue([])
    const builder = await ContextBuilder.forStory('cow')
    expect(database.getCharactersResolved).toHaveBeenCalledWith('cow', [
      expect.objectContaining({ id: 'parent' }),
      expect.objectContaining({ id: 'child' }),
    ])
    expect(builder.getContext().novelCharacterContext).toContain('Inherited NPC')
    expect(builder.getContext().novelCharacterContext).not.toContain('Sibling leak')
  })
})
