import { clean, sanitize, inspectCardImport } from '../characterCardImport/aiService'
import { parseJson } from '../characterCardImport/parseJson'
import type { CardImportResult, SanitizedCharacter } from '../characterCardImport/types'
import type { CardImportDraft } from './draft'

export interface OrganizationCandidate {
  scenario?: CardImportResult
  character?: SanitizedCharacter
  warnings: string[]
}

export async function organizeCard(
  card: CardImportDraft,
  packId: string,
  variables: Record<string, string>,
  signal?: AbortSignal,
): Promise<OrganizationCandidate> {
  signal?.throwIfAborted()
  const candidate: OrganizationCandidate = { warnings: [] }
  const tasks: Promise<void>[] = []
  const options = { variables, signal }
  if (card.selections.scenario || card.selections.characters)
    tasks.push(
      clean(packId, card.rawJson, 'custom', options)
        .then((result) => {
          if (
            result.success &&
            (result.settingSeed.trim() || result.npcs.some((v) => v.description.trim()))
          )
            candidate.scenario = result
          else candidate.warnings.push('场景整理没有返回可用内容，保留原资料。')
        })
        .catch((error) => {
          candidate.warnings.push(`场景整理失败：${String(error)}`)
        }),
    )
  if (
    card.selections.characters &&
    card.characters.some((v) => v.key === 'card:primary' && v.selected)
  )
    tasks.push(
      sanitize(packId, card.rawJson, options)
        .then((result) => {
          if (result?.name.trim() && result.description.trim()) candidate.character = result
          else candidate.warnings.push('人物整理没有返回可用内容，保留原资料。')
        })
        .catch((error) => {
          candidate.warnings.push(`人物整理失败：${String(error)}`)
        }),
    )
  if (!tasks.length) throw new Error('请选择人物或场景作为整理目标；世界书按原资料导入。')
  await Promise.all(tasks)
  signal?.throwIfAborted()
  return candidate
}

export function applyOrganization(
  card: CardImportDraft,
  candidate: OrganizationCandidate,
): CardImportDraft {
  const next = structuredClone(card)
  if (next.selections.scenario && candidate.scenario?.settingSeed.trim())
    next.background = candidate.scenario.settingSeed
  if (next.selections.characters) {
    if (candidate.character && next.characters.some((v) => v.key === 'card:primary')) {
      const existing = next.characters.find((v) => v.key === 'card:primary')
      const value = { ...existing?.value, ...candidate.character }
      if (existing) existing.value = value
      else next.characters.push({ key: 'card:primary', origin: 'card', selected: true, value })
    }
    for (const npc of candidate.scenario?.npcs ?? []) {
      if (!npc.name.trim() || !npc.description.trim()) continue
      const existing = next.characters.find(
        (v) => v.value.name?.trim().toLowerCase() === npc.name.trim().toLowerCase(),
      )
      if (existing) continue
      next.characters.push({
        key: `npc:${npc.name.trim().toLowerCase()}`,
        origin: 'card',
        selected: true,
        value: npc,
      })
    }
  }
  return next
}

export async function inspectOrganization(
  card: CardImportDraft,
  packId: string,
  variables: Record<string, string>,
) {
  const parsed = parseJson(card.rawJson)
  if (!parsed) throw new Error('角色卡格式无效。')
  const templates = [
    ...(card.selections.scenario || card.selections.characters ? ['character-card-import'] : []),
    ...(card.selections.characters &&
    card.characters.some((v) => v.key === 'card:primary' && v.selected)
      ? ['vault-character-import']
      : []),
  ]
  return Promise.all(templates.map((id) => inspectCardImport(packId, parsed, id, { variables })))
}
