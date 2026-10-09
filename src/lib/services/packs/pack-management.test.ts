import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomVariable, PresetPack } from './types'
import { COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY } from './types'

const getPack = vi.fn()
const getAllPacks = vi.fn()
const duplicatePack = vi.fn()
const getPackVariables = vi.fn()
const getStoryCustomVariables = vi.fn()
const reassignStoriesPack = vi.fn()
const getSetting = vi.fn()
const setSetting = vi.fn()
const deleteSetting = vi.fn()

vi.mock('$lib/services/database', () => ({
  database: {
    getPack,
    getAllPacks,
    duplicatePack,
    getPackVariables,
    getStoryCustomVariables,
    reassignStoriesPack,
    getSetting,
    setSetting,
    deleteSetting,
  },
}))

const { packService, missingRequiredVariables } = await import('./pack-service')

const sourcePack: PresetPack = {
  id: 'source-pack',
  name: '原始 Pack',
  description: '说明',
  author: '作者',
  isDefault: false,
  createdAt: 1,
  updatedAt: 1,
}

function variable(overrides: Partial<CustomVariable> = {}): CustomVariable {
  return {
    id: 'var-1',
    packId: 'target-pack',
    variableName: 'tone',
    displayName: '文风',
    variableType: 'text',
    isRequired: true,
    sortOrder: 0,
    createdAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  getPack.mockReset()
  getAllPacks.mockReset().mockResolvedValue([])
  duplicatePack.mockReset()
  getPackVariables.mockReset()
  getStoryCustomVariables.mockReset()
  reassignStoriesPack.mockReset()
  getSetting.mockReset().mockResolvedValue(null)
  setSetting.mockReset().mockResolvedValue(undefined)
  deleteSetting.mockReset().mockResolvedValue(undefined)
  getPack.mockResolvedValue(sourcePack)
  duplicatePack.mockImplementation(async (_source: string, pack: PresetPack) => ({
    ...pack,
    createdAt: 2,
    updatedAt: 2,
  }))
  getPackVariables.mockResolvedValue([])
  getStoryCustomVariables.mockResolvedValue(null)
})

describe('Chinese card import default pack', () => {
  beforeEach(() => {
    vi.spyOn(packService, 'ensureCollaborativePack').mockResolvedValue({
      ...sourcePack,
      id: 'managed',
    })
  })

  it('marks the effective system default without creating or modifying packs', async () => {
    getAllPacks.mockResolvedValue([
      { ...sourcePack, id: 'managed', name: '中文写作', author: 'AIRP' },
    ])
    expect(await packService.getEffectiveCollaborativeImportDefaultPackId()).toBe('managed')
    expect(packService.ensureCollaborativePack).not.toHaveBeenCalled()
    expect(setSetting).not.toHaveBeenCalled()
    getSetting.mockResolvedValue('source-pack')
    expect(await packService.getEffectiveCollaborativeImportDefaultPackId()).toBe('source-pack')
    getSetting.mockResolvedValue('deleted')
    getPack.mockResolvedValue(null)
    expect(await packService.getEffectiveCollaborativeImportDefaultPackId()).toBe('managed')
  })

  it('stores a stable ID, surviving renamed pack metadata and a new reader', async () => {
    const preferences = new Map<string, string>()
    getSetting.mockImplementation(async (key) => preferences.get(key) ?? null)
    setSetting.mockImplementation(async (key, value) => {
      preferences.set(key, value)
    })
    await packService.setCollaborativeImportDefaultPackId('source-pack')
    getPack.mockResolvedValue({ ...sourcePack, name: '重命名后的包' })
    expect(await packService.resolveSetupPackId('creative-writing', true)).toBe('source-pack')
    expect(setSetting).toHaveBeenCalledWith(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY, 'source-pack')
  })

  it('limits the preference to Chinese card imports and preserves a valid restored choice', async () => {
    getSetting.mockResolvedValue('source-pack')
    expect(await packService.resolveSetupPackId('creative-writing', true)).toBe('source-pack')
    expect(await packService.resolveSetupPackId('creative-writing', false)).toBe('managed')
    expect(await packService.resolveSetupPackId('adventure', true)).toBe('default-pack')
    expect(await packService.resolveSetupPackId('adventure', false)).toBe('default-pack')
    expect(await packService.resolveSetupPackId('creative-writing', true, 'chosen')).toBe('chosen')
  })

  it('falls back for missing preference and deleted preference or restored packs', async () => {
    expect(await packService.resolveSetupPackId('creative-writing', true)).toBe('managed')
    getSetting.mockResolvedValue('deleted')
    getPack.mockImplementation(async (id) => (id === 'deleted' ? null : sourcePack))
    expect(await packService.resolveSetupPackId('creative-writing', true, 'deleted')).toBe(
      'managed',
    )
  })

  it('resets to system policy and rejects missing targets and failed writes', async () => {
    await packService.resetCollaborativeImportDefaultPack()
    expect(deleteSetting).toHaveBeenCalledWith(COLLABORATIVE_IMPORT_DEFAULT_PACK_KEY)
    getPack.mockResolvedValue(null)
    await expect(packService.setCollaborativeImportDefaultPackId('deleted')).rejects.toThrow(
      '已不存在',
    )
    expect(setSetting).not.toHaveBeenCalled()
    getPack.mockResolvedValue(sourcePack)
    setSetting.mockRejectedValue(new Error('磁盘故障'))
    await expect(packService.setCollaborativeImportDefaultPackId('source-pack')).rejects.toThrow(
      '磁盘故障',
    )
  })
})

describe('Prompt Pack management', () => {
  it('duplicates a Pack with a new id and source metadata by default', async () => {
    const result = await packService.duplicatePack('source-pack', '原始 Pack 副本')

    expect(result).toMatchObject({
      name: '原始 Pack 副本',
      description: sourcePack.description,
      author: sourcePack.author,
      isDefault: false,
    })
    expect(result.id).not.toBe(sourcePack.id)
    expect(duplicatePack).toHaveBeenCalledWith(
      sourcePack.id,
      expect.objectContaining({ name: '原始 Pack 副本', isDefault: false }),
    )
  })

  it('rejects an empty duplicate name before touching the database', async () => {
    await expect(packService.duplicatePack('source-pack', '   ')).rejects.toThrow(
      '提示词包名称不能为空',
    )
    expect(duplicatePack).not.toHaveBeenCalled()
  })

  it('treats a default as satisfying a required variable', () => {
    expect(missingRequiredVariables([variable({ defaultValue: '克制' })], null)).toEqual([])
    expect(missingRequiredVariables([variable()], {})).toHaveLength(1)
  })

  it('preflights all stories before one batch reassignment', async () => {
    const required = variable()
    getPackVariables.mockResolvedValue([required])
    getStoryCustomVariables.mockImplementation(async (storyId: string) =>
      storyId === 'story-ok' ? { tone: '克制' } : {},
    )

    await expect(
      packService.reassignStoriesPack(['story-ok', 'story-missing'], 'target-pack'),
    ).rejects.toThrow(/story-missing/)
    expect(reassignStoriesPack).not.toHaveBeenCalled()
  })

  it('passes the complete selection to the atomic database update when valid', async () => {
    getPackVariables.mockResolvedValue([variable()])
    getStoryCustomVariables.mockResolvedValue({ tone: '克制' })

    await packService.reassignStoriesPack(['story-1', 'story-1', 'story-2'], 'target-pack')

    expect(reassignStoriesPack).toHaveBeenCalledWith(
      ['story-1', 'story-1', 'story-2'],
      'target-pack',
    )
  })
})
