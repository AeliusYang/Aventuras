import type { CollaborativeAgentKey, CollaborativeRequestMode } from '$lib/types/collaborative'

const templateIds: Record<CollaborativeAgentKey, string> = {
  sceneDirector: 'collaborative-scene-director',
  narrativePlanner: 'collaborative-long-planner',
  patternReviewer: 'collaborative-pattern-reviewer',
  writer: 'collaborative-chinese-writer',
  factStateExtractor: 'collaborative-fact-extractor',
  plotSuggestions: 'collaborative-plot-suggestions',
}

export const collaborativeServiceIds = {
  sceneDirector: 'collaborativeSceneDirector',
  narrativePlanner: 'collaborativeNarrativePlanner',
  patternReviewer: 'collaborativePatternReviewer',
  writer: 'collaborativeWriter',
  factStateExtractor: 'collaborativeFactStateExtractor',
  plotSuggestions: 'collaborativePlotSuggestions',
} as const satisfies Record<CollaborativeAgentKey, string>

const structuredAgents = new Set<CollaborativeAgentKey>([
  'factStateExtractor',
  'plotSuggestions',
])

export function getCollaborativeAgentTemplateId(key: CollaborativeAgentKey): string {
  return templateIds[key]
}

export function getCollaborativeRequestMode(
  key: CollaborativeAgentKey,
): CollaborativeRequestMode {
  return structuredAgents.has(key) ? 'json-text' : 'stream-text'
}
