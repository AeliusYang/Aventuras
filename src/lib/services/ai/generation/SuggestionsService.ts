/**
 * Suggestions Service
 *
 * Generates story direction suggestions for creative writing mode.
 * Uses the Vercel AI SDK for structured output with Zod schema validation.
 *
 * Prompt generation flows through ContextBuilder + Liquid templates.
 */

import type { StoryEntry, StoryBeat, Entry } from '$lib/types'
import { settings, type ServiceId } from '$lib/stores/settings.svelte'
import { BaseAIService } from '../BaseAIService'
import { ContextBuilder } from '$lib/services/context'
import { getContextConfig, getLorebookConfig } from '../core/config'
import { createLogger } from '$lib/log'
import { suggestionsResultSchema, type SuggestionsResult } from '../sdk/schemas/suggestions'
import { database } from '$lib/services/database'
import { generateCollaborativeJsonText } from '../sdk/generate'
import { CollaborativePromptService } from '../core/CollaborativePromptService'
import { collaborativeServiceIds } from '../core/collaborativeAgentDefaults'
import { collaborativeOptionalContext } from '$lib/services/generation/collaborative'

const log = createLogger('Suggestions')

/**
 * Service for generating story direction suggestions.
 *
 * This service has been refactored to use the Vercel AI SDK with Zod schemas
 * for automatic output validation. The constructor no longer requires a provider.
 */
export class SuggestionsService extends BaseAIService {
  /**
   * Create a new SuggestionsService.
   * @param serviceId - The service ID used to resolve the preset dynamically
   */
  constructor(serviceId: ServiceId) {
    super(serviceId)
  }

  /**
   * Generate story direction suggestions for creative writing mode.
   * Per design doc section 4.2: Suggestions System
   *
   * @param recentEntries - Recent story entries for context
   * @param activeThreads - Active story beats/threads
   * @param lorebookEntries - Optional lorebook entries for world context
   * @param storyId - Story whose pack supplies the template; undefined only outside a story
   * @param latestNarrativeResponse - Latest generated narration (optional, used when entries are stale)
   */
  async generateSuggestions(
    recentEntries: StoryEntry[],
    activeThreads: StoryBeat[],
    lorebookEntries: Entry[] | undefined,
    storyId: string | undefined,
    latestNarrativeResponse?: string,
  ): Promise<SuggestionsResult> {
    log('generateSuggestions called', {
      recentEntriesCount: recentEntries.length,
      activeThreadsCount: activeThreads.length,
      hasStoryId: !!storyId,
      lorebookEntriesCount: lorebookEntries?.length ?? 0,
      hasLatestNarrativeResponse: !!latestNarrativeResponse?.trim(),
    })
    const currentStory = storyId ? await database.getStory(storyId) : null
    const collaborative = currentStory?.mode === 'creative-writing'
    if (
      collaborative &&
      currentStory?.settings?.collaborativeNovelWorkflow?.plotSuggestions?.enabled === false
    ) {
      throw new Error('中文写作短期剧情建议已关闭。')
    }

    // Get the last few entries for context
    const contextConfig = getContextConfig()
    const lorebookConfig = getLorebookConfig()
    const lastEntries = recentEntries
      .filter((entry) => !collaborative || entry.type === 'narration')
      .slice(-contextConfig.recentEntriesForSuggestions)
    let recentContent = lastEntries
      .map((e) => {
        const prefix = e.type === 'user_action' ? '[DIRECTION]' : '[NARRATIVE]'
        return `${prefix} ${e.content}`
      })
      .join('\n\n')

    const latestNarrative = latestNarrativeResponse?.trim()
    if (latestNarrative) {
      const lastNarrativeInEntries = [...lastEntries]
        .reverse()
        .find((e) => e.type === 'narration')
        ?.content?.trim()

      if (lastNarrativeInEntries !== latestNarrative) {
        recentContent = recentContent
          ? `${recentContent}\n\n[NARRATIVE] ${latestNarrative}`
          : `[NARRATIVE] ${latestNarrative}`
      }
    }

    // Format active threads
    const activeThreadsStr =
      activeThreads.length > 0
        ? activeThreads
            .map((t) => `• ${t.title}${t.description ? `: ${t.description}` : ''}`)
            .join('\n')
        : '(none)'

    // Format lorebook entries for context
    let lorebookContext = ''
    if (lorebookEntries && lorebookEntries.length > 0) {
      const entryDescriptions = lorebookEntries
        .slice(0, lorebookConfig.maxForSuggestions)
        .map((e) => {
          let desc = `• ${e.name} (${e.type})`
          if (e.description) {
            desc += `: ${e.description}`
          }
          return desc
        })
        .join('\n')
      lorebookContext = `\n## Lorebook/World Elements\nThe following characters, locations, and concepts exist in this world and can be incorporated into suggestions:\n${entryDescriptions}`
    }

    // Create ContextBuilder -- use forStory when storyId available
    let ctx: ContextBuilder
    if (storyId) {
      ctx = collaborative
        ? await ContextBuilder.forStory(storyId, undefined, false)
        : await ContextBuilder.forStory(storyId)
    } else {
      ctx = new ContextBuilder()
      ctx.add({
        mode: 'creative-writing',
        pov: 'third',
        tense: 'past',
        protagonistName: 'the protagonist',
      })
    }

    // Build genre string from context
    const ctxData = ctx.getContext()
    const genreStr = ctxData.genre ? `## Genre: ${ctxData.genre}\n` : ''

    // Add runtime variables for template rendering
    const planningInput = {
      recentContent,
      activeThreads: activeThreadsStr,
      ...(lorebookContext ? { lorebookContext } : {}),
      ...(collaborative && currentStory
        ? collaborativeOptionalContext(currentStory, recentEntries)
        : {}),
    }
    ctx.add({
      recentContent,
      activeThreads: activeThreadsStr,
      genre: genreStr,
      lorebookContext,
      planningInput: JSON.stringify(planningInput),
    })

    const templateId = collaborative ? 'collaborative-plot-suggestions' : 'suggestions'
    const rendered =
      collaborative && currentStory
        ? await CollaborativePromptService.render(
            currentStory.id,
            'plotSuggestions',
            planningInput,
            ctx.getContext(),
          )
        : await ctx.render(templateId)
    const { system, user: prompt } = rendered

    try {
      // Use SDK's generateStructured - all boilerplate handled automatically
      const result =
        collaborative && currentStory
          ? await generateCollaborativeJsonText(
              {
                presetId: templateId,
                presetOverride: settings.getPresetConfig(
                  settings.getServicePresetId(collaborativeServiceIds.plotSuggestions),
                  collaborativeServiceIds.plotSuggestions,
                ),
                schema: suggestionsResultSchema.refine(
                  (value) =>
                    value.suggestions.every((suggestion) =>
                      /\p{Script=Han}/u.test(suggestion.text),
                    ),
                  '中文写作剧情建议必须使用中文。',
                ),
                system,
                prompt,
              },
              templateId,
            )
          : await this.generate(suggestionsResultSchema, system, prompt, templateId)

      log('Suggestions generated:', result.suggestions.length)
      return result
    } catch (error) {
      log('Suggestions generation failed:', error)
      if (collaborative) throw error
      return { suggestions: [] }
    }
  }
}
