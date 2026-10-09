import { describe, expect, it } from 'vitest'
import { storyBasicsUpdate } from './storyBasics'
import { collaborativeTemplates } from './prompts/templates/collaborative'
import { templateEngine } from './templates/engine'

describe('editable story basics', () => {
  it('clears empty fields without overwriting other settings or confirmed guidance', () => {
    const story = {
      settings: {
        pov: 'first',
        collaborativeNovelPlan: { confirmed: '保留', draft: '草稿' },
        collaborativeNovelWorkflow: { plotSuggestions: { enabled: false } },
      },
    } as any
    const update = storyBasicsUpdate(story, { description: ' ', genre: '', tone: '', themes: '\n' })
    expect(update).toEqual({
      description: null,
      genre: null,
      settings: { ...story.settings, tone: '', themes: [] },
    })
  })
  it('renders background, genre, tone and themes for Director and Writer', () => {
    for (const id of ['collaborative-scene-director', 'collaborative-chinese-writer']) {
      const template = collaborativeTemplates.find((t) => t.id === id)!
      const context = {
        protagonistName: '主角',
        genre: '推理题材',
        settingDescription: '山间古堡',
        tone: '冷峻基调',
        themes: '信任与背叛',
        rawInput: '继续',
      }
      const rendered = templateEngine.render(
        template.content + '\n' + template.userContent,
        context as any,
      )
      for (const field of ['推理题材', '山间古堡', '冷峻基调', '信任与背叛'])
        expect(rendered).toContain(field)
    }
  })
})
