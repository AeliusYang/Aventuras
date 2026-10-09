import { publicTemplates } from './public-defaults'

const canonicalIds = new Set([
  'collaborative-scene-director',
  'collaborative-long-planner',
  'collaborative-pattern-reviewer',
  'collaborative-chinese-writer',
  'collaborative-fact-extractor',
  'collaborative-plot-suggestions',
])
const collaborativeIds = new Set([
  'collaborative-scene-director',
  'collaborative-long-planner',
  'collaborative-pattern-reviewer',
  'collaborative-chinese-writer',
  'collaborative-fact-extractor',
  'collaborative-plot-suggestions',
  'novel-plan',
  'novel-scene',
  'novel-patterns',
  'collaborative-novel',
])

export const canonicalCollaborativeTemplates = publicTemplates.filter((template) =>
  canonicalIds.has(template.id),
)
export const collaborativeTemplates = publicTemplates.filter((template) =>
  collaborativeIds.has(template.id),
)
export const novelOpeningRules = publicTemplates.find(
  (template) => template.id === 'opening-generation-creative',
)!.content
