import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { loreInsertStatements } from './loreRows'
import {
  createSetupDraft,
  createCardDraft,
  setupPayload,
  replaceUser,
  replaceLoreUser,
} from './draft'
import { convertToEntries } from '../lorebookImportExport/import/convert'

const bridge = vi.hoisted(() => ({ db: null as any, failAt: -1, commits: 0 }))
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      execute: async (sql: string, values: unknown[] = []) => {
        const result = bridge.db.prepare(sql).run(...values)
        return { rowsAffected: Number(result.changes) }
      },
      select: async (sql: string, values: unknown[] = []) => bridge.db.prepare(sql).all(...values),
    }),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, { statements }: any) => {
    if (command !== 'db_transaction') throw new Error(command)
    bridge.db.exec('BEGIN')
    try {
      const rows = statements.map((s: any, index: number) => {
        if (index === bridge.failAt) throw new Error('injected write failure')
        return Number(bridge.db.prepare(s.sql).run(...s.params).changes)
      })
      bridge.db.exec('COMMIT')
      bridge.commits++
      return rows
    } catch (error) {
      bridge.db.exec('ROLLBACK')
      throw error
    }
  },
}))
import { DatabaseService } from '../database'
import { COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY } from '../packs/types'
import { NarrativePhase } from '../generation/phases/NarrativePhase'
import { resolveCollaborativeLength } from '../generation/collaborative'
import * as collaborative from '../generation/collaborative'

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: { getServicePresetId: () => 'writer', getPresetConfig: () => ({ timeoutMs: 360000 }) },
}))

function creator(database: DatabaseService) {
  const source = readFileSync('src/lib/stores/story.svelte.ts', 'utf8')
  const ast = ts.createSourceFile('story.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(
    (n) => ts.isClassDeclaration(n) && n.name?.text === 'StoryStore',
  ) as ts.ClassDeclaration
  const methods = cls.members.filter((n) =>
    ['createStoryFromWizard', 'applyImportOrganization'].includes(n.name?.getText(ast) ?? ''),
  )
  const code = ts.transpileModule(
    `return class Store { ${methods.map((m) => m.getText(ast)).join('\n')} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText
  const ui = { setPendingCreativeInput: vi.fn(), requestCreativeInputFocus: vi.fn() }
  const eventBus = { emit: vi.fn() }
  const Store = new Function(
    'database',
    'packService',
    'DEFAULT_MEMORY_CONFIG',
    'createDefaultCollaborativeWorkflow',
    'countTokens',
    'ui',
    'eventBus',
    'aiService',
    'log',
    'LorebookImportExport',
    'replaceUser',
    'replaceLoreUser',
    'settings',
    code,
  )(
    database,
    { ensureCollaborativePack: async () => ({ id: 'default-pack' }) },
    {},
    () => ({}),
    () => 1,
    ui,
    eventBus,
    {},
    () => {},
    { convertToEntries },
    replaceUser,
    replaceLoreUser,
    { experimentalFeatures: { lightweightBranches: true } },
  )
  const store = new Store()
  store.allStories = []
  store.currentStory = null
  store.characters = []
  store.lorebookEntries = []
  store.assertNotBusy = () => {
    if (store.busy) throw new Error('busy')
  }
  store.invalidateRetrievalCache = vi.fn()
  store.captureWriteScope = ({ scope }: any) => {
    const check = () => {
      if (
        store.currentStory?.id !== scope.storyId ||
        (store.currentStory?.currentBranchId ?? null) !== scope.branchId
      )
        throw new Error('stale scope')
    }
    check()
    return { ...scope, check }
  }
  return { store, ui, eventBus }
}
beforeEach(() => {
  bridge.db = new DatabaseSync(':memory:')
  bridge.failAt = -1
  bridge.commits = 0
  for (const name of readdirSync('src-tauri/migrations')
    .filter((n) => /^\d.*\.sql$/.test(n))
    .sort())
    bridge.db.exec(readFileSync(`src-tauri/migrations/${name}`, 'utf8'))
  bridge.db.exec('PRAGMA foreign_keys = ON')
})
afterEach(() => bridge.db.close())

describe('setup real SQLite persistence', () => {
  it.each(['dynamic', 'short', 'medium', 'long', 'metrics-error'] as const)(
    'persists exact streamed prose and diagnostics for %s',
    async (mode) => {
      const database = new DatabaseService()
      const { store } = creator(database)
      const draft = createSetupDraft('creative-writing')
      draft.packId = 'default-pack'
      const created = await store.createStoryFromWizard(setupPayload(draft))
      const turn = {
        version: 2 as const,
        historyKey: 'h',
        rawInput: '继续',
        sceneDirectorOutput: '按现场继续',
        requestedLength: resolveCollaborativeLength(
          '继续',
          undefined,
          mode === 'metrics-error' ? 'dynamic' : mode,
        ),
        confirmedPlan: null,
        confirmedPatternGuidance: null,
      }
      const prose = '她没有接那封信。\n\n走廊里传来了脚步声。'
      const spy =
        mode === 'metrics-error'
          ? vi.spyOn(collaborative, 'recordNovelOutput').mockImplementation(() => {
              throw new Error('统计故障')
            })
          : null
      try {
        const phase = new NarrativePhase({
          streamNarrative: async function* () {
            yield { content: prose.slice(0, 8), done: false }
            yield { content: prose.slice(8), done: true, finishReason: 'stop' }
          },
        })
        let streamed = ''
        let savedId: string | undefined
        for await (const event of phase.execute({
          novelTurn: turn,
          visibleEntries: [],
          worldState: {} as any,
          story: created,
          retrievalResult: {} as any,
          styleReview: null,
        })) {
          if (event.type === 'narrative_chunk') streamed += event.content
          if (event.type === 'phase_complete' && event.phase === 'narrative') {
            const result = event.result as { content: string }
            const saved = await database.addStoryEntry({
              id: crypto.randomUUID(),
              storyId: created.id,
              type: 'narration',
              content: result.content,
              position: 1,
              parentId: null,
              branchId: null,
              metadata: { novelTurn: turn },
            })
            savedId = saved.id
          }
        }
        expect(streamed).toBe(prose)
        const row = bridge.db
          .prepare('SELECT content,metadata FROM story_entries WHERE id=?')
          .get(savedId)
        expect(row.content).toBe(streamed)
        const stored = JSON.parse(row.metadata).novelTurn
        expect(stored.requestedLength).toBe(turn.requestedLength)
        expect(stored.outputTruncated).toBe(false)
        if (mode === 'metrics-error') expect(stored.outputMetricsWarning).toContain('统计故障')
        else expect(stored.outputMetricsWarning).toBeUndefined()
      } finally {
        spy?.mockRestore()
      }
    },
  )

  it('deletes an import-default pack and clears its preference atomically', async () => {
    const database = new DatabaseService()
    await database.createPack({
      id: 'removable',
      name: '可删除',
      description: null,
      author: null,
      isDefault: false,
    })
    await database.setSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY, 'removable')
    bridge.failAt = 1
    await expect(database.deletePack('removable')).rejects.toThrow('injected write failure')
    expect(await database.getPack('removable')).not.toBeNull()
    expect(await database.getSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)).toBe('removable')
    bridge.failAt = -1
    await database.deletePack('removable')
    expect(await database.getPack('removable')).toBeNull()
    expect(await database.getSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)).toBeNull()
  })

  it('does not clear unrelated preferences or delete a built-in default pack', async () => {
    const database = new DatabaseService()
    await database.setSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY, 'default-pack')
    await database.deletePack('default-pack')
    expect(await database.getPack('default-pack')).not.toBeNull()
    expect(await database.getSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)).toBe('default-pack')
    await database.createPack({
      id: 'other',
      name: '其他',
      description: null,
      author: null,
      isDefault: false,
    })
    await database.deletePack('other')
    expect(await database.getSetting(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)).toBe('default-pack')
  })
  it('copies imported characters to a lightweight branch and preserves the parent', async () => {
    const database = new DatabaseService()
    const { store } = creator(database)
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'default-pack'
    draft.card = createCardDraft(
      {
        name: '沈宁',
        version: 'v1',
        description: '原人物资料',
        personality: '',
        scenario: '',
        firstMessage: '',
        alternateGreetings: [],
        exampleMessages: '',
      },
      '{}',
      'c.json',
    )
    const created = await store.createStoryFromWizard(setupPayload(draft))
    store.characters = await database.getCharacters(created.id)
    const original = store.characters[0]
    bridge.db
      .prepare(
        'INSERT INTO branches (id, story_id, name, fork_entry_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('fork', created.id, '分支', '', Date.now())
    store.currentStory.currentBranchId = 'fork'
    draft.card.characters[0].value.description = '分支整理资料'
    await store.applyImportOrganization(draft.card, {
      storyId: created.id,
      branchId: 'fork',
      rawJson: '{}',
    })
    expect(store.characters[0]).toMatchObject({
      branchId: 'fork',
      overridesId: original.id,
      description: '分支整理资料',
    })
    expect(
      bridge.db.prepare('SELECT description FROM characters WHERE id = ?').get(original.id)
        .description,
    ).toBe('原人物资料')
    await expect(
      store.applyImportOrganization(draft.card, {
        storyId: created.id,
        branchId: 'fork',
        rawJson: '{}',
        packId: 'different-pack',
        variables: {},
      }),
    ).rejects.toThrow('提示词包')
  })
  it('keeps an explicitly chosen custom pack and variables for first generation', async () => {
    const database = new DatabaseService()
    await database.createPack({
      id: 'custom-pack',
      name: '自定义',
      description: null,
      author: null,
      isDefault: false,
    })
    const { store } = creator(database)
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'custom-pack'
    draft.variables = { custom: '值', optional: '' }
    const created = await store.createStoryFromWizard(setupPayload(draft))
    expect(await database.getStoryPackId(created.id)).toBe('custom-pack')
    expect(await database.getStoryCustomVariables(created.id)).toEqual(draft.variables)
  })
  it('adopts repeated organization atomically without resurrecting exclusions or replacing manual characters', async () => {
    const database = new DatabaseService()
    const { store } = creator(database)
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'default-pack'
    draft.protagonist.name = '林舟'
    draft.card = createCardDraft(
      {
        name: '沈宁',
        version: 'v3',
        description: '修复师',
        personality: '',
        scenario: '',
        firstMessage: '',
        alternateGreetings: [],
        exampleMessages: '',
        characterBook: {
          entries: [
            { uid: 7, comment: '{{user}}的住所', key: ['{{user}}'], content: '旧城', order: 1 },
            { uid: 8, comment: '排除条目', key: [], content: '不能恢复', order: 2 },
          ],
        },
      },
      '{}',
      'c.json',
    )
    draft.card.lore[1].selected = false
    draft.characters.push({
      key: 'manual',
      origin: 'manual',
      selected: true,
      value: { name: '手写人物', description: '不能覆盖' },
    })
    const created = await store.createStoryFromWizard(setupPayload(draft))
    store.characters = await database.getCharacters(created.id)
    store.lorebookEntries = await database.getEntries(created.id)
    const candidate = structuredClone(draft.card)
    candidate.characters[0].value.description = '新的中文人物资料'
    candidate.background = '第一次整理背景'
    candidate.characters.push({
      key: 'npc:manual',
      origin: 'card',
      selected: true,
      value: { name: '手写人物', description: '不应写入' },
    })
    candidate.lore[1].selected = true
    const scope = { storyId: created.id, branchId: null, rawJson: '{}' }
    const result = await store.applyImportOrganization(candidate, scope)
    expect(result).toEqual({ charactersAdded: 0, charactersUpdated: 1, loreEntriesAdded: 0 })
    expect(store.characters.find((c: any) => c.name === '手写人物').description).toBe('不能覆盖')
    expect(store.characters.find((c: any) => c.name === '沈宁').description).toBe(
      '新的中文人物资料',
    )
    candidate.background = '再次整理后的背景'
    await store.applyImportOrganization(candidate, scope)
    expect(store.currentStory.description).toBe('再次整理后的背景')
    expect(bridge.db.prepare('SELECT count(*) AS n FROM entries').get().n).toBe(1)
    expect(bridge.db.prepare('SELECT count(*) AS n FROM characters').get().n).toBe(3)
    const before = JSON.stringify(store.characters)
    bridge.failAt = 1
    candidate.characters[0].value.description = '事务失败不能覆盖'
    await expect(store.applyImportOrganization(candidate, scope)).rejects.toThrow('injected')
    expect(JSON.stringify(store.characters)).toBe(before)
    expect(
      (await database.getCharacters(created.id)).find((c) => c.name === '沈宁')?.description,
    ).toBe('新的中文人物资料')
    bridge.failAt = -1
    store.currentStory.settings.importSource.organizationEnabled = false
    await expect(store.applyImportOrganization(candidate, scope)).rejects.toThrow('关闭')
    store.currentStory.settings.importSource.organizationEnabled = true
    store.busy = true
    await expect(store.applyImportOrganization(candidate, scope)).rejects.toThrow('busy')
    store.busy = false
    store.currentStory.currentBranchId = 'changed'
    await expect(store.applyImportOrganization(candidate, scope)).rejects.toThrow('stale')
  })
  it('commits story, custom pack, chat and lore together and preserves order', async () => {
    const { store } = creator(new DatabaseService())
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'default-pack'
    draft.card = createCardDraft(
      {
        name: '卡',
        version: 'v3',
        description: '旅人',
        personality: '',
        scenario: '',
        firstMessage: '不得重复',
        alternateGreetings: [],
        exampleMessages: '',
        characterBook: {
          entries: [{ uid: 7, comment: '旧站', content: '背景', key: ['站'], order: 1 }],
        },
      },
      '{}',
      'c.json',
    )
    draft.chat = {
      filename: 'c.jsonl',
      messages: [
        { type: 'user_action', content: '最前动作' },
        { type: 'narration', content: '第一段正文' },
      ],
    }
    draft.openingSource = 'chat'
    const result = await store.createStoryFromWizard(setupPayload(draft))
    expect(bridge.commits).toBe(1)
    expect(bridge.db.prepare('SELECT content FROM story_entries ORDER BY position').all()).toEqual([
      { content: '最前动作' },
      { content: '第一段正文' },
    ])
    expect(bridge.db.prepare('SELECT count(*) AS n FROM entries').get().n).toBe(1)
    expect(result.settings.importSource.entryIdsBySourceKey['lore:7']).toBeTruthy()
    expect(bridge.db.prepare('SELECT pack_id FROM stories').get().pack_id).toBe('default-pack')
  })
  it('rolls back every row and UI side effect when a later write fails', async () => {
    const { store, ui, eventBus } = creator(new DatabaseService())
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'default-pack'
    draft.protagonist.name = '林舟'
    draft.opening = '开场'
    draft.initialInput = '继续'
    bridge.failAt = 2
    await expect(store.createStoryFromWizard(setupPayload(draft))).rejects.toThrow('injected')
    for (const table of ['stories', 'characters', 'story_entries'])
      expect(bridge.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0)
    expect(store.currentStory).toBeNull()
    expect(store.allStories).toEqual([])
    expect(ui.setPendingCreativeInput).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
  it('handles zero, one and multiple batches with the same real INSERT mapping', async () => {
    const database = new DatabaseService()
    await database.bulkInsertEntries([])
    expect(bridge.commits).toBe(0)
    const { store } = creator(database)
    const draft = createSetupDraft('creative-writing')
    draft.packId = 'default-pack'
    const story = await store.createStoryFromWizard(setupPayload(draft))
    const [base] = convertToEntries([
      {
        name: '站',
        type: 'location',
        description: '',
        aliases: [],
        keywords: [],
        injectionMode: 'keyword',
        priority: 1,
      },
    ])
    const entries = Array.from({ length: 103 }, (_, i) => ({
      ...base,
      id: `l${i}`,
      storyId: story.id,
    }))
    expect(loreInsertStatements(entries).length).toBe(3)
    await database.addEntry(entries[0])
    await database.bulkInsertEntries(entries.slice(1))
    expect(bridge.db.prepare('SELECT count(*) AS n FROM entries').get().n).toBe(103)
    bridge.failAt = 1
    await expect(
      database.bulkInsertEntries(entries.map((e) => ({ ...e, id: `fail-${e.id}` }))),
    ).rejects.toThrow('injected')
    expect(bridge.db.prepare('SELECT count(*) AS n FROM entries').get().n).toBe(103)
  })
})
