import { buildCardContext, importOrganizationRules } from './cardContext'
import { generateStructured } from '$lib/services/ai/sdk/generate'
import { countTokens } from '$lib/services/tokenizer'
import { settings } from '$lib/stores/settings.svelte'
import { createLogger } from '$lib/log'
import type { ServiceId } from '$lib/stores/settings.svelte'
import { BaseAIService } from '$lib/services/ai/BaseAIService'
import type { GeneratedCharacter } from '$lib/services/ai/sdk'
import type { Genre } from '$lib/services/ai/wizard'
import { ContextBuilder } from '$lib/services/context'
import { cardImportResultSchema, vaultCharacterImportSchema } from './schemas'
import type { CardImportResult, ParsedCard, SanitizedCharacter } from './types'
import { parseJson } from './parseJson'

const log = createLogger('characterCardImport:aiService')

function normalizeUserMacro(text: string): string {
  if (!text) return ''
  return text.replace(/\{\{user}}/gi, '{{user}}')
}

export interface OrganizationOptions {
  signal?: AbortSignal
  variables?: Record<string, string>
}

export async function inspectCardImport(
  packId: string | undefined,
  card: ParsedCard,
  templateId: string,
  options: OrganizationOptions = {},
  genre = 'custom',
) {
  const ctx = await ContextBuilder.forPackId(packId)
  // These tokens are literal SillyTavern macros, not missing Liquid variables.
  ctx.add({
    ...options.variables,
    user: '{{user}}',
    char: '{{char}}',
    title: card.name,
    genre,
    cardContent: buildCardContext(card),
  })
  const inspected = await ctx.inspectTemplate(templateId)
  if (inspected.renderErrors.length) throw new Error('整理提示词存在语法错误，请在提示词包中修复。')
  const presetId = settings.getServicePresetId('characterCardImport')
  const preset = settings.getPresetConfig(presetId, templateId)
  const profile = settings.getProfile(
    preset.profileId ?? settings.apiSettings.mainNarrativeProfileId,
  )
  return {
    ...inspected,
    system: inspected.system + importOrganizationRules,
    preset,
    profile,
    stPresetSource: '现有角色卡整理模板；无内置 STpreset 来源',
    context: ctx.getContext(),
  }
}

function checkInputBudget(system: string, prompt: string) {
  if (countTokens(system + '\n' + prompt) > 24000)
    throw new Error(
      '角色卡材料超过单次整理安全预算（24000 tokens）。未截断内容；可跳过整理，按原资料导入。',
    )
}

class AIService extends BaseAIService {
  constructor(serviceId: ServiceId = 'characterCardImport') {
    super(serviceId)
  }

  async convertCardToScenario(
    packId: string | undefined,
    parsedCard: ParsedCard,
    genre: Genre,
    options: OrganizationOptions = {},
  ): Promise<CardImportResult> {
    const cardTitle = parsedCard.name
    const inspected = await inspectCardImport(
      packId,
      parsedCard,
      'character-card-import',
      options,
      genre,
    )
    checkInputBudget(inspected.system, inspected.user)
    const result = await generateStructured(
      {
        presetId: this.presetId,
        schema: cardImportResultSchema,
        system: inspected.system,
        prompt: inspected.user,
        signal: options.signal,
      },
      'character-card-import',
    )

    const npcs: GeneratedCharacter[] = result.npcs.map((npc) => ({
      name: npc.name,
      role: npc.role,
      description: npc.description,
      relationship: npc.relationship,
      traits: npc.personality
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    }))

    log('Card import successful', {
      primaryCharacter: result.primaryCharacterName,
      npcCount: npcs.length,
    })

    return {
      success: true,
      settingSeed: result.settingSeed,
      npcs,
      primaryCharacterName: result.primaryCharacterName,
      storyTitle: result.primaryCharacterName || cardTitle,
      firstMessage: normalizeUserMacro(parsedCard.firstMessage),
      alternateGreetings: parsedCard.alternateGreetings.map((g) => normalizeUserMacro(g)),
      errors: [],
    }
  }

  async sanitizeCharacterCard(
    packId: string | undefined,
    parsedCard: ParsedCard,
    options: OrganizationOptions = {},
  ): Promise<SanitizedCharacter> {
    const inspected = await inspectCardImport(packId, parsedCard, 'vault-character-import', options)
    checkInputBudget(inspected.system, inspected.user)
    const result = await generateStructured(
      {
        presetId: this.presetId,
        schema: vaultCharacterImportSchema,
        system: inspected.system,
        prompt: inspected.user,
        signal: options.signal,
      },
      'vault-character-import',
    )

    log('Character sanitization successful', { name: result.name })

    return {
      name: result.name,
      description: result.description,
      traits: result.traits,
      visualDescriptors: result.visualDescriptors,
    }
  }
}

const aiService = new AIService()

/**
 * Convert a parsed character card into a clean character card using LLM.
 */
export async function clean(
  packId: string | undefined,
  jsonString: string,
  genre: Genre = 'fantasy',
  options: OrganizationOptions = {},
): Promise<CardImportResult> {
  const card = parseJson(jsonString)
  if (!card) {
    return {
      success: false,
      settingSeed: '',
      npcs: [],
      primaryCharacterName: '',
      storyTitle: '',
      firstMessage: '',
      alternateGreetings: [],
      errors: [
        'Failed to parse character card. Please ensure the file is a valid SillyTavern character card JSON.',
      ],
    }
  }

  log('Parsed card:', { name: card.name, version: card.version })

  return await aiService.convertCardToScenario(packId, card, genre, options)
}

/**
 * Sanitize a character card using LLM to extract clean character data.
 */
export async function sanitize(
  packId: string | undefined,
  jsonString: string,
  options: OrganizationOptions = {},
): Promise<SanitizedCharacter | null> {
  const card = parseJson(jsonString)
  if (!card) {
    log('Failed to parse card for sanitization')
    return null
  }

  return await aiService.sanitizeCharacterCard(packId, card, options)
}
