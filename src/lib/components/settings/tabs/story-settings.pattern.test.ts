import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import { transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  collaborativeOptionalContext,
  collaborativePatternFreshness,
  collaborativeRecentPassages,
  historyKey,
} from '$lib/services/generation/collaborative'

const source = readFileSync('src/lib/components/settings/tabs/story-settings.svelte', 'utf8')
const ast = parse(source) as any
const names = new Set([
  'generatePatternDraft',
  'confirmPatternDraft',
  'clearPatternDraft',
  'editConfirmedPattern',
  'savePatternDraft',
  'parsePatternDraft',
  'formatPattern',
])
const methods = ast.instance.content.body.filter(
  (node: any) => node.type === 'FunctionDeclaration' && names.has(node.id.name),
)
const code = transpileModule(
  methods.map((node: any) => source.slice(node.start, node.end)).join('\n'),
  { compilerOptions: { target: 99 } },
).outputText

function fixture() {
  const story: any = {
    currentStory: {
      id: 'story',
      mode: 'creative-writing',
      currentBranchId: null,
      settings: {
        collaborativeNovelWorkflow: { patternReviewer: { enabled: true } },
        collaborativeNovelPattern: {
          confirmed: '旧指导：不要再用最后期限压迫',
          draft: null,
          analyzedHistoryKey: 'old-history',
          analyzedNarrationCount: 1,
          confirmedAt: 10,
        },
      },
    },
    entries: Array.from({ length: 5 }, (_, index) => ({
      id: `prose-${index}`,
      type: 'narration',
      content: `已有正文${index}`,
      position: index,
    })),
    worldStateSnapshot: { characters: [], locations: [], items: [], storyBeats: [], chapters: [] },
  }
  story.updateStorySettings = vi.fn(async (changes: any) => {
    story.currentStory.settings = { ...story.currentStory.settings, ...structuredClone(changes) }
  })
  const aiService = {
    generateCollaborativePatternReview: vi.fn(async () => '新分析草稿，尚未确认'),
  }
  const api = new Function(
    'story',
    'aiService',
    'collaborativeOptionalContext',
    'collaborativeRecentPassages',
    'historyKey',
    `
    const ui = { isGenerating: false };
    let generatingPattern = false, patternController = null, patternDraftError = '', patternDraftText = '', patternFeedback = '';
    const patternReviewerEnabled = true;
    ${code}
    return { generatePatternDraft, confirmPatternDraft, clearPatternDraft, editConfirmedPattern, savePatternDraft,
      setText: text => patternDraftText = text, getText: () => patternDraftText, getError: () => patternDraftError };
  `,
  )(story, aiService, collaborativeOptionalContext, collaborativeRecentPassages, historyKey)
  const state = () => story.currentStory.settings.collaborativeNovelPattern
  const freshness = () =>
    collaborativePatternFreshness(state(), historyKey(story.entries), story.entries.length)
  return { ...api, story, aiService, state, freshness }
}

describe('pattern guidance draft confirmation boundary', () => {
  it('does not refresh confirmed guidance or its evidence before confirmation', async () => {
    const context = fixture()
    expect(context.freshness()).toBe('stale')
    const before = structuredClone(context.state())
    await context.generatePatternDraft()
    expect(context.state()).toMatchObject({
      confirmed: before.confirmed,
      confirmedAt: before.confirmedAt,
      analyzedHistoryKey: before.analyzedHistoryKey,
      analyzedNarrationCount: before.analyzedNarrationCount,
      draft: '新分析草稿，尚未确认',
      draftAnalyzedHistoryKey: historyKey(context.story.entries),
      draftAnalyzedNarrationCount: 5,
    })
    expect(context.freshness()).toBe('stale')
    expect(
      collaborativeOptionalContext(context.story.currentStory, context.story.entries)
        .confirmedPatternGuidance,
    ).toBe(before.confirmed)
  })

  it('promotes the saved draft evidence only on explicit confirmation after reload', async () => {
    const context = fixture()
    await context.generatePatternDraft()
    const evidenceKey = historyKey(context.story.entries)
    context.story.currentStory = JSON.parse(JSON.stringify(context.story.currentStory))
    context.story.entries.push({ id: 'later', type: 'narration', content: '后来一轮', position: 5 })
    context.setText(context.state().draft)
    await context.confirmPatternDraft()
    expect(context.state()).toMatchObject({
      confirmed: '新分析草稿，尚未确认',
      draft: null,
      analyzedHistoryKey: evidenceKey,
      analyzedNarrationCount: 5,
    })
    expect(context.state().draftAnalyzedHistoryKey).toBeUndefined()
    expect(context.state().draftAnalyzedNarrationCount).toBeUndefined()
    expect(context.freshness()).toBe('aging')
  })

  it('clearing a generated draft preserves the old confirmed evidence', async () => {
    const context = fixture()
    await context.generatePatternDraft()
    await context.clearPatternDraft()
    expect(context.state()).toMatchObject({
      draft: null,
      analyzedHistoryKey: 'old-history',
      analyzedNarrationCount: 1,
    })
    expect(context.state().draftAnalyzedHistoryKey).toBeUndefined()
    expect(context.freshness()).toBe('stale')
  })

  it('an edited confirmed copy retains its own evidence rather than a rejected draft', async () => {
    const context = fixture()
    await context.generatePatternDraft()
    await context.editConfirmedPattern()
    expect(context.state()).toMatchObject({
      draftAnalyzedHistoryKey: 'old-history',
      draftAnalyzedNarrationCount: 1,
    })
    context.setText('用户调整旧指导')
    await context.savePatternDraft()
    await context.confirmPatternDraft()
    expect(context.state()).toMatchObject({
      confirmed: '用户调整旧指导',
      analyzedHistoryKey: 'old-history',
      analyzedNarrationCount: 1,
    })
    expect(context.freshness()).toBe('stale')
  })

  it('does not invent evidence for a legacy or manually written draft', async () => {
    const context = fixture()
    context.state().draft = '旧版本保存的草稿'
    context.setText(context.state().draft)
    await context.confirmPatternDraft()
    expect(context.state().analyzedHistoryKey).toBeUndefined()
    expect(context.state().analyzedNarrationCount).toBeUndefined()
    expect(context.freshness()).toBe('stale')
  })

  it('does not call a same-length edited history merely aging', () => {
    const context = fixture()
    context.state().analyzedHistoryKey = historyKey(context.story.entries)
    context.state().analyzedNarrationCount = context.story.entries.length
    expect(context.freshness()).toBe('current')
    context.story.entries[0].content = '用户更换因果路线后的正文'
    expect(context.freshness()).toBe('stale')
  })

  it('does not save a draft when the story changes during the request', async () => {
    const context = fixture()
    context.aiService.generateCollaborativePatternReview.mockImplementation(async () => {
      context.story.currentStory = { ...context.story.currentStory, id: 'different' }
      return '迟到的旧分析'
    })
    await context.generatePatternDraft()
    expect(context.story.updateStorySettings).not.toHaveBeenCalled()
    expect(context.getError()).toContain('已变化')
  })

  it('does not save or display a late draft after the reviewer is disabled elsewhere', async () => {
    const context = fixture()
    context.aiService.generateCollaborativePatternReview.mockImplementation(async () => {
      context.story.currentStory.settings.collaborativeNovelWorkflow.patternReviewer.enabled = false
      return '已关闭后的迟到草稿'
    })
    await context.generatePatternDraft()
    expect(context.story.updateStorySettings).not.toHaveBeenCalled()
    expect(context.getText()).toBe('')
  })

  it('preserves both confirmed and draft evidence after a failed model response', async () => {
    const context = fixture()
    const original = structuredClone(context.state())
    context.aiService.generateCollaborativePatternReview.mockRejectedValue(
      new Error('本次分析失败'),
    )
    await context.generatePatternDraft()
    expect(context.state()).toEqual(original)
    expect(context.story.updateStorySettings).not.toHaveBeenCalled()
    expect(context.aiService.generateCollaborativePatternReview).toHaveBeenCalledOnce()
    expect(context.getError()).toBe('本次分析失败')
  })
})
