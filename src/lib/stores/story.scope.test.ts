import { mergeVisualDescriptors } from '$lib/utils/visualDescriptors'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { assertWriteScopeCurrent } from '$lib/utils/branchScope'
import { resolveCharacterPresence } from '$lib/services/generation/characterPresence'
import { sameEntityName } from '$lib/utils/text'
import { ClassifierService } from '$lib/services/ai/generation/ClassifierService'
import type { StoryEntryVariant } from '$lib/types'

const model = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('$lib/services/ai/BaseAIService', () => ({ BaseAIService: class {} }))
vi.mock('$lib/services/ai/sdk/generate', () => ({
  generateCollaborativeJsonText: model.generate,
  generateStructured: vi.fn(),
}))
vi.mock('$lib/services/ai/core/CollaborativePromptService', () => ({
  CollaborativePromptService: { render: async () => ({ system: '', user: '' }) },
}))
vi.mock('$lib/services/context', () => ({
  ContextBuilder: class {
    static async forStory() {
      return new this()
    }
    add() {
      return this
    }
    getContext() {
      return {}
    }
  },
}))
vi.mock('$lib/services/database', () => ({ database: { getStoryPackId: async () => null } }))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: { getServicePresetId: () => 'classifier', getPresetConfig: () => ({}) },
}))

// Execute the actual store methods without booting Tauri or a Svelte component tree.
const source = readFileSync('src/lib/stores/story.svelte.ts', 'utf8')
const ast = ts.createSourceFile('story.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'StoryStore',
)!
const names = new Set([
  'captureWriteScope',
  'flatVariantSet',
  'variantSetForEntry',
  'mirrorVariant',
  'appendNarrationVariant',
  'updateNarrationVariant',
  'activateNarrationVariant',
  'discardNarrationVariant',
  'undoNarrationForRegenerate',
  'restoreNarrationVariantState',
  'settleNarrationReroll',
  'switchNarrationVariant',
  'addEntry',
  'applyClassificationResult',
  'applyClassificationResultScoped',
  'applyClassificationResultMutating',
  'retryCollaborativeStateExtraction',
  'assertNotBusy',
  'drainClassificationWrites',
  'wrapUpdate',
  'cowCharacter',
  'cowLocation',
  'cowItem',
  'cowStoryBeat',
  'isCowBranch',
  'addChapter',
  'getNextChapterNumber',
  'addTime',
  'addTimeWithDatabase',
  'applyTimeProgression',
  'normalizeTime',
  'maybeCreateAutoSnapshot',
  'updateEntryTimeEnd',
  'deleteEntry',
  'truncateCollaborativeBranchFrom',
  'deleteEntriesFromPosition',
  'restoreFromRetryBackup',
  'restoreTimeTrackerSnapshot',
  'reloadEntriesForCurrentBranch',
  'restoreTimeFromLastEntry',
  'checkpointsAnchoredTo',
  'forgetCheckpoints',
])
const methods = declaration.members.filter((node) => node.name && names.has(node.name.getText(ast)))
const code = ts.transpileModule(
  `class Store { ${methods.map((m) => m.getText(ast)).join('\n')} }`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fixture(resolvePresence: typeof resolveCharacterPresence = () => []) {
  const database = Object.fromEntries(
    [
      'addCharacter',
      'updateCharacter',
      'addLocation',
      'updateLocation',
      'setCurrentLocation',
      'addItem',
      'updateItem',
      'addStoryBeat',
      'updateStoryBeat',
      'updateStoryEntry',
      'saveTimeTracker',
      'clearTimeTracker',
      'restoreRetryBackup',
      'deleteCheckpoints',
      'deleteEntriesWithDependents',
      'createWorldStateSnapshot',
      'addChapter',
      'updateStory',
      'stageAtomicStatements',
    ].map((name) => [name, vi.fn(async () => {})]),
  ) as Record<string, any>
  database.getNextEntryPosition = vi.fn(async () => 1)
  database.getLatestSnapshotBefore = vi.fn(async () => null)
  database.collectAtomicWrites = vi.fn(async (callback) => callback(database))
  database.addStoryEntry = vi.fn(async (entry) => entry)
  for (const method of [
    'getStoryEntriesForBranch',
    'getChaptersForBranch',
    'getCharactersForBranch',
    'getLocationsForBranch',
    'getItemsForBranch',
    'getStoryBeatsForBranch',
    'getEntriesForBranch',
  ]) {
    database[method] = vi.fn(async () => [])
  }
  const settings = {
    experimentalFeatures: {
      stateTracking: false,
      rollbackOnDelete: false,
      lightweightBranches: true,
      autoSnapshotInterval: 0,
    },
  }
  const rollbackService = {
    rollbackFromPosition: vi.fn(async (): Promise<void> => {
      throw new Error('rollback reached')
    }),
  }
  const ui = { showToast: vi.fn() }
  const aiService = { classifyResponse: vi.fn() }
  const Store = new Function(
    'database',
    'settings',
    'ui',
    'assertWriteScopeCurrent',
    'countTokens',
    'log',
    'sameEntityName',
    'extractInlineCustomVars',
    'resolveCharacterPresence',
    'emitStateUpdated',
    'emitChapterCreated',
    'rollbackService',
    'createStateMaintenanceRecord',
    'planStateRollback',
    'collaborativeTruncationPlanStatements',
    'clearTier3SelectionCache',
    'clearImageMarkerCache',
    'isCollaborativeStory',
    'aiService',
    'mergeVisualDescriptors',
    `${code}; return Store`,
  )(
    database,
    settings,
    ui,
    assertWriteScopeCurrent,
    () => 1,
    () => {},
    sameEntityName,
    () => ({}),
    resolvePresence,
    vi.fn(),
    vi.fn(),
    rollbackService,
    (status: string, options: Record<string, unknown> = {}) => ({
      version: 2,
      status,
      deltaVersion: status === 'applied' ? 2 : null,
      completedAt: 1,
      ...options,
    }),
    () => ({ valid: false, issues: [{ position: 1 }] }),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    (story: { mode?: string } | null) => story?.mode === 'creative-writing',
    aiService,
    mergeVisualDescriptors,
  )
  const store = new Store()
  Object.assign(store, {
    currentStory: {
      id: 'A',
      mode: 'creative-writing',
      currentBranchId: 'a',
      settings: { collaborativeNovelWorkflow: {} },
    },
    storyLoadSeq: 0,
    classificationWrite: null,
    branchSwitchSeq: 0,
    entries: [],
    characters: [],
    locations: [],
    items: [],
    storyBeats: [],
    chapters: [],
    checkpoints: [],
    lorebookEntries: [],
    classificationErrors: 0,
    timeTracker: { years: 0, days: 0, hours: 0, minutes: 0 },
    invalidateWordCountCache: vi.fn(),
    invalidateChapterCache: vi.fn(),
    assertNoBranchForkAtOrAfter: vi.fn(),
    restoreSuggestedActionsAfterDelete: vi.fn(),
    applyRollbackPlanInMemory: vi.fn(),
    refreshWorldState: vi.fn(async () => {}),
  })
  const switchStory = () => {
    store.currentStory = { id: 'B', mode: 'adventure', currentBranchId: 'b', settings: {} }
    store.entries = []
    store.characters = []
    store.locations = []
    store.items = []
    store.storyBeats = []
    store.chapters = []
  }
  return { store, database, settings, ui, switchStory, rollbackService, aiService }
}

function classification() {
  return {
    entryUpdates: {
      characterUpdates: [],
      locationUpdates: [],
      itemUpdates: [],
      storyBeatUpdates: [],
      newCharacters: [],
      newLocations: [],
      newItems: [],
      newStoryBeats: [],
    },
    scene: { timeProgression: 'none' },
  } as any
}

describe('opening variant storage stays bounded', () => {
  function openingFixture(count = 10) {
    const context = fixture()
    const variants = Array.from({ length: count }, (_, index) => ({
      id: `opening-${index}`,
      content: `第${index + 1}个开场白。${'保留这段正文。'.repeat(400)}`,
      createdAt: 1,
      metadata: { source: 'wizard', tokenCount: 1000 },
      classificationResult: null,
      worldStateDelta: null,
    }))
    context.store.entries = [
      {
        id: 'opening',
        storyId: 'A',
        branchId: 'a',
        type: 'narration',
        position: 0,
        content: variants[0].content,
        createdAt: 1,
        metadata: {
          source: 'wizard',
          variantSet: { version: 1, activeVariantId: variants[0].id, variants },
        },
      },
    ]
    return { ...context, contents: variants.map((variant) => variant.content) }
  }

  it('can switch ten long openings one hundred times without nesting whole variant sets', async () => {
    const { store, database, contents } = openingFixture()
    const initialSize = JSON.stringify(store.entries[0].metadata).length
    for (let iteration = 1; iteration <= 100; iteration++) {
      const index = iteration % contents.length
      await store.switchNarrationVariant('opening', `opening-${index}`)
      const entry = store.entries[0]
      expect(entry.content).toBe(contents[index])
      expect(
        entry.metadata.variantSet.variants.map((variant: StoryEntryVariant) => variant.content),
      ).toEqual(contents)
      expect(JSON.stringify(entry.metadata).length).toBeLessThan(initialSize + 1500)
      for (const variant of entry.metadata.variantSet.variants) {
        expect(variant.metadata).not.toHaveProperty('variantSet')
      }
      const statements = database.stageAtomicStatements.mock.calls.at(-1)![0]
      const saved = JSON.parse(statements[0].params[4])
      expect(saved).toEqual(entry.metadata)
    }
  })

  it('drops legacy nested copies before serializing, without traversing them', () => {
    const { store, contents } = openingFixture()
    const existing = store.entries[0].metadata.variantSet
    existing.variants[3].metadata.variantSet = {
      toJSON() {
        throw new Error('nested version history must not be serialized')
      },
    }
    const normalized = store.variantSetForEntry(store.entries[0])
    expect(normalized.variants.map((variant: StoryEntryVariant) => variant.content)).toEqual(
      contents,
    )
    expect(normalized.variants[3].metadata).not.toHaveProperty('variantSet')
    expect(existing.variants[3].metadata).toHaveProperty('variantSet')
  })

  it('strips whole-set metadata passed to append and preserves other per-variant fields', async () => {
    const { store, contents } = openingFixture()
    await store.appendNarrationVariant('opening', {
      id: 'new',
      content: '新版本',
      createdAt: 2,
      metadata: { ...store.entries[0].metadata, model: 'model-a' },
    })
    const variants = store.entries[0].metadata.variantSet.variants
    expect(variants.map((variant: StoryEntryVariant) => variant.content)).toEqual([
      ...contents,
      '新版本',
    ])
    expect(variants.at(-1).metadata.model).toBe('model-a')
    expect(variants.at(-1).metadata).not.toHaveProperty('variantSet')
  })
})

describe('interrupted same-turn reroll recovery', () => {
  function rerollFixture() {
    const context = fixture()
    const result = classification()
    const delta = {
      version: 2,
      classificationResult: result,
      previousState: { timeTracker: { years: 0, days: 0, hours: 0, minutes: 0 } },
      createdEntities: { locationIds: ['old-location'] },
    }
    context.store.entries = [
      {
        id: 'entry',
        storyId: 'A',
        branchId: 'a',
        type: 'narration',
        position: 1,
        content: '原正文',
        createdAt: 1,
        worldStateDelta: delta,
        metadata: {
          timeEnd: { years: 0, days: 0, hours: 0, minutes: 15 },
          collaborativeStateMaintenance: { version: 2, status: 'applied', deltaVersion: 2 },
          variantSet: {
            version: 1,
            activeVariantId: 'old',
            variants: [{ id: 'old', content: '原正文', createdAt: 1, state: 'pending' }],
          },
        },
      },
    ]
    context.store.truncateCollaborativeBranchFrom = vi.fn(async (_id, preserved) => {
      context.store.entries = preserved ? [preserved] : []
    })
    return { ...context, result, delta }
  }

  it('atomically stages preserved prose with truthful rollback status and the saved classification', async () => {
    const { store, result, delta, database } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    const entry = store.entries[0]
    expect(entry.content).toBe('原正文')
    expect(entry.worldStateDelta).toBeNull()
    expect(entry.metadata.timeEnd).toEqual(delta.previousState.timeTracker)
    expect(entry.metadata.collaborativeStateMaintenance.status).toBe('failed')
    expect(entry.metadata.variantSet.variants[0]).toMatchObject({
      classificationResult: result,
      worldStateDelta: null,
      metadata: { collaborativeStateMaintenance: { status: 'failed' } },
    })
    expect(store.truncateCollaborativeBranchFrom).toHaveBeenCalledWith('entry', entry)
    expect(database.addStoryEntry).not.toHaveBeenCalled()
    expect(delta.createdEntities.locationIds).toEqual(['old-location'])
  })

  it('retains saved facts when preparing again after an interrupted rollback', async () => {
    const { store, result } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    expect(store.entries[0].metadata.variantSet.variants[0].classificationResult).toEqual(result)
  })

  it('reapplies old facts once after pre-writer cancellation using the saved classification', async () => {
    const { store, result } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    store.applyClassificationResult = vi.fn(async () => {
      store.entries[0] = {
        ...store.entries[0],
        worldStateDelta: { version: 2, classificationResult: result },
        metadata: {
          ...store.entries[0].metadata,
          collaborativeStateMaintenance: { status: 'applied' },
        },
      }
    })
    await store.settleNarrationReroll('entry', 'old')
    await store.settleNarrationReroll('entry', 'old')
    expect(store.applyClassificationResult).toHaveBeenCalledExactlyOnceWith(result, 'entry')
    expect(
      store.entries[0].metadata.variantSet.variants[0].metadata.collaborativeStateMaintenance
        .status,
    ).toBe('applied')
    expect(store.entries[0].content).toBe('原正文')
  })

  it('keeps completed replacement prose when cancellation interrupts extraction', async () => {
    const { store } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    await store.appendNarrationVariant('entry', { id: 'new', content: '新正文', createdAt: 2 })
    store.applyClassificationResult = vi.fn()
    await store.settleNarrationReroll('entry', 'old')
    expect(store.applyClassificationResult).not.toHaveBeenCalled()
    expect(store.entries[0].content).toBe('新正文')
    expect(store.entries[0].worldStateDelta).toBeNull()
    expect(store.entries[0].metadata.collaborativeStateMaintenance.status).toBe('failed')
    expect(store.entries[0].metadata.variantSet.variants).toHaveLength(2)
  })

  it('retains applied extraction that drained after stop without applying it twice', async () => {
    const { store, result } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    await store.appendNarrationVariant('entry', { id: 'new', content: '新正文', createdAt: 2 })
    store.entries[0].metadata.collaborativeStateMaintenance = { status: 'applied' }
    store.entries[0].worldStateDelta = { version: 2, classificationResult: result }
    store.applyClassificationResult = vi.fn()
    await store.settleNarrationReroll('entry', 'old')
    expect(store.applyClassificationResult).not.toHaveBeenCalled()
    expect(store.entries[0].metadata.variantSet.variants[1]).toMatchObject({
      state: 'stored',
      classificationResult: result,
      worldStateDelta: { version: 2 },
    })
  })

  it('leaves a removable failed record if restoring old facts fails', async () => {
    const { store } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    store.applyClassificationResult = vi.fn(async () => {
      throw new Error('write failed')
    })
    await expect(store.settleNarrationReroll('entry', 'old')).rejects.toThrow('write failed')
    expect(store.entries[0].worldStateDelta).toBeNull()
    expect(store.entries[0].metadata.collaborativeStateMaintenance.status).toBe('failed')
  })

  it('does not recover into a different story after waiting for an in-flight extraction', async () => {
    const { store, switchStory, database } = rerollFixture()
    await store.undoNarrationForRegenerate('entry', { preserveEntry: true })
    const pending = deferred<void>()
    store.drainClassificationWrites = () => pending.promise
    const recovery = store.settleNarrationReroll('entry', 'old')
    switchStory()
    pending.resolve()
    await expect(recovery).rejects.toMatchObject({ name: 'AbortError' })
    expect(database.updateStoryEntry).not.toHaveBeenCalled()
  })
})

describe('collaborative failed extraction and standalone retry', () => {
  function failedFixture() {
    const context = fixture(resolveCharacterPresence)
    context.store.entries = [
      {
        id: 'entry',
        type: 'narration',
        storyId: 'A',
        branchId: 'a',
        position: 1,
        content: '她把水杯放在桌边，没有替他作答。',
        worldStateDelta: null,
        metadata: {
          collaborativeStateMaintenance: { version: 2, status: 'failed', error: '旧错误' },
        },
      },
    ]
    return context
  }

  it.each([false, true])(
    'persists failed extraction without applying partial data=%s',
    async (partial) => {
      const { store, database } = failedFixture()
      const original = structuredClone(store.entries[0])
      const result = classification()
      result._error = '更新目标未匹配'
      if (partial) {
        result.entryUpdates.newCharacters = [{ name: '不应保存的人物' }]
        result.scene.timeProgression = 'days'
      }
      await expect(store.applyClassificationResult(result, 'entry')).rejects.toThrow(result._error)
      expect(store.entries[0].content).toBe(original.content)
      expect(store.entries[0].worldStateDelta).toBeNull()
      expect(store.entries[0].metadata.collaborativeStateMaintenance).toMatchObject({
        status: 'failed',
        error: result._error,
        deltaVersion: null,
      })
      expect(database.updateStoryEntry).toHaveBeenCalledWith('entry', {
        metadata: store.entries[0].metadata,
        worldStateDelta: null,
      })
      expect(database.addCharacter).not.toHaveBeenCalled()
      expect(database.saveTimeTracker).not.toHaveBeenCalled()
      expect(store.characters).toEqual([])
    },
  )

  it('keeps adventure partial recovery unchanged', async () => {
    const { store, database } = failedFixture()
    store.currentStory.mode = 'adventure'
    const result = classification()
    result._error = '部分字段无效'
    result.entryUpdates.newCharacters = [{ name: '可恢复人物' }]
    await store.applyClassificationResult(result, 'entry')
    expect(database.addCharacter).toHaveBeenCalledOnce()
  })

  it('does not apply failed collaborative chapter extraction without an entry id', async () => {
    const { store, database } = failedFixture()
    const result = classification()
    result._error = '部分恢复仍失败'
    result.entryUpdates.newCharacters = [{ name: '不应保存的人物' }]
    await expect(store.applyClassificationResult(result)).rejects.toThrow(result._error)
    expect(database.addCharacter).not.toHaveBeenCalled()
    expect(database.updateStoryEntry).not.toHaveBeenCalled()
  })

  it('rejects a synthetic renamed thread before state writes and accepts a corrected standalone retry', async () => {
    const { store, database, aiService } = failedFixture()
    const response = classification()
    response.entryUpdates.storyBeatUpdates = [
      { title: '设备检修', changes: { description: '检修人员已经到场。' } },
      { title: '材料采购', changes: { description: '订单已核对，尚未付款。' } },
      { title: '场地预约', changes: { description: '预约时间仍待确认。' } },
    ]
    const renamedThread = {
      prose: '检修人员走进仓库。采购单已经核对，会议室的预约时间还没有确认。',
      existingCharacters: [],
      existingLocations: [],
      existingItems: [],
      existingStoryBeats: ['设备检修通知', '材料采购', '场地预约'].map((title) => ({
        title,
        description: '尚未完成的测试事项',
        status: 'active',
      })),
      responseText: JSON.stringify(response),
    }
    store.entries[0].content = renamedThread.prose
    const service = new ClassifierService('classifier')
    const context = {
      storyId: store.currentStory.id,
      story: store.currentStory,
      narrativeResponse: renamedThread.prose,
      userAction: '继续',
      ...renamedThread,
    } as unknown as Parameters<ClassifierService['classify']>[0]
    for (const [collection, existing] of [
      ['characters', 'existingCharacters'],
      ['locations', 'existingLocations'],
      ['items', 'existingItems'],
      ['storyBeats', 'existingStoryBeats'],
    ] as const) {
      store[collection] = context[existing].map((entity, index) => ({
        ...entity,
        id: `${collection}-${index}`,
        storyId: 'A',
        branchId: 'a',
      }))
    }
    const before = structuredClone({
      characters: store.characters,
      locations: store.locations,
      items: store.items,
      storyBeats: store.storyBeats,
    })
    model.generate.mockImplementationOnce(async (options) =>
      options.schema.parse(JSON.parse(renamedThread.responseText)),
    )
    const rejected = await service.classify(context)
    expect(rejected._error).toContain('线程「设备检修」')
    await expect(store.applyClassificationResult(rejected, 'entry')).rejects.toThrow('未匹配')
    expect({
      characters: store.characters,
      locations: store.locations,
      items: store.items,
      storyBeats: store.storyBeats,
    }).toEqual(before)
    expect(database.collectAtomicWrites).not.toHaveBeenCalled()
    expect(database.addStoryBeat).not.toHaveBeenCalled()
    expect(store.entries[0].content).toBe(renamedThread.prose)
    expect(store.entries[0].metadata.collaborativeStateMaintenance.status).toBe('failed')

    const corrected = JSON.parse(renamedThread.responseText)
    corrected.entryUpdates.storyBeatUpdates.find(
      (update: any) => update.title === '设备检修',
    ).title = '设备检修通知'
    model.generate.mockImplementationOnce(async (options) => options.schema.parse(corrected))
    aiService.classifyResponse.mockImplementation(() => service.classify(context))
    await store.retryCollaborativeStateExtraction('entry')
    expect(database.addStoryBeat).not.toHaveBeenCalled()
    expect(database.updateStoryBeat).toHaveBeenCalledTimes(3)
    expect(store.storyBeats).toHaveLength(before.storyBeats.length)
    expect(store.entries[0].content).toBe(renamedThread.prose)
    expect(store.entries[0].metadata.collaborativeStateMaintenance.status).toBe('applied')
    expect(model.generate.mock.calls).toHaveLength(2)
  })

  it.each([false, true])(
    'retries only saved prose and persists successful changes=%s',
    async (changed) => {
      const { store, database, aiService } = failedFixture()
      const prose = store.entries[0].content
      const result = classification()
      if (changed) result.entryUpdates.newStoryBeats = [{ title: '重新排班', status: 'active' }]
      aiService.classifyResponse.mockResolvedValue(result)
      await store.retryCollaborativeStateExtraction('entry')
      expect(aiService.classifyResponse).toHaveBeenCalledOnce()
      expect(aiService.classifyResponse.mock.calls[0][0]).toBe(prose)
      expect(store.entries[0].content).toBe(prose)
      expect(store.entries[0].metadata.collaborativeStateMaintenance).toMatchObject({
        status: changed ? 'applied' : 'no_changes',
      })
      expect(store.entries[0].metadata.collaborativeStateMaintenance.error).toBeUndefined()
      expect(database.addStoryBeat).toHaveBeenCalledTimes(changed ? 1 : 0)
    },
  )

  it('reports a failed retry while retaining its saved prose and retry status', async () => {
    const { store, aiService } = failedFixture()
    const result = classification()
    result._error = '本次仍未匹配'
    aiService.classifyResponse.mockResolvedValue(result)
    await expect(store.retryCollaborativeStateExtraction('entry')).rejects.toThrow(result._error)
    expect(store.entries[0].content).toContain('没有替他作答')
    expect(store.entries[0].metadata.collaborativeStateMaintenance).toMatchObject({
      status: 'failed',
      error: result._error,
    })
  })

  it('does not restore an old branch after failure metadata finishes saving', async () => {
    const { store, database, switchStory } = failedFixture()
    const pending = deferred<void>()
    database.updateStoryEntry.mockReturnValue(pending.promise)
    const result = classification()
    result._error = '提取失败'
    const run = store.applyClassificationResult(result, 'entry')
    const assertion = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(database.updateStoryEntry).toHaveBeenCalledOnce())
    switchStory()
    const entries = [{ id: 'entry', type: 'narration', content: '另一个故事的正文' }]
    store.entries = entries
    pending.resolve()
    await assertion
    expect(store.entries).toBe(entries)
    expect(store.entries[0].metadata).toBeUndefined()
  })

  it('retains the active variant and its maintenance after a successful retry', async () => {
    const { store, aiService } = failedFixture()
    const original = store.entries[0]
    await store.appendNarrationVariant('entry', {
      id: 'active',
      content: original.content,
      metadata: original.metadata,
      worldStateDelta: null,
      createdAt: 2,
    })
    aiService.classifyResponse.mockResolvedValue(classification())
    await store.retryCollaborativeStateExtraction('entry')
    const set = store.entries[0].metadata.variantSet
    expect(set.activeVariantId).toBe('active')
    expect(
      set.variants.find((variant: any) => variant.id === 'active').metadata
        .collaborativeStateMaintenance.status,
    ).toBe('no_changes')
    expect(
      set.variants.find((variant: any) => variant.id !== 'active').metadata
        .collaborativeStateMaintenance.status,
    ).toBe('failed')
  })

  it.each(['applied', 'no_changes', 'disabled'])(
    'does not reapply a %s extraction',
    async (status) => {
      const { store, aiService } = failedFixture()
      store.entries[0].metadata.collaborativeStateMaintenance.status = status
      aiService.classifyResponse.mockResolvedValue(classification())
      await expect(store.retryCollaborativeStateExtraction('entry')).rejects.toThrow()
      expect(aiService.classifyResponse).not.toHaveBeenCalled()
    },
  )

  it('does not retry an inherited narration against the current branch state', async () => {
    const { store, aiService } = failedFixture()
    store.entries[0].branchId = 'parent'
    aiService.classifyResponse.mockResolvedValue(classification())
    await expect(store.retryCollaborativeStateExtraction('entry')).rejects.toThrow('继承')
    expect(aiService.classifyResponse).not.toHaveBeenCalled()
  })

  it('does not erase a committed undo delta on a later failed application', async () => {
    const { store } = failedFixture()
    const result = classification()
    result.entryUpdates.newStoryBeats = [{ title: '重新排班', status: 'active' }]
    await store.applyClassificationResult(result, 'entry')
    const committed = structuredClone(store.entries[0].worldStateDelta)
    const failed = classification()
    failed._error = '稍后失败'
    await expect(store.applyClassificationResult(failed, 'entry')).rejects.toThrow(failed._error)
    expect(store.entries[0].worldStateDelta).toEqual(committed)
    expect(store.entries[0].metadata.collaborativeStateMaintenance).toMatchObject({
      status: 'applied',
      warning: failed._error,
    })
    expect(store.storyBeats).toHaveLength(1)
  })

  it.each(['navigate', 'edit', 'next-narration', 'disable', 'variant', 'reload'])(
    'rejects a late retry after %s',
    async (change) => {
      const { store, database, aiService, switchStory } = failedFixture()
      const pending = deferred<any>()
      aiService.classifyResponse.mockReturnValue(pending.promise)
      const run = store.retryCollaborativeStateExtraction('entry')
      const assertion = expect(run).rejects.toThrow()
      if (change === 'navigate') switchStory()
      if (change === 'edit') store.entries = [{ ...store.entries[0], content: '用户编辑的正文' }]
      if (change === 'next-narration')
        store.entries = [...store.entries, { id: 'next', type: 'narration', position: 2 }]
      if (change === 'disable')
        store.currentStory.settings.collaborativeNovelWorkflow.factStateExtractor = {
          enabled: false,
        }
      if (change === 'variant')
        store.entries = [
          {
            ...store.entries[0],
            metadata: {
              ...store.entries[0].metadata,
              variantSet: { activeVariantId: 'different' },
            },
          },
        ]
      if (change === 'reload') store.storyLoadSeq += 1
      const result = classification()
      result.entryUpdates.newStoryBeats = [{ title: '过期状态' }]
      pending.resolve(result)
      await assertion
      expect(database.addStoryBeat).not.toHaveBeenCalled()
      expect(database.updateStoryEntry).not.toHaveBeenCalled()
    },
  )
})

describe('collaborative classification presence', () => {
  // These fixtures start at the accepted extraction boundary. They exercise the real
  // state application methods, not an invented local prose/knowledge classifier.
  it.each([
    ['off-scene ending', '陈禾在远处仓库烧掉旧账；林和沈宁仍在渡口，尚不知情。'],
    [
      'historical flashback',
      '作者叙述三年前陈禾在仓库保管旧账；当前林和沈宁仍在渡口，未获知旧事。',
    ],
    ['reader-only revelation', '作者揭示陈禾是旧账的持有人；这是读者所见，林尚未知道其身份。'],
  ])(
    'applies %s without moving the protagonist, advancing time or granting knowledge',
    async (_kind, description) => {
      const { store, database } = fixture(resolveCharacterPresence)
      store.currentStory.currentBranchId = null
      store.characters = [
        { id: 'lin', name: '林', relationship: 'self', status: 'active', traits: [] },
        { id: 'shen', name: '沈宁', relationship: '尚未答应合作', status: 'active', traits: [] },
      ]
      store.locations = [{ id: 'ferry', name: '渡口', current: true }]
      store.currentLocation = store.locations[0]
      const beforeTime = structuredClone(store.timeTracker)
      const result = classification()
      result.entryUpdates.newCharacters = [{ name: '陈禾', status: 'inactive', description }]
      result.entryUpdates.newLocations = [
        { name: '仓库', visited: false, description: '旧账曾存放的场外地点。' },
      ]
      result.entryUpdates.newStoryBeats = [
        { title: '旧账去向', description, type: 'revelation', status: 'active' },
      ]
      result.scene = {
        currentLocationName: '渡口',
        presentCharacterNames: ['沈宁'],
        timeProgression: 'none',
      }
      await store.applyClassificationResult(result)
      expect(database.setCurrentLocation).not.toHaveBeenCalled()
      expect(database.saveTimeTracker).not.toHaveBeenCalled()
      expect(store.timeTracker).toEqual(beforeTime)
      expect(store.locations.find((location: any) => location.name === '渡口').current).toBe(true)
      expect(store.locations.find((location: any) => location.name === '仓库').current).toBe(false)
      expect(store.characters.find((character: any) => character.name === '陈禾').status).toBe(
        'inactive',
      )
      expect(
        store.characters.find((character: any) => character.name === '沈宁').relationship,
      ).toBe('尚未答应合作')
      expect(database.addStoryBeat).toHaveBeenCalledWith(expect.objectContaining({ description }))
      expect(database.updateCharacter).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['creative-writing', 'inactive', 'inactive'],
    ['creative-writing', 'deceased', 'deceased'],
    ['adventure', 'inactive', 'active'],
    ['adventure', 'deceased', 'active'],
  ])('applies new-character %s / %s as %s', async (mode, suppliedStatus, expectedStatus) => {
    const { store, database } = fixture(resolveCharacterPresence)
    store.currentStory.mode = mode
    const result = classification()
    result.entryUpdates.newCharacters = [
      { name: '周衡', status: suppliedStatus, description: '据老宋声称与信件有关，未核实。' },
    ]
    result.scene.presentCharacterNames = ['沈宁']
    await store.applyClassificationResult(result)
    expect(database.addCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ name: '周衡', status: expectedStatus }),
    )
    expect(store.characters.find((character: any) => character.name === '周衡').status).toBe(
      expectedStatus,
    )
    if (mode === 'creative-writing') expect(database.updateCharacter).not.toHaveBeenCalled()
  })

  it('allows a previously mentioned character to enter in a later scene', async () => {
    const { store } = fixture(resolveCharacterPresence)
    const first = classification()
    first.entryUpdates.newCharacters = [{ name: '周衡', status: 'inactive' }]
    first.scene.presentCharacterNames = ['沈宁']
    await store.applyClassificationResult(first)
    const next = classification()
    next.scene.presentCharacterNames = ['周衡']
    await store.applyClassificationResult(next)
    expect(store.characters.find((character: any) => character.name === '周衡').status).toBe(
      'active',
    )
  })
})

describe('collaborative missing character status', () => {
  it.each([
    ['creative-writing', ['沈宁'], 'inactive'],
    ['creative-writing', ['沈宁', '周衡'], 'active'],
    ['creative-writing', [], 'inactive'],
    ['adventure', ['沈宁'], 'active'],
  ])('uses presence evidence in %s / %j', async (mode, presentNames, expectedStatus) => {
    const { store } = fixture(resolveCharacterPresence)
    store.currentStory.mode = mode
    const result = classification()
    result.entryUpdates.newCharacters = [{ name: '周衡', description: '仅在回忆中提及。' }]
    result.scene.presentCharacterNames = presentNames
    await store.applyClassificationResult(result)
    expect(store.characters.find((character: any) => character.name === '周衡').status).toBe(
      expectedStatus,
    )
  })

  it('does not bring an unknown character update into the scene without evidence', async () => {
    const { store } = fixture(resolveCharacterPresence)
    const result = classification()
    result.entryUpdates.characterUpdates = [
      { name: '周衡', changes: { relationship: '被提及的朋友' } },
    ]
    result.scene.presentCharacterNames = []
    await store.applyClassificationResult(result)
    expect(store.characters.find((character: any) => character.name === '周衡').status).toBe(
      'inactive',
    )
  })
})

describe('narration variant lifecycle', () => {
  it('treats a legacy narration as one variant and keeps it when appending pending prose', async () => {
    const { store, database } = fixture()
    store.entries = [
      {
        id: 'entry',
        type: 'narration',
        storyId: 'A',
        branchId: 'a',
        position: 1,
        content: '旧正文',
        reasoning: '旧推理',
        translatedContent: null,
        translationLanguage: null,
        metadata: { source: 'legacy' },
        worldStateDelta: null,
        suggestedActions: null,
        createdAt: 1,
      },
    ]

    const result = await store.appendNarrationVariant(
      'entry',
      { id: 'new', content: '新正文', createdAt: 2, state: 'pending' },
      { activate: false },
    )

    expect(result.content).toBe('旧正文')
    expect(result.metadata.variantSet.activeVariantId).toBe('legacy-entry')
    expect(result.metadata.variantSet.variants.map((v: any) => v.id)).toEqual([
      'legacy-entry',
      'new',
    ])
    expect(result.metadata.variantSet.variants[1].state).toBe('pending')
    expect(database.updateStoryEntry).toHaveBeenCalledWith(
      'entry',
      expect.objectContaining({ content: '旧正文', metadata: expect.any(Object) }),
    )
  })

  it('mirrors every active variant field when activation changes', async () => {
    const { store } = fixture()
    store.entries = [
      {
        id: 'entry',
        type: 'narration',
        storyId: 'A',
        branchId: 'a',
        position: 1,
        content: '旧正文',
        metadata: {
          variantSet: {
            version: 1,
            activeVariantId: 'old',
            variants: [
              { id: 'old', content: '旧正文', createdAt: 1, suggestedActions: 'old-actions' },
              {
                id: 'new',
                content: '新正文',
                reasoning: '新推理',
                translatedContent: 'translated',
                translationLanguage: 'en',
                worldStateDelta: {
                  version: 2,
                  classificationResult: {},
                  createdEntities: {},
                  updatedEntities: {},
                  previousState: {},
                },
                suggestedActions: 'new-actions',
                createdAt: 2,
              },
            ],
          },
        },
        createdAt: 1,
      },
    ]

    const result = await store.activateNarrationVariant('entry', 'new')
    expect(result.content).toBe('新正文')
    expect(result.reasoning).toBe('新推理')
    expect(result.translatedContent).toBe('translated')
    expect(result.translationLanguage).toBe('en')
    expect(result.worldStateDelta).toMatchObject({ version: 2 })
    expect(result.suggestedActions).toBe('new-actions')
    expect(result.metadata.variantSet.activeVariantId).toBe('new')
  })
})

describe('store scoped async writes', () => {
  it.each(['story', 'branch', 'turn', 'roundtrip'])(
    'cancels entry insertion after position lookup when %s changes',
    async (kind) => {
      const { store, database, switchStory } = fixture()
      const pending = deferred<number>()
      database.getNextEntryPosition.mockReturnValue(pending.promise)
      let current = true
      const run = store.addEntry('narration', 'text', undefined, undefined, 'entry', {
        isScopeCurrent: () => current,
      })
      if (kind === 'story') switchStory()
      if (kind === 'branch') store.currentStory.currentBranchId = 'b'
      if (kind === 'turn') current = false
      if (kind === 'roundtrip') store.branchSwitchSeq += 2
      pending.resolve(1)
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(database.addStoryEntry).not.toHaveBeenCalled()
    },
  )

  it('does not refill the new story after an already-issued entry write', async () => {
    const { store, database, switchStory } = fixture()
    const pending = deferred<any>()
    database.addStoryEntry.mockReturnValue(pending.promise)
    const run = store.addEntry('narration', 'text')
    await vi.waitFor(() => expect(database.addStoryEntry).toHaveBeenCalledOnce())
    expect(database.addStoryEntry.mock.calls[0][0]).toMatchObject({ storyId: 'A', branchId: 'a' })
    switchStory()
    pending.resolve({ id: 'old' })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.entries).toEqual([])
    expect(database.updateStory).not.toHaveBeenCalled()
  })

  it.each([
    ['newCharacters', 'addCharacter', 'characters', { name: 'one' }],
    ['newLocations', 'addLocation', 'locations', { name: 'one' }],
    ['newItems', 'addItem', 'items', { name: 'one' }],
    ['newStoryBeats', 'addStoryBeat', 'storyBeats', { title: 'one' }],
  ] as const)(
    'cancels %s before another write or store refill',
    async (field, method, collection, entity) => {
      const { store, database, switchStory, ui } = fixture()
      const pending = deferred<void>()
      database[method].mockReturnValue(pending.promise)
      const result = classification()
      result.entryUpdates[field] = [entity, { ...entity, name: 'two', title: 'two' }]
      const run = store.applyClassificationResult(result, 'entry')
      await vi.waitFor(() => expect(database[method]).toHaveBeenCalledOnce())
      expect(database[method].mock.calls[0][0]).toMatchObject({ storyId: 'A', branchId: 'a' })
      switchStory()
      pending.resolve()
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(store[collection]).toEqual([])
      expect(database[method]).toHaveBeenCalledOnce()
      expect(database.updateStoryEntry).not.toHaveBeenCalled()
      expect(ui.showToast).not.toHaveBeenCalled()
    },
  )

  it('guards COW refill and the subsequent classifier update', async () => {
    const { store, database, switchStory } = fixture()
    store.characters = [{ id: 'inherited', storyId: 'A', branchId: null, name: 'one', traits: [] }]
    const pending = deferred<void>()
    database.addCharacter.mockReturnValue(pending.promise)
    const result = classification()
    result.entryUpdates.characterUpdates = [{ name: 'one', changes: { status: 'inactive' } }]
    const run = store.applyClassificationResult(result)
    await vi.waitFor(() => expect(database.addCharacter).toHaveBeenCalledOnce())
    switchStory()
    pending.resolve()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(database.updateCharacter).not.toHaveBeenCalled()
    expect(store.characters).toEqual([])
  })

  it.each([
    [
      'characterUpdates',
      'updateCharacter',
      'characters',
      { name: 'one', changes: { status: 'inactive' } },
    ],
    [
      'locationUpdates',
      'updateLocation',
      'locations',
      { name: 'one', changes: { description: 'changed' } },
    ],
    ['itemUpdates', 'updateItem', 'items', { name: 'one', changes: { quantity: 2 } }],
    [
      'storyBeatUpdates',
      'updateStoryBeat',
      'storyBeats',
      { title: 'one', changes: { status: 'completed' } },
    ],
  ] as const)(
    'cancels %s while an owned entity update is pending',
    async (field, method, collection, change) => {
      const { store, database, switchStory } = fixture()
      store[collection] = [
        { id: 'owned', storyId: 'A', branchId: 'a', name: 'one', title: 'one', traits: [] },
      ]
      const pending = deferred<void>()
      database[method].mockReturnValue(pending.promise)
      const result = classification()
      result.entryUpdates[field] = [change]
      const run = store.applyClassificationResult(result, 'entry')
      await vi.waitFor(() => expect(database[method]).toHaveBeenCalledOnce())
      switchStory()
      pending.resolve()
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(store[collection]).toEqual([])
      expect(database.updateStoryEntry).not.toHaveBeenCalled()
    },
  )

  it('finishes delta persistence when a same-scope turn is stopped', async () => {
    const { store, database } = fixture()
    const pending = deferred<void>()
    database.updateStoryEntry.mockReturnValue(pending.promise)
    let current = true
    store.entries = [{ id: 'entry' }]
    const run = store.applyClassificationResult(classification(), 'entry', {
      isScopeCurrent: () => current,
    })
    await vi.waitFor(() => expect(database.updateStoryEntry).toHaveBeenCalledOnce())
    current = false
    pending.resolve()
    await expect(run).resolves.toBeUndefined()
    expect(store.entries[0].worldStateDelta).toBeDefined()
    expect(database.createWorldStateSnapshot).not.toHaveBeenCalled()
  })

  it('rollback waits for classification writes and its delta before starting', async () => {
    const { store, database, rollbackService } = fixture()
    const pending = deferred<void>()
    database.addCharacter.mockReturnValue(pending.promise)
    store.entries = [{ id: 'entry', position: 1 }]
    store.assertNoBranchForkAtOrAfter = vi.fn()
    const result = classification()
    result.entryUpdates.newCharacters = [{ name: 'one' }]
    let current = true
    const run = store.applyClassificationResult(result, 'entry', { isScopeCurrent: () => current })
    await vi.waitFor(() => expect(database.addCharacter).toHaveBeenCalledOnce())
    current = false
    const rollback = store.deleteEntriesFromPosition(1)
    const refused = expect(rollback).rejects.toThrow('无法安全删除')
    await Promise.resolve()
    expect(rollbackService.rollbackFromPosition).not.toHaveBeenCalled()
    pending.resolve()
    await run
    await refused
    const delta = store.entries[0].worldStateDelta
    expect(delta.createdEntities.characterIds).toHaveLength(1)
    expect(database.updateStoryEntry).toHaveBeenCalled()
  })

  it('refuses rollback when the draining classification cannot save its undo record', async () => {
    const { store, database, rollbackService } = fixture()
    const pending = deferred<void>()
    database.addCharacter.mockReturnValue(pending.promise)
    database.updateStoryEntry.mockRejectedValue(new Error('delta failed'))
    store.assertNoBranchForkAtOrAfter = vi.fn()
    const result = classification()
    result.entryUpdates.newCharacters = [{ name: 'one' }]
    const run = store.applyClassificationResult(result, 'entry')
    const failed = expect(run).rejects.toThrow('delta failed')
    await vi.waitFor(() => expect(database.addCharacter).toHaveBeenCalledOnce())
    const rollback = store.deleteEntriesFromPosition(1)
    const refused = expect(rollback).rejects.toThrow('delta failed')
    pending.resolve()
    await failed
    await refused
    expect(rollbackService.rollbackFromPosition).not.toHaveBeenCalled()
  })

  it('never deletes B entries when A rollback or deletion completes after navigation', async () => {
    for (const _stage of ['rollback', 'delete', 'timestamp']) {
      const { store, database, switchStory } = fixture()
      const entriesA = [{ id: 'A-entry', storyId: 'A', branchId: 'a', position: 1 }]
      store.entries = entriesA
      const run = store.deleteEntriesFromPosition(1)
      switchStory()
      const entriesB = [{ id: 'B-entry', storyId: 'B', branchId: 'b', position: 1 }]
      store.entries = entriesB
      await expect(run).rejects.toThrow('Story write scope is no longer current')
      expect(store.entries).toBe(entriesB)
      expect(database.deleteEntriesWithDependents).not.toHaveBeenCalled()
      expect(database.updateStory).not.toHaveBeenCalled()
      expect(store.restoreSuggestedActionsAfterDelete).not.toHaveBeenCalled()
    }
  })

  it('never writes A backup time or reload data into B after a deferred stop restore', async () => {
    for (const stage of ['restore', 'checkpoints', 'reload', 'time', 'clearTime'] as const) {
      const { store, database, switchStory } = fixture()
      store.currentStory.currentBranchId = null
      store.entries = [{ id: 'A-entry', position: 1 }]
      store.checkpoints = [{ id: 'A-checkpoint', lastEntryId: 'A-entry' }]
      const pending = deferred<any>()
      const operation =
        database[
          {
            restore: 'restoreRetryBackup',
            checkpoints: 'deleteCheckpoints',
            reload: 'getStoryEntriesForBranch',
            time: 'saveTimeTracker',
            clearTime: 'clearTimeTracker',
          }[stage]!
        ]
      operation.mockReturnValue(pending.promise)
      const run = store.restoreFromRetryBackup({
        entries: [],
        characters: [],
        locations: [],
        items: [],
        storyBeats: [],
        timeTracker: stage === 'clearTime' ? null : { years: 0, days: 1, hours: 2, minutes: 3 },
        entryCountBeforeAction: 1,
      })
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
      expect(database.restoreRetryBackup).toHaveBeenCalledExactlyOnceWith(
        ['A-entry'],
        'A',
        null,
        [],
        [],
        [],
        [],
      )
      switchStory()
      const storyB = {
        ...store.currentStory,
        timeTracker: { years: 9, days: 8, hours: 7, minutes: 6 },
      }
      const entriesB = [{ id: 'B-entry', position: 1 }]
      store.currentStory = storyB
      store.entries = entriesB
      pending.resolve(stage === 'reload' ? [{ id: 'A-late-entry', position: 0 }] : undefined)
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(store.entries).toBe(entriesB)
      expect(store.currentStory).toBe(storyB)
      expect(store._isRetryInProgress).toBe(false)
      expect(database.saveTimeTracker.mock.calls.every(([id]: [string]) => id === 'A')).toBe(true)
      expect(database.clearTimeTracker.mock.calls.every(([id]: [string]) => id === 'A')).toBe(true)
      expect(database.updateStory).not.toHaveBeenCalled()
      if (stage !== 'time' && stage !== 'clearTime') {
        expect(database.saveTimeTracker).not.toHaveBeenCalled()
        expect(database.clearTimeTracker).not.toHaveBeenCalled()
      }
    }
  })

  it('does not refill entry metadata after timeEnd persistence loses its scope', async () => {
    const { store, database, switchStory } = fixture()
    store.entries = [{ id: 'entry', metadata: {} }]
    const pending = deferred<void>()
    database.updateStoryEntry.mockReturnValue(pending.promise)
    const run = store.updateEntryTimeEnd('entry')
    switchStory()
    store.entries = [{ id: 'entry', metadata: { other: true } }]
    pending.resolve()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.entries[0].metadata).toEqual({ other: true })
  })

  it('guards time progression refill and later delta writes', async () => {
    const { store, database, switchStory } = fixture()
    const pending = deferred<void>()
    database.saveTimeTracker.mockReturnValue(pending.promise)
    const result = classification()
    result.scene.timeProgression = 'minutes'
    const run = store.applyClassificationResult(result, 'entry')
    await vi.waitFor(() => expect(database.saveTimeTracker).toHaveBeenCalledOnce())
    switchStory()
    pending.resolve()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.currentStory.timeTracker).toBeUndefined()
    expect(database.updateStoryEntry).not.toHaveBeenCalled()
  })

  it('cancels a scene move between location writes without clearing sibling branches', async () => {
    const { store, database, switchStory } = fixture()
    store.currentStory.currentBranchId = null
    store.locations = [
      { id: 'old', name: 'old', current: true },
      { id: 'target', name: 'target', current: false },
    ]
    const pending = deferred<void>()
    database.updateLocation.mockReturnValue(pending.promise)
    const result = classification()
    result.scene.currentLocationName = 'target'
    const run = store.applyClassificationResult(result)
    await vi.waitFor(() =>
      expect(database.updateLocation).toHaveBeenCalledWith('old', { current: false }),
    )
    switchStory()
    pending.resolve()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(database.updateLocation).toHaveBeenCalledOnce()
    expect(database.setCurrentLocation).not.toHaveBeenCalled()
    expect(store.locations).toEqual([])
  })

  it('rejects a chapter number lookup for a stale captured branch', async () => {
    const { store } = fixture()
    store.chapters = [{ number: 99 }]
    await expect(
      store.getNextChapterNumber({ scope: { storyId: 'A', branchId: 'other' } }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await store.getNextChapterNumber({ scope: { storyId: 'A', branchId: 'a' } })).toBe(100)
  })

  it('records a delta for creative-writing stories with experimental tracking off', async () => {
    const { store, database } = fixture()
    await store.applyClassificationResult(classification(), 'entry')
    expect(database.updateStoryEntry).toHaveBeenCalledWith(
      'entry',
      expect.objectContaining({ worldStateDelta: expect.any(Object) }),
    )
  })

  it.each(['deleteEntry', 'deleteEntriesFromPosition'])(
    'creative-writing %s enters rollback',
    async (method) => {
      const { store, rollbackService } = fixture()
      store.entries = [{ id: 'entry', position: 1 }]
      store.assertEntryDeletable = () => store.entries[0]
      store.assertNoBranchForkAtOrAfter = vi.fn()
      store.assertNotBusy = vi.fn()
      await expect(store[method](method === 'deleteEntry' ? 'entry' : 1)).rejects.toThrow(
        '无法安全删除',
      )
      expect(rollbackService.rollbackFromPosition).not.toHaveBeenCalled()
    },
  )

  it('refuses a chapter for another branch and does not refill after a late save', async () => {
    const { store, database, switchStory } = fixture()
    await expect(store.addChapter({ storyId: 'A', branchId: 'wrong' })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(database.addChapter).not.toHaveBeenCalled()
    const pending = deferred<void>()
    database.addChapter.mockReturnValue(pending.promise)
    const run = store.addChapter({ storyId: 'A', branchId: 'a' })
    switchStory()
    pending.resolve()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.chapters).toEqual([])
  })
})

describe('appearance fact persistence semantics', () => {
  it.each(['creative-writing', 'adventure'])(
    'applies %s appearance rules through the actual store',
    async (mode) => {
      const { store, database } = fixture()
      store.currentStory.mode = mode
      store.currentStory.currentBranchId = null
      store.characters = [
        {
          id: 'lin',
          storyId: 'A',
          branchId: null,
          name: '林岚',
          traits: [],
          visualDescriptors: { hair: '银发', eyes: '金眸', clothing: '制服' },
        },
      ]
      const result = classification()
      result.entryUpdates.characterUpdates = [
        { name: '林岚', changes: { visualDescriptors: { clothing: '雨衣' } } },
      ]
      await store.applyClassificationResult(result)
      const expected =
        mode === 'creative-writing'
          ? { hair: '银发', eyes: '金眸', clothing: '雨衣' }
          : { clothing: '雨衣' }
      expect(store.characters[0].visualDescriptors).toEqual(expected)
      expect(database.updateCharacter).toHaveBeenCalledWith(
        'lin',
        expect.objectContaining({ visualDescriptors: expected }),
      )
      await store.applyClassificationResult(result)
      expect(store.characters[0].visualDescriptors).toEqual(expected)
    },
  )
  it('keeps inherited appearance in a branch copy and records the complete undo value', async () => {
    const { store, database, settings } = fixture()
    settings.experimentalFeatures.stateTracking = true
    const original = {
      id: 'lin',
      storyId: 'A',
      branchId: null,
      name: '林岚',
      traits: [],
      visualDescriptors: { hair: '银发', eyes: '金眸', clothing: '制服' },
    }
    store.characters = [original]
    store.entries = [
      {
        id: 'entry',
        storyId: 'A',
        branchId: 'a',
        position: 1,
        type: 'narration',
        content: '林岚换了雨衣。',
        metadata: {},
      },
    ]
    const result = classification()
    result.entryUpdates.characterUpdates = [
      { name: '林岚', changes: { visualDescriptors: { clothing: '雨衣' } } },
    ]
    await store.applyClassificationResult(result, 'entry')
    expect(original.visualDescriptors.clothing).toBe('制服')
    expect(store.characters[0].branchId).toBe('a')
    expect(store.characters[0].visualDescriptors).toEqual({
      hair: '银发',
      eyes: '金眸',
      clothing: '雨衣',
    })
    expect(database.addCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ visualDescriptors: original.visualDescriptors }),
    )
    const firstDelta = database.updateStoryEntry.mock.calls[0][1].worldStateDelta
    expect(firstDelta.createdEntities.characterIds).toContain(store.characters[0].id)
    result.entryUpdates.characterUpdates[0].changes.visualDescriptors = { clothing: '斗篷' }
    await store.applyClassificationResult(result, 'entry')
    const serialized = JSON.stringify(database.updateStoryEntry.mock.lastCall)
    expect(serialized).toContain('银发')
    expect(serialized).toContain('雨衣')
  })
})
