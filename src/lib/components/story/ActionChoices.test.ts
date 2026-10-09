import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import { ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { historyKey } from '$lib/services/generation/collaborative'
import type { ActionChoice } from '$lib/services/ai/sdk/schemas/actionchoices'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Like PipelineEventHandler.test.ts, execute AST-extracted component code in Node.
// Keep the actual state declaration, request/release functions, effect registration,
// and onDestroy registration together so they share the production closure. Only
// rune scheduling is replaced: flushEffects() explicitly simulates a Svelte effect
// flush after store changes. This is not a DOM or Svelte scheduler integration test.
const source = readFileSync('src/lib/components/story/ActionChoices.svelte', 'utf8')
const ast = parse(source, { modern: true })
const statements = ast.instance!.content.body.filter((node) => {
  if (node.type === 'VariableDeclaration')
    return node.declarations.some(
      (declaration) =>
        declaration.id.type === 'Identifier' && declaration.id.name === 'pendingRequest',
    )
  if (node.type === 'FunctionDeclaration')
    return node.id?.name === 'releaseRequest' || node.id?.name === 'requestChoices'
  return (
    node.type === 'ExpressionStatement' &&
    node.expression.type === 'CallExpression' &&
    node.expression.callee.type === 'Identifier' &&
    ['$effect', 'onDestroy'].includes(node.expression.callee.name)
  )
})
const code = transpileModule(
  statements
    .map((node) => {
      const { start, end } = node as typeof node & { start: number; end: number }
      return source.slice(start, end)
    })
    .join('\n'),
  { compilerOptions: { target: ScriptTarget.ESNext } },
).outputText

function fixture() {
  const choices: ActionChoice[] = [{ type: 'action', text: 'Open the door' }]
  const story = {
    currentStory: {
      id: 'story-a',
      currentBranchId: 'child' as string | null | undefined,
      mode: 'creative-writing',
    },
    entries: [
      {
        id: 'narration',
        type: 'narration',
        content: 'Original prose',
        branchId: 'child' as string | null | undefined,
      },
    ],
    characters: [{ name: 'Protagonist', relationship: 'self' }],
    locations: [],
    items: [],
    storyBeats: [],
    lorebookEntries: [],
    pov: 'second',
    tense: 'past',
  }
  const ui = {
    isGenerating: false,
    actionChoicesLoading: false,
    generationScope: { turnId: 'turn-a' } as { turnId: string } | null,
    setActionChoicesLoading: vi.fn((loading: boolean) => {
      ui.actionChoicesLoading = loading
    }),
    setActionChoices: vi.fn(),
    showToast: vi.fn(),
  }
  const aiService = { generateActionChoices: vi.fn<() => Promise<{ choices: ActionChoice[] }>>() }
  const database = { updateStoryEntry: vi.fn(async (_id: string, _update: object) => {}) }
  const effects: (() => void)[] = []
  const destroyCallbacks: (() => void)[] = []
  let nextRequestId = 0
  const requestChoices = new Function(
    'story',
    'ui',
    'aiService',
    'database',
    'historyKey',
    'crypto',
    '$state',
    '$effect',
    'onDestroy',
    `${code}\nreturn requestChoices;`,
  )(
    story,
    ui,
    aiService,
    database,
    historyKey,
    { randomUUID: () => `request-${++nextRequestId}` },
    (value: unknown) => value,
    (effect: () => void) => effects.push(effect),
    (callback: () => void) => destroyCallbacks.push(callback),
  ) as () => Promise<void>
  expect(effects).toHaveLength(1)
  expect(destroyCallbacks).toHaveLength(1)
  const flushEffects = () => effects.forEach((effect) => effect())
  flushEffects()
  const start = () => {
    const response = deferred<{ choices: ActionChoice[] }>()
    aiService.generateActionChoices.mockReturnValueOnce(response.promise)
    const finished = requestChoices()
    flushEffects()
    expect(ui.actionChoicesLoading).toBe(true)
    return { ...response, finished }
  }
  const expectNoResult = () => {
    expect(ui.setActionChoices).not.toHaveBeenCalled()
    expect(database.updateStoryEntry).not.toHaveBeenCalled()
    expect(ui.showToast).not.toHaveBeenCalled()
  }
  return {
    story,
    ui,
    aiService,
    database,
    choices,
    requestChoices,
    start,
    flushEffects,
    expectNoResult,
    destroy: () => destroyCallbacks.forEach((callback) => callback()),
  }
}

describe('ActionChoices request scope regressions (compiled component functions)', () => {
  it.each(['parent', null, undefined])(
    'does not update an inherited narration owned by %s',
    async (owner) => {
      const f = fixture()
      f.story.entries[0].branchId = owner
      const request = f.start()
      request.resolve({ choices: f.choices })
      await request.finished
      expect(f.ui.setActionChoices).toHaveBeenCalledExactlyOnceWith(f.choices, 'story-a')
      expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
      expect(f.ui.actionChoicesLoading).toBe(false)
    },
  )

  it.each(['child', null, undefined])(
    'persists an owned narration on branch %s',
    async (branch) => {
      const f = fixture()
      f.story.currentStory.currentBranchId = branch
      f.story.entries[0].branchId = branch
      const request = f.start()
      request.resolve({ choices: f.choices })
      await request.finished
      expect(f.ui.setActionChoices).toHaveBeenCalledExactlyOnceWith(f.choices, 'story-a')
      expect(f.database.updateStoryEntry).toHaveBeenCalledExactlyOnceWith('narration', {
        suggestedActions: JSON.stringify(f.choices),
      })
      expect(f.ui.setActionChoicesLoading.mock.calls).toEqual([[true], [false]])
    },
  )

  it('does not dispatch during generation or while a request is pending', async () => {
    const f = fixture()
    f.ui.isGenerating = true
    await f.requestChoices()
    expect(f.aiService.generateActionChoices).not.toHaveBeenCalled()
    expect(f.ui.actionChoicesLoading).toBe(false)
    f.ui.isGenerating = false
    const request = f.start()
    await f.requestChoices()
    expect(f.aiService.generateActionChoices).toHaveBeenCalledOnce()
    request.resolve({ choices: f.choices })
    await request.finished
  })

  it.each(['during-generation', 'after-generation', 'before-effect-flush'])(
    'rejects late results %s',
    async (timing) => {
      const f = fixture()
      const request = f.start()
      f.ui.isGenerating = true
      if (timing !== 'before-effect-flush') {
        f.flushEffects()
        expect(f.ui.actionChoicesLoading).toBe(false)
      }
      if (timing === 'after-generation') {
        // Even if no new narration was produced and the turn ID stayed unchanged,
        // observing generation start must permanently invalidate this request.
        f.ui.isGenerating = false
        f.flushEffects()
      }
      request.resolve({ choices: f.choices })
      await request.finished
      f.expectNoResult()
      expect(f.ui.actionChoicesLoading).toBe(false)
    },
  )

  it.each([null, { turnId: 'turn-a' }])(
    'rejects a late result after generation changed turn from %j',
    async (scope) => {
      const f = fixture()
      f.ui.generationScope = scope
      const request = f.start()
      // Simulate start and finish before the effect runs; the captured turn must
      // still block the result even though isGenerating is already false again.
      f.ui.generationScope = { turnId: 'turn-b' }
      request.resolve({ choices: f.choices })
      await request.finished
      f.expectNoResult()
      expect(f.ui.actionChoicesLoading).toBe(false)
    },
  )

  it.each(['story', 'branch', 'turn'] as const)(
    'releases loading immediately on %s switch and cannot revive after switching back',
    async (scope) => {
      const f = fixture()
      const request = f.start()
      const originalStory = { ...f.story.currentStory }
      if (scope === 'story') f.story.currentStory = { ...originalStory, id: 'story-b' }
      if (scope === 'branch') f.story.currentStory.currentBranchId = 'sibling'
      if (scope === 'turn') f.ui.generationScope = { turnId: 'turn-b' }
      f.flushEffects()
      expect(f.ui.actionChoicesLoading).toBe(false)
      f.expectNoResult()
      f.story.currentStory = originalStory
      f.ui.generationScope = { turnId: 'turn-a' }
      f.flushEffects()
      request.resolve({ choices: f.choices })
      await request.finished
      f.expectNoResult()
      expect(f.ui.setActionChoicesLoading.mock.calls).toEqual([[true], [false]])
    },
  )

  it.each(['edit-prose', 'append-action', 'replace-narration'])(
    'rejects changed history: %s',
    async (change) => {
      const f = fixture()
      const request = f.start()
      if (change === 'edit-prose') f.story.entries[0].content = 'Edited prose with the same ID'
      if (change === 'append-action')
        f.story.entries.push({
          id: 'action',
          type: 'user_action',
          content: 'Wait',
          branchId: 'child',
        })
      if (change === 'replace-narration')
        f.story.entries = [{ ...f.story.entries[0], id: 'replacement' }]
      f.flushEffects()
      request.resolve({ choices: f.choices })
      await request.finished
      f.expectNoResult()
      expect(f.ui.actionChoicesLoading).toBe(false)
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'an old request that will %s cannot clear a new request loading or publish a result',
    async (outcome) => {
      const f = fixture()
      const old = f.start()
      f.story.currentStory.currentBranchId = 'sibling'
      f.story.entries = [{ ...f.story.entries[0], id: 'sibling-narration', branchId: 'sibling' }]
      f.flushEffects()
      expect(f.ui.actionChoicesLoading).toBe(false)
      const current = f.start()
      f.ui.setActionChoicesLoading.mockClear()
      if (outcome === 'resolve') old.resolve({ choices: [{ type: 'move', text: 'Stale choice' }] })
      else old.reject(new Error('Old request failed'))
      await old.finished
      f.expectNoResult()
      expect(f.ui.actionChoicesLoading).toBe(true)
      expect(f.ui.setActionChoicesLoading).not.toHaveBeenCalled()
      current.resolve({ choices: f.choices })
      await current.finished
      expect(f.ui.setActionChoices).toHaveBeenCalledExactlyOnceWith(f.choices, 'story-a')
      expect(f.database.updateStoryEntry).toHaveBeenCalledExactlyOnceWith('sibling-narration', {
        suggestedActions: JSON.stringify(f.choices),
      })
      expect(f.ui.setActionChoicesLoading.mock.calls).toEqual([[false]])
    },
  )

  it('an old database completion cannot release a newer request loading', async () => {
    const f = fixture()
    const write = deferred<void>()
    f.database.updateStoryEntry.mockReturnValueOnce(write.promise)
    const old = f.start()
    old.resolve({ choices: f.choices })
    await Promise.resolve()
    expect(f.database.updateStoryEntry).toHaveBeenCalledOnce()
    expect(f.ui.actionChoicesLoading).toBe(true)
    f.ui.generationScope = { turnId: 'turn-b' }
    f.flushEffects()
    const current = f.start()
    f.ui.setActionChoicesLoading.mockClear()
    write.resolve()
    await old.finished
    expect(f.ui.actionChoicesLoading).toBe(true)
    expect(f.ui.setActionChoicesLoading).not.toHaveBeenCalled()
    current.resolve({ choices: f.choices })
    await current.finished
    expect(f.ui.actionChoicesLoading).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)(
    'releases on destroy and ignores a subsequent %s',
    async (outcome) => {
      const f = fixture()
      const request = f.start()
      f.destroy()
      expect(f.ui.actionChoicesLoading).toBe(false)
      f.ui.setActionChoicesLoading.mockClear()
      if (outcome === 'resolve') request.resolve({ choices: f.choices })
      else request.reject(new Error('Late error after unmount'))
      await request.finished
      f.expectNoResult()
      expect(f.ui.setActionChoicesLoading).not.toHaveBeenCalled()
    },
  )

  it('reports a current request failure and releases loading', async () => {
    const f = fixture()
    const request = f.start()
    request.reject(new Error('Provider unavailable'))
    await request.finished
    expect(f.ui.showToast).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'warning')
    expect(f.ui.setActionChoices).not.toHaveBeenCalled()
    expect(f.database.updateStoryEntry).not.toHaveBeenCalled()
    expect(f.ui.actionChoicesLoading).toBe(false)
  })
})
