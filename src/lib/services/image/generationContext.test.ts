import { describe, expect, it, vi } from 'vitest'
import type { Character, Entry, Story, StoryEntry } from '$lib/types'
import { generateStructured } from '$lib/services/ai/sdk/generate'
vi.mock('$lib/stores/settings.svelte', () => ({ settings: {} }))
vi.mock('$lib/services/ai/sdk/generate', () => ({
  generateStructured: vi.fn(() => {
    throw new Error('No model allowed')
  }),
}))
import {
  buildImageEvidence,
  ImageIdentityConflict,
  type ImageEvidenceInput,
} from './generationContext'

export const character = (patch: Partial<Character> = {}): Character =>
  ({
    id: 'c',
    storyId: 's',
    name: '林岚',
    description: '',
    visualDescriptors: {},
    traits: [],
    metadata: {},
    portrait: null,
    deleted: false,
    branchId: 'branch',
    ...patch,
  }) as Character
export const lore = (patch: Partial<Entry> = {}): Entry =>
  ({
    id: 'l',
    storyId: 's',
    name: '林岚',
    type: 'character',
    description: '银白长发、琥珀眼，身着北境学院制服。性格警觉。',
    aliases: ['小岚'],
    hiddenInfo: '隐藏王族身份，将来长出黑翼',
    state: { type: 'character' },
    injection: { mode: 'keyword', priority: 50, keywords: ['林岚'] },
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'user',
    branchId: null,
    ...patch,
  }) as Entry
export const prose = (patch: Partial<StoryEntry> = {}): StoryEntry =>
  ({
    id: 'e',
    storyId: 's',
    type: 'narration',
    content: '林岚穿着制服，警惕地望向窗外。',
    createdAt: 10,
    position: 1,
    ...patch,
  }) as StoryEntry
export const fixture = (): ImageEvidenceInput => ({
  story: {
    id: 's',
    mode: 'creative-writing',
    currentBranchId: 'branch',
    settings: {},
    description: '北境学院',
  } as Story,
  characters: [character()],
  lore: [lore()],
  entries: [prose()],
  characterId: 'c',
})

describe('read-only image evidence', () => {
  it('keeps complete lore when the fact character has no appearance, excluding secrets and Director plans', async () => {
    const input = fixture()
    input.entries[0].metadata = {
      directorBrief: '下轮长出黑翼',
      variantSet: { variants: [{ content: '被拒绝正文' }] },
    } as any
    const before = JSON.stringify(input)
    const result = await buildImageEvidence(input)
    expect(result.context).toContain(input.lore[0].description)
    for (const forbidden of ['隐藏王族', '黑翼', '被拒绝正文'])
      expect(result.context).not.toContain(forbidden)
    expect(JSON.stringify(input)).toBe(before)
    expect(generateStructured).not.toHaveBeenCalled()
  })
  it('includes saved summary, original card and unsaved edits separately', async () => {
    const input = fixture()
    input.characters[0] = character({
      description: '学院学生',
      metadata: { characterCard: { personality: '谨慎', scenario: '初入学院' } },
    })
    input.edits = {
      name: '林岚',
      description: '用户补充：成年',
      visualDescriptors: 'Eyes: 金色',
      traits: '',
    }
    const result = await buildImageEvidence(input)
    expect(result.sources.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['character', 'card', 'edit', 'lore', 'prose']),
    )
    for (const value of ['谨慎', '学院学生', '用户补充：成年', '金色'])
      expect(result.context).toContain(value)
  })
  it('reads the actual imported raw card, but never reimports disabled embedded lore', async () => {
    const input = fixture()
    input.story.settings = {
      importSource: {
        sourceType: 'sillytavern-card',
        importedAt: 1,
        status: 'raw',
        rawCardJson: JSON.stringify({
          spec: 'chara_card_v2',
          data: {
            name: '林岚',
            description: '原始银发设定',
            personality: '严肃',
            character_book: { entries: [{ content: '被禁用条目' }] },
          },
        }),
      },
    }
    const result = await buildImageEvidence(input)
    expect(result.context).toContain('原始银发设定')
    expect(result.context).not.toContain('被禁用条目')
  })
  it('resolves aliases and imported concept-type character entries, requiring explicit disambiguation', async () => {
    const input = fixture()
    input.lore = [
      lore({ type: 'concept', name: '设定：林岚', aliases: ['林岚'] }),
      lore({ id: 'l2', name: '另一林岚', aliases: ['林岚'], description: '红发' }),
    ]
    await expect(buildImageEvidence(input)).rejects.toBeInstanceOf(ImageIdentityConflict)
    const result = await buildImageEvidence({ ...input, selectedLoreIds: { 林岚: 'l' } })
    expect(result.context).toContain('银白长发')
    expect(result.context).not.toContain('红发')
  })
  it('does not include disabled, deleted, unrelated or other-story material', async () => {
    const input = fixture()
    input.lore.push(
      lore({
        id: 'disabled',
        name: 'disabled',
        description: '禁用内容',
        injection: { mode: 'never', priority: 100, keywords: ['林岚'] },
      }),
      lore({ id: 'deleted', description: '分支删除内容', deleted: true }),
      lore({ id: 'other', storyId: 'other', description: '其他故事' }),
      lore({
        id: 'unrelated',
        name: '远方NPC',
        aliases: [],
        description: '无关人物',
        injection: { mode: 'keyword', keywords: [], priority: 0 },
      }),
    )
    const result = await buildImageEvidence(input)
    for (const value of ['禁用内容', '分支删除内容', '其他故事', '无关人物'])
      expect(result.context).not.toContain(value)
  })
  it('old prose excludes later dynamic facts, portraits, later lore edits and rejected variants', async () => {
    const input = fixture()
    delete input.characterId
    input.entryId = 'e'
    input.characters[0] = character({
      description: '后来加冕女王',
      visualDescriptors: { clothing: '礼服', distinguishing: '新伤' },
      portrait: 'LATER_IMAGE',
    })
    input.entries.push(prose({ id: 'later', createdAt: 20, content: '林岚登基，换上礼服。' }))
    input.lore.push(
      lore({ id: 'late-lore', updatedAt: 20, description: '后来加冕', name: '王冠', type: 'item' }),
    )
    const result = await buildImageEvidence(input)
    for (const value of ['礼服', '新伤', '登基', '后来加冕'])
      expect(result.context).not.toContain(value)
    expect(result.characters[0].portrait).toBeNull()
    expect(result.context).toContain('制服')
    expect(result.missing.join('')).toContain('旧正文')
  })
  it('only marks people mentioned in the target prose and includes lore-only characters', async () => {
    const input = fixture()
    delete input.characterId
    input.entryId = 'e'
    input.characters.push(character({ id: 'absent', name: '王远' }))
    input.lore.push(
      lore({
        id: 'new',
        name: '苏晴',
        aliases: [],
        description: '苏晴的蓝发',
        injection: { mode: 'keyword', priority: 0, keywords: ['苏晴'] },
      }),
    )
    input.entries[0].content += '苏晴推开门。'
    const result = await buildImageEvidence(input)
    expect(result.characters.map((c) => c.name)).toEqual(['林岚'])
    expect(result.context).toContain('苏晴的蓝发')
  })
  it('fails on name-only or oversized core evidence rather than generating from a truncation', async () => {
    await expect(buildImageEvidence({ ...fixture(), lore: [], entries: [] })).rejects.toThrow(
      '只有人物姓名',
    )
    await expect(buildImageEvidence({ ...fixture(), tokenBudget: 2 })).rejects.toThrow(
      '核心人物资料',
    )
  })
  it('uses nearby accepted prose to resolve a pronoun, without adding every active character', async () => {
    const input = fixture()
    delete input.characterId
    input.entryId = 'next'
    input.entries.push(prose({ id: 'next', content: '她合上信，站到窗边。', createdAt: 20 }))
    input.characters.push(character({ id: 'unrelated', name: '其他同学' }))
    const result = await buildImageEvidence(input)
    expect(result.characters.map((c) => c.name)).toEqual(['林岚'])
    expect(result.context).toContain('银白长发')
    expect(result.missing.join('')).toContain('候选人物')
  })
})
