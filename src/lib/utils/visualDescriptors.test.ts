import { describe, expect, it } from 'vitest'
import { mergeVisualDescriptors } from './visualDescriptors'
import {
  collaborativeCharacterUpdateSchema,
  characterUpdateSchema,
} from '$lib/services/ai/sdk/schemas/classifier'

describe('collaborative appearance patches', () => {
  it('preserves unspecified, null and blank categories; replaces evidenced categories idempotently', () => {
    const before = { hair: '银发', eyes: '金眸', clothing: '制服' }
    const patch = collaborativeCharacterUpdateSchema.parse({
      name: '林岚',
      changes: { visualDescriptors: { hair: null, eyes: '  ', clothing: '雨衣' } },
    }).changes.visualDescriptors
    const after = mergeVisualDescriptors(before, patch)
    expect(after).toEqual({ hair: '银发', eyes: '金眸', clothing: '雨衣' })
    expect(mergeVisualDescriptors(after, patch)).toEqual(after)
    expect(before.clothing).toBe('制服')
    expect(
      collaborativeCharacterUpdateSchema.parse({
        name: '林岚',
        changes: { visualDescriptors: null },
      }).changes.visualDescriptors,
    ).toBeUndefined()
    expect(
      characterUpdateSchema.safeParse({
        name: '林岚',
        changes: { visualDescriptors: { hair: null } },
      }).success,
    ).toBe(false)
  })
})
