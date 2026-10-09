import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DatabaseService } from '$lib/services/database'
import { collaborativeSuffixCleanupStatements } from '$lib/services/collaborativeTransactions'
import { imageContentVersion } from './imageScope'

describe('image version persistence and reroll retention', () => {
  it('migrates existing images and round trips new revision metadata through the real database methods', async () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec(`CREATE TABLE embedded_images (
        id TEXT PRIMARY KEY, story_id TEXT, entry_id TEXT, source_text TEXT, prompt TEXT,
        style_id TEXT, model TEXT, image_data TEXT, width INTEGER, height INTEGER,
        status TEXT, error_message TEXT, created_at INTEGER);
        INSERT INTO embedded_images (id,story_id,entry_id) VALUES ('old','s','e');`)
      sqlite.exec(readFileSync('src-tauri/migrations/039_image_content_version.sql', 'utf8'))
      const database = new DatabaseService()
      ;(database as any).db = {
        execute: async (sql: string, params: any[]) => sqlite.prepare(sql).run(...params),
        select: async (sql: string, params: any[]) => sqlite.prepare(sql).all(...params),
      }
      const version = imageContentVersion({ content: '她把信锁进抽屉。' })
      await database.createEmbeddedImage({
        id: 'new',
        storyId: 's',
        entryId: 'e',
        contentVersion: version,
        sourceText: '信',
        prompt: 'letter',
        styleId: 'style',
        model: 'image',
        imageData: 'BASE64',
        status: 'complete',
      })
      const full = await database.getEmbeddedImage('new')
      const metadata = await database.getEmbeddedImageMetaForStory('s')
      expect(full?.contentVersion).toBe(version)
      expect(metadata.find((row) => row.id === 'new')).toMatchObject({ contentVersion: version })
      expect(metadata.find((row) => row.id === 'new')).not.toHaveProperty('imageData')
      expect((await database.getEmbeddedImage('old'))?.contentVersion).toBeUndefined()
      expect(await database.getEmbeddedImageSourceTextsForEntry('e', version, false)).toEqual([
        '信',
      ])
      expect(
        await database.getEmbeddedImageSourceTextsForEntry('e', 'another-version', false),
      ).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('keeps an entry and its pictures atomically while deleting its abandoned suffix', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE story_entries(id TEXT PRIMARY KEY,story_id TEXT,branch_id TEXT,position INTEGER);
        CREATE TABLE chapters(story_id TEXT,branch_id TEXT,start_entry_id TEXT,end_entry_id TEXT);
        CREATE TABLE checkpoints(story_id TEXT,last_entry_id TEXT);
        CREATE TABLE world_state_snapshots(story_id TEXT,branch_id TEXT,entry_position INTEGER);
        CREATE TABLE embedded_images(id TEXT,story_id TEXT,entry_id TEXT REFERENCES story_entries(id) ON DELETE CASCADE);
        INSERT INTO story_entries VALUES ('keep','s',NULL,1),('remove','s',NULL,2),('other','s','branch',2);
        INSERT INTO embedded_images VALUES ('i1','s','keep'),('i2','s','remove'),('i3','s','other');`)
      sqlite.exec('BEGIN')
      for (const statement of collaborativeSuffixCleanupStatements(
        { storyId: 's', branchId: null },
        1,
        'keep',
      ))
        sqlite.prepare(statement.sql).run(...(statement.params as any[]))
      sqlite.exec('COMMIT')
      expect(
        sqlite
          .prepare('SELECT id FROM embedded_images ORDER BY id')
          .all()
          .map((row) => row.id),
      ).toEqual(['i1', 'i3'])
      expect(
        sqlite
          .prepare('SELECT id FROM story_entries ORDER BY id')
          .all()
          .map((row) => row.id),
      ).toEqual(['keep', 'other'])
    } finally {
      sqlite.close()
    }
  })
})
