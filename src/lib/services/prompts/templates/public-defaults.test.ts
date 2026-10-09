import { describe, expect, it } from 'vitest'
import { PROMPT_TEMPLATES } from './index'
import { collaborativeTemplates, canonicalCollaborativeTemplates } from './collaborative'
import { templateEngine } from '../../templates/engine'

describe('public prompt defaults', () => {
  it('renders every shipped system/user template without external files or custom variables', () => {
    const ids = PROMPT_TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of PROMPT_TEMPLATES) {
      for (const content of [template.content, template.userContent ?? '']) {
        expect(templateEngine.render(content, {}), template.id).not.toBeNull()
      }
    }
  })

  it('removes adult guidance from both canonical and legacy defaults', () => {
    for (const template of PROMPT_TEMPLATES) {
      expect(template.content).not.toMatch(/【色情场景|【亲密与情欲场景】|前戏|性场景|情欲套语/)
    }
    expect(collaborativeTemplates.some((template) => template.id === 'collaborative-novel')).toBe(
      true,
    )
  })

  it('renders the specified length and scene handoff while keeping public provenance inspectable', () => {
    const writer = PROMPT_TEMPLATES.find(
      (template) => template.id === 'collaborative-chinese-writer',
    )!
    const system = templateEngine.render(writer.content, {
      protagonistName: '测试主角',
      requestedLength: '600中文字',
      pov: '第一人称',
    })!
    const user = templateEngine.render(writer.userContent!, {
      novelAgentContext: '【用户意图】保持沉默\n【场景安排】核验记录',
    })!
    expect(system).toContain('600中文字')
    expect(system).not.toContain('1500–3000')
    expect(system).toContain('用户明确指定沉默时绝不能补对白')
    expect(system).toContain('stopBoundary')
    expect(user).toContain('保持沉默')
    for (const template of canonicalCollaborativeTemplates) {
      expect(template.metadata?.sources[0].source).toBe('中文写作（内置默认）')
      expect(template.metadata?.sources[0].sourceEntry).toBe(template.id)
    }
  })
})
