import { describe, expect, it } from 'vitest'
import { createGenerationScope, isGenerationScopeCurrent } from './branchScope'

describe('generation scope', () => {
  it('captures an immutable turn identity and rejects another branch', () => {
    const scope = createGenerationScope('story-1', 'branch-a')
    expect(Object.isFrozen(scope)).toBe(true)
    expect(scope.turnId).toBeTruthy()
    expect(isGenerationScopeCurrent(scope, { id: 'story-1', currentBranchId: 'branch-a' })).toBe(
      true,
    )
    expect(isGenerationScopeCurrent(scope, { id: 'story-1', currentBranchId: 'branch-b' })).toBe(
      false,
    )
    expect(isGenerationScopeCurrent(scope, { id: 'story-2', currentBranchId: 'branch-a' })).toBe(
      false,
    )
  })
})
