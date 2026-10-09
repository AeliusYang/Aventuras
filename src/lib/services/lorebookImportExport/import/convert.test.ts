import { describe, expect, it } from 'vitest'
import type { EntryInjection, EntryState } from '$lib/types'
import type { ImportedEntry } from '../types'
import { convertToEntries } from './convert'

describe('convertToEntries', () => {
  it('repairs incomplete AIRP injection data while preserving imported fallbacks', () => {
    const imported: ImportedEntry = {
      name: '旧车站守夜人',
      type: 'character',
      description: '夜间值守者。',
      keywords: ['旧车站', '守夜人'],
      aliases: [],
      injectionMode: 'always',
      priority: 25,
      originalData: {
        state: { type: 'character' } as EntryState,
        injection: { mode: 'keyword' } as EntryInjection,
      } as unknown as ImportedEntry['originalData'],
    }

    const [entry] = convertToEntries([imported])

    expect(entry.injection).toEqual({
      mode: 'keyword',
      keywords: ['旧车站', '守夜人'],
      priority: 25,
    })
  })
})
