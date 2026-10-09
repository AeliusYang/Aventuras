import { ContextBuilder } from '$lib/services/context'
import { buildImageEvidence, type ImageEvidenceInput } from '$lib/services/image/generationContext'
import type { ImagePromptDiagnostic } from '$lib/services/image/diagnostics'
import { settings } from '$lib/stores/settings.svelte'
import { ImageAnalysisService } from './ImageAnalysisService'
import { getImageAnalysisConfigurationIssue, imageAnalysisBinding } from './analysisConfig'
import { getImageConfigurationIssue } from './imageUtils'
import { resolveStylePrompt } from './stylePrompt'

export interface PreparedPortrait {
  signature: string
  prompt: string
  diagnostic: ImagePromptDiagnostic
}

/** Pure preparation: image dispatch and saving remain owned by the editing session. */
export async function preparePortraitRequest(
  input: ImageEvidenceInput,
  options: {
    previous?: PreparedPortrait | null
    canContinue: () => boolean
    onDiagnostic: (diagnostic: ImagePromptDiagnostic) => void
  },
): Promise<PreparedPortrait> {
  const issue = getImageConfigurationIssue('portrait') || getImageAnalysisConfigurationIssue()
  if (issue) throw new Error(issue)
  const evidence = await buildImageEvidence(input)
  const imageSettings = settings.systemServicesSettings.imageGeneration
  const style = await resolveStylePrompt(input.story.id, imageSettings.portraitStyleId)
  const variables = {
    characterName: input.edits?.name || evidence.characters[0]?.name,
    mode: input.story.mode,
    pov:
      input.story.settings?.pov ?? (input.story.mode === 'creative-writing' ? 'third' : 'second'),
    tense: input.story.settings?.tense ?? 'present',
    imageStylePrompt: style,
  }
  const ctx = await ContextBuilder.forPack(input.story.id)
  ctx.add({ ...variables, imageEvidence: evidence.context })
  const preparation = await ctx.inspectTemplate('image-portrait-preparation')
  const generation = await ctx.resolveTemplate('image-portrait-generation')
  const profile = settings.getImageProfile(imageSettings.portraitProfileId ?? '')
  const signature = JSON.stringify([
    evidence.context,
    preparation.system,
    preparation.user,
    generation?.content,
    ctx.getContext(),
    imageAnalysisBinding(),
    settings.getPresetConfig(settings.getServicePresetId('imageGeneration'), 'imageGeneration'),
    imageSettings.portraitProfileId,
    profile?.model,
    imageSettings.portraitSize,
  ])
  if (!options.canContinue()) throw new Error('人物或故事已变化，本次请求已停止。')
  if (options.previous?.signature === signature) {
    options.onDiagnostic(options.previous.diagnostic)
    return options.previous
  }
  const { result, diagnostic } = await new ImageAnalysisService('imageGeneration').preparePortrait(
    evidence,
    variables,
    options.onDiagnostic,
    options.canContinue,
  )
  ctx.add({ visualDescriptors: result.visualDescription })
  const rendered = await ctx.inspectTemplate('image-portrait-generation')
  if (!options.canContinue()) throw new Error('人物或故事已变化，本次请求已停止。')
  if (rendered.renderErrors.length || !rendered.system.trim())
    throw new Error('肖像生成模板为空或渲染失败，请检查提示词包。')
  const prepared = {
    signature,
    prompt: rendered.system,
    diagnostic: {
      ...diagnostic,
      finalPrompt: rendered.system,
      generationTemplateId: rendered.systemResolution?.templateId,
      imageModel: profile?.model,
      imageProfile: profile?.name,
    },
  }
  options.onDiagnostic(prepared.diagnostic)
  return prepared
}
