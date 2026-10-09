/** Prompt template category */
export type PromptCategory = 'story' | 'service' | 'wizard' | 'image-style'

/** Provenance is inspector data, never part of the rendered model prompt. */
export interface PromptSourceMetadata {
  ruleId: string
  source: string
  sourceEntry: string
  adaptation: 'verbatim' | 'variable-adapted' | 'conflict-resolved'
  reason: string
  excludedReason?: string
}

/** Prompt template definition with Liquid syntax content resolved at runtime via ContextBuilder. */
export interface PromptTemplate {
  id: string
  name: string
  category: PromptCategory
  description: string
  /** System prompt content with Liquid template syntax. */
  content: string
  /** Optional user message template with Liquid template syntax. */
  userContent?: string
  metadata?: {
    sources: PromptSourceMetadata[]
    canonicalId?: string
  }
}
