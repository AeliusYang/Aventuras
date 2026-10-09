/**
 * Image Generation Utilities
 *
 * Helper functions for image generation using the standalone provider registry.
 */

import { generateImage, supportsImageGeneration, requiresApiKey } from './providers/registry'
import { imageMatchesEntry } from '$lib/services/image/imageScope'
import { database } from '$lib/services/database'
import { settings } from '$lib/stores/settings.svelte'
import type { EmbeddedImage, StorySettings } from '$lib/types'
import { emitImageQueued, emitImageReady, emitImageAnalysisFailed } from '$lib/services/events'
import { createLogger } from '$lib/log'
import { expectedPixels, defaultImageSpec, type ImageSpec } from '$lib/utils/image'

const log = createLogger('ImageUtils')

export type ImageProfileSlot = 'standard' | 'background' | 'portrait' | 'reference'

const SLOT_PROFILE_KEYS = {
  standard: 'profileId',
  background: 'backgroundProfileId',
  portrait: 'portraitProfileId',
  reference: 'referenceProfileId',
} as const satisfies Record<ImageProfileSlot, string>

/**
 * Each slot answers for itself: an unset slot profile means unconfigured, never a reason to
 * spend the standard one. The settings UI and the generation paths read this same value, and
 * they have to agree — a slot the UI offers and generation then refuses fails in silence.
 */
function slotProfileId(slot: ImageProfileSlot): string | null {
  return settings.systemServicesSettings.imageGeneration?.[SLOT_PROFILE_KEYS[slot]] ?? null
}

/**
 * Check if image generation is enabled and has valid configuration.
 * Now checks Image Profiles instead of API Profiles.
 */
export function isImageGenerationEnabled(
  storySettings?: StorySettings,
  type: ImageProfileSlot = 'standard',
): boolean {
  if (storySettings) {
    if (type !== 'background' && storySettings.imageGenerationMode === 'none') return false
  }

  const profileId = slotProfileId(type)
  if (!profileId) return false

  const profile = settings.getImageProfile(profileId)
  if (!profile) return false

  return supportsImageGeneration(profile.providerType)
}

/**
 * Check if required credentials are configured for a given image slot.
 */
export function hasRequiredCredentials(slot: ImageProfileSlot = 'standard'): boolean {
  return getImageConfigurationIssue(slot) === null
}

/** Shared validation for controls and calls. A slot never borrows another slot's profile. */
export function getImageConfigurationIssue(slot: ImageProfileSlot = 'standard'): string | null {
  const label = {
    standard: '故事插图',
    background: '背景图片',
    portrait: '角色肖像',
    reference: '参考图',
  }[slot]
  const profileId = slotProfileId(slot)
  if (!profileId) return `尚未选择${label}配置。`

  const profile = settings.getImageProfile(profileId)
  if (!profile) return `${label}配置已不存在，请重新选择。`

  if (!supportsImageGeneration(profile.providerType)) return `${label}服务不支持生图。`
  if (!profile.model?.trim()) return `${label}配置尚未选择模型。`

  return requiresApiKey(profile.providerType) && !profile.apiKey?.trim()
    ? `${label}配置缺少 API 密钥。`
    : null
}

/**
 * Get display name for the currently configured image generation provider.
 */
export function getProviderDisplayName(): string {
  const imageSettings = settings.systemServicesSettings.imageGeneration
  const profileId = imageSettings?.profileId
  if (!profileId) return 'No provider'

  const profile = settings.getImageProfile(profileId)
  if (!profile) return 'Unknown'

  const names: Record<string, string> = {
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    nanogpt: 'NanoGPT',
    chutes: 'Chutes',
    pollinations: 'Pollinations.ai',
    google: 'Google',
    zhipu: 'Zhipu',
    comfyui: 'ComfyUI',
  }

  return names[profile.providerType] || profile.providerType
}

/**
 * Write a finished generation onto its record.
 *
 * `ImageReady` goes out in a `finally`: it balances the `ImageQueued` the caller emitted
 * when it scheduled the work, and the header's in-flight count has to come back down even
 * when recording the outcome is itself what failed.
 */
export async function recordImageResult(
  imageId: string,
  entryId: string,
  result: { base64: string | null; error?: string },
): Promise<void> {
  try {
    if (result.base64) {
      await database.updateEmbeddedImage(imageId, {
        imageData: result.base64,
        status: 'complete',
      })
    } else {
      await database.updateEmbeddedImage(imageId, {
        status: 'failed',
        errorMessage: result.error ?? 'Image generation failed',
      })
    }
  } catch (error) {
    log('Failed to record image result', { imageId, error })
  } finally {
    emitImageReady(imageId, entryId, !!result.base64)
  }
}

export interface ImageGenerationRequest {
  imageId: string
  entryId: string
  prompt: string
  profileId: string
  model: string
  size: ImageSpec
  referenceImages?: string[]
  /** Raise a user-facing failure notice for explicit generation and retry requests. */
  notifyFailure?: boolean
  /** Written with the flip to `generating`, so a caller resetting the row for a fresh
   *  attempt spends one round trip and not two. */
  recordUpdates?: Partial<EmbeddedImage>
}

/**
 * Run one generation against an existing record and record what came back.
 *
 * Returns the base64 payload so a caller with a further use for it — saving a portrait
 * onto its character — does not have to read the row back.
 */
export async function runImageGeneration(request: ImageGenerationRequest): Promise<string | null> {
  const { imageId, entryId, prompt, profileId, model, size, referenceImages } = request

  let base64: string | null = null
  let failure: string | undefined

  // Its own try: a failed status flip is a database problem, not a generation failure, and
  // reporting it as one raises a user-facing notice for the wrong thing. The generation goes
  // ahead regardless — `recordImageResult` writes the terminal status either way.
  try {
    await database.updateEmbeddedImage(imageId, {
      ...request.recordUpdates,
      status: 'generating',
    })
  } catch (error) {
    log('Failed to mark the image generating', { imageId, error })
  }

  try {
    log('Generating image', { imageId, profileId, model, hasReference: !!referenceImages?.length })
    const result = await generateImage({ profileId, model, prompt, size, referenceImages })

    if (!result.base64) throw new Error('No image data returned')
    base64 = result.base64
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Unknown error'
    log('Image generation failed', { imageId, error: failure })
  }

  await recordImageResult(imageId, entryId, { base64, error: failure })

  if (failure && request.notifyFailure) {
    emitImageAnalysisFailed(entryId, `插图生成失败，可在图片旁重试：${failure}`)
  }

  return base64
}

/**
 * Retry a failed or stuck image, as a regular scene image at the current settings.
 *
 * Deliberately regular, whatever the row was generated as. An img2img reference cannot be
 * reproduced at all — the references are the portraits of the characters the analysis
 * named, and that list is not kept on the row — and a portrait is not worth reproducing:
 * a retry only rewrites the row, never `characters.portrait`, so the entry gets a picture
 * and the character keeps the one it has.
 */
export async function retryImageGeneration(imageId: string, prompt: string): Promise<void> {
  const issue = getImageConfigurationIssue()
  if (issue) throw new Error(issue)

  const image = await database.getEmbeddedImage(imageId)
  if (!image) {
    log('Cannot retry - image not found', { imageId })
    return
  }
  const [sourceStory, entry] = await Promise.all([
    database.getStory(image.storyId),
    database.getStoryEntry(image.entryId),
  ])
  if (
    !sourceStory ||
    sourceStory.settings?.imageGenerationMode === 'none' ||
    (sourceStory.mode === 'creative-writing' &&
      sourceStory.settings?.imageGenerationMode !== 'manual')
  )
    throw new Error('请先在故事设置中启用插图。')
  if (!entry || !imageMatchesEntry(image, entry))
    throw new Error('这张插图属于另一版正文，请先切回对应版本。')

  const imageSettings = settings.systemServicesSettings.imageGeneration
  const profileId = imageSettings.profileId

  if (!profileId) {
    log('Cannot retry - no profile configured')
    return
  }

  const profile = settings.getImageProfile(profileId)
  const model = profile?.model ?? ''
  const size = imageSettings.size
  const { width, height } = expectedPixels(size)

  log('Retrying image generation', { imageId, profileId, model, size })

  // `runImageGeneration` emits `ImageReady`, which decrements the header's in-flight count —
  // so the retry has to announce itself, or it spends another image's increment and the
  // indicator disappears while that one is still generating.
  emitImageQueued(imageId, image.entryId)

  await runImageGeneration({
    imageId,
    entryId: image.entryId,
    prompt,
    profileId,
    model,
    size,
    notifyFailure: true,
    recordUpdates: { prompt, model, width, height },
  })
}

/**
 * Generate a portrait image for a character.
 * Returns the base64 image data on success.
 */
export async function generatePortrait(prompt: string): Promise<string> {
  const issue = getImageConfigurationIssue('portrait')
  if (issue) throw new Error(issue)
  const imageSettings = settings.systemServicesSettings.imageGeneration

  const profileId = imageSettings.portraitProfileId
  if (!profileId) {
    throw new Error('No image generation profile configured')
  }

  const profile = settings.getImageProfile(profileId)
  const model = profile?.model ?? ''
  if (!model) {
    throw new Error('No image model configured')
  }

  const size = imageSettings.portraitSize ?? defaultImageSpec()

  log('Generating portrait', { profileId, model, size, promptLength: prompt.length })

  const result = await generateImage({ profileId, model, prompt, size })

  if (!result.base64) {
    throw new Error('No image data returned from provider')
  }

  return result.base64
}
