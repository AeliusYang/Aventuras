import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackTemplate, PresetPack } from './types'
import { hashContent } from './hash'
import { PROMPT_TEMPLATES } from '../prompts/templates'

const state = vi.hoisted(() => ({
  packs: new Map<string, PresetPack>(),
  rows: new Map<string, Map<string, PackTemplate>>(),
}))

vi.mock('$lib/services/database', () => ({
  database: {
    getAllPacks: async () => [...state.packs.values()],
    getPack: async (id: string) => state.packs.get(id) ?? null,
    getSetting: async () => null,
    createPack: async (pack: PresetPack) => {
      const result = { ...pack, createdAt: 0, updatedAt: 0 }
      state.packs.set(pack.id, result)
      return result
    },
    getPackTemplates: async (id: string) => [...(state.rows.get(id)?.values() ?? [])],
    setPackTemplateContent: async (packId: string, templateId: string, content: string) => {
      const contentHash = await hashContent(content)
      const rows = state.rows.get(packId) ?? new Map<string, PackTemplate>()
      rows.set(templateId, {
        id: templateId,
        packId,
        templateId,
        content,
        contentHash,
        baselineHash: contentHash,
        createdAt: 0,
        updatedAt: 0,
      })
      state.rows.set(packId, rows)
    },
  },
}))

const { packService } = await import('./pack-service')
beforeEach(() => {
  state.packs.clear()
  state.rows.clear()
})

describe('fresh collaborative default pack', () => {
  it.each([false, true])(
    'seeds built-in templates for creation/import=%s',
    async (isImport) => {
      const id = await packService.resolveSetupPackId('creative-writing', isImport)
      expect(state.packs.get(id)?.name).toBe('中文写作')
      const rows = state.rows.get(id)!
      for (const template of PROMPT_TEMPLATES) {
        expect(rows.get(template.id)?.content).toBe(template.content)
        if (template.userContent)
          expect(rows.get(`${template.id}-user`)?.content).toBe(template.userContent)
      }
      expect(await packService.getEffectiveCollaborativeImportDefaultPackId()).toBe(id)
    },
  )

  it('preserves user edits when resolving the managed pack again', async () => {
    const id = await packService.resolveSetupPackId('creative-writing', false)
    const row = state.rows.get(id)!.get('collaborative-chinese-writer')!
    row.content = '用户之后手工编辑的正文提示词'
    row.contentHash = await hashContent(row.content)
    expect(await packService.resolveSetupPackId('creative-writing', true)).toBe(id)
    expect(state.rows.get(id)!.get(row.templateId)?.content).toBe(row.content)
  })
})
