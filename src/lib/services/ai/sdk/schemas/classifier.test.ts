import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { JSONSchema7 } from 'json-schema'
import { classificationResultSchema, collaborativeClassificationResultSchema } from './classifier'
import { schemaToTypeScriptBlock } from '../middleware/promptSchema'

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, child]) => key !== 'description' || typeof child !== 'string')
        .map(([key, child]) => [key, withoutDescriptions(child)]),
    )
  }
  return value
}

describe('collaborative classification schema', () => {
  it('changes only descriptions, preserving all structural validation and defaults', () => {
    expect(withoutDescriptions(z.toJSONSchema(collaborativeClassificationResultSchema))).toEqual(
      withoutDescriptions(z.toJSONSchema(classificationResultSchema)),
    )
    const input = {
      entryUpdates: { newCharacters: [{ name: '路人', visualDescriptors: { hair: '短发' } }] },
      scene: {},
    }
    expect(collaborativeClassificationResultSchema.parse(input)).toEqual(
      classificationResultSchema.parse(input),
    )
    expect(collaborativeClassificationResultSchema.parse(input).scene.timeProgression).toBe('none')
  })

  it('removes invention, completeness and guessed time instructions from the provider schema', () => {
    const collaborative = JSON.stringify(z.toJSONSchema(collaborativeClassificationResultSchema))
    for (const text of [
      'invent plausible',
      'ALL categories should be filled',
      'Complete visual appearance',
      'minutes=conversations',
      'hours=travel',
      'days=sleep',
    ]) {
      expect(collaborative).not.toContain(text)
    }
    expect(collaborative).toContain('未知类别省略')
    expect(collaborative).toContain('没有明确时间证据则输出 none')
    const ordinary = JSON.stringify(z.toJSONSchema(classificationResultSchema))
    expect(ordinary).toContain('ALL categories should be filled')
    expect(ordinary).toContain('minutes=conversations')
  })

  it('carries attribution into the actual text contract without changing ordinary RPG', () => {
    const contract = schemaToTypeScriptBlock(
      z.toJSONSchema(collaborativeClassificationResultSchema, { io: 'output' }) as JSONSchema7,
    )
    const descriptionLines = contract
      .split('\n')
      .filter((line) => /description\??: string;/.test(line))
    expect(descriptionLines).toHaveLength(6)
    expect(descriptionLines.every((line) => line.includes('须保留说话人及确定程度'))).toBe(true)
    expect(descriptionLines.every((line) => line.includes('未回应只记尚未回应'))).toBe(true)
    expect(contract.split('\n').find((line) => /relationship\??: string;/.test(line))).toContain(
      '行为没有发生不等于人物已决定不做',
    )
    expect(contract).toContain('未执行仍保留原位置，不替正文补动作')
    expect(contract).toContain('不把陌生人的自称或未经证实的身份写成确定关系')
    expect(contract).toContain('未签名、待领取等可变进度归线程')
    const ordinary = schemaToTypeScriptBlock(
      z.toJSONSchema(classificationResultSchema, { io: 'output' }) as JSONSchema7,
    )
    expect(ordinary).not.toContain('须保留说话人及确定程度')
  })

  it.each([
    {
      entryUpdates: { newCharacters: [{ name: '路人', visualDescriptors: { eyes: 42 } }] },
      scene: {},
    },
    { entryUpdates: {}, scene: { timeProgression: 'weeks' } },
  ])('preserves rejection of invalid field types and enum values', (input) => {
    expect(collaborativeClassificationResultSchema.safeParse(input).success).toBe(false)
    expect(classificationResultSchema.safeParse(input).success).toBe(false)
  })

  it('keeps multi-view time and knowledge guidance in the actual extraction contract', () => {
    const contract = schemaToTypeScriptBlock(
      z.toJSONSchema(collaborativeClassificationResultSchema, { io: 'output' }) as JSONSchema7,
    )
    for (const rule of [
      '结尾的NPC场外镜头、历史闪回和未来设想不移动主角',
      '结尾切镜或闪回不替换该名单',
      '回忆中的多年间隔、NPC场外时间和未来设想不推进主角时钟',
      '读者所见不等于角色所知',
      '未写入正文的导演构想、规划及被拒版本不是事实',
    ])
      expect(contract).toContain(rule)
  })

  // This checks transport and schema preservation of an extraction, not whether an LLM
  // correctly understood prose. The isolated live evaluation checks that separate boundary.
  it('preserves an attributed off-scene revelation without changing the protagonist scene', () => {
    const result = collaborativeClassificationResultSchema.parse({
      entryUpdates: {
        newCharacters: [
          { name: '陈禾', status: 'inactive', description: '场外仓库中烧掉旧账。林尚未获知。' },
        ],
        newStoryBeats: [
          {
            title: '旧账的去向',
            description:
              '作者在场外镜头确立陈禾烧掉旧账；林仍在渡口，不知此事。她声称三年前替林保管过账册，此说法尚未证实。',
            type: 'revelation',
            status: 'active',
          },
        ],
      },
      scene: {
        currentLocationName: '渡口',
        presentCharacterNames: ['沈宁'],
        timeProgression: 'none',
      },
    })
    expect(result.scene).toEqual({
      currentLocationName: '渡口',
      presentCharacterNames: ['沈宁'],
      timeProgression: 'none',
    })
    expect(result.entryUpdates.newCharacters[0].status).toBe('inactive')
    expect(result.entryUpdates.newStoryBeats[0].description).toContain('此说法尚未证实')
    expect(result.entryUpdates.newStoryBeats[0].description).toContain('不知此事')
    expect(result.entryUpdates.characterUpdates).toEqual([])
  })
})
