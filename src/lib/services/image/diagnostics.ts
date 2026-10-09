import type { ImageEvidence } from './generationContext'

export interface ImagePromptDiagnostic {
  evidence: ImageEvidence
  packId?: string
  templateId: string
  resolvedTemplateId?: string
  templateSource?: string | null
  model: string
  profile: string
  system: string
  user: string
  inferredDetails: string[]
  finalPrompt?: string
  imageModel?: string
  imageProfile?: string
  generationTemplateId?: string
}
