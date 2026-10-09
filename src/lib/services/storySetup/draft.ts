import type { Character, StoryMode, StorySettings, StoryImportSource } from '$lib/types'
import type { ParsedCard } from '../characterCardImport/types'
import type { ImportedEntry } from '../lorebookImportExport/types'
import { extractEmbeddedLorebook } from '../lorebookImportExport/import/embedded'
import type { STChatMessage } from '../stChatImporter'

export interface SelectedMaterial<T> {
  key: string
  selected: boolean
  origin: 'card' | 'manual'
  value: T
}
export interface CardImportDraft {
  rawJson: string
  filename: string
  selections: { characters: boolean; scenario: boolean; lorebook: boolean }
  characters: SelectedMaterial<Partial<Character>>[]
  background: string
  lore: SelectedMaterial<ImportedEntry>[]
  greetings: string[]
  selectedGreeting: number
}
export interface StorySetupDraft {
  version: 1
  mode: StoryMode
  title: string
  packId: string
  variables: Record<string, string>
  background: string
  protagonist: Partial<Character>
  characters: SelectedMaterial<Partial<Character>>[]
  lore: SelectedMaterial<ImportedEntry>[]
  opening: string
  initialInput: string
  settings: StorySettings & { pov: 'first' | 'second' | 'third'; tense: 'past' | 'present' }
  card: CardImportDraft | null
  chat: { filename: string; messages: STChatMessage[] } | null
  openingSource: 'card' | 'chat' | 'manual'
}

export function createSetupDraft(mode: StoryMode): StorySetupDraft {
  return {
    version: 1,
    mode,
    title: '',
    packId: '',
    variables: {},
    background: '',
    protagonist: {},
    characters: [],
    lore: [],
    opening: '',
    initialInput: '',
    card: null,
    chat: null,
    openingSource: 'manual',
    settings: {
      pov: mode === 'creative-writing' ? 'third' : 'second',
      tense: 'present',
      tone: '',
      targetLength: 'dynamic',
      imageGenerationMode: 'none',
      backgroundImagesEnabled: false,
      referenceMode: false,
      visualProseMode: false,
    },
  }
}

export function createCardDraft(
  card: ParsedCard,
  rawJson: string,
  filename: string,
  portrait?: string,
): CardImportDraft {
  const description = [card.description, card.personality].filter((v) => v.trim()).join('\n\n')
  const worldbookOnly =
    !card.personality.trim() && /世界书|世界观|设定集|world\s*(book|lore|setting)/i.test(card.name)
  const embedded = card.characterBook
    ? extractEmbeddedLorebook(card.characterBook, card.name)
    : null
  return {
    rawJson,
    filename,
    selections: { characters: true, scenario: true, lorebook: true },
    characters:
      description.trim() && !worldbookOnly
        ? [
            {
              key: 'card:primary',
              origin: 'card',
              selected: true,
              value: {
                name: card.name,
                description,
                traits: [],
                ...(portrait ? { portrait } : {}),
              },
            },
          ]
        : [],
    background: [worldbookOnly ? description : '', card.scenario]
      .filter((v) => v.trim())
      .join('\n\n'),
    lore: (embedded?.result.entries ?? []).map((value, index) => ({
      key: `lore:${value.originalData?.uid ?? index}`,
      origin: 'card',
      selected: true,
      value,
    })),
    greetings: [card.firstMessage, ...card.alternateGreetings].filter((v) => v.trim()),
    selectedGreeting: 0,
  }
}

export function replaceUser(text: string, name?: string | null): string {
  return name?.trim() ? text.replace(/\{\{user\}\}/gi, () => name.trim()) : text
}
export function replaceLoreUser(entry: ImportedEntry, name?: string | null): ImportedEntry {
  return {
    ...entry,
    name: replaceUser(entry.name, name),
    description: replaceUser(entry.description, name),
    keywords: entry.keywords.map((v) => replaceUser(v, name)),
    aliases: entry.aliases.map((v) => replaceUser(v, name)),
  }
}

export function selectedSetup(draft: StorySetupDraft) {
  const card = draft.card
  const characters = [
    ...(card?.selections.characters ? card.characters : []),
    ...draft.characters,
  ].filter((v) => v.selected && v.value.name?.trim())
  const lore = [...(card?.selections.lorebook ? card.lore : []), ...draft.lore].filter(
    (v) => v.selected,
  )
  const background = [card?.selections.scenario ? card.background : '', draft.background]
    .filter((v) => v?.trim())
    .join('\n\n')
  const chatMessages = draft.openingSource === 'chat' ? draft.chat?.messages : undefined
  const opening =
    draft.openingSource === 'card'
      ? (card?.greetings[card.selectedGreeting] ?? '')
      : draft.openingSource === 'manual'
        ? draft.opening
        : ''
  return { characters, lore, background, chatMessages, opening }
}

export function setupProblems(draft: StorySetupDraft): string[] {
  const result: string[] = []
  if (!draft.packId) result.push('请选择提示词包。')
  if (draft.mode === 'adventure') {
    if (!draft.protagonist.name?.trim()) result.push('请填写主角姓名。')
    const { opening, chatMessages } = selectedSetup(draft)
    if (!opening.trim() && !chatMessages?.some((v) => v.type === 'narration' && v.content.trim()))
      result.push('请选择、填写或主动生成一段开场正文。')
  }
  return result
}

export function setupPayload(draft: StorySetupDraft) {
  const selected = selectedSetup(draft)
  const name = draft.protagonist.name?.trim() || null
  const importSource: StoryImportSource | undefined =
    draft.card || draft.chat
      ? {
          sourceType: draft.card
            ? draft.chat
              ? 'sillytavern-card-and-chat'
              : 'sillytavern-card'
            : 'sillytavern-chat',
          originalFilename: draft.card?.filename ?? draft.chat?.filename,
          chatFilename: draft.chat?.filename,
          rawCardJson: draft.card?.rawJson,
          importedAt: Date.now(),
          status: 'raw',
          lastError: null,
          selections: draft.card ? { ...draft.card.selections } : undefined,
          userReplacement: name,
          excludedSourceKeys: draft.card
            ? [...draft.card.characters, ...draft.card.lore]
                .filter((v) => !v.selected)
                .map((v) => v.key)
            : undefined,
          organizationEnabled: true,
          backgroundText: draft.card?.selections.scenario
            ? replaceUser(draft.card.background, name).trim()
            : '',
          greetings: draft.card?.greetings.slice(),
        }
      : undefined
  return {
    title: draft.title.trim() || '未命名故事',
    genre: draft.mode === 'creative-writing' ? '中文写作' : '',
    description: replaceUser(selected.background, name).trim() || undefined,
    mode: draft.mode,
    settings: {
      ...draft.settings,
      ...(draft.mode === 'creative-writing'
        ? {
            visualProseMode: false,
            imageGenerationMode:
              draft.settings.imageGenerationMode === 'manual'
                ? ('manual' as const)
                : ('none' as const),
          }
        : {}),
    },
    protagonist: { ...draft.protagonist, name: name ?? undefined },
    startingLocation: {},
    initialItems: [],
    characters: selected.characters.map(({ value, key, origin }) => ({
      ...value,
      metadata: { ...value.metadata, ...(origin === 'card' ? { importSourceKey: key } : {}) },
      name: replaceUser(value.name ?? '', name),
      description: replaceUser(value.description ?? '', name),
      relationship:
        value.relationship && value.relationship !== 'self'
          ? replaceUser(value.relationship, name)
          : null,
      traits: (value.traits ?? []).map((v) => replaceUser(v, name)),
    })),
    importedEntries: selected.lore.map(({ value }) => replaceLoreUser(value, name)),
    importEntrySourceKeys: selected.lore.map((v) => v.key),
    openingScene: replaceUser(selected.opening, name).trim() || undefined,
    openingVariants:
      draft.openingSource === 'card'
        ? draft.card?.greetings.map((v) => replaceUser(v, name))
        : undefined,
    selectedOpeningVariantId:
      draft.openingSource === 'card' ? `opening-${draft.card?.selectedGreeting ?? 0}` : undefined,
    chatMessages: selected.chatMessages,
    initialUserInput: draft.initialInput.trim() || undefined,
    packId: draft.packId,
    customVariableValues: { ...draft.variables },
    importSource,
  }
}

/** Legacy drafts are copied, never removed until a complete save succeeds. */
export function migrateLegacyDraft(
  mode: StoryMode,
  value: Record<string, unknown>,
): StorySetupDraft {
  const draft = createSetupDraft(mode)
  for (const key of ['title', 'initialInput'] as const)
    if (typeof value[key] === 'string') draft[key] = value[key]
  if (typeof value.context === 'string') draft.background = value.context
  if (typeof value.protagonistName === 'string') draft.protagonist.name = value.protagonistName
  for (const key of ['packId', 'background', 'opening'] as const)
    if (typeof value[key] === 'string') draft[key] = value[key]
  if (value.variables && typeof value.variables === 'object')
    draft.variables = value.variables as Record<string, string>
  return draft
}

/** Reject corrupt persisted drafts before assigning them to reactive form state. */
export function restoreSetupDraft(value: unknown, mode: StoryMode): StorySetupDraft {
  if (!value || typeof value !== 'object') throw new Error('草稿格式不完整')
  const d = value as StorySetupDraft
  if (
    d.version !== 1 ||
    d.mode !== mode ||
    !d.settings ||
    !d.protagonist ||
    !d.variables ||
    !['title', 'packId', 'background', 'opening', 'initialInput'].every(
      (k) => typeof (d as unknown as Record<string, unknown>)[k] === 'string',
    ) ||
    !['manual', 'card', 'chat'].includes(d.openingSource)
  )
    throw new Error('草稿格式不完整')
  const materials = (items: unknown) =>
    Array.isArray(items) &&
    items.every(
      (i) =>
        i &&
        typeof i.key === 'string' &&
        typeof i.selected === 'boolean' &&
        i.value &&
        typeof i.value === 'object',
    )
  if (!materials(d.characters) || !materials(d.lore)) throw new Error('草稿资料不完整')
  if (
    d.card &&
    (!d.card.selections ||
      typeof d.card.rawJson !== 'string' ||
      typeof d.card.background !== 'string' ||
      !materials(d.card.characters) ||
      !materials(d.card.lore) ||
      !Array.isArray(d.card.greetings))
  )
    throw new Error('角色卡草稿不完整')
  if (
    d.chat &&
    (!Array.isArray(d.chat.messages) ||
      !d.chat.messages.every(
        (m) => typeof m.content === 'string' && ['narration', 'user_action'].includes(m.type),
      ))
  )
    throw new Error('聊天草稿不完整')
  return d
}
