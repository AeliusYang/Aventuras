import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { RuntimeVariable } from '$lib/services/packs'
import { assertNoDiscardedFactFields } from './factFieldValidation'
import { collaborativeClassificationResultSchema } from './schemas/classifier'
import { buildExtendedClassificationSchema } from './schemas/runtime-variables'

describe('fact field loss visibility without changing the contract', () => {
  it.each([
    [{ extra: { nested: 'private-value' } }, 'extra'],
    [{ scene: { timeProgression: 'none', deadline: 'private-value' } }, 'scene.deadline'],
    [
      {
        entryUpdates: {
          characterUpdates: [{ name: '周平', changes: { description: 'private-value' } }],
        },
      },
      'entryUpdates.characterUpdates[0].changes.description',
    ],
    [{ toString: 'private-value' }, 'toString'],
    [JSON.parse('{"__proto__":"private-value"}'), '__proto__'],
    [{ 'extra\nfield': 'private-value' }, '["extra\\nfield"]'],
  ])('reports discarded paths, not values: %j', (extra, path) => {
    const source = { entryUpdates: {}, scene: { timeProgression: 'none' }, ...extra }
    const parsed = collaborativeClassificationResultSchema.parse(source)
    expect(() => assertNoDiscardedFactFields(source, parsed)).toThrow(path)
    expect(() => assertNoDiscardedFactFields(source, parsed)).not.toThrow('private-value')
  })

  it('accepts defaults, explicit nulls and supported new-character descriptions', () => {
    const source = {
      entryUpdates: { newCharacters: [{ name: '周平', description: '负责分粮' }] },
      scene: { currentLocationName: null, timeProgression: 'none' },
    }
    const snapshot = structuredClone(source)
    const parsed = collaborativeClassificationResultSchema.parse(source)
    expect(parsed.entryUpdates.characterUpdates).toEqual([])
    expect(() => assertNoDiscardedFactFields(source, parsed)).not.toThrow()
    expect(source).toEqual(snapshot)
  })

  it('accepts fields declared by the active runtime-variable schema', () => {
    const schema = buildExtendedClassificationSchema(
      {
        character: [
          {
            id: 'trust',
            packId: 'pack',
            variableName: 'trust',
            entityType: 'character',
            displayName: '信任',
            variableType: 'number',
            color: '#fff',
            pinned: false,
            sortOrder: 0,
            createdAt: 0,
          } as RuntimeVariable,
        ],
      },
      true,
    )
    const source = {
      entryUpdates: { characterUpdates: [{ name: '周平', changes: { trust: 12 } }] },
      scene: { timeProgression: 'none' },
    }
    const parsed = schema.parse(source)
    expect(parsed).toMatchObject({
      entryUpdates: { characterUpdates: [{ changes: { trust: 12 } }] },
    })
    expect(() => assertNoDiscardedFactFields(source, parsed)).not.toThrow()
  })

  it('accepts retained record and passthrough data rather than imposing a key allowlist', () => {
    const schema = z.object({ values: z.record(z.string(), z.unknown()) }).passthrough()
    const source = { values: { arbitrary: [{ nested: null }] }, extra: { retained: true } }
    expect(() => assertNoDiscardedFactFields(source, schema.parse(source))).not.toThrow()
  })
})
