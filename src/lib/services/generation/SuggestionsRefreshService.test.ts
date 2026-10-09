import { describe, expect, it, vi } from 'vitest'
import {
  SuggestionsRefreshService,
  type SuggestionsRefreshInput,
} from './SuggestionsRefreshService'

vi.mock('$lib/services/ai/utils/TranslationService', () => ({
  TranslationService: { shouldTranslate: () => true },
}))

describe('manual collaborative suggestions', () => {
  it.each([true, false])('translation routing for collaborative=%s', async (isCollaborative) => {
    const suggestions = [{ text: '检查信封', type: 'action' as const }]
    const deps = {
      generateSuggestions: vi.fn(async () => ({ suggestions })),
      translateSuggestions: vi.fn(async () => suggestions),
    }
    const result = await new SuggestionsRefreshService(deps).refresh({
      storyId: 'story',
      entries: [
        { type: 'narration', content: '现有正文' } as SuggestionsRefreshInput['entries'][number],
      ],
      pendingQuests: [],
      storyMode: 'creative-writing',
      lastLorebookRetrieval: null,
      translationSettings: {
        enabled: true,
        sourceLanguage: 'zh',
        targetLanguage: 'zh',
        translateNarration: true,
        translateUserInput: true,
        translateWorldState: true,
      },
      isCollaborative,
    } as SuggestionsRefreshInput)
    expect(deps.generateSuggestions).toHaveBeenCalledOnce()
    expect(deps.translateSuggestions).toHaveBeenCalledTimes(isCollaborative ? 0 : 1)
    expect(result.translated).toBe(!isCollaborative)
  })
})
