import { describe, expect, it } from 'vitest'
import type { StoryEntry } from '$lib/types'
import { imageContentVersion, imageMatchesEntry } from './imageScope'

const prose = (content: string, metadata: any = null) => ({ content, metadata }) as StoryEntry
describe('illustration prose revisions', () => {
  it('rejects changed prose and restores the picture with the original, including after the first reroll', () => {
    const original = prose('她把信锁进抽屉。')
    const image = { contentVersion: imageContentVersion(original) }
    expect(imageMatchesEntry(image, prose('她烧掉了信。'))).toBe(false)
    expect(
      imageMatchesEntry(
        image,
        prose(original.content, {
          variantSet: { activeVariantId: 'v1', variants: [{ id: 'v1' }, { id: 'v2' }] },
        }),
      ),
    ).toBe(true)
    expect(imageMatchesEntry(JSON.parse(JSON.stringify(image)), original)).toBe(true)
  })
  it('does not guess the variant of an unattributed legacy picture', () => {
    expect(imageMatchesEntry({}, prose('旧正文'))).toBe(true)
    expect(imageMatchesEntry({}, prose('另一版', { variantSet: { variants: [{}, {}] } }))).toBe(
      false,
    )
  })
})
