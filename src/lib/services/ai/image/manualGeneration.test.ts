import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageGenerationContext } from '../index'
import type { StoryEntry } from '$lib/types'
import { imageContentVersion } from '$lib/services/image/imageScope'

const mocks = vi.hoisted(() => ({
  issue: null as string | null,
  story: {
    id: 'story',
    currentBranchId: null,
    settings: { imageGenerationMode: 'manual', backgroundImagesEnabled: false },
  },
  entry: { id: 'entry', storyId: 'story', content: '她推开了雨中的铁门。', metadata: null } as any,
  rows: [] as any[],
  identify: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
  analyzeBackground: vi.fn(),
  generateBackground: vi.fn(),
}))
vi.mock('$lib/stores/settings.svelte', () => ({ settings: {} }))
vi.mock('$lib/stores/debug.svelte', () => ({
  debug: { addDebugRequest: vi.fn(), addDebugResponse: vi.fn() },
}))
vi.mock('$lib/services/database', () => ({
  database: {
    getStory: vi.fn(async () => mocks.story),
    getStoryEntry: vi.fn(async () => mocks.entry),
    getEmbeddedImagesForEntry: vi.fn(async () => mocks.rows),
    createEmbeddedImage: mocks.create,
    deleteEmbeddedImage: vi.fn(),
  },
}))
vi.mock('../core/factory', () => ({
  serviceFactory: {
    createNarrativeService: () => ({}),
    createImageAnalysisService: () => ({ identifyScenes: mocks.identify }),
    createBackgroundImageService: () => ({
      analyzeResponsesForBackgroundImage: mocks.analyzeBackground,
      generateBackgroundImage: mocks.generateBackground,
    }),
  },
}))
vi.mock('./analysisConfig', () => ({ getImageAnalysisConfigurationIssue: () => null }))
vi.mock('./imageUtils', () => ({ getImageConfigurationIssue: () => mocks.issue }))
vi.mock('./index', () => ({
  inlineImageService: { processNarrativeForInlineImages: vi.fn(async () => 1) },
  isImageGenerationEnabled: () => true,
  resolveStylePrompt: vi.fn(async () => 'watercolor'),
  runImageGeneration: mocks.run,
}))
const { aiService } = await import('../index')
const scene = (sourceText = '她推开了雨中的铁门。') => ({
  sourceText,
  prompt: 'A woman opens an iron door in rain',
  characters: [],
  priority: 9,
  generatePortrait: false,
  sceneType: 'scene',
})
const context = (): ImageGenerationContext => ({
  storyId: 'story',
  entryId: 'entry',
  narrativeResponse: mocks.entry.content,
  userAction: '继续',
  presentCharacters: [],
  referenceMode: false,
  imageGenerationMode: 'manual',
  trigger: 'manual',
  contentVersion: imageContentVersion(mocks.entry as StoryEntry),
  canContinue: () => true,
  imageSettings: {
    profileId: 'image',
    styleId: 'style',
    maxImagesPerMessage: 3,
    size: { width: 512, height: 512 },
  } as any,
  getImageProfile: () => ({ id: 'image', model: 'image-model' }) as any,
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.issue = null
  mocks.story.settings = { imageGenerationMode: 'manual', backgroundImagesEnabled: false }
  mocks.entry.content = '她推开了雨中的铁门。'
  mocks.rows = []
  mocks.identify.mockResolvedValue([scene(), scene('第二个画面')])
  mocks.create.mockImplementation(async (image) => {
    mocks.rows.push(image)
    return image
  })
  mocks.run.mockResolvedValue(null)
})
describe('manual Chinese illustrations', () => {
  it('never analyzes a manual story from an automatic call', async () => {
    expect(
      (await aiService.generateImagesForNarrative({ ...context(), trigger: undefined })).status,
    ).toBe('disabled')
    expect(mocks.identify).not.toHaveBeenCalled()
  })
  it('checks configuration before calling an Agent', async () => {
    mocks.issue = '普通图片配置缺少模型'
    expect(await aiService.generateImagesForNarrative(context())).toMatchObject({
      status: 'not-configured',
      message: mocks.issue,
    })
    expect(mocks.identify).not.toHaveBeenCalled()
  })
  it('requests and enforces one picture even when the analyzer returns multiple scenes', async () => {
    const input = context()
    expect(await aiService.generateImagesForNarrative(input)).toMatchObject({
      status: 'queued',
      queued: 1,
    })
    expect(mocks.identify).toHaveBeenCalledWith(
      expect.objectContaining({ maxImages: 1, manual: true }),
    )
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.rows[0].contentVersion).toBe(input.contentVersion)
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ notifyFailure: true }))
    expect(input.imageSettings?.maxImagesPerMessage).toBe(3)
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('busy')
  })
  it.each(['switch', 'disable', 'edit'])(
    'does not queue after %s while analysis is running',
    async (change) => {
      let current = true
      const input = { ...context(), canContinue: () => current }
      mocks.identify.mockImplementation(async () => {
        if (change === 'switch') current = false
        if (change === 'disable') mocks.story.settings.imageGenerationMode = 'none'
        if (change === 'edit') mocks.entry.content = '这是另一版正文。'
        return [scene()]
      })
      expect((await aiService.generateImagesForNarrative(input)).status).toBe('disabled')
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.run).not.toHaveBeenCalled()
    },
  )
  it('distinguishes analysis errors from no suitable scenes, with a retry available', async () => {
    mocks.identify.mockRejectedValueOnce(new Error('network'))
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('failed')
    mocks.identify.mockResolvedValueOnce([])
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('no-scenes')
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('queued')
  })
  it('does not allow duplicate requests during analysis', async () => {
    let finish!: (value: any[]) => void
    mocks.identify.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = aiService.generateImagesForNarrative(context())
    await vi.waitFor(() => expect(mocks.identify).toHaveBeenCalledOnce())
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('busy')
    finish([scene()])
    expect((await first).status).toBe('queued')
  })
  it('does not draw a blank prompt or a scene without a quote in the requested prose', async () => {
    mocks.identify.mockResolvedValueOnce([
      { ...scene(), prompt: '  ' },
      scene('后续正文才有的画面'),
    ])
    expect((await aiService.generateImagesForNarrative(context())).status).toBe('no-scenes')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('preserves adventure multi-image behavior', async () => {
    expect(
      await aiService.generateImagesForNarrative({
        ...context(),
        imageGenerationMode: 'agentic',
        trigger: undefined,
      }),
    ).toMatchObject({ status: 'queued', queued: 2 })
    expect(mocks.identify).toHaveBeenCalledWith(
      expect.objectContaining({ maxImages: 3, manual: false }),
    )
  })
  it('does not analyze a disabled background and rechecks after analysis', async () => {
    const update = vi.fn()
    await aiService.analyzeBackgroundChangeAndGenerateImage('story', [], update)
    expect(mocks.analyzeBackground).not.toHaveBeenCalled()
    mocks.story.settings.backgroundImagesEnabled = true
    mocks.analyzeBackground.mockImplementation(async () => {
      mocks.story.settings.backgroundImagesEnabled = false
      return { changeNecessary: true, prompt: 'rain' }
    })
    await aiService.analyzeBackgroundChangeAndGenerateImage('story', [], update)
    expect(mocks.generateBackground).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
