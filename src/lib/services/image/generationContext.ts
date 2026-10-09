import type { Character, Entry, Story, StoryEntry } from '$lib/types'
import { EntryRetrievalService } from '$lib/services/ai/retrieval/EntryRetrievalService'
import { entityNameMatches, sameEntityName } from '$lib/utils/text'
import { countTokens } from '$lib/services/tokenizer'
import { parseJson } from '$lib/services/characterCardImport/parseJson'
import { descriptorsToString } from '$lib/utils/visualDescriptors'

export interface ImageSource {
  id: string
  name: string
  kind: 'edit' | 'character' | 'card' | 'lore' | 'prose' | 'world'
  text: string
}
export interface ImageStorySnapshot {
  story: Story
  characters: Character[]
  lore: Entry[]
  entries: StoryEntry[]
}
export interface ImageEvidence {
  storyId: string
  branchId: string | null
  sources: ImageSource[]
  missing: string[]
  context: string
  characters: Character[]
}
export interface ImageEvidenceInput extends ImageStorySnapshot {
  characterId?: string
  entryId?: string
  edits?: { name: string; description: string; visualDescriptors: string; traits: string }
  selectedLoreIds?: Record<string, string>
  tokenBudget?: number
}
export class ImageIdentityConflict extends Error {
  constructor(
    public characterName: string,
    public candidates: { id: string; name: string; description: string }[],
  ) {
    super(`“${characterName}”匹配到多个人物条目，请选择对应设定后再生成。`)
  }
}
const sourceText = (source: ImageSource) =>
  `【${source.kind} · ${source.name} · ${source.id}】\n${source.text}`
const cardText = (character: Character, story: Story) => {
  const card = character.metadata?.characterCard
  const source = story.settings?.importSource
  const raw = source?.rawCardJson ? parseJson(source.rawCardJson) : null
  const primary =
    source?.selections?.characters !== false &&
    !source?.excludedSourceKeys?.includes('card:primary') &&
    raw &&
    (character.metadata?.importSourceKey === 'card:primary' ||
      sameEntityName(raw.name, character.name))
  const data = (
    card && typeof card === 'object' && !Array.isArray(card)
      ? card
      : primary
        ? raw
        : (character.metadata ?? {})
  ) as Record<string, unknown>
  return ['description', 'personality', 'scenario', 'history']
    .flatMap((key) =>
      typeof data[key] === 'string' && data[key].trim() ? [`${key}: ${data[key]}`] : [],
    )
    .join('\n')
    .replace(/\{\{user\}\}/gi, source?.userReplacement || '{{user}}')
}

/** The caller supplies branch-resolved snapshots. Never reads the vault or writes activation history. */
export async function buildImageEvidence(input: ImageEvidenceInput): Promise<ImageEvidence> {
  const { story, edits } = input
  const budget = input.tokenBudget ?? 12000
  const entries = input.entries.filter((entry) => entry.storyId === story.id)
  const targetIndex = input.entryId
    ? entries.findIndex((entry) => entry.id === input.entryId)
    : entries.length - 1
  if (input.entryId && targetIndex < 0)
    throw new Error('目标正文已不在当前分支，请重新打开后生成。')
  const target = input.entryId ? entries[targetIndex] : undefined
  const historical =
    !!target && entries.slice(targetIndex + 1).some((entry) => entry.type === 'narration')
  const history = entries.slice(0, targetIndex + 1).filter((entry) => entry.type === 'narration')
  const available = input.lore.filter(
    (entry) =>
      entry.storyId === story.id &&
      !entry.deleted &&
      entry.injection.mode !== 'never' &&
      (!historical || entry.updatedAt <= target!.createdAt),
  )
  const live = input.characters.filter(
    (character) => character.storyId === story.id && !character.deleted,
  )
  // Pronoun-only prose can use nearby accepted prose to identify candidates, never live presence.
  const namedInTarget =
    live.some((character) => entityNameMatches(character.name, target?.content ?? '')) ||
    available.some(
      (entry) =>
        entry.type === 'character' &&
        [entry.name, ...entry.aliases].some((name) =>
          entityNameMatches(name, target?.content ?? ''),
        ),
    )
  const characterQuery =
    target && !namedInTarget
      ? history
          .slice(-3)
          .map((entry) => entry.content)
          .join('\n')
      : (target?.content ?? '')
  let characters = input.characterId
    ? live.filter((character) => character.id === input.characterId)
    : live.filter((character) => {
        const aliases = available
          .filter((entry) => sameEntityName(entry.name, character.name))
          .flatMap((entry) => entry.aliases)
        return [character.name, ...aliases].some((name) => entityNameMatches(name, characterQuery))
      })
  if (input.characterId && !characters.length) throw new Error('目标角色已不在当前分支。')
  const required: ImageSource[] = []
  const missing: string[] = []
  const excludedIdentities = new Set<string>()
  if (historical) {
    missing.push(
      '旧正文：未使用当前人物状态、简介或肖像参考，避免后续剧情混入；动态外貌以目标正文为准。',
    )
    characters = characters.map((character) => ({
      ...character,
      description: null,
      traits: [],
      visualDescriptors: {},
      portrait: null,
    }))
  }
  for (const character of characters) {
    const names = [character.name, ...(edits?.name ? [edits.name] : [])]
    let matches = available.filter((entry) =>
      names.some((name) =>
        [entry.name, ...entry.aliases].some((alias) => sameEntityName(alias, name)),
      ),
    )
    if (!matches.length)
      matches = available.filter((entry) =>
        names.some((name) =>
          entry.injection.keywords.some((keyword) => sameEntityName(keyword, name)),
        ),
      )
    if (matches.length > 1) {
      const chosen = input.selectedLoreIds?.[character.name]
      if (!chosen || !matches.some((entry) => entry.id === chosen))
        throw new ImageIdentityConflict(
          character.name,
          matches.map(({ id, name, description }) => ({ id, name, description })),
        )
      for (const entry of matches) if (entry.id !== chosen) excludedIdentities.add(entry.id)
      matches = matches.filter((entry) => entry.id === chosen)
    }
    for (const entry of matches)
      required.push({ id: entry.id, name: entry.name, kind: 'lore', text: entry.description })
    if (!matches.length) missing.push(`${character.name}：没有匹配的人物世界书条目。`)
    const original = cardText(character, story)
    if (original)
      required.push({
        id: character.id + ':card',
        name: character.name,
        kind: 'card',
        text: original,
      })
    if (
      character.description ||
      Object.values(character.visualDescriptors ?? {}).some(Boolean) ||
      character.traits.length
    )
      required.push({
        id: character.id,
        name: character.name,
        kind: 'character',
        text: JSON.stringify({
          description: character.description,
          traits: character.traits,
          appearance: character.visualDescriptors,
        }),
      })
  }
  // A person may exist only in the worldbook, before fact maintenance creates a Character.
  if (target) {
    const mentioned = available.filter(
      (entry) =>
        entry.type === 'character' &&
        [entry.name, ...entry.aliases, ...entry.injection.keywords].some(
          (name) => name.trim() && entityNameMatches(name, characterQuery),
        ),
    )
    for (const entry of mentioned) {
      if (
        excludedIdentities.has(entry.id) ||
        required.some((source) => source.id === entry.id) ||
        characters.some((character) =>
          [entry.name, ...entry.aliases].some((name) => sameEntityName(name, character.name)),
        )
      )
        continue
      const peers = mentioned.filter((other) =>
        [other.name, ...other.aliases].some((name) =>
          [entry.name, ...entry.aliases].some((alias) => sameEntityName(name, alias)),
        ),
      )
      if (peers.length > 1) {
        const choice = input.selectedLoreIds?.[peers[0].name]
        if (!choice || !peers.some((peer) => peer.id === choice))
          throw new ImageIdentityConflict(
            peers[0].name,
            peers.map(({ id, name, description }) => ({ id, name, description })),
          )
        for (const peer of peers) if (peer.id !== choice) excludedIdentities.add(peer.id)
        if (choice !== entry.id) continue
      }
      required.push({ id: entry.id, name: entry.name, kind: 'lore', text: entry.description })
    }
  }
  if (edits) {
    const saved = characters[0]
    const changes = Object.fromEntries(
      Object.entries(edits).filter(
        ([key, value]) =>
          value.trim() &&
          value !==
            (
              {
                name: saved?.name,
                description: saved?.description ?? '',
                traits: saved?.traits.join(', '),
                visualDescriptors: descriptorsToString(saved?.visualDescriptors),
              } as Record<string, unknown>
            )[key],
      ),
    )
    if (Object.keys(changes).some((key) => key !== 'name'))
      required.push({
        id: 'current-edit',
        name: edits.name,
        kind: 'edit',
        text: JSON.stringify(changes),
      })
  }
  if (target)
    required.push({
      id: target.id,
      name: '本次配图正文（唯一场景依据）',
      kind: 'prose',
      text: target.content,
    })
  if (target && !namedInTarget)
    missing.push('正文未点名人物：附近已接受正文只用于识别候选人物，不代表本轮都在场。')

  const relevantHistory = input.characterId
    ? history.filter((entry) =>
        characters.some((character) => entityNameMatches(character.name, entry.content)),
      )
    : history.filter((entry) => entry.id !== target?.id)
  if (
    input.characterId &&
    !required.some((source) => source.text.trim()) &&
    !relevantHistory.length
  )
    throw new Error('只有人物姓名，没有可用的人物设定或正文依据。请先补充世界书或人物说明。')

  const query = [
    edits?.name,
    ...characters.map((character) => character.name),
    target?.content,
    ...required
      .filter((source) => source.kind === 'lore' || source.kind === 'card')
      .map((source) => source.text),
  ]
    .filter(Boolean)
    .join('\n')
  const retrieval = new EntryRetrievalService({
    enableLLMSelection: false,
    tier3WholesaleWordBudget: 0,
    maxTier3Entries: 0,
    maxTier2Entries: 20,
    maxWordsPerEntry: 0,
    recentEntriesCount: 0,
    useSceneEntities: false,
  })
  // Public authored descriptions only. No hiddenInfo, dynamic lore state or future AI additions.
  const supporting = available
    .filter(
      (entry) =>
        !excludedIdentities.has(entry.id) &&
        !required.some((source) => source.id === entry.id) &&
        entry.type !== 'character',
    )
    .map((entry) => ({ ...entry, hiddenInfo: null }))
  const retrieved = await retrieval.getRelevantEntries(supporting, query, [], { storyId: story.id })
  const optional: ImageSource[] = [
    ...(!historical && story.description
      ? [{ id: story.id, name: '故事背景', kind: 'world' as const, text: story.description }]
      : []),
    ...retrieved.all.map(({ entry }): ImageSource => ({
      id: entry.id,
      name: entry.name,
      kind: 'lore',
      text: entry.description,
    })),
    ...relevantHistory
      .slice(-8)
      .reverse()
      .map((entry): ImageSource => ({
        id: entry.id,
        name: '已接受正文（历史，不是当前场景）',
        kind: 'prose',
        text: entry.content,
      })),
  ]
  const sources = required.filter((source) => source.text.trim())
  let tokens = countTokens(sources.map(sourceText).join('\n\n'))
  if (tokens > budget)
    throw new Error(
      `核心人物资料或目标正文超出生图资料预算（${budget} tokens），请精简相关条目后重试。`,
    )
  for (const source of optional) {
    const cost = countTokens(sourceText(source)) + 2
    if (tokens + cost <= budget) {
      sources.push(source)
      tokens += cost
    } else missing.push(`预算未纳入：${source.name}（${source.id}）。`)
  }
  return {
    storyId: story.id,
    branchId: story.currentBranchId ?? null,
    sources,
    missing,
    context: sources.map(sourceText).join('\n\n'),
    characters,
  }
}
