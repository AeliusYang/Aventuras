import { describe, expect, it, vi } from 'vitest'
import {
  ChapterService,
  type ChapterCheckInput,
  type ChapterServiceDependencies,
} from './ChapterService'
import { BackgroundTaskCoordinator, type BackgroundTaskInput } from './BackgroundTaskCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fixture() {
  let current = true
  const input = {
    storyId: 'A',
    currentBranchId: 'a',
    scope: { storyId: 'A', branchId: 'a' },
    isScopeCurrent: () => current,
    entries: [{ id: 'entry', metadata: null }],
    lastChapterEndIndex: 0,
    tokensOutsideBuffer: 100,
    tokensSinceLastChapter: 100,
    messagesSinceLastChapter: 1,
    memoryConfig: { tokenThreshold: 10, chapterBuffer: 0 },
    currentBranchChapters: [],
    mode: 'creative-writing',
    pov: 'third',
    tense: 'past',
  } as unknown as ChapterCheckInput
  const analysis = { shouldCreateChapter: true, optimalEndIndex: 1, suggestedTitle: 'chapter' }
  const summary = {
    summary: 'summary',
    keywords: [],
    characters: [],
    locations: [],
    plotThreads: [],
  }
  const deps = {
    analyzeForChapter: vi.fn(async () => analysis),
    summarizeChapter: vi.fn(async () => summary),
    getNextChapterNumber: vi.fn(async () => 3),
    addChapter: vi.fn(async () => {}),
  } as unknown as ChapterServiceDependencies
  return {
    input,
    deps,
    analysis,
    summary,
    cancel: () => {
      current = false
    },
  }
}

describe('chapter scoped async work', () => {
  it.each(['analysis', 'summary', 'number'] as const)(
    'cancels after deferred %s before persistence',
    async (stage) => {
      const { input, deps, analysis, summary, cancel } = fixture()
      const pending = deferred<any>()
      const method =
        stage === 'analysis'
          ? 'analyzeForChapter'
          : stage === 'summary'
            ? 'summarizeChapter'
            : 'getNextChapterNumber'
      vi.mocked(deps[method]).mockReturnValue(pending.promise)
      const run = new ChapterService(deps).checkAndCreateChapter(input)
      await vi.waitFor(() => expect(deps[method]).toHaveBeenCalledOnce())
      cancel()
      pending.resolve(stage === 'analysis' ? analysis : stage === 'summary' ? summary : 3)
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(deps.addChapter).not.toHaveBeenCalled()
      if (stage === 'analysis') expect(deps.summarizeChapter).not.toHaveBeenCalled()
      if (stage !== 'number') expect(deps.getNextChapterNumber).not.toHaveBeenCalled()
    },
  )

  it('passes captured identity and cancellation into number lookup and store save', async () => {
    const { input, deps, cancel } = fixture()
    const result = await new ChapterService(deps).checkAndCreateChapter(input)
    expect(result.created).toBe(true)
    const options = vi.mocked(deps.getNextChapterNumber).mock.calls[0][0]!
    expect(options.scope).toEqual({ storyId: 'A', branchId: 'a' })
    expect(deps.addChapter).toHaveBeenCalledWith(
      expect.objectContaining({ storyId: 'A', branchId: 'a', number: 3 }),
      options,
    )
    cancel()
    expect(options.isScopeCurrent).toThrow(expect.objectContaining({ name: 'AbortError' }))
  })

  it('coordinator forwards its scope before the chapter can persist', async () => {
    const { input, deps, analysis, cancel } = fixture()
    const pending = deferred<any>()
    vi.mocked(deps.analyzeForChapter).mockReturnValue(pending.promise)
    const runLoreManagement = vi.fn()
    const coordinator = new BackgroundTaskCoordinator({
      chapterService: deps,
      styleReview: { analyzeStyle: vi.fn() },
      loreManagement: { runLoreManagement },
    })
    const background = {
      scope: { storyId: 'A', branchId: 'a', turnId: 'turn' },
      isScopeCurrent: input.isScopeCurrent,
      chapterCheck: { ...input, scope: undefined, isScopeCurrent: undefined },
      styleReview: { enabled: false },
      loreSession: vi.fn(),
      loreCallbacks: {},
    } as unknown as BackgroundTaskInput
    const run = coordinator.runBackgroundTasks(background)
    await vi.waitFor(() => expect(deps.analyzeForChapter).toHaveBeenCalledOnce())
    cancel()
    pending.resolve(analysis)
    await expect(run).rejects.toThrow('scope changed')
    expect(deps.summarizeChapter).not.toHaveBeenCalled()
    expect(deps.addChapter).not.toHaveBeenCalled()
    expect(runLoreManagement).not.toHaveBeenCalled()
  })
})
