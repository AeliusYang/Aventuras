import { extractEmbeddedLorebook } from '$lib/services/lorebookImportExport/import/embedded'
import type { ImportedEntry } from '$lib/services/lorebookImportExport/types'
import type { ParsedCard } from './types'

export interface CollaborativeCardImportPayload {
  protagonist: {
    name: string
    description: string
    traits: string[]
  }
  startingLocation: {
    name?: string
    description?: string
  }
  openingScene?: string
  openingVariants?: string[]
  selectedOpeningVariantId?: string
  importedEntries?: ImportedEntry[]
}

function replaceUserPlaceholders(text: string, protagonistName?: string): string {
  const name = protagonistName?.trim()
  return name ? text.replace(/\{\{user\}\}/gi, name) : text
}

/**
 * Build the non-AI portion of a Chinese collaborative story import.
 * Embedded lorebook entries and all greetings are preserved before any optional
 * story-internal organization is requested.
 */
export function buildCollaborativeCardImport(
  card: ParsedCard,
  protagonistName?: string,
): CollaborativeCardImportPayload {
  const resolvedProtagonistName = protagonistName?.trim() || '主角'
  const openings = [card.firstMessage, ...(card.alternateGreetings ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => replaceUserPlaceholders(value, protagonistName))

  const embedded = card.characterBook
    ? extractEmbeddedLorebook(card.characterBook, card.name)
    : null
  const importedEntries = embedded?.result.entries
    .map((entry) => ({
      ...entry,
      name: replaceUserPlaceholders(entry.name, protagonistName),
      description: replaceUserPlaceholders(entry.description, protagonistName),
      keywords: entry.keywords.map((keyword) => replaceUserPlaceholders(keyword, protagonistName)),
      aliases: entry.aliases.map((alias) => replaceUserPlaceholders(alias, protagonistName)),
    }))
    .filter((entry) => entry.name.trim() || entry.description.trim())

  return {
    protagonist: {
      name: resolvedProtagonistName,
      description: '',
      traits: [],
    },
    startingLocation: card.scenario.trim()
      ? {
          name: '导入场景',
          description: replaceUserPlaceholders(card.scenario.trim(), protagonistName),
        }
      : {},
    openingScene: openings[0],
    openingVariants: openings.length > 0 ? openings : undefined,
    selectedOpeningVariantId: openings.length > 0 ? 'opening-0' : undefined,
    importedEntries: importedEntries && importedEntries.length > 0 ? importedEntries : undefined,
  }
}
