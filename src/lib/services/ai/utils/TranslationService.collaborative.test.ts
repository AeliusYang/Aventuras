import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  generate: vi.fn(),
  plain: vi.fn(),
  story: { mode: 'creative-writing', settings: { collaborativeNovelWorkflow: {} } },
}))
vi.mock('$lib/services/database', () => ({ database: { getStory: async () => mocks.story } }))
vi.mock('$lib/services/context', () => ({
  ContextBuilder: { forPack: async () => ({ add: vi.fn(), render: mocks.render }) },
}))
vi.mock('../sdk/generate', () => ({
  generateStructured: mocks.generate,
  generatePlainText: mocks.plain,
}))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: { getServicePresetId: () => 'translation' },
}))
import { TranslationService } from './TranslationService'

describe('collaborative translation defense', () => {
  it('bypasses every story translation endpoint even with translation requested', async () => {
    const service = new TranslationService('translation:narration')
    expect(await service.translateNarration('正文', 'zh', false, 'story')).toEqual({
      translatedContent: '正文',
    })
    expect(await service.translateInput('继续', 'zh', 'story')).toEqual({
      translatedContent: '继续',
    })
    const items = [{ id: 'name', text: '林舟', type: 'name' as const }]
    expect(await service.translateUIElements(items, 'zh', 'story')).toBe(items)
    const suggestions = [{ text: '检查窗台', type: 'action' }]
    expect(await service.translateSuggestions(suggestions, 'zh', 'story')).toBe(suggestions)
    expect(await service.translateActionChoices(suggestions, 'zh', 'story')).toBe(suggestions)
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.plain).not.toHaveBeenCalled()
  })
})
