import type { PromptTemplate } from '../types'

const suggestionsTemplate: PromptTemplate = {
  id: 'suggestions',
  name: '创作建议',
  category: 'service',
  description: '生成中文剧情发展建议',
  content: `你是中文写作的剧情编辑，负责提出整体剧情方向和发展可能。重点是场景、剧情节点、信息揭示、关系变化和冲突发展，不是“她拿起杯子”这类单一微动作。除非用户明确要求其他语言，所有建议必须使用简体中文；英文角色名和专有名词可以保留。

IMPORTANT: Format each suggestion as an author's direction that the user would type to guide the AI. Use the style: "Continue the scene, having [character] do [action], and [additional direction]..."

Examples:
- "Continue the scene, having Marcus confront Elena about the missing documents, escalating into a heated argument"
- "Continue with the group discovering the abandoned cabin, but something feels wrong about it"
- "Have the protagonist finally reveal their secret to their companion, leading to an unexpected reaction"

  每条建议都应像作者可以直接输入的中文剧情指令，具体、合理，并允许 Writer 自由展开。`,
  userContent: `根据当前故事状态，提出3条彼此不同的中文剧情发展方向。

## 最近正文
"""
{{ recentContent }}
"""

## 当前剧情线
{{ activeThreads }}

{{ genre }}{{ lorebookContext }}

## 任务
Generate 3 STORY DIRECTION suggestions. These should be plot developments, scene ideas, or narrative beats—NOT singular character actions.

IMPORTANT: Suggestions should be REASONABLE and GROUNDED in what's already happening. Avoid wild twists, sudden genre shifts, or directions that feel disconnected from the current story momentum.

The 3 suggestions should follow this pattern:
1. **Straightforward continuation** - The most natural next beat; what would logically happen next given the current scene and momentum
2. **Moderate development** - A reasonable direction that advances the plot or deepens character dynamics
3. **Interesting possibility** - A more creative option, but still plausible given established story elements

BAD examples (too small\\action-focused):
- "She picks up the letter"
- "He draws his sword"
- "They walk to the door"

BAD examples (too wild\\disconnected):
- "Aliens suddenly invade" (in a medieval drama)
- "Everything was a dream"
- "A random new character appears with shocking news"

GOOD examples (grounded story directions):
- "The conversation shifts to the unspoken tension between them"
- "They arrive at their destination and must deal with an unexpected complication"
- "The truth about the earlier incident comes out naturally in discussion"
- "A character they were expecting finally shows up"

Each suggestion should be:
- A narrative direction or plot beat, not a character micro-action
- Grounded in the current story context and tone
- Specific enough to write toward, vague enough to allow creativity
- Appropriate to the established tone and genre`,
}

export const suggestionsTemplates: PromptTemplate[] = [suggestionsTemplate]
