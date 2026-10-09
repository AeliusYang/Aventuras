import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageEvidenceInput } from '$lib/services/image/generationContext'
import { preparePortraitRequest } from './portraitRequest'
import { ImageAnalysisService } from './ImageAnalysisService'
import type { ImagePromptDiagnostic } from '$lib/services/image/diagnostics'

const mock = vi.hoisted(() => ({
  generate: vi.fn(),
  imageIssue: null as string | null,
  templates: new Map<string, string>(),
  preset: { id: 'analysis', model: 'text-model', profileId: 'text', temperature: 0.3 },
  profile: {
    id: 'text',
    name: '分析连接',
    providerType: 'openai-compatible',
    apiKey: 'mock',
    baseUrl: 'http://invalid.test',
  },
}))
vi.mock('$lib/services/database', () => ({
  database: {
    getStoryPackId: async () => 'custom',
    getStoryCustomVariables: async () => ({}),
    getPackVariables: async () => [],
    getRuntimeVariables: async () => [],
    getPackTemplate: async (pack: string, id: string) =>
      mock.templates.has(id)
        ? { packId: pack, templateId: id, content: mock.templates.get(id) }
        : null,
  },
}))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    get generationPresets() {
      return [mock.preset]
    },
    getServicePresetId: () => 'analysis',
    getPresetConfig: () => mock.preset,
    getProfile: () => mock.profile,
    apiSettings: { mainNarrativeProfileId: 'text' },
    systemServicesSettings: {
      imageGeneration: {
        portraitStyleId: 'style',
        portraitProfileId: 'portrait',
        portraitSize: { width: 512, height: 768 },
      },
    },
    getImageProfile: () => ({ id: 'portrait', name: '肖像连接', model: 'portrait-model' }),
  },
}))
vi.mock('$lib/services/ai/sdk/generate', () => ({ generateStructured: mock.generate }))
vi.mock('./imageUtils', () => ({ getImageConfigurationIssue: () => mock.imageIssue }))
vi.mock('./stylePrompt', () => ({ resolveStylePrompt: async () => 'STYLE_EXACTLY_ONCE' }))
const input = (): ImageEvidenceInput => ({
  story: {
    id: 's',
    mode: 'creative-writing',
    currentBranchId: 'b',
    settings: { pov: 'third' },
  } as any,
  characterId: 'c',
  characters: [
    {
      id: 'c',
      storyId: 's',
      name: '林岚',
      description: '学生',
      traits: [],
      visualDescriptors: {},
      metadata: { characterCard: { personality: '谨慎' } },
    } as any,
  ],
  entries: [],
  lore: [
    {
      id: 'l',
      storyId: 's',
      name: '林岚',
      type: 'character',
      description: '银发金眸，古代制服',
      aliases: [],
      injection: { mode: 'keyword', keywords: [], priority: 1 },
    } as any,
  ],
  edits: { name: '林岚', description: '用户编辑成年', visualDescriptors: '', traits: '' },
})
const options = () => ({ canContinue: () => true, onDiagnostic: vi.fn() })
beforeEach(() => {
  vi.clearAllMocks()
  mock.templates.clear()
  mock.imageIssue = null
  mock.preset.model = 'text-model'
  mock.generate.mockResolvedValue({
    visualDescription: 'silver hair, golden eyes, ancient uniform, alert expression',
    inferredDetails: ['袖口纹样'],
  })
})

describe('portrait preparation using the existing pack and analysis binding', () => {
  it('sends all evidence in one text call, then renders a full-body prompt without persisting facts', async () => {
    const opts = options()
    const result = await preparePortraitRequest(input(), opts)
    expect(mock.generate).toHaveBeenCalledOnce()
    const [request, template] = mock.generate.mock.calls[0]
    expect(template).toBe('image-portrait-preparation')
    expect(request.presetId).toBe('analysis')
    for (const text of ['银发金眸', '学生', '谨慎', '用户编辑成年', 'creative-writing'])
      expect(request.prompt).toContain(text)
    expect(request.system).toContain('不是新故事事实')
    expect(result.prompt).toContain('Full body')
    expect(result.prompt).toContain('silver hair')
    expect(result.prompt.match(/STYLE_EXACTLY_ONCE/g)).toHaveLength(1)
    expect(result.diagnostic.inferredDetails).toEqual(['袖口纹样'])
    expect(result.diagnostic.imageModel).toBe('portrait-model')
  })
  it('reuses the prepared prompt on image retry, but re-prepares edited evidence or templates', async () => {
    const data = input()
    const first = await preparePortraitRequest(data, options())
    expect(await preparePortraitRequest(data, { ...options(), previous: first })).toBe(first)
    expect(mock.generate).toHaveBeenCalledOnce()
    data.edits!.description += '，黑色制服'
    const second = await preparePortraitRequest(data, { ...options(), previous: first })
    expect(mock.generate).toHaveBeenCalledTimes(2)
    mock.templates.set(
      'image-portrait-generation',
      'MY CUSTOM {{ visualDescriptors }} {{ imageStylePrompt }}',
    )
    const third = await preparePortraitRequest(data, { ...options(), previous: second })
    expect(third.prompt).toContain('MY CUSTOM')
    expect(mock.templates.get('image-portrait-generation')).toContain('MY CUSTOM')
    expect(mock.generate).toHaveBeenCalledTimes(3)
  })
  it('refuses missing image/text configuration, name-only evidence, and a stale scope before the model', async () => {
    mock.imageIssue = '缺少肖像配置'
    await expect(preparePortraitRequest(input(), options())).rejects.toThrow('缺少肖像配置')
    mock.imageIssue = null
    mock.preset.model = ''
    await expect(preparePortraitRequest(input(), options())).rejects.toThrow('文本模型')
    mock.preset.model = 'text-model'
    await expect(
      preparePortraitRequest(input(), { ...options(), canContinue: () => false }),
    ).rejects.toThrow('故事已变化')
    expect(mock.generate).not.toHaveBeenCalled()
  })
  it('surfaces preparation failure with the actual sent prompt still inspectable', async () => {
    mock.generate.mockRejectedValueOnce(new Error('offline'))
    const opts = options()
    await expect(preparePortraitRequest(input(), opts)).rejects.toThrow('offline')
    expect(opts.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'image-portrait-preparation', model: 'text-model' }),
    )
  })
  it('rejects the prepared result if the editor changes while the text model is running', async () => {
    let current = true
    mock.generate.mockImplementationOnce(async () => {
      current = false
      return { visualDescription: 'old scope', inferredDetails: [] }
    })
    await expect(
      preparePortraitRequest(input(), { ...options(), canContinue: () => current }),
    ).rejects.toThrow('故事已变化')
  })
  it('adds manual scene evidence once, uses one analysis call and reports visual invention', async () => {
    mock.generate.mockResolvedValueOnce({ scenes: [], inferredDetails: ['环境光'] })
    const evidence = {
      storyId: 's',
      branchId: 'b',
      sources: [],
      missing: [],
      context: 'UNIQUE_FULL_LORE',
      characters: [],
    }
    const onDiagnostic = vi.fn<(value: ImagePromptDiagnostic) => void>()
    await new ImageAnalysisService('imageGeneration').identifyScenes({
      storyId: 's',
      narrativeResponse: '林岚推开门。',
      userAction: '',
      presentCharacters: [],
      charactersWithPortraits: [],
      charactersWithoutPortraits: [],
      referenceMode: false,
      maxImages: 1,
      manual: true,
      evidence,
      stylePrompt: 'STYLE_EXACTLY_ONCE',
      onDiagnostic,
    })
    expect(mock.generate).toHaveBeenCalledOnce()
    expect(mock.generate.mock.calls[0][0].prompt.match(/UNIQUE_FULL_LORE/g)).toHaveLength(1)
    expect(onDiagnostic.mock.lastCall?.[0].inferredDetails).toEqual(['环境光'])
  })
})
