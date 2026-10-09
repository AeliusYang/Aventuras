import { describe, expect, it } from 'vitest'
import { normalizeEntryInjection, normalizeStringArray, parseJsonOr } from './lorebookEntry'

describe('lorebook entry normalization', () => {
  it('fills missing injection fields from imported metadata', () => {
    expect(
      normalizeEntryInjection(
        { mode: 'keyword' },
        { mode: 'always', keywords: ['旧车站'], priority: 25 },
      ),
    ).toEqual({ mode: 'keyword', keywords: ['旧车站'], priority: 25 })
  })

  it('repairs invalid and malformed persisted values', () => {
    expect(normalizeEntryInjection({ mode: 'relevant', keywords: null, priority: 'high' })).toEqual(
      {
        mode: 'keyword',
        keywords: [],
        priority: 0,
      },
    )
    expect(parseJsonOr('{bad json', [])).toEqual([])
    expect(normalizeStringArray(['valid', null, 7])).toEqual(['valid'])
  })
})
