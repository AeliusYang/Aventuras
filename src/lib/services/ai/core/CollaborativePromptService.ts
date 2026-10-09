import { settings } from '$lib/stores/settings.svelte'
import { ContextBuilder } from '$lib/services/context'
import {
  collaborativeServiceIds,
  getCollaborativeAgentTemplateId,
  getCollaborativeRequestMode,
} from './collaborativeAgentDefaults'
import type { CollaborativeAgentKey, CollaborativeRequestMode } from '$lib/types/collaborative'
import type { APIProfile, GenerationPreset, Story, StoryEntry } from '$lib/types'
import type { WorldState } from '$lib/services/generation/types'
import {
  collaborativeRerollInput,
  collaborativeRecentPassages,
  collaborativeUserContext,
  collaborativeOptionalContext,
} from '$lib/services/generation/collaborative'
import { PROMPT_TEMPLATES } from '$lib/services/prompts/templates'
import type { PromptSourceMetadata } from '$lib/services/prompts/types'

function optionalAgentSections(input: Record<string, unknown>) {
  const keys = [
    'worldState',
    'recent',
    'recentContent',
    'activeThreads',
    'lorebookContext',
    'confirmedPlan',
    'confirmedPatternGuidance',
    'currentDraft',
    'previousDirectorOutput',
    'recentUserInputs',
    'request',
    'userFeedback',
  ]
  const remaining = { ...input }
  const sections: { key: string; value: string }[] = []
  for (const key of keys) {
    const value = remaining[key]
    delete remaining[key]
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue
    sections.push({ key, value: typeof value === 'string' ? value : JSON.stringify(value) })
  }
  if (Object.keys(remaining).length)
    sections.push({ key: 'extra', value: JSON.stringify(remaining) })
  return sections
}

function writerNarrativePov(pov: unknown): string {
  switch (pov) {
    case 'first':
      return '第一人称'
    case 'second':
      return '第二人称'
    default:
      return '第三人称'
  }
}

function applyWriterPovInstruction(system: string, pov: unknown): string {
  const narrativePov = writerNarrativePov(pov)
  const perspectiveRule =
    narrativePov === '第一人称'
      ? '主角场景以“我”作为旁白对主角的指代。'
      : narrativePov === '第二人称'
        ? '主角场景以“你”或主角姓名作为旁白对主角的指代，不以“我”作为旁白自称。'
        : '主角场景以主角姓名或“他／她”等第三人称作为旁白对主角的指代；旁白严禁以“我”自称主角。'

  return `${system.trim()}\n\n【运行时叙述人称约束】\n当前故事设置的人称是：${narrativePov}。${perspectiveRule}\n用户原文中用“我”描述主角动作、感受或经历时，这是作者对主角的指代，不是正文人称示范；须按上述人称改写。人物实际说出口的对白中的“我”按原意保留。不得因Director简报或近期正文采用另一人称而改变本故事设置。`
}

export interface CollaborativePromptResult {
  agentKey: CollaborativeAgentKey
  templateId: string
  presetId: string
  preset: GenerationPreset
  profile: Pick<APIProfile, 'id' | 'name' | 'providerType' | 'baseUrl'>
  system: string
  user: string
  variables: string[]
  missingVariables: string[]
  source: 'story-pack' | 'default-pack' | 'baseline' | 'mixed' | 'missing' | 'user'
  requestMode: CollaborativeRequestMode
  systemTemplateId?: string
  userTemplateId?: string
  packId?: string
  systemSource?: string
  userSource?: string
  variableValues?: Record<string, unknown>
  hasDirectorBrief?: boolean
  resolvedSystemSource?: string
  provenance?: {
    sources: PromptSourceMetadata[]
    systemCustomized: boolean
    userCustomized: boolean
  }
}

export interface CollaborativeInspectionContext {
  storyId: string
  branchId: string | null
  entries: StoryEntry[]
  story?: Story
  worldState?: WorldState
}

/**
 * Single prompt pipeline for collaborative runtime calls and Prompt Inspector. Model/request
 * settings come from the assigned shared Generation Profile, while prompt text is resolved from
 * the same canonical/legacy/default/baseline precedence used by the Prompt Pack editor.
 */
export class CollaborativePromptService {
  static async render(
    storyId: string,
    agentKey: CollaborativeAgentKey,
    input: unknown = {},
    contextOverrides: Record<string, unknown> = {},
    currentPreview?: CollaborativeInspectionContext,
  ): Promise<CollaborativePromptResult> {
    const serviceId = collaborativeServiceIds[agentKey]
    const presetId = settings.getServicePresetId(serviceId)
    const preset = settings.getPresetConfig(presetId, serviceId)
    const profileId = preset.profileId ?? settings.apiSettings.mainNarrativeProfileId
    const profile = settings.getProfile(profileId)
    if (!profile) throw new Error(`中文写作 Agent 的模型连接不存在：${profileId}`)
    const inputFields =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const preview = inputFields.preview === true ? currentPreview : undefined
    if (preview && preview.storyId !== storyId)
      throw new Error('预览故事已切换，请重新打开提示词管理。')
    const contextBuilder = preview
      ? await ContextBuilder.forInspection(
          storyId,
          getCollaborativeAgentTemplateId(agentKey),
          preview,
        )
      : await ContextBuilder.forStory(storyId)
    const previewFields = preview
      ? {
          ...(preview.story ? collaborativeOptionalContext(preview.story, preview.entries) : {}),
          ...collaborativeUserContext(preview.entries, undefined, false),
          previousDirectorOutput: '',
          ...(preview.worldState
            ? {
                worldState: JSON.stringify(preview.worldState),
                chapters: preview.worldState.chapters,
                storyBeats: preview.worldState.storyBeats,
              }
            : {}),
          recent: collaborativeRecentPassages(preview.entries).map((entry) => entry.text),
          recentContent: contextBuilder.getContext().recentNovelProse,
        }
      : {}
    const reroll = inputFields.reroll ?? contextOverrides.reroll
    const rerollRequest = agentKey === 'sceneDirector' && reroll && typeof reroll === 'object'
    const fields = rerollRequest
      ? collaborativeRerollInput({ ...inputFields, reroll })
      : { ...previewFields, ...inputFields }
    const overrides = rerollRequest
      ? collaborativeRerollInput({ ...contextOverrides, reroll })
      : contextOverrides
    const confirmed =
      agentKey === 'narrativePlanner' ? fields.confirmedPlan : fields.confirmedPatternGuidance
    contextBuilder.add({
      ...(confirmed !== undefined ? { currentConfirmed: confirmed } : {}),
      ...(agentKey === 'narrativePlanner' && fields.confirmedPlan !== undefined
        ? { previousPlan: fields.confirmedPlan }
        : {}),
      ...(agentKey === 'patternReviewer' && fields.confirmedPatternGuidance !== undefined
        ? { currentConfirmedGuidance: fields.confirmedPatternGuidance }
        : {}),
      ...fields,
      ...overrides,
      // A current-story inspection is not a replay of the last Director run.
      ...(inputFields.preview === true ? { novelAgentContext: '', sceneBrief: '' } : {}),
      ...(agentKey === 'sceneDirector' && fields.reroll
        ? { previousDirectorOutput: '', rejectedDirectorOutput: '', reroll: fields.reroll }
        : {}),
      planningInput: JSON.stringify(agentKey === 'sceneDirector' ? fields : input),
      ...(['narrativePlanner', 'patternReviewer', 'plotSuggestions'].includes(agentKey)
        ? { optionalAgentSections: optionalAgentSections(fields) }
        : {}),
    })
    const templateId = getCollaborativeAgentTemplateId(agentKey)
    const inspected = await contextBuilder.inspectTemplate(templateId)
    if (inspected.renderErrors.length > 0) {
      throw new Error(
        `中文写作 Agent ${agentKey} 的 ${inspected.renderErrors.join('/')} Prompt 模板渲染失败。`,
      )
    }
    if (!inspected.system.trim() || !inspected.user.trim()) {
      throw new Error(`中文写作 Agent ${agentKey} 的 Prompt 模板不能为空。`)
    }
    const system =
      agentKey === 'writer'
        ? applyWriterPovInstruction(inspected.system, contextBuilder.getContext().pov)
        : inspected.system
    const systemSource = agentKey === 'writer' ? 'mixed' : (inspected.systemSource ?? 'missing')
    const userSource = inspected.userSource ?? 'missing'
    const baseline = PROMPT_TEMPLATES.find((template) => template.id === templateId)
    return {
      agentKey,
      templateId,
      presetId,
      preset,
      profile: {
        id: profile.id,
        name: profile.name,
        providerType: profile.providerType,
        baseUrl: profile.baseUrl,
      },
      system,
      user: inspected.user,
      variables: inspected.variables,
      missingVariables: inspected.missingVariables,
      source:
        systemSource === userSource
          ? (systemSource as CollaborativePromptResult['source'])
          : 'mixed',
      requestMode: getCollaborativeRequestMode(agentKey),
      systemTemplateId: inspected.systemResolution?.templateId,
      userTemplateId: inspected.userResolution?.templateId,
      packId: inspected.packId,
      systemSource,
      userSource,
      resolvedSystemSource: inspected.systemSource ?? 'missing',
      variableValues:
        inputFields.preview === true
          ? Object.fromEntries(
              inspected.variables.map((name) => [name, contextBuilder.getContext()[name] ?? null]),
            )
          : undefined,
      hasDirectorBrief: inspected.hasDirectorBrief,
      provenance: {
        sources: baseline?.metadata?.sources ?? [],
        systemCustomized: inspected.systemTemplate !== baseline?.content,
        userCustomized: inspected.userTemplate !== (baseline?.userContent ?? ''),
      },
    }
  }
}
