import { BaseAIService } from '../BaseAIService'
import { generateCollaborativeText } from '../sdk/generate'
import type { CollaborativeAgentKey } from '$lib/types/collaborative'
import { database } from '$lib/services/database'
import { CollaborativePromptService } from '../core/CollaborativePromptService'
import { collaborativeServiceIds } from '../core/collaborativeAgentDefaults'
import { LLM_TIMEOUT_DEFAULT } from '$lib/constants/timeout'
import { settings } from '$lib/stores/settings.svelte'

/** Text-to-text control Agent. It never parses or rewrites Agent content. */
export class CollaborativeService extends BaseAIService {
  async run(
    storyId: string,
    _template: string,
    input: unknown,
    signal?: AbortSignal,
    onDiagnostic?: Parameters<typeof generateCollaborativeText>[0]['onDiagnostic'],
    onChunk?: Parameters<typeof generateCollaborativeText>[0]['onChunk'],
  ): Promise<string> {
    signal?.throwIfAborted()
    const story = await database.getStory(storyId)
    if (!story) throw new Error('中文写作故事不存在，已停止生成。')
    const agent = (Object.keys(collaborativeServiceIds) as CollaborativeAgentKey[]).find(
      (key) => collaborativeServiceIds[key] === this.serviceId,
    )
    if (!agent) throw new Error(`未知中文写作 Agent 服务：${this.serviceId}`)
    if (
      agent !== 'sceneDirector' &&
      agent !== 'writer' &&
      story.settings?.collaborativeNovelWorkflow?.[agent]?.enabled === false
    ) {
      throw new Error(`中文写作 Agent 已关闭：${agent}`)
    }
    const rendered = await CollaborativePromptService.render(storyId, agent, input)
    onDiagnostic?.({
      presetId: rendered.presetId,
      profileId: rendered.profile.id,
      profileName: rendered.profile.name,
      model: rendered.preset.model,
    })
    const result = await generateCollaborativeText({
      presetId: rendered.presetId,
      presetOverride: rendered.preset,
      system: rendered.system,
      prompt: rendered.user,
      signal,
      requestBudgetMs:
        rendered.preset.timeoutMs ??
        (agent === 'sceneDirector' ? settings.apiSettings.llmTimeoutMs : LLM_TIMEOUT_DEFAULT),
      serviceId: `collaborative:${agent}`,
      onDiagnostic,
      onChunk,
    })
    signal?.throwIfAborted()
    return result
  }
}
