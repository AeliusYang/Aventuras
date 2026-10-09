import { describe, expect, it } from 'vitest'
import { recoveryFingerprint, recoveryScopeMatches, recoveryWasSaved } from './writerRecovery'
import type { GenerationContext } from './types'
import type { CollaborativeWriterRecovery } from '$lib/types/collaborative'

const context = () =>
  ({
    story: {
      id: 's',
      mode: 'creative-writing',
      currentBranchId: null,
      description: '旧车站',
      genre: '悬疑',
      settings: {
        tone: '克制',
        themes: ['信任'],
        collaborativeNovelPlan: { confirmed: '保持疑虑' },
      },
    },
    userAction: { entryId: 'a', content: '我没有回答她。', rawInput: '我没有回答她。' },
    allEntries: [{ id: 'a', type: 'user_action', content: '我没有回答她。', branchId: null }],
    visibleEntries: [],
    worldState: {
      characters: [{ name: '她', metadata: { runtimeVars: { suspicion: 2 } }, updatedAt: 1 }],
      chapters: [],
      lorebookEntries: [],
    },
  }) as unknown as GenerationContext
const binding = { packId: 'p', variables: { weather: '雨' } }
const record = (ctx: GenerationContext) =>
  ({
    version: 1,
    id: 'r',
    storyId: 's',
    branchId: null,
    userActionEntryId: 'a',
    narrationEntryId: 'n',
    novelTurn: {
      version: 2,
      rawInput: ctx.userAction.rawInput,
      sceneDirectorOutput: '【用户意图】保持沉默。\n【场景安排】她收起车票。',
    },
  }) as CollaborativeWriterRecovery

describe('Writer recovery identity and freshness', () => {
  it('ignores timestamps, error messages and UI-only metadata', async () => {
    const before = context(),
      after = context()
    after.story.updatedAt = 500
    ;(after.worldState.characters[0] as any).updatedAt = 500
    after.allEntries.push({ type: 'system', content: '网络错误' } as any)
    after.allEntries[0].metadata = { tokenCount: 999 }
    expect(await recoveryFingerprint(after, binding)).toBe(
      await recoveryFingerprint(before, binding),
    )
  })
  it.each([
    'description',
    'tone',
    'plan',
    'history',
    'world',
    'lore',
    'pack',
    'variables',
    'branch',
  ])('invalidates changed %s', async (field) => {
    const before = context(),
      after = context(),
      nextBinding = structuredClone(binding)
    if (field === 'description') after.story.description = '城堡'
    if (field === 'tone') after.story.settings!.tone = '轻松'
    if (field === 'plan') after.story.settings!.collaborativeNovelPlan!.confirmed = '新计划'
    if (field === 'history') after.allEntries[0].content = '我答应了。'
    if (field === 'world') after.worldState.characters[0].name = '另一个人'
    if (field === 'lore') after.worldState.lorebookEntries.push({ name: '世界规则' } as any)
    if (field === 'pack') nextBinding.packId = 'other'
    if (field === 'variables') nextBinding.variables.weather = '晴'
    if (field === 'branch') after.story.currentBranchId = 'child'
    expect(await recoveryFingerprint(after, nextBinding)).not.toBe(
      await recoveryFingerprint(before, binding),
    )
  })
  it('refuses wrong scope, edited input, failed or incomplete Director', () => {
    const ctx = context(),
      recovery = record(ctx)
    expect(recoveryScopeMatches(recovery, ctx)).toBe(true)
    expect(recoveryScopeMatches({ ...recovery, branchId: 'child' }, ctx)).toBe(false)
    expect(
      recoveryScopeMatches(
        { ...recovery, novelTurn: { ...recovery.novelTurn, sceneDirectorOutput: null } },
        ctx,
      ),
    ).toBe(false)
    expect(
      recoveryScopeMatches(
        {
          ...recovery,
          novelTurn: { ...recovery.novelTurn, directorDiagnostics: { directorFallback: true } },
        },
        ctx,
      ),
    ).toBe(false)
    ctx.userAction.rawInput = '我答应了。'
    expect(recoveryScopeMatches(recovery, ctx)).toBe(false)
  })
  it('recognizes saved prose and inactive saved variants after interrupted cleanup', () => {
    const recovery = record(context())
    expect(recoveryWasSaved(recovery, null)).toBe(false)
    expect(
      recoveryWasSaved(recovery, { type: 'narration', metadata: { writerRecoveryId: 'r' } } as any),
    ).toBe(true)
    expect(
      recoveryWasSaved(recovery, {
        type: 'narration',
        metadata: { variantSet: { variants: [{ metadata: { writerRecoveryId: 'r' } }] } },
      } as any),
    ).toBe(true)
  })
})
