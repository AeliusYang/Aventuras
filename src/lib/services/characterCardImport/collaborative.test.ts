import { describe, expect, it } from 'vitest'
import { buildCollaborativeCardImport } from './collaborative'

describe('buildCollaborativeCardImport', () => {
  it('keeps all greetings, scenario, and embedded lorebook entries without AI processing', () => {
    const result = buildCollaborativeCardImport(
      {
        name: '霜月',
        description: '一名沉默的旅人。',
        personality: '谨慎，克制',
        scenario: '{{user}}在旧车站遇见了霜月。',
        firstMessage: '“你终于来了，{{user}}。”',
        alternateGreetings: ['她没有立刻转身。'],
        exampleMessages: '',
        version: 'v3',
        characterBook: {
          name: '霜月世界书',
          entries: {
            '0': {
              uid: 1,
              key: ['旧车站'],
              comment: '旧车站',
              content: '{{user}}曾在这里失踪。',
              order: 10,
              constant: false,
              selective: true,
            },
          },
        },
      },
      '林遥',
    )

    expect(result.protagonist).toEqual({
      name: '林遥',
      description: '',
      traits: [],
    })
    expect(result.startingLocation).toEqual({
      name: '导入场景',
      description: '林遥在旧车站遇见了霜月。',
    })
    expect(result.openingScene).toBe('“你终于来了，林遥。”')
    expect(result.openingVariants).toEqual(['“你终于来了，林遥。”', '她没有立刻转身。'])
    expect(result.selectedOpeningVariantId).toBe('opening-0')
    expect(result.importedEntries).toHaveLength(1)
    expect(result.importedEntries?.[0]).toMatchObject({
      name: '旧车站',
      description: '林遥曾在这里失踪。',
      keywords: ['旧车站'],
    })
  })

  it('allows cards without optional content', () => {
    const result = buildCollaborativeCardImport({
      name: '空白卡',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      alternateGreetings: [],
      exampleMessages: '',
      version: 'v2',
    })

    expect(result.openingScene).toBeUndefined()
    expect(result.openingVariants).toBeUndefined()
    expect(result.importedEntries).toBeUndefined()
    expect(result.startingLocation).toEqual({})
  })

  it('keeps user placeholders when no protagonist name is supplied and leaves the protagonist blank', () => {
    const result = buildCollaborativeCardImport({
      name: '空白卡',
      description: '',
      personality: '',
      scenario: '{{user}}进入旧宅。',
      firstMessage: '你来了，{{user}}。',
      alternateGreetings: [],
      exampleMessages: '',
      version: 'v2',
      characterBook: {
        name: '世界书',
        entries: {
          '0': {
            uid: 1,
            key: ['{{user}}'],
            comment: '{{user}}',
            content: '{{user}}的旧日记录。',
            order: 10,
            constant: false,
            selective: true,
          },
        },
      },
    })

    expect(result.protagonist).toEqual({ name: '主角', description: '', traits: [] })
    expect(result.startingLocation.description).toBe('{{user}}进入旧宅。')
    expect(result.openingScene).toBe('你来了，{{user}}。')
    expect(result.importedEntries?.[0]).toMatchObject({
      name: '{{user}}',
      description: '{{user}}的旧日记录。',
      keywords: ['{{user}}'],
      aliases: [],
    })
  })
})
