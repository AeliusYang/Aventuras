import { database } from '$lib/services/database'
import type { StoryMode } from '$lib/types'
import { COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY } from './types'
import { PROMPT_TEMPLATES } from '$lib/services/prompts/templates'
import {
  canonicalCollaborativeTemplates,
  novelOpeningRules,
} from '$lib/services/prompts/templates/collaborative'
import { legacyTemplateId } from '$lib/services/prompts/resolution'
import { ContextBuilder } from '$lib/services/context/context-builder'
import { validateTemplate } from '$lib/services/templates/validator'
import { templateEngine } from '$lib/services/templates/engine'
import { hashContent } from './hash'
import {
  classifyTemplates,
  isUntouched,
  type ClassifiedTemplates,
  type RefreshScope,
} from './staleness'
import type { PresetPack, FullPack, PackTemplate, PackUsageStory, CustomVariable } from './types'

export { isUntouched } from './staleness'

export function missingRequiredVariables(
  variables: CustomVariable[],
  values: Record<string, string> | null | undefined,
): CustomVariable[] {
  return variables.filter(
    (variable) =>
      variable.isRequired &&
      !variable.defaultValue?.trim() &&
      !values?.[variable.variableName]?.trim(),
  )
}

/**
 * Pack Service
 *
 * Business logic for preset pack management.
 * Handles default pack initialization, pack creation (copies from default),
 * template modification detection, and safe pack deletion.
 *
 * All database operations are delegated to DatabaseService.
 * This service adds the business rules on top.
 */
class PackService {
  private savingTemplates = new Set<string>()
  async getCollaborativeImportDefaultPackId(): Promise<string | null> {
    const id = await database.getSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)
    return id && (await database.getPack(id)) ? id : null
  }

  async getEffectiveCollaborativeImportDefaultPackId(): Promise<string | null> {
    const preferred = await this.getCollaborativeImportDefaultPackId()
    if (preferred) return preferred
    return (
      (await database.getAllPacks()).find(
        (pack) => pack.name === '中文写作' && pack.author === 'AIRP',
      )?.id ?? null
    )
  }

  async setCollaborativeImportDefaultPackId(packId: string): Promise<void> {
    if (!(await database.getPack(packId))) throw new Error('提示词包已不存在，请重新选择。')
    await database.setSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY, packId)
  }

  async resetCollaborativeImportDefaultPack(): Promise<void> {
    await database.deleteSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)
  }

  async resolveSetupPackId(
    mode: StoryMode,
    isImport: boolean,
    restoredPackId?: string,
  ): Promise<string> {
    if (restoredPackId && (await database.getPack(restoredPackId))) return restoredPackId
    if (mode !== 'creative-writing') return 'default-pack'
    if (isImport) {
      const preferred = await this.getCollaborativeImportDefaultPackId()
      if (preferred) return preferred
    }
    return (await this.ensureCollaborativePack()).id
  }

  async ensureCollaborativePack(): Promise<PresetPack> {
    const existing = (await database.getAllPacks()).find(
      (p) => p.name === '中文写作' && p.author === 'AIRP',
    )
    if (existing) {
      await this.syncManagedCollaborativePack(existing.id)
      return existing
    }
    const pack = await this.createPack(
      '中文写作',
      '中文小说默认提示词；自然输入、主角决定权与场景停点优先。',
      'AIRP',
    )
    for (const id of ['opening-generation-creative', 'opening-refinement-creative']) {
      await database.setPackTemplateContent(pack.id, id, novelOpeningRules, false)
    }
    return pack
  }

  /** Keep the app-owned AIRP pack on public defaults without touching user edits. */
  private async syncManagedCollaborativePack(packId: string): Promise<void> {
    const existing = new Map(
      (await database.getPackTemplates(packId)).map((template) => [template.templateId, template]),
    )
    for (const template of canonicalCollaborativeTemplates) {
      const system = existing.get(template.id)
      if (!system || isUntouched(system)) {
        await database.setPackTemplateContent(packId, template.id, template.content, true)
      }
      if (template.userContent) {
        const userId = `${template.id}-user`
        const user = existing.get(userId)
        if (!user || isUntouched(user)) {
          await database.setPackTemplateContent(packId, userId, template.userContent, true)
        }
      }
    }
  }
  private initialized = false

  /**
   * Initialize the pack system.
   * Call on app startup after database is ready.
   * - Ensures default pack exists
   * - Seeds templates from PROMPT_TEMPLATES if missing
   * - Adds any new templates from app updates
   * Idempotent: safe to call multiple times.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    let defaultPack = await database.getDefaultPack()

    if (!defaultPack) {
      // Create default pack if missing (first run)
      defaultPack = await database.createPack({
        id: 'default-pack',
        name: 'Default',
        description: 'Built-in prompt templates shipped with Aventura',
        author: 'Aventuras',
        isDefault: true,
      })
    }

    // Check existing templates
    const existingTemplates = await database.getPackTemplates('default-pack')
    const existingIds = new Set(existingTemplates.map((t) => t.templateId))

    // Build lookup of existing templates by templateId for quick access
    const existingByTemplateId = new Map(existingTemplates.map((t) => [t.templateId, t]))

    // Seed or update templates from PROMPT_TEMPLATES
    for (const template of PROMPT_TEMPLATES) {
      // Seed system prompt content
      if (!existingIds.has(template.id)) {
        await database.setPackTemplateContent('default-pack', template.id, template.content, true)
      }
      // Seed user content (if template has it)
      const userContentId = `${template.id}-user`
      if (template.userContent && !existingIds.has(userContentId)) {
        await database.setPackTemplateContent(
          'default-pack',
          userContentId,
          template.userContent,
          true,
        )
      }
    }

    // Existing story prompts stay pinned. Baseline replacement is an explicit editor action.
    await this.refreshDefaultPackTemplates(existingByTemplateId)

    await this.backfillMissingTemplates()

    const managedCollaborativePacks = (await database.getAllPacks()).filter(
      (pack) => pack.name === '中文写作' && pack.author === 'AIRP',
    )
    for (const pack of managedCollaborativePacks) {
      await this.syncManagedCollaborativePack(pack.id)
    }

    this.initialized = true
  }

  /**
   * Add templates that exist in the code baseline but not yet in a pack.
   *
   * Custom packs are seeded once from PROMPT_TEMPLATES at creation and are deliberately
   * never auto-updated, so a template *added* by a later app version is simply absent
   * from them. Backfilling gives the user something they can actually open and edit in
   * the template editor, which a runtime fallback alone would not.
   *
   * This is the persistence half; `ContextBuilder.resolveTemplate` is the safety half and
   * neither replaces the other. The fallback there still matters for packs this never
   * reaches -- one imported from a file after startup, or a row that fails to write --
   * where a missing id would otherwise render an empty prompt and the service would
   * silently issue a contentless request.
   *
   * Only ever inserts, so a user's edits to templates they already have are untouched.
   */
  private async backfillMissingTemplates(): Promise<void> {
    const packs = await database.getAllPacks()

    for (const pack of packs) {
      const existing = await database.getPackTemplates(pack.id)
      const existingIds = new Set(existing.map((t) => t.templateId))

      // id -> content for everything missing, built before touching the database so the
      // common case (nothing missing) does no writes and logs nothing.
      const missing = new Map<string, string>()
      for (const template of PROMPT_TEMPLATES) {
        // Custom packs keep legacy customizations. The built-in pack always receives canonical
        // IDs so runtime resolution cannot remain pinned to an obsolete alias.
        const alias = legacyTemplateId(template.id)
        if (pack.id !== 'default-pack' && alias && existingIds.has(alias)) continue
        if (!existingIds.has(template.id)) missing.set(template.id, template.content)
        const userId = `${template.id}-user`
        if (template.userContent && !existingIds.has(userId)) {
          missing.set(userId, template.userContent)
        }
      }
      if (missing.size === 0) continue

      for (const [templateId, content] of missing) {
        await database.setPackTemplateContent(pack.id, templateId, content, true)
      }
      console.log('[PackService] Backfilled missing templates', {
        pack: pack.id,
        added: [...missing.keys()],
      })
    }
  }

  /**
   * Get all preset packs.
   */
  async getAllPacks(): Promise<PresetPack[]> {
    return database.getAllPacks()
  }

  /**
   * Get a single pack by ID.
   */
  async getPack(id: string): Promise<PresetPack | null> {
    return database.getPack(id)
  }

  /**
   * Load a pack with all its templates and variables.
   */
  async getFullPack(packId: string): Promise<FullPack | null> {
    const pack = await database.getPack(packId)
    if (!pack) return null

    const [templates, variables, runtimeVariables] = await Promise.all([
      database.getPackTemplates(packId),
      database.getPackVariables(packId),
      database.getRuntimeVariables(packId),
    ])

    return { pack, templates, variables, runtimeVariables }
  }

  /** Create a new pack seeded from the pristine PROMPT_TEMPLATES baseline. */
  async createPack(name: string, description?: string, author?: string): Promise<PresetPack> {
    const packId = crypto.randomUUID()

    // Create pack metadata
    const pack = await database.createPack({
      id: packId,
      name,
      description: description ?? null,
      author: author ?? null,
      isDefault: false,
    })

    // Seed templates from code baseline (not from the database default-pack, which may be modified)
    for (const template of PROMPT_TEMPLATES) {
      await database.setPackTemplateContent(packId, template.id, template.content, true)
      if (template.userContent) {
        await database.setPackTemplateContent(
          packId,
          `${template.id}-user`,
          template.userContent,
          true,
        )
      }
    }

    // No custom variables copied — new packs start clean

    return pack
  }

  async duplicatePack(
    sourcePackId: string,
    name: string,
    description?: string,
    author?: string,
  ): Promise<PresetPack> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('提示词包名称不能为空')
    const source = await database.getPack(sourcePackId)
    if (!source) throw new Error('Source Pack not found')
    return database.duplicatePack(sourcePackId, {
      id: crypto.randomUUID(),
      name: cleanName,
      description: description ?? source.description,
      author: author ?? source.author,
      isDefault: false,
    })
  }

  async getPackUsageStories(packId: string): Promise<PackUsageStory[]> {
    return database.getPackUsageStories(packId)
  }

  /** Validate all selected stories before performing one atomic Pack reassignment. */
  async reassignStoriesPack(storyIds: string[], targetPackId: string): Promise<void> {
    const targetPack = await database.getPack(targetPackId)
    if (!targetPack) throw new Error('Target Pack not found')
    const variables = await database.getPackVariables(targetPackId)
    const missingByStory: string[] = []
    for (const storyId of [...new Set(storyIds)]) {
      const values = await database.getStoryCustomVariables(storyId)
      const missing = missingRequiredVariables(variables, values)
      if (missing.length > 0) {
        missingByStory.push(
          `${storyId}: ${missing.map((variable) => variable.displayName).join('、')}`,
        )
      }
    }
    if (missingByStory.length > 0) {
      throw new Error(`以下故事缺少目标 Pack 的必填变量：\n${missingByStory.join('\n')}`)
    }
    await database.reassignStoriesPack(storyIds, targetPackId)
  }

  /**
   * Update pack metadata (name, description, author).
   */
  async updatePack(
    id: string,
    updates: { name?: string; description?: string | null; author?: string | null },
  ): Promise<void> {
    await database.updatePack(id, updates)
  }

  /**
   * Split a pack's edited templates by whether the app has shipped newer text for them.
   *
   * Returned as template ids; the caller names them for display. Ids the app no longer ships
   * appear in neither group -- there is nothing to compare them against.
   */
  async classifyPackTemplates(packId: string): Promise<ClassifiedTemplates> {
    const rows = await database.getPackTemplates(packId)

    const shippedHashes = new Map(
      await Promise.all(
        rows.map(async (row) => {
          const shipped = this.getDefaultContent(row.templateId)
          return [row.templateId, shipped === null ? undefined : await hashContent(shipped)] as [
            string,
            string | undefined,
          ]
        }),
      ).then((entries) => entries.filter((e): e is [string, string] => e[1] !== undefined)),
    )

    return classifyTemplates(rows, shippedHashes)
  }

  /**
   * Return a pack's edited templates to the shipped text, at the scope the user chose.
   *
   * `'behind'` takes only the templates the app has changed since; `'edited'` takes every
   * edit, which is what keeps a set of related customisations coherent rather than leaving
   * half of it against the other half's replacement.
   *
   * Restricted to the default pack: a custom pack's baseline is not the shipped text -- for
   * an imported pack it is the file its author wrote, so this would overwrite their prompts
   * rather than restore anything.
   */
  async refreshTemplates(packId: string, scope: RefreshScope): Promise<number> {
    const pack = await database.getPack(packId)
    if (!pack) throw new Error('Pack not found')
    if (!pack.isDefault) {
      throw new Error(
        'Only the built-in pack can be refreshed from the shipped prompts — a custom pack’s templates came from its author, not from the app.',
      )
    }

    const { behind, customised } = await this.classifyPackTemplates(packId)
    const templateIds = scope === 'behind' ? behind : [...behind, ...customised]
    if (templateIds.length === 0) return 0

    const rows = await Promise.all(
      templateIds.map(async (templateId) => {
        const content = this.getDefaultContent(templateId)!
        return { templateId, content, contentHash: await hashContent(content) }
      }),
    )

    await database.refreshPackTemplatesToShipped(packId, rows)
    return rows.length
  }

  /** Delete a pack. Default pack and packs in use by stories cannot be deleted. */
  async deletePack(packId: string): Promise<{ deleted: boolean; reason?: string }> {
    const pack = await database.getPack(packId)
    if (!pack) return { deleted: false, reason: 'Pack not found' }
    if (pack.isDefault) return { deleted: false, reason: 'Cannot delete the default pack' }

    const canDelete = await database.canDeletePack(packId)
    if (!canDelete) {
      return {
        deleted: false,
        reason: 'Pack is in use by one or more stories. Reassign stories first.',
      }
    }

    await database.deletePack(packId)
    return { deleted: true }
  }

  /**
   * Check if a template in a pack has been modified from the default baseline.
   * Compares the pack template's content hash against the hash of the default content.
   */
  async isTemplateModified(packId: string, templateId: string): Promise<boolean> {
    const packTemplate = await database.getPackTemplate(packId, templateId)
    if (!packTemplate) return false

    // Find default baseline content
    const defaultContent = this.getDefaultContent(templateId)
    if (defaultContent === null) return false

    const defaultHash = await hashContent(defaultContent)
    return packTemplate.contentHash !== defaultHash
  }

  /**
   * Get modification status for all templates in a pack.
   * Returns a map of templateId -> isModified.
   */
  async getModifiedTemplates(packId: string): Promise<Map<string, boolean>> {
    const templates = await database.getPackTemplates(packId)
    const result = new Map<string, boolean>()

    for (const template of templates) {
      const defaultContent = this.getDefaultContent(template.templateId)
      if (defaultContent === null) {
        result.set(template.templateId, false)
        continue
      }
      const defaultHash = await hashContent(defaultContent)
      result.set(template.templateId, template.contentHash !== defaultHash)
    }

    return result
  }

  /** Reset a template to the default baseline content. */
  async resetTemplate(packId: string, templateId: string): Promise<boolean> {
    const defaultContent = this.getDefaultContent(templateId)
    if (defaultContent === null) return false

    await database.setPackTemplateContent(packId, templateId, defaultContent, true)
    return true
  }

  /** Same save path for the pack editor and the Inspector; validate both halves first. */
  async saveTemplatePair(
    packId: string,
    templateId: string,
    next: { system: string; user?: string },
    expected: { system: string; user?: string },
  ): Promise<void> {
    const key = `${packId}:${templateId}`
    if (this.savingTemplates.has(key)) throw new Error('该模板正在保存，请稍后重试。')
    this.savingTemplates.add(key)
    try {
      const builder = await ContextBuilder.forPackId(packId)
      const current = await builder.inspectTemplate(templateId)
      if (
        current.systemTemplate !== expected.system ||
        (expected.user !== undefined && current.userTemplate !== expected.user)
      ) {
        throw new Error('模板已被其他编辑器修改，请重新加载后再保存。')
      }
      const variables = (await database.getPackVariables(packId)).map((v) => v.variableName)
      const errors = [next.system, next.user ?? ''].flatMap((content) =>
        validateTemplate(content, variables).errors.filter(
          (error) => error.type !== 'unknown_variable',
        ),
      )
      if (errors.length) throw new Error(errors.map((error) => error.message).join('\n'))
      if (templateId === 'collaborative-chinese-writer') {
        const user = next.user ?? current.userTemplate
        if (!user.trim())
          throw new Error(
            '中文写作 Writer 的 user 模板不能为空；旧版缺失 user 与显式清空不是同一配置。',
          )
        if (!templateEngine.extractVariableNames(user).includes('novelAgentContext')) {
          throw new Error(
            '中文写作 Writer 的 user 模板必须引用 {{ novelAgentContext }}，不能省略本轮 Agent 原文上下文。',
          )
        }
      }
      await database.setPackTemplateContent(packId, templateId, next.system, false)
      if (next.user !== undefined) {
        await database.setPackTemplateContent(packId, `${templateId}-user`, next.user, false)
      }
    } finally {
      this.savingTemplates.delete(key)
    }
  }

  /**
   * Refresh default pack templates whose code baseline has changed.
   * Untouched templates follow the application baseline; editor changes remain pinned.
   */
  private async refreshDefaultPackTemplates(
    existingByTemplateId: Map<string, PackTemplate>,
  ): Promise<void> {
    for (const template of PROMPT_TEMPLATES) {
      // Check system prompt content
      const existing = existingByTemplateId.get(template.id)
      if (existing && isUntouched(existing)) {
        const newHash = await hashContent(template.content)
        if (existing.contentHash !== newHash) {
          await database.setPackTemplateContent('default-pack', template.id, template.content, true)
        }
      }

      // Check user content
      if (template.userContent) {
        const userContentId = `${template.id}-user`
        const existingUser = existingByTemplateId.get(userContentId)
        if (existingUser && isUntouched(existingUser)) {
          const newUserHash = await hashContent(template.userContent)
          if (existingUser.contentHash !== newUserHash) {
            await database.setPackTemplateContent(
              'default-pack',
              userContentId,
              template.userContent,
              true,
            )
          }
        }
      }
    }
  }

  /**
   * Get the default baseline content for a template ID.
   * Handles both system prompt (template.id) and user message (template.id + '-user') patterns.
   */
  getDefaultContent(templateId: string): string | null {
    // Check for user content template (e.g., 'adventure-user')
    if (templateId.endsWith('-user')) {
      const baseId = templateId.replace(/-user$/, '')
      const template = PROMPT_TEMPLATES.find((t) => t.id === baseId)
      return template?.userContent ?? null
    }

    // System prompt content
    const template = PROMPT_TEMPLATES.find((t) => t.id === templateId)
    return template?.content ?? null
  }
}

/** Singleton pack service instance */
export const packService = new PackService()
