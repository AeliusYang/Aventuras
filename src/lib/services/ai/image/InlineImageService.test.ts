import { beforeEach, describe, expect, it, vi } from 'vitest'
import { imageContentVersion } from '$lib/services/image/imageScope'

const mocks = vi.hoisted(() => ({
  entry: {
    id: 'entry',
    storyId: 'story',
    content: '原始正文',
    metadata: { variantSet: { variants: [{}, {}] } },
  },
  sources: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
}))
vi.mock('$lib/services/database', () => ({
  database: {
    getStoryEntry: async () => mocks.entry,
    getEmbeddedImageSourceTextsForEntry: mocks.sources,
    createEmbeddedImage: mocks.create,
  },
}))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    systemServicesSettings: {
      imageGeneration: {
        profileId: 'p',
        styleId: 'style',
        size: { width: 512, height: 512 },
        maxImagesPerMessage: 3,
      },
    },
    getImageProfile: () => ({ model: 'image-model' }),
  },
}))
vi.mock('./stylePrompt', () => ({ resolveStylePrompt: async () => 'watercolor' }))
vi.mock('./imageUtils', () => ({ runImageGeneration: mocks.run }))
vi.mock('$lib/services/events', () => ({ emitImageQueued: vi.fn() }))
import { inlineImageService } from './InlineImageService'

const tag = '<pic prompt="a lantern hanging outside the railway station"></pic>'
const context = () => ({
  storyId: 'story',
  entryId: 'entry',
  narrativeContent: `Translated text ${tag}`,
  contentVersion: imageContentVersion(mocks.entry),
  presentCharacters: [],
  referenceMode: false,
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.sources.mockResolvedValue([])
  mocks.run.mockResolvedValue(null)
})
describe('inline image prose versions', () => {
  it('retains the original prose version when generating from translated text', async () => {
    expect(await inlineImageService.processNarrativeForInlineImages(context())).toBe(1)
    expect(mocks.sources).toHaveBeenCalledWith('entry', imageContentVersion(mocks.entry), false)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contentVersion: imageContentVersion(mocks.entry),
        sourceText: tag,
      }),
    )
  })
  it('does not generate after the prose version changes', async () => {
    expect(
      await inlineImageService.processNarrativeForInlineImages({
        ...context(),
        contentVersion: 'old-version',
      }),
    ).toBe(0)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('still deduplicates tags already generated for this version', async () => {
    mocks.sources.mockResolvedValue([tag])
    expect(await inlineImageService.processNarrativeForInlineImages(context())).toBe(0)
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
