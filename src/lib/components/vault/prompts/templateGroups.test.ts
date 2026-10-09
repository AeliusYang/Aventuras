import { describe, expect, it } from 'vitest'
import { getTemplateGroups } from './templateGroups'

describe('template group filtering', () => {
  it('keeps the normal editor complete by default', () => {
    const ids = getTemplateGroups().flatMap((group) =>
      group.templates.map((template) => template.id),
    )

    expect(ids).toContain('adventure')
    expect(ids).toContain('novel-scene')
    expect(ids).toContain('image-prompt-analysis')
  })

  it('limits collaborative workspace navigation to canonical agents', () => {
    const allowed = [
      'collaborative-scene-director',
      'collaborative-long-planner',
      'collaborative-pattern-reviewer',
      'collaborative-chinese-writer',
      'collaborative-fact-extractor',
      'collaborative-plot-suggestions',
    ] as const
    const groups = getTemplateGroups(allowed)
    const ids = groups.flatMap((group) => group.templates.map((template) => template.id))

    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('中文写作')
    expect(ids).toEqual([...allowed])
    expect(ids).not.toContain('novel-scene')
    expect(ids).not.toContain('adventure')
  })

  it('does not leave empty groups for an incomplete allowlist', () => {
    const groups = getTemplateGroups(['collaborative-chinese-writer'])

    expect(groups).toEqual([
      expect.objectContaining({
        name: '中文写作',
        templates: [expect.objectContaining({ id: 'collaborative-chinese-writer' })],
      }),
    ])
  })
})
