import { describe, expect, it } from 'vitest'
import type { StoryEntry } from '$lib/types'
import {
  collaborativeRecentPassages,
  historyKey,
  novelRetry,
  novelWriterContext,
  resolveCollaborativeLength,
  novelOutputMetrics,
  validateCollaborativeLength,
} from './collaborative'

const entry = (type: StoryEntry['type'], content: string): StoryEntry => ({
  id: type,
  storyId: 'story',
  branchId: null,
  type,
  content,
  metadata: null,
  parentId: null,
  position: 0,
  createdAt: 0,
})

describe('raw collaborative context', () => {
  it.each(['dynamic', 'short', 'medium', 'long'] as const)(
    'records %s length without inventing a numeric minimum',
    (mode) => {
      const requestedLength = resolveCollaborativeLength('继续', undefined, mode)
      const metrics = novelOutputMetrics({ requestedLength } as any, '中文𠀀。', 'stop')
      expect(metrics).toMatchObject({
        requestedLength,
        actualChineseCharacters: 3,
        outputTruncated: false,
      })
      expect(metrics.shortStopReason).toBeUndefined()
      expect(metrics.outputMetricsWarning).toBeUndefined()
      expect(
        novelOutputMetrics({ requestedLength } as any, '短文', 'length').shortStopReason,
      ).toContain('Token')
    },
  )

  it.each(['2000', '1500-3000', '2,000', '1500–3000中文字'])(
    'still checks numeric length %s and validates fixed settings before generation',
    (length) => {
      const requestedLength = resolveCollaborativeLength('继续', length, 'dynamic')
      const metrics = novelOutputMetrics({ requestedLength } as any, '短文', 'stop')
      expect(metrics.shortStopReason).toContain('低于本轮目标')
      expect(metrics.requestedLength).toBe(validateCollaborativeLength(length))
    },
  )

  it('rejects an invalid fixed setting before generating', () => {
    expect(() => resolveCollaborativeLength('继续', '错误字数', 'dynamic')).toThrow(
      '字符单值或范围',
    )
    expect(() => resolveCollaborativeLength('继续', '3000-1500', 'dynamic')).toThrow('上限')
    expect(resolveCollaborativeLength('本轮写800字', '错误字数', 'dynamic')).toBe('800中文字')
  })

  it('honors setup length while preserving explicit and legacy character limits', () => {
    expect(resolveCollaborativeLength('继续', undefined, 'dynamic')).toContain('动态')
    expect(resolveCollaborativeLength('继续', undefined, 'short')).toContain('2–4')
    expect(resolveCollaborativeLength('继续', '2000', 'short')).toBe('2000中文字')
    expect(resolveCollaborativeLength('本轮写 800 字', '2000', 'long')).toBe('800中文字')
    expect(resolveCollaborativeLength('继续')).toBe('1500-3000中文字')
  })
  it('keeps passage identities stable as the eight-passage window advances', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      ...entry('narration', `正文-${index}`),
      id: `narration-${index}`,
    }))
    const before = collaborativeRecentPassages(history.slice(0, 9))
    const after = collaborativeRecentPassages(history)
    expect(after).toHaveLength(8)
    expect(after[0]).toEqual({ entryId: 'narration-2', passage: 3, text: '正文-2' })
    expect(before.slice(1)).toEqual(after.slice(0, -1))
    expect(collaborativeRecentPassages([entry('user_action', '继续')])).toEqual([])
    expect(collaborativeRecentPassages(history.slice(0, 2))).toEqual([
      { entryId: 'narration-0', passage: 1, text: '正文-0' },
      { entryId: 'narration-1', passage: 2, text: '正文-1' },
    ])
  })

  it('keeps user input and Agent output as original text', () => {
    const narration = entry('narration', '被拒绝正文')
    narration.metadata = {
      novelTurn: {
        version: 2,
        historyKey: '',
        rawInput: '继续',
        sceneDirectorOutput: '上一轮完整导演原文',
        confirmedPlan: null,
        confirmedPatternGuidance: null,
      },
    } as any
    const retry = novelRetry(narration, '继续')
    expect(retry.rejectedDirectorOutput).toBe('上一轮完整导演原文')
    const context = novelWriterContext({
      version: 2,
      historyKey: historyKey([narration]),
      rawInput: '“随你怎么想。”',
      sceneDirectorOutput: '长导演原文\n自定义章节',
      confirmedPlan: '长期计划原文',
      confirmedPatternGuidance: '结构指导原文',
    })
    expect(context).toContain('长导演原文\n自定义章节')
    expect(context).toContain('“随你怎么想。”')
    expect(context).not.toContain('长期计划原文')
    expect(context).not.toContain('结构指导原文')
    expect(context).toContain('requestedLength')
  })

  it('links a passage only to its preceding author entry without repeating author text', () => {
    const history = [
      { ...entry('narration', '开场'), id: 'opening' },
      { ...entry('user_action', '本轮沉默'), id: 'silence' },
      { ...entry('narration', '沉默生效的正文'), id: 'first-prose' },
      { ...entry('narration', '独立插入的正文'), id: 'inserted-prose' },
      { ...entry('user_action', '她别急着信'), id: 'doubt' },
      { ...entry('narration', '她仍然存疑的正文'), id: 'second-prose' },
    ]
    expect(collaborativeRecentPassages(history)).toEqual([
      { entryId: 'opening', passage: 1, text: '开场' },
      { entryId: 'first-prose', passage: 2, userInputEntryId: 'silence', text: '沉默生效的正文' },
      { entryId: 'inserted-prose', passage: 3, text: '独立插入的正文' },
      { entryId: 'second-prose', passage: 4, userInputEntryId: 'doubt', text: '她仍然存疑的正文' },
    ])
    expect(JSON.stringify(collaborativeRecentPassages(history))).not.toContain('本轮沉默')
  })

  it('keeps linkage stable when an author source precedes the visible passage window', () => {
    const history = Array.from({ length: 10 }, (_, index) => [
      { ...entry('user_action', `输入${index}`), id: `author-${index}` },
      { ...entry('narration', `正文${index}`), id: `prose-${index}` },
    ]).flat()
    const before = collaborativeRecentPassages(history.slice(0, -2))
    const after = collaborativeRecentPassages(history)
    expect(before.slice(1)).toEqual(after.slice(0, -1))
    expect(after[0]).toMatchObject({ userInputEntryId: 'author-2', passage: 3 })
  })
})
