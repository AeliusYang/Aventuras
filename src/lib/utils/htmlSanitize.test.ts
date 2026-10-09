import { describe, expect, it } from 'vitest'
import { markDialogueText } from './htmlSanitize'

describe('markDialogueText', () => {
  it('marks Chinese dialogue and escapes raw text', () => {
    expect(markDialogueText('她说：“现在走。” <危险>')).toBe(
      '她说：<span class="dialogue-line">“现在走。”</span> &lt;危险&gt;',
    )
  })
})
