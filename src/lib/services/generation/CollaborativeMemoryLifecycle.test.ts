import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Chapter, StoryEntry } from '$lib/types'
import type { GenerationContext } from './types'

const runtime = vi.hoisted(() => ({
  structured: vi.fn(),
  plain: vi.fn(),
  director: vi.fn(),
  open: null as null | (() => unknown),
  loads: 0,
}))

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async (url: string) => {
      if (url !== 'sqlite:aventura.db' || !runtime.open) throw new Error('Unexpected test database')
      runtime.loads++
      return runtime.open()
    },
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => {
    throw new Error('Native IPC is not part of this backend test')
  }),
}))
vi.mock('$lib/log', () => ({ createLogger: () => () => undefined }))
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    apiSettings: { profiles: [] },
    getServicePresetId: () => 'offline-fixture',
    getPresetConfig: () => ({
      id: 'offline-fixture',
      profileId: 'offline',
      model: 'glm-5.3',
      reasoningEffort: 'low',
      timeoutMs: 120000,
    }),
    getProfile: () => ({
      id: 'offline',
      name: 'offline',
      providerType: 'openai-compatible',
      apiKey: 'not-a-key',
    }),
  },
}))
vi.mock('$lib/services/ai/sdk/generate', () => ({
  generateStructured: (...args: unknown[]) => runtime.structured(...args),
  generatePlainText: (...args: unknown[]) => runtime.plain(...args),
  generateCollaborativeText: (...args: unknown[]) => runtime.director(...args),
}))

import { database } from '$lib/services/database'
import { MemoryService, DEFAULT_MEMORY_CONFIG } from '$lib/services/ai/generation/MemoryService'
import { TimelineFillService } from '$lib/services/ai/retrieval/TimelineFillService'
import { CollaborativeService } from '$lib/services/ai/generation/CollaborativeService'
import { ChapterService } from './ChapterService'
import { RetrievalPhase, type RetrievalDependencies } from './phases/RetrievalPhase'
import { prepareNovelTurn } from './prepareNovelTurn'

const persistentInput = '在我明确解除之前，不让其他人知道她打算辞职。'
const retrievedAnswer = `第1章用户原话：“${persistentInput}”此后没有解除；这是作者限制，不是角色已经知道的事。`
let directory: string

beforeEach(() => {
  vi.clearAllMocks()
  runtime.loads = 0
  directory = mkdtempSync(join(tmpdir(), 'airp-memory-lifecycle-'))
  const path = join(directory, 'test.db')
  const native = new DatabaseSync(path)
  const migrations = resolve('src-tauri/migrations')
  for (const name of readdirSync(migrations)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    native.exec(readFileSync(join(migrations, name), 'utf8'))
  }
  native.close()
  runtime.open = () => {
    const connection = new DatabaseSync(path)
    return {
      execute: async (sql: string, params: any[] = []) => {
        const result = connection.prepare(sql).run(...params)
        return {
          rowsAffected: Number(result.changes),
          lastInsertId: Number(result.lastInsertRowid),
        }
      },
      select: async (sql: string, params: any[] = []) => connection.prepare(sql).all(...params),
      close: async () => connection.close(),
    }
  }
  runtime.structured.mockImplementation(async (options, template) => {
    const common = { keywords: ['辞职'], characters: [], locations: [], plotThreads: [] }
    if (template === 'chapter-analysis') {
      return options.schema.parse({
        ...common,
        shouldCreateChapter: true,
        optimalEndIndex: 14,
        emotionalTone: '克制',
        significantEvents: [],
      })
    }
    if (template === 'chapter-summarization') {
      return options.schema.parse({
        ...common,
        title: '交接',
        summary: `两人继续完成交接。作者持续限制：${persistentInput}`,
        emotionalTone: '克制',
      })
    }
    if (template === 'timeline-fill') {
      return options.schema.parse({
        queries: [{ query: '尚未解除的作者限制是什么？', chapters: [1] }],
      })
    }
    throw new Error(`Unexpected offline model request: ${template}`)
  })
  runtime.plain.mockResolvedValue(retrievedAnswer)
  runtime.director.mockResolvedValue('【用户意图】原文交接。\n【场景安排】保留自主空间。')
})

afterEach(async () => {
  await database.close()
  runtime.open = null
  if (directory) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('airp-memory-lifecycle-')
    )
      throw new Error('Refusing cleanup outside the test directory')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('backend memory lifecycle with actual services and SQLite, replayed model responses', () => {
  it('summarizes real entry rows, reopens the database, retrieves archived text and hands it to the Director without widening windows', async () => {
    const story = await database.createStory({
      id: 'memory-test',
      title: '交接',
      description: '现实团队故事',
      genre: '现实',
      templateId: null,
      mode: 'creative-writing',
      settings: { collaborativeNovelWorkflow: {} },
      memoryConfig: DEFAULT_MEMORY_CONFIG,
      retryState: null,
      styleReviewState: null,
      timeTracker: null,
      currentBranchId: null,
      currentBgImage: null,
    })
    const entries: StoryEntry[] = []
    for (let turn = 1; turn <= 12; turn++) {
      for (const type of ['user_action', 'narration'] as const) {
        const content =
          type === 'user_action'
            ? turn === 1
              ? persistentInput
              : '继续。'
            : `第${turn}轮：两人继续完成交接，没有人说出她的打算。`
        entries.push(
          await database.addStoryEntry({
            id: `${type}-${turn}`,
            storyId: story.id,
            branchId: null,
            parentId: entries.at(-1)?.id ?? null,
            type,
            content,
            position: entries.length,
            metadata: { tokenCount: 100 },
          }),
        )
      }
    }
    const memory = new MemoryService('memory')
    const chapterService = new ChapterService({
      analyzeForChapter: (storyId, rows, lastIndex, _config, tokens, mode, pov, tense) =>
        memory.analyzeForChapter(storyId, rows, lastIndex, tokens, mode, pov, tense),
      summarizeChapter: memory.summarizeChapter.bind(memory),
      getNextChapterNumber: async () =>
        (await database.getChaptersForBranch(story.id, null)).length + 1,
      addChapter: database.addChapter.bind(database),
    })
    const created = await chapterService.checkAndCreateChapter({
      storyId: story.id,
      currentBranchId: null,
      entries,
      lastChapterEndIndex: 0,
      tokensOutsideBuffer: 1400,
      tokensSinceLastChapter: 2400,
      messagesSinceLastChapter: 24,
      memoryConfig: { ...DEFAULT_MEMORY_CONFIG, tokenThreshold: 1000 },
      currentBranchChapters: [],
      mode: 'creative-writing',
      pov: 'third',
      tense: 'past',
    })
    expect(created.created).toBe(true)
    expect(created.chapter!.entryCount).toBe(14)
    expect(created.chapter!.endEntryId).toBe('narration-7')
    expect(runtime.structured.mock.calls.map((call) => call[1])).toEqual([
      'chapter-analysis',
      'chapter-summarization',
    ])
    expect(runtime.structured.mock.calls[1][0].prompt).toContain(persistentInput)
    expect(runtime.structured.mock.calls[1][0].prompt).not.toContain('第8轮')

    await database.close()
    const chapters = await database.getChaptersForBranch(story.id, null)
    const reloaded = await database.getStoryEntriesForBranch(story.id, null)
    expect(runtime.loads).toBe(2)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].summary).toBe(created.chapter!.summary)
    expect(reloaded.map((entry) => entry.content)).toEqual(entries.map((entry) => entry.content))
    const visible = reloaded.slice(
      reloaded.findIndex((entry) => entry.id === chapters[0].endEntryId) + 1,
    )
    expect(visible).toHaveLength(DEFAULT_MEMORY_CONFIG.chapterBuffer)
    const chapterEntries = (chapter: Chapter) =>
      reloaded.slice(
        reloaded.findIndex((entry) => entry.id === chapter.startEntryId),
        reloaded.findIndex((entry) => entry.id === chapter.endEntryId) + 1,
      )
    const timeline = new TimelineFillService('timelineFill')
    const context = {
      story,
      allEntries: reloaded,
      visibleEntries: visible,
      userAction: { rawInput: '继续。', content: '继续。' },
      worldState: {
        chapters,
        storyBeats: [],
        lorebookEntries: [],
        memoryConfig: DEFAULT_MEMORY_CONFIG,
      },
    } as unknown as GenerationContext
    const dependencies: RetrievalDependencies = {
      shouldUseAgenticRetrieval: () => false,
      runAgenticRetrieval: vi.fn(async () => {
        throw new Error('Unexpected agentic retrieval')
      }),
      answerChapterQuestion: vi.fn(async () => {
        throw new Error('Unexpected separate chapter question')
      }),
      getRelevantLorebookEntries: vi.fn(async () => {
        throw new Error('This fixture has no lorebook')
      }),
      runTimelineFill: (recent, archive, known) =>
        timeline.runTimelineFill(story.id, recent, archive, chapterEntries, known),
      buildWorldStateContext: async () => ({
        tier1: [],
        tier2: [],
        tier3: [],
        all: [],
        contextBlock: '当前现场：交接继续。',
      }),
    }
    const generator = new RetrievalPhase().execute({
      context,
      dependencies,
      memoryRetrievalEnabled: true,
    })
    let next = await generator.next()
    while (!next.done) next = await generator.next()
    expect(next.value.timelineFillResult!.responses[0].answer).toBe(retrievedAnswer)
    expect(runtime.plain).toHaveBeenCalledOnce()
    expect(runtime.plain.mock.calls[0][0].prompt).toContain(`[ACTION]: ${persistentInput}`)
    expect(runtime.plain.mock.calls[0][0].prompt).not.toContain('第8轮')
    const director = new CollaborativeService('collaborativeSceneDirector')
    const scene = vi.fn((input: unknown) =>
      director.run(story.id, 'collaborative-scene-director', input),
    )
    const prepared = await prepareNovelTurn({ context, retrieval: next.value }, { scene })
    expect(prepared.directorDiagnostics?.directorFallback).toBe(false)
    const fields = scene.mock.calls[0][0] as any
    expect(fields.recentUserInputs).toHaveLength(8)
    expect(fields.recent).toHaveLength(8)
    expect(JSON.stringify(fields.recentUserInputs)).not.toContain(persistentInput)
    expect(fields.retrievedMemory).toContain(retrievedAnswer)
    const request = runtime.director.mock.calls[0][0]
    expect(request.prompt.split(retrievedAnswer)).toHaveLength(2)
    expect(request.serviceId).toBe('collaborative:sceneDirector')
    expect(request).not.toHaveProperty('schema')
    expect(runtime.structured.mock.calls.map((call) => call[1])).toEqual([
      'chapter-analysis',
      'chapter-summarization',
      'timeline-fill',
    ])
  })
})
