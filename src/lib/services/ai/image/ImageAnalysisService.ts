/**
 * Image Analysis Service
 *
 * Analyzes narrative text to identify visually striking moments for image generation.
 * Uses the Vercel AI SDK with structured output for scene identification.
 *
 * This implements the "analyzed" mode where the LLM acts as an agent to select
 * which phrases/moments should have images generated.
 */

import { NoObjectGeneratedError } from 'ai'
import type { VisualDescriptors } from '$lib/types'
import type { ServiceId } from '$lib/stores/settings.svelte'
import { BaseAIService } from '../BaseAIService'
import { ContextBuilder } from '$lib/services/context'
import type { ImageEvidence } from '$lib/services/image/generationContext'
import type { ImagePromptDiagnostic } from '$lib/services/image/diagnostics'
import { IMAGE_EVIDENCE_RULES } from './evidenceRules'
import { getImageAnalysisConfigurationIssue, imageAnalysisBinding } from './analysisConfig'
import { createLogger } from '$lib/log'
import {
  sceneAnalysisResultSchema,
  imageableSceneSchema,
  type ImageableScene,
  portraitPreparationSchema,
  manualSceneAnalysisSchema,
  type PortraitPreparation,
} from '../sdk/schemas/imageanalysis'

const log = createLogger('ImageAnalysis')

/**
 * Context needed to analyze narrative for imageable scenes.
 */
export interface ImageAnalysisContext {
  /** Story whose pack supplies the analysis template. */
  storyId: string
  /** The narrative text to analyze (English original) */
  narrativeResponse: string
  /** The user action that triggered this narrative */
  userAction: string
  /** Characters present in the scene with their visual descriptors */
  presentCharacters: Array<{
    name: string
    visualDescriptors?: VisualDescriptors
    isProtagonist: boolean
  }>
  /** Current location name */
  currentLocation?: string
  /** The image style prompt to include */
  stylePrompt: string
  /** Maximum number of images (0 = unlimited) */
  maxImages: number
  /** Full chat history for comprehensive context */
  chatHistory?: string
  /** Activated lorebook entries for world context */
  lorebookContext?: string
  /** Names of characters that have portrait images available */
  charactersWithPortraits: string[]
  /** Names of characters that need portrait generation before appearing in scene images */
  charactersWithoutPortraits: string[]
  /** Translated narrative text - use this for sourceText extraction when available */
  translatedNarrative?: string
  /** Target language for translation */
  translationLanguage?: string
  /** Generate images with character references */
  referenceMode: boolean
  /** A user-requested single illustration, never a request to create character portraits. */
  manual?: boolean
  evidence?: ImageEvidence
  onDiagnostic?: (diagnostic: ImagePromptDiagnostic) => void
}

/**
 * Service that identifies imageable scenes in narrative text using the Vercel AI SDK.
 */
export class ImageAnalysisService extends BaseAIService {
  /**
   * Create a new ImageAnalysisService.
   * @param serviceId - The service ID used to resolve the preset dynamically
   */
  constructor(serviceId: ServiceId) {
    super(serviceId)
  }

  async preparePortrait(
    evidence: ImageEvidence,
    variables: Record<string, unknown>,
    onDiagnostic?: (diagnostic: ImagePromptDiagnostic) => void,
    canContinue?: () => boolean,
  ): Promise<{ result: PortraitPreparation; diagnostic: ImagePromptDiagnostic }> {
    const issue = getImageAnalysisConfigurationIssue()
    if (issue) throw new Error(issue)
    const ctx = await ContextBuilder.forPack(evidence.storyId)
    ctx.add({ ...variables, imageEvidence: evidence.context })
    const rendered = await ctx.inspectTemplate('image-portrait-preparation')
    if (rendered.renderErrors.length || !rendered.system.trim() || !rendered.user.trim())
      throw new Error('肖像资料整理模板为空或渲染失败，请检查提示词包。')
    const diagnostic: ImagePromptDiagnostic = {
      evidence,
      templateId: 'image-portrait-preparation',
      packId: rendered.packId,
      resolvedTemplateId: rendered.systemResolution?.templateId,
      templateSource: rendered.systemSource,
      ...imageAnalysisBinding(),
      system: `${rendered.system}\n\n${IMAGE_EVIDENCE_RULES}`,
      user: rendered.user,
      inferredDetails: [],
    }
    onDiagnostic?.(diagnostic)
    if (canContinue?.() === false) throw new Error('人物或故事已变化，本次请求已停止。')
    const result = await this.generate(
      portraitPreparationSchema,
      diagnostic.system,
      diagnostic.user,
      'image-portrait-preparation',
    )
    return { result, diagnostic: { ...diagnostic, inferredDetails: result.inferredDetails } }
  }

  /**
   * Analyze narrative text to identify visually striking moments.
   * Returns an array of imageable scenes sorted by priority (highest first).
   */
  async identifyScenes(context: ImageAnalysisContext): Promise<ImageableScene[]> {
    log('identifyScenes called', {
      narrativeLength: context.narrativeResponse.length,
      presentCharactersCount: context.presentCharacters.length,
      referenceMode: context.referenceMode,
      maxImages: context.maxImages,
      hasTranslation: !!context.translatedNarrative,
    })

    // Build character descriptors block
    const characterDescriptors = this.buildCharacterDescriptors(context.presentCharacters)

    // Format portrait lists
    const charactersWithPortraitsStr =
      context.charactersWithPortraits.length > 0
        ? context.charactersWithPortraits.join(', ')
        : 'None'
    const charactersWithoutPortraitsStr =
      context.charactersWithoutPortraits.length > 0
        ? context.charactersWithoutPortraits.join(', ')
        : 'None'

    // Build translated narrative block if available
    let translatedNarrativeBlock = ''
    if (context.translatedNarrative && context.translationLanguage) {
      translatedNarrativeBlock = `## Display Narrative (${context.translationLanguage} - use this for sourceText)
${context.translatedNarrative}`
    }

    // Select template based on portrait mode
    const templateId = context.referenceMode
      ? 'image-prompt-analysis-reference'
      : 'image-prompt-analysis'

    // Build context and render
    const ctx = await ContextBuilder.forPack(context.storyId)
    ctx.add({
      imageStylePrompt: context.manual ? '' : context.stylePrompt,
      characterDescriptors: characterDescriptors || 'No character visual descriptors available.',
      charactersWithPortraits: charactersWithPortraitsStr,
      charactersWithoutPortraits: charactersWithoutPortraitsStr,
      maxImages: context.maxImages === 0 ? '0 (unlimited)' : String(context.maxImages),
      narrativeResponse: context.narrativeResponse,
      userAction: context.userAction,
      chatHistory: context.chatHistory || '',
      lorebookContext: context.manual ? '' : (context.lorebookContext ?? ''),
      imageEvidence: context.evidence?.context ?? '',
      translatedNarrativeBlock,
    })
    const rendered = await ctx.inspectTemplate(templateId)
    if (rendered.renderErrors.length) throw new Error('图片分析模板渲染失败，请检查提示词包。')
    const system = context.manual
      ? `${rendered.system}\n\n本次是用户主动请求的单张正文插图。只选择一个最适合的画面，generatePortrait 必须为 false；不得额外生成肖像。仅使用已有肖像作为参考，缺少肖像的人物用外貌描述呈现。sourceText 必须逐字摘取本次中文正文，不翻译原句；绘图 prompt 可用英文。\n${IMAGE_EVIDENCE_RULES}`
      : rendered.system
    const prompt = context.manual
      ? `${rendered.user}${context.evidence?.context && !rendered.user.includes(context.evidence.context) ? `\n\n【生图依据（有来源的完整资料）】\n${context.evidence.context}` : ''}\n【画风，仅用于理解，调用方最终加入】\n${context.stylePrompt}`
      : rendered.user
    const diagnostic: ImagePromptDiagnostic | undefined = context.evidence
      ? {
          evidence: context.evidence,
          templateId,
          packId: rendered.packId,
          resolvedTemplateId: rendered.systemResolution?.templateId,
          templateSource: rendered.systemSource,
          ...imageAnalysisBinding(),
          system,
          user: prompt,
          inferredDetails: [],
        }
      : undefined
    if (diagnostic) context.onDiagnostic?.(diagnostic)

    try {
      const result = context.manual
        ? await this.generate(manualSceneAnalysisSchema, system, prompt, templateId)
        : await this.generate(sceneAnalysisResultSchema, system, prompt, templateId)
      if (diagnostic)
        context.onDiagnostic?.({
          ...diagnostic,
          inferredDetails: 'inferredDetails' in result ? (result.inferredDetails as string[]) : [],
        })

      // Sort by priority (highest first)
      const sortedScenes = result.scenes.sort((a, b) => b.priority - a.priority)

      log('identifyScenes complete', {
        scenesFound: sortedScenes.length,
        priorities: sortedScenes.map((s) => s.priority),
      })

      return sortedScenes as ImageableScene[]
    } catch (error) {
      const recovered = this.recoverScenesFromMalformedOutput(error)
      if (recovered && recovered.length > 0) {
        log('identifyScenes recovered scenes from malformed output', {
          scenesFound: recovered.length,
        })
        return recovered.sort((a, b) => b.priority - a.priority)
      }
      log('identifyScenes failed', error)
      throw error
    }
  }

  /**
   * Providers without real structured-output support (e.g. local llama.cpp models
   * without a forced JSON schema grammar) sometimes return the scene array directly
   * instead of the required `{ scenes: [...] }` wrapper, or include one malformed
   * scene among otherwise-valid ones. jsonrepair only fixes JSON *syntax*, not this
   * kind of *shape* mismatch, so `Output.object` rejects the whole response as
   * AI_NoObjectGeneratedError even though most of the data is usable. Re-parse the
   * already-repaired raw text (`error.text`) here, accept either shape, and keep
   * whichever individual scenes validate instead of discarding the entire batch.
   */
  private recoverScenesFromMalformedOutput(error: unknown): ImageableScene[] | null {
    if (!NoObjectGeneratedError.isInstance(error) || !error.text) {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(error.text)
    } catch {
      return null
    }

    const rawScenes = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { scenes?: unknown })?.scenes)
        ? (parsed as { scenes: unknown[] }).scenes
        : null
    if (!rawScenes) {
      return null
    }

    const scenes: ImageableScene[] = []
    for (const raw of rawScenes) {
      const validated = imageableSceneSchema.safeParse(raw)
      if (validated.success) {
        scenes.push(validated.data)
      } else {
        log('Dropping malformed scene during recovery', validated.error.flatten())
      }
    }

    return scenes.length > 0 ? scenes : null
  }

  /**
   * Build a formatted string of character visual descriptors for the prompt.
   */
  private buildCharacterDescriptors(
    characters: Array<{
      name: string
      visualDescriptors?: VisualDescriptors
      isProtagonist: boolean
    }>,
  ): string {
    const withDescriptors = characters.filter((c) => c.visualDescriptors)

    if (withDescriptors.length === 0) {
      return ''
    }

    return withDescriptors
      .map((char) => {
        const vd = char.visualDescriptors!
        const parts: string[] = [`**${char.name}**:`]

        /* if (vd.gender) parts.push(`Gender: ${vd.gender}`)
        if (vd.age) parts.push(`Age: ${vd.age}`)
        if (vd.height) parts.push(`Height: ${vd.height}`)
        if (vd.build) parts.push(`Build: ${vd.build}`)
        if (vd.skinTone) parts.push(`Skin: ${vd.skinTone}`)
        if (vd.hairColor) parts.push(`Hair color: ${vd.hairColor}`)
        if (vd.hairStyle) parts.push(`Hair style: ${vd.hairStyle}`)
        if (vd.eyeColor) parts.push(`Eyes: ${vd.eyeColor}`)
        if (vd.facialFeatures) parts.push(`Face: ${vd.facialFeatures}`)
        if (vd.distinguishingMarks) parts.push(`Marks: ${vd.distinguishingMarks}`)
        if (vd.clothingStyle) parts.push(`Clothing: ${vd.clothingStyle}`)
        if (vd.accessories) parts.push(`Accessories: ${vd.accessories}`) */
        if (vd.face) parts.push(`Face: ${vd.face}`)
        if (vd.hair) parts.push(`Hair: ${vd.hair}`)
        if (vd.eyes) parts.push(`Eyes: ${vd.eyes}`)
        if (vd.build) parts.push(`Build: ${vd.build}`)
        if (vd.clothing) parts.push(`Clothing: ${vd.clothing}`)
        if (vd.accessories) parts.push(`Accessories: ${vd.accessories}`)
        if (vd.distinguishing) parts.push(`Distinguishing features: ${vd.distinguishing}`)
        if (char.isProtagonist) parts.push(` (Protagonist)`)

        return parts.join('\n  ')
      })
      .join('\n\n')
  }
}
