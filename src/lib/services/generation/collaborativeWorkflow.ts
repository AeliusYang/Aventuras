import type { Story, StoryMode, StorySettings } from '$lib/types'
import type {
  CollaborativeAgentBinding,
  CollaborativeNovelWorkflow,
} from '$lib/types/collaborative'

type LegacyStorySettings = StorySettings & { collaborativeNovel?: boolean }
type LegacyCollaborativeAgentBinding = CollaborativeAgentBinding & {
  profileId?: string
  model?: string
  maxTokens?: number
}
type LegacyCollaborativeNovelWorkflow = Omit<
  CollaborativeNovelWorkflow,
  | 'sceneDirector'
  | 'narrativePlanner'
  | 'patternReviewer'
  | 'writer'
  | 'factStateExtractor'
  | 'plotSuggestions'
> & {
  sceneDirector?: LegacyCollaborativeAgentBinding
  narrativePlanner?: LegacyCollaborativeAgentBinding
  patternReviewer?: LegacyCollaborativeAgentBinding
  writer?: LegacyCollaborativeAgentBinding
  factStateExtractor?: LegacyCollaborativeAgentBinding
  plotSuggestions?: LegacyCollaborativeAgentBinding
}

export const DEFAULT_COLLABORATIVE_WORKFLOW: Readonly<CollaborativeNovelWorkflow> = {
  sceneDirector: { enabled: true },
  narrativePlanner: { enabled: true },
  patternReviewer: { enabled: true },
  writer: { enabled: true },
  factStateExtractor: { enabled: true },
  plotSuggestions: { enabled: true },
  language: 'zh-CN',
  translationsEnabled: false,
}

function behaviorOnly(
  binding: LegacyCollaborativeAgentBinding | undefined,
): CollaborativeAgentBinding | undefined {
  if (!binding || binding.enabled === undefined) return undefined
  return { enabled: binding.enabled }
}

/** Remove legacy per-story connection/model fields while preserving story-owned behavior. */
export function cleanCollaborativeWorkflow(
  workflow: CollaborativeNovelWorkflow | LegacyCollaborativeNovelWorkflow | undefined,
): CollaborativeNovelWorkflow | undefined {
  if (!workflow) return undefined
  return {
    sceneDirector: { enabled: true },
    narrativePlanner: behaviorOnly(workflow.narrativePlanner),
    patternReviewer: behaviorOnly(workflow.patternReviewer),
    writer: { enabled: true },
    factStateExtractor: behaviorOnly(workflow.factStateExtractor),
    plotSuggestions: behaviorOnly(workflow.plotSuggestions),
    planEvery: workflow.planEvery,
    reviewEvery: workflow.reviewEvery,
    language: workflow.language,
    targetLength: workflow.targetLength,
    translationsEnabled: workflow.translationsEnabled,
  }
}

export function createDefaultCollaborativeWorkflow(
  workflow?: CollaborativeNovelWorkflow | LegacyCollaborativeNovelWorkflow,
): CollaborativeNovelWorkflow {
  const cleaned = cleanCollaborativeWorkflow(workflow)
  return {
    ...DEFAULT_COLLABORATIVE_WORKFLOW,
    ...cleaned,
    sceneDirector: { enabled: true },
    writer: { enabled: true },
    narrativePlanner: cleaned?.narrativePlanner ?? { enabled: true },
    patternReviewer: cleaned?.patternReviewer ?? { enabled: true },
    factStateExtractor: cleaned?.factStateExtractor ?? { enabled: true },
    plotSuggestions: cleaned?.plotSuggestions ?? { enabled: true },
  }
}

/** The story mode is the only runtime switch for the Chinese collaborative workflow. */
export function isCollaborativeStory(story: Pick<Story, 'mode'> | null | undefined): boolean {
  return story?.mode === 'creative-writing'
}

function hasLegacyWorkflowSignal(workflow: CollaborativeNovelWorkflow | undefined): boolean {
  if (!workflow) return false
  return Object.values(workflow).some((value) => {
    if (value === undefined) return false
    if (typeof value !== 'object' || value === null) return true
    return Object.keys(value).length > 0
  })
}

export interface CollaborativeStoryState {
  mode: StoryMode
  settings: StorySettings | null
}

/** Canonicalize current and legacy story records at load/import boundaries. */
export function normalizeCollaborativeStory<T extends CollaborativeStoryState>(story: T): T {
  const legacySettings = (story.settings ?? {}) as LegacyStorySettings
  const legacyEnabled = legacySettings.collaborativeNovel === true
  const workflowSignal = hasLegacyWorkflowSignal(legacySettings.collaborativeNovelWorkflow)
  const mode: StoryMode =
    story.mode === 'creative-writing' || legacyEnabled || workflowSignal
      ? 'creative-writing'
      : 'adventure'

  const settings: LegacyStorySettings = { ...legacySettings }
  delete settings.collaborativeNovel
  if (mode === 'creative-writing') {
    settings.imageGenerationMode =
      legacySettings.imageGenerationMode && legacySettings.imageGenerationMode !== 'none'
        ? 'manual'
        : 'none'
    settings.collaborativeNovelWorkflow = createDefaultCollaborativeWorkflow(
      legacySettings.collaborativeNovelWorkflow,
    )
  } else {
    delete settings.collaborativeNovelWorkflow
  }

  return { ...story, mode, settings } as T
}
