import type { Story, StorySettings } from '$lib/types'

export interface StoryBasicsDraft {
  description: string
  genre: string
  tone: string
  themes: string
}

export function storyBasicsUpdate(story: Story, draft: StoryBasicsDraft) {
  const settings: StorySettings = {
    ...story.settings,
    tone: draft.tone.trim(),
    themes: [
      ...new Set(
        draft.themes
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
  }
  return {
    description: draft.description.trim() || null,
    genre: draft.genre.trim() || null,
    settings,
  }
}
