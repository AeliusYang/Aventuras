import { describe, expect, it } from 'vitest'
import {
  createCardDraft,
  createSetupDraft,
  selectedSetup,
  setupPayload,
  setupProblems,
  replaceUser,
  restoreSetupDraft,
} from './draft'
import { buildCardContext } from '../characterCardImport/cardContext'
import type { ParsedCard } from '../characterCardImport/types'

const card: ParsedCard = {
  name: '雨夜',
  version: 'v3',
  description: '',
  personality: '',
  scenario: '',
  exampleMessages: '',
  firstMessage: '{{user}}到达旧站。',
  alternateGreetings: ['另一个开场'],
  characterBook: {
    entries: [
      {
        uid: 7,
        comment: '{{user}}的住所',
        key: ['{{user}}'],
        content: '世界书中的人物与背景',
        order: 1,
      },
    ],
  },
}

describe('story setup draft', () => {
  it('keeps explicit manual illustrations, portrait references and backgrounds when creating a Chinese story', () => {
    const draft = createSetupDraft('creative-writing')
    expect(setupPayload(draft).settings?.imageGenerationMode).toBe('none')
    draft.settings.imageGenerationMode = 'manual'
    draft.settings.referenceMode = true
    draft.settings.backgroundImagesEnabled = true
    expect(setupPayload(draft).settings).toMatchObject({
      imageGenerationMode: 'manual',
      referenceMode: true,
      backgroundImagesEnabled: true,
    })
  })
  it('allows blank collaborative stories and requires only an adventure protagonist and opening', () => {
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'custom'
    expect(setupProblems(draft)).toEqual([])
    expect(setupPayload(draft)).toMatchObject({
      packId: 'custom',
      protagonist: {},
      startingLocation: {},
      characters: [],
    })
    expect(setupPayload(draft).openingScene).toBeUndefined()
    draft.mode = 'adventure'
    expect(setupProblems(draft)).toHaveLength(2)
    draft.protagonist.name = '林舟'
    draft.opening = '雨停了。'
    expect(setupProblems(draft)).toEqual([])
    expect(setupPayload(draft).description).toBeUndefined()
  })
  it('preserves worldbook-only cards without manufacturing a primary character', () => {
    const parsed = createCardDraft(card, JSON.stringify(card), 'card.json')
    expect(parsed.characters).toEqual([])
    expect(parsed.lore).toHaveLength(1)
    expect(parsed.greetings).toEqual([card.firstMessage, ...card.alternateGreetings])
    const input = buildCardContext(card)
    expect(input).toContain('世界书中的人物与背景')
    expect(input).toContain('另一个开场')
    expect(input).toContain('不是连续历史')
  })
  it('switches affect the saved selection, while manually added material survives', () => {
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'p'
    draft.card = createCardDraft(
      { ...card, description: '人物资料', scenario: '卡片背景' },
      '{}',
      'c.json',
    )
    draft.characters.push({
      key: 'manual',
      origin: 'manual',
      selected: true,
      value: { name: '手写人物' },
    })
    draft.card.selections = { characters: false, scenario: false, lorebook: false }
    draft.background = '手写背景'
    expect(setupPayload(draft).characters.map((v) => v.name)).toEqual(['手写人物'])
    expect(setupPayload(draft).importedEntries).toEqual([])
    expect(setupPayload(draft).description).toBe('手写背景')
    draft.card.selections.characters = true
    draft.card.characters[0].selected = false
    expect(selectedSetup(draft).characters).toHaveLength(1)
  })
  it('applies the same literal user substitution to names, keywords, aliases and greetings', () => {
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'p'
    draft.card = createCardDraft(card, '{}', 'c.json')
    draft.openingSource = 'card'
    draft.card.lore[0].value.aliases = ['{{user}}旧居']
    expect(setupPayload(draft).importedEntries[0].name).toContain('{{user}}')
    draft.protagonist.name = '$&林舟'
    const payload = setupPayload(draft)
    expect(payload.importedEntries[0]).toMatchObject({
      name: '$&林舟的住所',
      keywords: ['$&林舟'],
      aliases: ['$&林舟旧居'],
    })
    expect(payload.openingScene).toBe('$&林舟到达旧站。')
    expect(replaceUser('{{USER}}', '$&')).toBe('$&')
  })
  it('saves chat verbatim instead of duplicating the first narration as an opening', () => {
    const draft = createSetupDraft('adventure')
    draft.packId = 'p'
    draft.protagonist.name = '林舟'
    draft.card = createCardDraft(card, '{}', 'c.json')
    draft.chat = {
      filename: 'c.jsonl',
      messages: [
        { type: 'narration', content: '第一条正文' },
        { type: 'user_action', content: '继续' },
      ],
    }
    draft.openingSource = 'chat'
    expect(setupProblems(draft)).toEqual([])
    const payload = setupPayload(draft)
    expect(payload.openingScene).toBeUndefined()
    expect(payload.chatMessages).toEqual(draft.chat.messages)
    expect(payload.importSource?.greetings).toHaveLength(2)
  })
})

it('rejects corrupt saved drafts before reactive assignment and preserves valid fields', () => {
  const draft = createSetupDraft('creative-writing')
  draft.title = '已写内容'
  draft.packId = 'mine'
  expect(restoreSetupDraft(JSON.parse(JSON.stringify(draft)), 'creative-writing')).toEqual(draft)
  expect(() =>
    restoreSetupDraft(
      { version: 1, mode: 'creative-writing', settings: {}, characters: [], lore: [] },
      'creative-writing',
    ),
  ).toThrow('草稿')
})
