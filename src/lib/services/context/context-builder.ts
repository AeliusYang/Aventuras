/**
 * ContextBuilder
 *
 * Flat variable store + template renderer. Services add variables
 * via .add(), then render templates via .render(). Variables accumulate
 * across services -- all templates can access all variables.
 *
 * External templates (image styles, lorebook tools) don't use ContextBuilder.
 * Services fetch those directly from the pack and inject data programmatically.
 */

import { database } from '$lib/services/database'
import { PROMPT_TEMPLATES, formatLengthInstruction } from '$lib/services/prompts/templates'
import { templateEngine } from '$lib/services/templates/engine'
import { createLogger } from '$lib/log'
import type { RenderResult } from './types'
import type { Character, Location, Item, StoryBeat, StoryEntry } from '$lib/types'
import type { RuntimeVariable, RuntimeVarsMap } from '$lib/services/packs/types'
import { legacyTemplateId } from '$lib/services/prompts/resolution'

const log = createLogger('ContextBuilder')

export class ContextBuilder {
  // Bounded, memory-only render contexts; never written to logs or story facts.
  private static recentContexts = new Map<
    string,
    { context: Record<string, any>; packId: string; at: number }
  >()
  private scope?: string
  private previewAt?: number
  private context: Record<string, any> = {}
  private packId: string = 'default-pack'

  constructor(packId?: string) {
    if (packId) this.packId = packId
  }

  /**
   * Factory for services that populate their own context and need nothing from the story
   * but the pack its templates come from. Resolves the pack and its variables; skips the
   * entity loads `forStory` does.
   *
   * `storyId` is undefined only where no story exists yet, which resolves to the default
   * pack. It is a required argument so that a caller which *has* a story cannot omit it
   * by accident -- that omission renders the default pack's template for a story the user
   * pointed at another pack, and nothing about the output says so.
   *
   * Never throws: a caller holds a template it must render, and several build their
   * context outside the try that guards the model call. Losing the pack costs a
   * customization; propagating the failure would cost the turn.
   */
  static async forPack(storyId: string | undefined): Promise<ContextBuilder> {
    let packId = 'default-pack'
    let storyVarValues: Record<string, string> | null = null

    if (storyId) {
      try {
        packId = (await database.getStoryPackId(storyId)) || 'default-pack'
        storyVarValues = await database.getStoryCustomVariables(storyId)
      } catch (error) {
        log('forPack: pack lookup failed, using default pack', { storyId, error })
      }
    }

    const builder = await ContextBuilder.forPackId(packId)
    if (storyVarValues) builder.add(storyVarValues)

    return builder
  }

  /**
   * Same, for the wizard and anywhere else holding a pack directly rather than a story.
   */
  static async forPackId(packId: string | undefined): Promise<ContextBuilder> {
    const builder = new ContextBuilder(packId || 'default-pack')
    await builder.loadCustomVariables()
    return builder
  }

  /**
   * Convenience factory: create a ContextBuilder pre-populated from a story.
   * Loads story settings, protagonist, location, time, and pack custom variables.
   */
  static async forStory(
    storyId: string,
    packIdOverride?: string,
    includePackContext = true,
  ): Promise<ContextBuilder> {
    const story = await database.getStory(storyId)
    if (!story) {
      log('forStory: story not found', { storyId })
      return new ContextBuilder()
    }

    const packId = includePackContext
      ? packIdOverride || (await database.getStoryPackId(storyId)) || 'default-pack'
      : 'collaborative-system'
    const builder = new ContextBuilder(packId)
    builder.scope = `${storyId}:${story.currentBranchId ?? 'main'}`

    const mode = story.mode || 'adventure'
    const targetLength = story.settings?.targetLength || 'dynamic'
    const lengthInstruction = formatLengthInstruction(targetLength, mode)

    // Load story data into context
    builder.add({
      mode,
      pov: story.settings?.pov || (mode === 'creative-writing' ? 'third' : 'second'),
      tense: story.settings?.tense || 'present',
      genre: story.genre || '',
      tone: story.settings?.tone || '',
      themes: story.settings?.themes?.join(', ') || '',
      settingDescription: story.description || '',
      visualProseMode: story.settings?.visualProseMode || false,
      inlineImageMode: story.settings?.imageGenerationMode === 'inline',
      targetLength,
      lengthInstruction,
    })

    // Protagonist
    let characters = await database.getCharacters(storyId)
    const collaborative = story.mode === 'creative-writing'
    if (collaborative) {
      const branchId = story.currentBranchId ?? null
      if (branchId) {
        const { settings } = await import('$lib/stores/settings.svelte')
        const branch = await database.getBranch(branchId)
        if (!branch || branch.storyId !== storyId) throw new Error('角色上下文的故事分支不存在。')
        if (branch.snapshotComplete || !settings.experimentalFeatures.lightweightBranches) {
          characters = characters.filter(
            (character) => character.branchId === branchId && !character.deleted,
          )
        } else {
          const lineage = [branch]
          const visited = new Set([branch.id])
          let parentId = branch.parentBranchId
          while (parentId) {
            if (visited.has(parentId)) throw new Error('角色上下文的分支继承链存在循环。')
            const parent = await database.getBranch(parentId)
            if (!parent || parent.storyId !== storyId) throw new Error('角色上下文的父分支不存在。')
            visited.add(parent.id)
            lineage.unshift(parent)
            parentId = parent.parentBranchId
          }
          characters = await database.getCharactersResolved(storyId, lineage)
        }
      } else {
        characters = characters.filter((character) => !character.branchId && !character.deleted)
      }
    }
    const protagonist = characters.find((c) => c.relationship === 'self')
    builder.add({
      protagonistName: protagonist?.name || 'the protagonist',
      protagonistDescription: protagonist?.description || '',
    })

    // Current location
    const locations = await database.getLocations(storyId)
    const currentLocation = locations.find((l) => l.current)
    builder.add({ currentLocation: currentLocation?.name || '' })

    // Story time
    if (story.timeTracker) {
      const t = story.timeTracker
      builder.add({
        storyTime: `Year ${t.years + 1}, Day ${t.days + 1}, ${t.hours} hours ${t.minutes} minutes`,
      })
    }

    // Entity facts win over a custom variable with the same name. Never load a live vault
    // card here: story characters are copies, and later vault edits must not rewrite them.
    if (collaborative) {
      builder.add({ novelCharacterContext: ContextBuilder.buildNovelCharacterContext(characters) })
    }

    // Runtime variable values from entities
    const items = await database.getItems(storyId)
    const storyBeats = await database.getStoryBeats(storyId)
    if (includePackContext) {
      await builder.loadCustomVariables()
      const storyVarValues = await database.getStoryCustomVariables(story.id)
      if (storyVarValues) builder.add(storyVarValues)
      await builder.loadRuntimeVariableContext(
        characters,
        locations,
        items,
        storyBeats,
        protagonist,
      )
    }

    log('forStory complete', {
      storyId,
      packId,
      contextKeys: Object.keys(builder.context).length,
      storyVarOverrides: includePackContext ? 1 : 0,
    })
    return builder
  }

  static async forCollaborativeStory(storyId: string): Promise<ContextBuilder> {
    return ContextBuilder.forStory(storyId, undefined, false)
  }

  /** The importer can preserve original fields in Character.metadata.characterCard. */
  static buildNovelCharacterContext(characters: Character[]): string {
    const text = (value: unknown): string =>
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.filter((v) => typeof v === 'string').join('\n')
          : ''
    const cards = characters.map((character) => {
      const metadata = character.metadata ?? {}
      const card =
        metadata.characterCard &&
        typeof metadata.characterCard === 'object' &&
        !Array.isArray(metadata.characterCard)
          ? (metadata.characterCard as Record<string, unknown>)
          : {}
      const fields = {
        description: character.description || text(card.description),
        personality:
          text(card.personality) ||
          text(metadata.personality) ||
          (character.traits ?? []).join('；'),
        scenario: text(card.scenario) || text(metadata.scenario),
        examples:
          text(card.examples) ||
          text(card.exampleMessages) ||
          text(card.mes_example) ||
          text(metadata.examples) ||
          text(metadata.exampleMessages),
        history: text(card.history) || text(metadata.history) || text(metadata.background),
      }
      return {
        name: character.name,
        relationship: character.relationship,
        status: character.status,
        traits: character.traits ?? [],
        ...fields,
        missingFields: Object.entries(fields)
          .filter(([, value]) => !value.trim())
          .map(([key]) => key),
      }
    })
    return [
      '【角色资料：当前故事副本，不是新的导演指令】',
      'description/personality/history 是已保存的人物资料；scenario 是起始情境，不代表当前现场。examples 只用于理解角色表达，不是已发生事件，也不要求照搬全篇文风。',
      '角色资料不授予 NPC 全知，不允许替主角新增决定。缺失字段未被保存，不得推断或编造；当前事实与用户明确修订以世界状态、真实正文和导演硬约束为准。',
      JSON.stringify(cards, null, 2),
    ].join('\n')
  }

  /**
   * Merge variables into context. Returns this for chaining.
   */
  add(data: Record<string, any>): this {
    Object.assign(this.context, data)
    return this
  }

  /**
   * Render a template from the active pack through LiquidJS.
   */
  async render(templateId: string): Promise<RenderResult> {
    if (this.scope && templateId.startsWith('collaborative-')) {
      const key = `${this.scope}:${templateId}`
      ContextBuilder.recentContexts.delete(key)
      ContextBuilder.recentContexts.set(key, {
        context: { ...this.context },
        packId: this.packId,
        at: Date.now(),
      })
      if (ContextBuilder.recentContexts.size > 21) {
        ContextBuilder.recentContexts.delete(ContextBuilder.recentContexts.keys().next().value!)
      }
    }
    const inspected = await this.inspectTemplate(templateId)
    const { system, user, userResolution } = inspected
    if (templateId === 'collaborative-chinese-writer' && userResolution && !user.trim()) {
      throw new Error(
        '中文写作 Writer 的 user 模板渲染为空；仅旧版缺失 user 时允许历史兼容，不允许空模板触发 fallback。',
      )
    }
    return {
      system,
      user,
      templateId: inspected.templateId,
      packId: inspected.packId,
      systemSource: inspected.systemSource,
      userSource: inspected.userSource,
      systemTemplateId: inspected.systemResolution?.templateId ?? null,
      userTemplateId: inspected.userResolution?.templateId ?? null,
      systemPackId: inspected.systemResolution?.packId ?? null,
      userPackId: inspected.userResolution?.packId ?? null,
      userTemplateState: inspected.userTemplateState,
    }
  }

  static async forInspection(
    storyId: string,
    templateId: string,
    currentPreview?: { branchId: string | null; entries: StoryEntry[] },
  ): Promise<ContextBuilder> {
    const builder = await ContextBuilder.forStory(storyId)
    if (currentPreview) {
      if (builder.scope !== `${storyId}:${currentPreview.branchId ?? 'main'}`) {
        throw new Error('预览期间故事分支已切换，请重新加载。')
      }
      builder.add({
        recentNovelProse: currentPreview.entries
          .filter((entry) => entry.storyId === storyId && entry.type === 'narration')
          .map((entry) => entry.content)
          .join('\n\n'),
        // No Director has run for the next turn. Never reuse an old brief as a future one.
        novelAgentContext: '',
      })
      return builder
    }
    const snapshot = ContextBuilder.recentContexts.get(`${builder.scope}:${templateId}`)
    if (snapshot && snapshot.packId === builder.packId) {
      builder.context = { ...snapshot.context }
      builder.previewAt = snapshot.at
    }
    return builder
  }

  /** Resolve each half once so the reported source and rendered text cannot diverge. */
  async inspectTemplate(templateId: string) {
    const [systemTemplate, userTemplate] = await Promise.all([
      this.resolveTemplateWithSource(templateId),
      this.resolveTemplateWithSource(`${templateId}-user`),
    ])
    const systemResult = systemTemplate?.content
      ? templateEngine.render(systemTemplate.content, this.context)
      : ''
    if (systemResult === null) {
      log('ERROR: system template render failed, using raw content', { templateId })
    }
    const userResult = userTemplate?.content
      ? templateEngine.render(userTemplate.content, this.context)
      : ''
    if (userResult === null) {
      log('ERROR: user template render failed, using raw content', { templateId })
    }

    const sources = [systemTemplate?.source, userTemplate?.source].filter(Boolean)
    const variables = [
      ...new Set(
        templateEngine.extractVariableNames(
          `${systemTemplate?.content ?? ''}\n${userTemplate?.content ?? ''}`,
        ),
      ),
    ]
    return {
      templateId,
      packId: this.packId,
      previewAt: this.previewAt,
      hasDirectorBrief: Boolean(this.context.novelAgentContext),
      characterContext: this.context.novelCharacterContext as string | undefined,
      system: systemResult ?? systemTemplate?.content ?? '',
      user: userResult ?? userTemplate?.content ?? '',
      systemTemplate: systemTemplate?.content ?? '',
      userTemplate: userTemplate?.content ?? '',
      systemResolution: systemTemplate,
      userResolution: userTemplate,
      userTemplateState: !userTemplate
        ? ('missing' as const)
        : userTemplate.content.trim()
          ? ('present' as const)
          : ('empty' as const),
      variables,
      missingVariables: variables.filter((name) => !(name in this.context)),
      renderErrors: [
        systemResult === null ? 'system' : '',
        userResult === null ? 'user' : '',
      ].filter(Boolean),
      systemSource: systemTemplate?.source ?? null,
      userSource: userTemplate?.source ?? null,
      source:
        sources.length === 0 ? 'missing' : new Set(sources).size === 1 ? sources[0]! : 'mixed',
    }
  }

  /**
   * Look up one template id, falling back to the default pack and then to the code
   * baseline.
   *
   * A pack only holds the templates it was seeded with, so a template introduced by a
   * later app version can be missing from a pack that predates it -- packs imported
   * from a file never pass through PackService's backfill at all. Without a fallback
   * that renders as an empty prompt and the caller silently issues a contentless
   * request, which is far worse than using a slightly less customized template.
   */
  async resolveTemplate(templateId: string): Promise<{ content: string } | null> {
    const resolved = await this.resolveTemplateWithSource(templateId)
    return resolved ? { content: resolved.content } : null
  }

  /** Resolve the actual runtime template and expose its precedence for inspectors. */
  async resolveTemplateWithSource(templateId: string) {
    const alias = legacyTemplateId(templateId)
    const ids = alias ? [templateId, alias] : [templateId]
    const packs = this.packId === 'default-pack' ? [this.packId] : [this.packId, 'default-pack']
    for (const packId of packs) {
      for (const id of ids) {
        const row = await database.getPackTemplate(packId, id)
        if (row) {
          const baseId = id.endsWith('-user') ? id.slice(0, -5) : id
          return {
            content: row.content,
            templateId: id,
            packId,
            source: packId === 'default-pack' ? ('default-pack' as const) : ('story-pack' as const),
            baseline: PROMPT_TEMPLATES.find((t) => t.id === baseId),
          }
        }
      }
      // An old system-only Writer must keep its historical service-built user prompt,
      // rather than silently mixing the new baseline user half into an old story.
      if (alias && templateId.endsWith('-user')) {
        const [canonicalSystem, legacySystem] = await Promise.all([
          database.getPackTemplate(packId, templateId.slice(0, -5)),
          database.getPackTemplate(packId, alias.slice(0, -5)),
        ])
        if (!canonicalSystem && legacySystem) return null
      }
    }

    // Last resort: the compiled-in baseline. `-user` ids map to a template's userContent.
    const baseId = templateId.endsWith('-user') ? templateId.slice(0, -'-user'.length) : templateId
    const baseline =
      PROMPT_TEMPLATES.find((t) => t.id === baseId) ??
      PROMPT_TEMPLATES.find((t) => t.id === legacyTemplateId(baseId))
    const content = templateId.endsWith('-user') ? baseline?.userContent : baseline?.content
    if (content) {
      log('template missing from every pack, falling back to code baseline', { templateId })
      return { content, source: 'baseline' as const, templateId, packId: null, baseline }
    }

    log('WARNING: template not found anywhere', { templateId, packId: this.packId })
    return null
  }

  /**
   * Get a copy of the current context. Useful for debugging.
   */
  getContext(): Record<string, any> {
    return { ...this.context }
  }

  /**
   * Get the active pack ID.
   */
  getPackId(): string {
    return this.packId
  }

  /**
   * Load custom variable defaults from the active pack.
   * Only sets variables not already in context.
   */
  private async loadCustomVariables(): Promise<void> {
    try {
      const variables = await database.getPackVariables(this.packId)
      for (const v of variables) {
        if (!(v.variableName in this.context)) {
          this.context[v.variableName] = v.defaultValue ?? ''
        }
      }
    } catch (error) {
      log('loadCustomVariables failed', { packId: this.packId, error })
    }
  }

  /**
   * Load runtime variable values from story entities and add formatted text blocks
   * to the context. Each entity type gets a separate variable:
   *   runtimeVars_characters, runtimeVars_locations, runtimeVars_items,
   *   runtimeVars_storyBeats, runtimeVars_protagonist
   *
   * Format per entity: "EntityName: VarLabel = value, VarLabel = value"
   * Empty string when no runtime variables are defined or no values exist.
   */
  private async loadRuntimeVariableContext(
    characters: Character[],
    locations: Location[],
    items: Item[],
    storyBeats: StoryBeat[],
    protagonist: Character | undefined,
  ): Promise<void> {
    try {
      const defs = await database.getRuntimeVariables(this.packId)
      if (defs.length === 0) {
        this.add({
          runtimeVars_characters: '',
          runtimeVars_locations: '',
          runtimeVars_items: '',
          runtimeVars_storyBeats: '',
          runtimeVars_protagonist: '',
        })
        return
      }

      // Group definitions by entity type for fast lookup
      const defsByType: Record<string, RuntimeVariable[]> = {}
      for (const d of defs) {
        if (!defsByType[d.entityType]) defsByType[d.entityType] = []
        defsByType[d.entityType].push(d)
      }

      const formatEntities = (
        entities: Array<{ name: string; metadata: Record<string, unknown> | null }>,
        entityType: string,
      ): string => {
        const typeDefs = defsByType[entityType]
        if (!typeDefs || typeDefs.length === 0) return ''

        const lines: string[] = []
        for (const entity of entities) {
          const runtimeVars = (entity.metadata as Record<string, unknown> | null)?.runtimeVars as
            RuntimeVarsMap | undefined
          if (!runtimeVars) continue

          const pairs: string[] = []
          for (const def of typeDefs) {
            const entry = runtimeVars[def.id]
            if (entry && entry.v != null && entry.v !== '') {
              pairs.push(`${def.displayName} = ${entry.v}`)
            }
          }
          if (pairs.length > 0) {
            lines.push(`${entity.name}: ${pairs.join(', ')}`)
          }
        }
        return lines.join('\n')
      }

      // Format entity name helper for story beats (uses title instead of name)
      const beatsWithName = storyBeats.map((b) => ({
        name: b.title,
        metadata: b.metadata,
      }))

      const runtimeVarsCharacters = formatEntities(characters, 'character')
      const runtimeVarsLocations = formatEntities(locations, 'location')
      const runtimeVarsItems = formatEntities(items, 'item')
      const runtimeVarsStoryBeats = formatEntities(beatsWithName, 'story_beat')

      // Protagonist-specific: filter to just the protagonist
      let runtimeVarsProtagonist = ''
      if (protagonist) {
        runtimeVarsProtagonist = formatEntities([protagonist], 'character')
      }

      this.add({
        runtimeVars_characters: runtimeVarsCharacters,
        runtimeVars_locations: runtimeVarsLocations,
        runtimeVars_items: runtimeVarsItems,
        runtimeVars_storyBeats: runtimeVarsStoryBeats,
        runtimeVars_protagonist: runtimeVarsProtagonist,
      })

      log('loadRuntimeVariableContext', {
        packId: this.packId,
        defCount: defs.length,
        hasCharVars: runtimeVarsCharacters.length > 0,
        hasLocVars: runtimeVarsLocations.length > 0,
        hasItemVars: runtimeVarsItems.length > 0,
        hasBeatVars: runtimeVarsStoryBeats.length > 0,
        hasProtagonistVars: runtimeVarsProtagonist.length > 0,
      })
    } catch (error) {
      log('loadRuntimeVariableContext failed', { packId: this.packId, error })
      this.add({
        runtimeVars_characters: '',
        runtimeVars_locations: '',
        runtimeVars_items: '',
        runtimeVars_storyBeats: '',
        runtimeVars_protagonist: '',
      })
    }
  }
}
