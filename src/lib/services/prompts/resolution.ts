/** Persisted pack IDs from before the collaborative workflow was named explicitly. */
export const COLLABORATIVE_TEMPLATE_ALIASES: Record<string, string> = {
  'collaborative-scene-director': 'novel-scene',
  'collaborative-long-planner': 'novel-plan',
  'collaborative-pattern-reviewer': 'novel-patterns',
  'collaborative-chinese-writer': 'collaborative-novel',
  'collaborative-fact-extractor': 'classifier',
}

export function legacyTemplateId(templateId: string): string | undefined {
  const user = templateId.endsWith('-user')
  const base = user ? templateId.slice(0, -5) : templateId
  const alias = COLLABORATIVE_TEMPLATE_ALIASES[base]
  return alias ? `${alias}${user ? '-user' : ''}` : undefined
}
