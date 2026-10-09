import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canonicalCollaborativeTemplates } from '$lib/services/prompts/templates/collaborative'

const actionInput = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
const storyView = readFileSync('src/lib/components/story/StoryView.svelte', 'utf8')
const settings = readFileSync('src/lib/components/settings/SettingsModal.svelte', 'utf8')
const templateGroups = readFileSync('src/lib/components/vault/prompts/templateGroups.ts', 'utf8')

describe('collaborative inspiration UI contract', () => {
  it('shows one collaborative inspiration surface and keeps RPG choices adventure-only', () => {
    expect(actionInput).toContain('<Suggestions')
    expect(actionInput).toContain('plotSuggestions?.enabled')
    expect(storyView).toContain("story.storyMode === 'adventure'")
    expect(storyView).not.toContain('collaborativeNovelWorkflow')
    expect(storyView).not.toContain('collaborativeNovel')
    expect(settings).toContain("label: '提示词管理'")
    expect(settings).toContain('ui.openPromptPackEditor(')
    expect(templateGroups).toContain("'collaborative-plot-suggestions'")
    expect(
      canonicalCollaborativeTemplates.find(
        (template) => template.id === 'collaborative-plot-suggestions',
      )?.name,
    ).toContain('短期剧情建议')
    expect(templateGroups).not.toContain('collaborative-action-choices')
  })

  it('does not persist collaborative inspiration into the legacy mode-dependent entry field', () => {
    expect(actionInput).toMatch(
      /if \(\s*!isCollaborative &&\s*lastNarration[\s\S]*?suggestedActions: JSON\.stringify\(result\.suggestions\)/,
    )
  })
})
