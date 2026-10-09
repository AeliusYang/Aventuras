import { describe, expect, it } from 'vitest'
import { templateEngine } from './engine'

describe('template context variable inspection', () => {
  it('does not report optional-agent loop locals as missing context inputs', () => {
    const template = `{% for section in optionalAgentSections %}{% case section.key %}{% when 'recent' %}正文{% endcase %}
{{ section.value }}{% unless forloop.last %}\n\n{% endunless %}{% endfor %}{{ planningInput }}`
    expect(templateEngine.extractVariableNames(template)).toEqual([
      'optionalAgentSections',
      'planningInput',
    ])
  })

  it('tracks external values and dotted paths without including assignments', () => {
    expect(
      templateEngine.extractVariableNames(
        '{% assign localTitle = title %}{{ localTitle }} {{ character.name | default: fallbackName }}',
      ),
    ).toEqual(['title', 'character.name', 'fallbackName'])
  })

  it('keeps incomplete editor templates inspectable with the existing fallback', () => {
    expect(templateEngine.extractVariableNames('{% if rawInput %}{{ rawInput }}')).toEqual([
      'rawInput',
    ])
  })
})
