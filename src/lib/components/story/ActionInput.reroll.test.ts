import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import { ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createGenerationScope, isGenerationScopeCurrent } from '$lib/utils/branchScope'
import { historyKey } from '$lib/services/generation/collaborative'

const source = readFileSync('src/lib/components/story/ActionInput.svelte', 'utf8')
const ast = parse(source, { modern: true })
const statements = ast.instance!.content.body.filter(
  (node) =>
    node.type === 'FunctionDeclaration' &&
    [
      'handleRegenerateNarration',
      'handleStopGeneration',
      'handleWriterOnlyNarration',
      'resumeWriterRecovery',
    ].includes(node.id?.name ?? ''),
)
const code = transpileModule(
  statements
    .map((node) => {
      const { start, end } = node as typeof node & { start: number; end: number }
      return source.slice(start, end)
    })
    .join('\n'),
  { compilerOptions: { target: ScriptTarget.ESNext } },
).outputText

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const user = {
    id: 'user',
    type: 'user_action',
    branchId: null,
    content: '继续',
    metadata: { retained: true },
  }
  const entry = {
    id: 'entry',
    type: 'narration',
    content: '原正文',
    metadata: { variantSet: { activeVariantId: 'old' } },
  }
  const story = {
    currentStory: { id: 'story', currentBranchId: null as string | null, mode: 'creative-writing' },
    entries: [user, entry],
    undoNarrationForRegenerate: vi.fn(async () => ({ entitiesUndone: true, timeUndone: true })),
    refreshEntry: vi.fn(async () => {}),
    settleNarrationReroll: vi.fn(async () => {}),
  }
  const ui = {
    isGenerating: false,
    submissionScope: null as ReturnType<typeof createGenerationScope> | null,
    isRetryingLastMessage: false,
    retryBackup: { storyId: 'story' },
    showToast: vi.fn(),
    endStreaming: vi.fn(),
    clearRetryBackup: vi.fn(),
    setGenerating(value: boolean) {
      ui.isGenerating = value
    },
    setGenerationStatus: vi.fn(),
  }
  const database = {
    updateStoryEntry: vi.fn(async () => {}),
    saveWriterRecovery: vi.fn(async () => {}),
    clearWriterRecovery: vi.fn(async () => {}),
  }
  const onGenerate = vi.fn(async (_signal: AbortSignal, _options?: any) => {})
  const retryService = { handleStopGeneration: vi.fn() }
  const handlers = new Function(
    'story',
    'ui',
    'database',
    'onGenerate',
    'retryService',
    'createGenerationScope',
    'isScopeCurrent',
    'historyKey',
    `
    let activeRerollScope = null;
    let activeAbortController = null;
    let stopRequested = false;
    let writerRecovery = null;
    let recoveryBusy = false; let recoveryMessage = '';
    const generationBlockReason = () => '';
    const currentRecoveryFingerprint = async (_record, exclude) => exclude ? (story.preFingerprint ?? 'settled') : (story.currentFingerprint ?? 'settled');
    const blockGeneration = false;
    const findPrecedingUserAction = () => story.entries[0];
    const novelRetry = () => ({});
    const retrievalKeyFor = () => null;
    const errMessage = (error) => error.message;
    async function generateResponse(_id, _content, options) {
      activeAbortController = new AbortController();
      await onGenerate(activeAbortController.signal, options);
    }
    ${code}
    return { reroll: handleRegenerateNarration, writerOnly: handleWriterOnlyNarration, stop: handleStopGeneration, resume: resumeWriterRecovery, message: () => recoveryMessage, setRecovery: value => writerRecovery = value };
  `,
  )(
    story,
    ui,
    database,
    onGenerate,
    retryService,
    createGenerationScope,
    isGenerationScopeCurrent,
    historyKey,
  )
  return { story, ui, database, onGenerate, retryService, handlers }
}

describe('same-turn reroll cancellation lifecycle', () => {
  it.each([true, false])(
    'manually retries successful prose (legacy=%s), without creating a new Director route',
    async (legacy) => {
      const { story, ui, onGenerate, handlers } = fixture()
      const turn = {
        version: 2,
        historyKey: historyKey([story.entries[0]] as any),
        rawInput: '继续',
        sceneDirectorOutput: '原样 Director',
        confirmedPlan: null,
        confirmedPatternGuidance: null,
      }
      Object.assign(story.entries[1].metadata, {
        novelTurn: turn,
        ...(!legacy
          ? {
              writerReplay: {
                version: 1,
                id: 'old-recovery',
                storyId: 'story',
                branchId: null,
                userActionEntryId: 'user',
                narrationEntryId: 'entry',
                novelTurn: turn,
                retrieval: { combinedContext: '原检索' },
                contextFingerprint: 'settled',
              },
            }
          : {}),
      })
      await handlers.writerOnly('entry')
      const options = onGenerate.mock.calls[0][1]
      expect(options.writerRecovery.novelTurn).toEqual(turn)
      expect(options.writerRecovery.contextFingerprint).toBe('settled')
      expect(options.writerRecovery.id).not.toBe('old-recovery')
      expect(options.novelRetry).toBeUndefined()
      expect(story.entries[1].content).toBe('原正文')
      expect(ui.showToast.mock.calls.some((call) => String(call[0]).includes('快照不完整'))).toBe(
        legacy,
      )
    },
  )

  it('refuses a manual Writer replay after its original input was edited', async () => {
    const { story, ui, onGenerate, handlers } = fixture()
    Object.assign(story.entries[1].metadata, {
      novelTurn: { rawInput: '旧输入', sceneDirectorOutput: 'Director' },
    })
    await handlers.writerOnly('entry')
    expect(onGenerate).not.toHaveBeenCalled()
    expect(story.undoNarrationForRegenerate).not.toHaveBeenCalled()
    expect(ui.showToast).toHaveBeenCalledWith(expect.stringContaining('已过期'), 'warning')
  })
  it('retries Writer into the same variant row and preserves recovery after another failure', async () => {
    const { story, database, onGenerate, handlers } = fixture()
    const record = {
      id: 'recovery',
      variantBaseEntryId: 'entry',
      novelRetry: { rawInput: '继续', mode: 'different' },
    }
    handlers.setRecovery(record)
    await handlers.reroll('entry', record)
    expect(onGenerate.mock.calls[0][1]).toMatchObject({
      variantBaseEntryId: 'entry',
      writerRecovery: record,
      novelRetry: record.novelRetry,
    })
    expect(story.settleNarrationReroll).toHaveBeenCalledWith('entry', 'old')
    expect(database.saveWriterRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ settledFingerprint: 'settled' }),
    )
    expect(story.entries[1].content).toBe('原正文')
  })
  it('keeps actions locked until cancellation recovery drains, without using the legacy backup', async () => {
    const { story, ui, onGenerate, retryService, handlers } = fixture()
    const started = deferred()
    const settling = deferred()
    const release = deferred()
    onGenerate.mockImplementation(async (signal) => {
      started.resolve()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    })
    story.settleNarrationReroll.mockImplementation(async () => {
      settling.resolve()
      await release.promise
    })
    const run = handlers.reroll('entry')
    await started.promise
    await handlers.stop()
    await settling.promise
    expect(ui.isGenerating).toBe(true)
    expect(retryService.handleStopGeneration).not.toHaveBeenCalled()
    await handlers.reroll('entry')
    expect(story.undoNarrationForRegenerate).toHaveBeenCalledTimes(1)
    release.resolve()
    await run
    expect(story.settleNarrationReroll).toHaveBeenCalledWith('entry', 'old')
    expect(ui.isGenerating).toBe(false)
    expect(ui.submissionScope).toBeNull()
    onGenerate.mockResolvedValue(undefined)
    await handlers.reroll('entry')
    expect(story.undoNarrationForRegenerate).toHaveBeenCalledTimes(2)
  })

  it('settles a prepared reroll even when temporary metadata persistence fails', async () => {
    const { story, ui, database, onGenerate, handlers } = fixture()
    database.updateStoryEntry.mockRejectedValueOnce(new Error('metadata write failed'))
    await handlers.reroll('entry')
    expect(onGenerate).not.toHaveBeenCalled()
    expect(story.settleNarrationReroll).toHaveBeenCalledWith('entry', 'old')
    expect(ui.isGenerating).toBe(false)
    expect(ui.submissionScope).toBeNull()
  })

  it('releases the UI lock after recovery failure while retaining the prose', async () => {
    const { story, ui, handlers } = fixture()
    story.settleNarrationReroll.mockRejectedValueOnce(new Error('recovery failed'))
    await handlers.reroll('entry')
    expect(ui.showToast).toHaveBeenCalledWith(expect.stringContaining('正文已保留'), 'warning')
    expect(story.entries[1].content).toBe('原正文')
    expect(ui.isGenerating).toBe(false)
    expect(ui.submissionScope).toBeNull()
  })

  it('does not restore an old reroll or unlock generation after navigating to another story', async () => {
    const { story, ui, onGenerate, handlers } = fixture()
    onGenerate.mockImplementation(async () => {
      story.currentStory = { ...story.currentStory, id: 'other' }
      ui.submissionScope = createGenerationScope('other', null)
      ui.isGenerating = true
    })
    await handlers.reroll('entry')
    expect(story.settleNarrationReroll).not.toHaveBeenCalled()
    expect(ui.isGenerating).toBe(true)
    expect(ui.submissionScope?.storyId).toBe('other')
  })
})

describe('persistent Writer recovery entry', () => {
  it('accepts an interrupted reroll only when the rolled-back context still matches', async () => {
    const { story, handlers, onGenerate } = fixture()
    Object.assign(story, { preFingerprint: 'pre', currentFingerprint: 'visible-old-prose' })
    handlers.setRecovery({
      id: 'recovery',
      storyId: 'story',
      branchId: null,
      variantBaseEntryId: 'entry',
      contextFingerprint: 'pre',
    })
    await handlers.resume()
    expect(onGenerate).toHaveBeenCalledOnce()
    expect(onGenerate.mock.calls[0][1].writerRecovery.id).toBe('recovery')
  })
  it('rejects expired state without silently invoking either model', async () => {
    const { story, handlers, onGenerate } = fixture()
    Object.assign(story, { preFingerprint: 'changed', currentFingerprint: 'changed' })
    handlers.setRecovery({
      id: 'recovery',
      storyId: 'story',
      branchId: null,
      variantBaseEntryId: 'entry',
      contextFingerprint: 'pre',
      settledFingerprint: 'saved',
    })
    await handlers.resume()
    expect(onGenerate).not.toHaveBeenCalled()
    expect(story.undoNarrationForRegenerate).not.toHaveBeenCalled()
    expect(handlers.message()).toContain('已过期')
    await handlers.resume(true)
    expect(onGenerate).toHaveBeenCalledOnce()
    expect(onGenerate.mock.calls[0][1].writerRecovery).toBeUndefined()
  })
})
