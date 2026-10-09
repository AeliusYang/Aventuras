import type { EmbeddedImageMeta, StoryEntry } from '$lib/types'

/** Exact, portable prose revision. Independent of variant ids: the first reroll creates a
 * variant set after the original prose already exists. Identical prose can reuse its picture. */
export function imageContentVersion(entry: Pick<StoryEntry, 'content'>): string {
  return JSON.stringify(['prose-v1', entry.content])
}

export function imageMatchesEntry(
  image: Pick<EmbeddedImageMeta, 'contentVersion'>,
  entry: Pick<StoryEntry, 'content' | 'metadata'>,
): boolean {
  if (image.contentVersion) return image.contentVersion === imageContentVersion(entry)
  // Older images have no reliable attribution when an entry has several alternatives.
  return (entry.metadata?.variantSet?.variants.length ?? 0) <= 1
}
