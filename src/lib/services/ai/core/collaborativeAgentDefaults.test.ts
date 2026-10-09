import { describe, expect, it } from 'vitest'
import type { StorySettings } from '$lib/types'
import {
  collaborativeServiceIds,
  getCollaborativeAgentTemplateId,
  getCollaborativeRequestMode,
} from './collaborativeAgentDefaults'
import {
  cleanCollaborativeWorkflow,
  isCollaborativeStory,
  normalizeCollaborativeStory,
} from '$lib/services/generation/collaborativeWorkflow'

describe('collaborative agent shared-profile routing', () => {
  it.each(['agentic', 'inline', 'manual'] as const)(
    'normalizes legacy collaborative %s pictures to manual without touching adventure',
    (mode) => {
      const settings = {
        imageGenerationMode: mode,
        referenceMode: true,
        backgroundImagesEnabled: true,
      }
      expect(
        normalizeCollaborativeStory({ mode: 'creative-writing', settings }).settings,
      ).toMatchObject({ ...settings, imageGenerationMode: 'manual' })
      expect(
        normalizeCollaborativeStory({ mode: 'adventure', settings }).settings.imageGenerationMode,
      ).toBe(mode)
      expect(
        normalizeCollaborativeStory({ mode: 'creative-writing', settings: {} as StorySettings })
          .settings.imageGenerationMode,
      ).toBe('none')
    },
  )
  it('defines six independent services while keeping only extraction and suggestions on JSON', () => {
    expect(Object.keys(collaborativeServiceIds)).toEqual([
      'sceneDirector',
      'narrativePlanner',
      'patternReviewer',
      'writer',
      'factStateExtractor',
      'plotSuggestions',
    ])
    for (const key of Object.keys(collaborativeServiceIds) as Array<
      keyof typeof collaborativeServiceIds
    >) {
      expect(getCollaborativeAgentTemplateId(key)).toMatch(/^collaborative-/)
    }
    expect(getCollaborativeRequestMode('factStateExtractor')).toBe('json-text')
    expect(getCollaborativeRequestMode('plotSuggestions')).toBe('json-text')
    expect(getCollaborativeRequestMode('sceneDirector')).toBe('stream-text')
    expect(getCollaborativeRequestMode('narrativePlanner')).toBe('stream-text')
    expect(getCollaborativeRequestMode('patternReviewer')).toBe('stream-text')
    expect(getCollaborativeRequestMode('writer')).toBe('stream-text')
  })

  it('removes legacy story runtime bindings while preserving behavior switches', () => {
    expect(
      cleanCollaborativeWorkflow({
        sceneDirector: { enabled: true, profileId: 'legacy', model: 'legacy', maxTokens: 1 },
        factStateExtractor: { enabled: false, model: 'legacy' },
        targetLength: '2400中文字',
        language: 'zh-CN',
        planEvery: 8,
      }),
    ).toEqual({
      sceneDirector: { enabled: true },
      narrativePlanner: undefined,
      patternReviewer: undefined,
      writer: { enabled: true },
      factStateExtractor: { enabled: false },
      plotSuggestions: undefined,
      planEvery: 8,
      reviewEvery: undefined,
      language: 'zh-CN',
      targetLength: '2400中文字',
      translationsEnabled: undefined,
    })
  })

  it('uses creative-writing as the only runtime collaboration switch', () => {
    expect(isCollaborativeStory({ mode: 'creative-writing' })).toBe(true)
    expect(isCollaborativeStory({ mode: 'adventure' })).toBe(false)
  })

  it('normalizes creative and legacy collaborative stories without promoting empty residue', () => {
    const creative = normalizeCollaborativeStory({
      mode: 'creative-writing' as const,
      settings: {} as StorySettings,
    })
    expect(creative.settings?.collaborativeNovelWorkflow?.sceneDirector).toEqual({ enabled: true })
    expect(creative.settings?.collaborativeNovelWorkflow?.writer).toEqual({ enabled: true })

    const legacy = normalizeCollaborativeStory({
      mode: 'adventure' as const,
      settings: {
        collaborativeNovel: true,
        collaborativeNovelWorkflow: { sceneDirector: { enabled: false } },
      } as any,
    })
    expect(legacy.mode).toBe('creative-writing')
    expect((legacy.settings as any).collaborativeNovel).toBeUndefined()
    expect(legacy.settings?.collaborativeNovelWorkflow?.sceneDirector).toEqual({ enabled: true })

    const residue = normalizeCollaborativeStory({
      mode: 'adventure' as const,
      settings: { collaborativeNovelWorkflow: {} },
    })
    expect(residue.mode).toBe('adventure')
    expect(residue.settings?.collaborativeNovelWorkflow).toBeUndefined()
  })
})
