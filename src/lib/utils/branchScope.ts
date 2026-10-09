/**
 * How a story branch is named when it is used as a map or set key.
 *
 * The lore-session lock and the background-task counter are separate locks and stay
 * separate; what must not diverge is what "the main branch" is spelled as, since a writer
 * and a reader that disagree both report the branch idle. A leaf module, so a rune store
 * and a plain service can share it.
 */
export function branchScopeKey(storyId: string, branchId: string | null): string {
  return `${storyId}:${branchId ?? 'main'}`
}

export interface GenerationScope {
  readonly storyId: string
  readonly branchId: string | null
  readonly turnId: string
}

export interface ScopedWriteOptions {
  scope?: Pick<GenerationScope, 'storyId' | 'branchId'>
  isScopeCurrent?: () => boolean
}

export function assertWriteScopeCurrent(isCurrent: boolean): void {
  if (!isCurrent) throw new DOMException('Story write scope is no longer current', 'AbortError')
}

export function createGenerationScope(storyId: string, branchId: string | null): GenerationScope {
  return Object.freeze({ storyId, branchId, turnId: crypto.randomUUID() })
}

export function isGenerationScopeCurrent(
  scope: GenerationScope,
  currentStory: { id: string; currentBranchId?: string | null } | null | undefined,
): boolean {
  return (
    currentStory?.id === scope.storyId && (currentStory.currentBranchId ?? null) === scope.branchId
  )
}
