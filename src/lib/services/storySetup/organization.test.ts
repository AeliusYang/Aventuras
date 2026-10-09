import { describe, it, expect, vi, beforeEach } from 'vitest'
const services = vi.hoisted(() => ({
  clean: vi.fn(),
  sanitize: vi.fn(),
  inspectCardImport: vi.fn(),
}))
vi.mock('../characterCardImport/aiService', () => services)
import { createCardDraft } from './draft'
import { organizeCard, applyOrganization } from './organization'
import { parseJson } from '../characterCardImport/parseJson'

function card() {
  const raw = JSON.stringify({
    name: '沈宁',
    description: '修复师',
    personality: '谨慎',
    scenario: '旧渡口',
    first_mes: '候选开场',
    mes_example: '',
  })
  return createCardDraft(parseJson(raw)!, raw, 'card.json')
}
beforeEach(() => vi.resetAllMocks())
describe('optional organization candidates', () => {
  it('does not call AI during parsing, and only calls selected services', async () => {
    const draft = card()
    expect(services.clean).not.toHaveBeenCalled()
    expect(services.sanitize).not.toHaveBeenCalled()
    draft.selections.characters = false
    services.clean.mockResolvedValue({ success: true, settingSeed: '候选背景', npcs: [] })
    const result = await organizeCard(draft, 'my-pack', { custom: '值' })
    expect(services.sanitize).not.toHaveBeenCalled()
    expect(services.clean).toHaveBeenCalledWith('my-pack', draft.rawJson, 'custom', {
      variables: { custom: '值' },
      signal: undefined,
    })
    expect(draft.background).toBe('旧渡口')
    expect(applyOrganization(draft, result).background).toBe('候选背景')
  })
  it('keeps deselections and edits after partial failure or empty results', async () => {
    const draft = card()
    draft.characters[0].selected = false
    draft.characters.push({
      key: 'manual',
      origin: 'manual',
      selected: true,
      value: { name: '手写人物', description: '保留' },
    })
    services.clean.mockResolvedValue({ success: true, settingSeed: '', npcs: [] })
    const empty = await organizeCard(draft, 'p', {})
    expect(empty.warnings).toHaveLength(1)
    expect(services.sanitize).not.toHaveBeenCalled()
    expect(applyOrganization(draft, empty)).toEqual(draft)
    const next = applyOrganization(draft, {
      character: { name: '沈宁', description: '整理资料', traits: [], visualDescriptors: {} },
      scenario: {
        success: true,
        settingSeed: '新背景',
        npcs: [{ name: '沈宁', description: '重复', role: '', relationship: '', traits: [] }],
        firstMessage: '',
        alternateGreetings: [],
        primaryCharacterName: '',
        storyTitle: '',
        errors: [],
      },
      warnings: [],
    })
    expect(next.characters).toHaveLength(2)
    expect(next.characters[0].selected).toBe(false)
    expect(next.characters[1].value.description).toBe('保留')
  })
  it('never promotes a worldbook title to a character', async () => {
    const raw = JSON.stringify({
      name: '江城世界书',
      description: '背景规则',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
    })
    const draft = createCardDraft(parseJson(raw)!, raw, 'world.json')
    services.clean.mockResolvedValue({ success: true, settingSeed: '城市背景', npcs: [] })
    const result = await organizeCard(draft, 'p', {})
    expect(services.sanitize).not.toHaveBeenCalled()
    expect(applyOrganization(draft, result).characters).toEqual([])
  })
  it('retains successful candidates when one service fails, and rejects cancellation', async () => {
    services.clean.mockRejectedValue(new Error('timeout'))
    services.sanitize.mockResolvedValue({
      name: '沈宁',
      description: '修复师',
      traits: [],
      visualDescriptors: {},
    })
    const draft = card()
    const result = await organizeCard(draft, 'p', {})
    expect(result.character?.name).toBe('沈宁')
    expect(result.warnings[0]).toContain('timeout')
    expect(draft.background).toBe('旧渡口')
    const controller = new AbortController()
    controller.abort()
    await expect(organizeCard(draft, 'p', {}, controller.signal)).rejects.toThrow()
  })
})
