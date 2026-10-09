import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { storyBasicsUpdate } from '../storyBasics'

// Exercise the real database methods against disk SQLite, without loading a personal Tauri DB.
const source = readFileSync('src/lib/services/database.ts', 'utf8')
const ast = ts.createSourceFile('database.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'DatabaseService',
)!
const names = new Set([
  'saveWriterRecovery',
  'getWriterRecovery',
  'clearWriterRecovery',
  'getStoryEntry',
  'getStoryEntries',
  'getStoryEntriesForBranch',
  'getRecentStoryEntries',
  'getStoryEntryCount',
  'mapStoryEntry',
  'updateStory',
])
const methods = declaration.members.filter((n) => n.name && names.has(n.name.getText(ast)))
const code = ts.transpileModule(
  `return class TestDatabase { ${methods.map((n) => n.getText(ast)).join('\n')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText
const DB = new Function(code)()
const connect = (sqlite: DatabaseSync) =>
  Object.assign(new DB(), {
    getDb: async () => ({
      execute: async (sql: string, args: any[]) => sqlite.prepare(sql).run(...args),
      select: async (sql: string, args: any[]) => sqlite.prepare(sql).all(...args),
    }),
  })

describe('local recovery storage', () => {
  it('survives reopening, stays out of history and isolates branches and conditional cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'airp-writer-recovery-'))
    const path = join(directory, 'test.sqlite')
    let sqlite = new DatabaseSync(path)
    try {
      sqlite.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'))
      sqlite.exec(
        "ALTER TABLE story_entries ADD COLUMN branch_id TEXT; INSERT INTO stories (id,title,created_at,updated_at) VALUES ('s','test',0,0);",
      )
      sqlite.exec(
        "INSERT INTO story_entries(id,story_id,type,content,position,created_at) VALUES ('a','s','user_action','继续',0,0)",
      )
      let db = connect(sqlite)
      const record = {
        version: 1,
        id: 'r',
        storyId: 's',
        branchId: null,
        createdAt: 1,
        userActionEntryId: 'a',
        narrationEntryId: 'n',
        contextFingerprint: 'hash',
        novelTurn: { sceneDirectorOutput: '原样导演输出' },
        retrieval: { combinedContext: '检索上下文' },
      }
      await db.saveWriterRecovery(record)
      await db.saveWriterRecovery({ ...record, id: 'child-record', branchId: 'child' })
      sqlite.close()
      sqlite = new DatabaseSync(path)
      db = connect(sqlite)
      expect(await db.getWriterRecovery('s', null)).toEqual(record)
      expect((await db.getWriterRecovery('s', 'child')).id).toBe('child-record')
      expect((await db.getStoryEntries('s')).map((e: any) => e.id)).toEqual(['a'])
      expect((await db.getStoryEntriesForBranch('s', null)).map((e: any) => e.id)).toEqual(['a'])
      expect((await db.getRecentStoryEntries('s', 10)).map((e: any) => e.id)).toEqual(['a'])
      expect(await db.getStoryEntryCount('s')).toBe(1)
      await db.saveWriterRecovery({ ...record, id: 'new-attempt' })
      await db.clearWriterRecovery('s', null, 'r')
      expect((await db.getWriterRecovery('s', null)).id).toBe('new-attempt')
      await db.clearWriterRecovery('s', null, 'new-attempt')
      expect(await db.getWriterRecovery('s', null)).toBeNull()
      expect(await db.getWriterRecovery('s', 'child')).not.toBeNull()
      const updates = storyBasicsUpdate(
        { settings: { collaborativeNovelPlan: { confirmed: '保留计划', draft: null } } } as any,
        { description: '新世界', genre: '悬疑', tone: '克制', themes: '信任\n信任\n秘密' },
      )
      await db.updateStory('s', updates)
      sqlite.close()
      sqlite = new DatabaseSync(path)
      const saved = sqlite.prepare('SELECT * FROM stories WHERE id = ?').get('s') as any
      expect(saved.description).toBe('新世界')
      expect(saved.genre).toBe('悬疑')
      expect(JSON.parse(saved.settings)).toEqual({
        tone: '克制',
        themes: ['信任', '秘密'],
        collaborativeNovelPlan: { confirmed: '保留计划', draft: null },
      })
    } finally {
      sqlite.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
