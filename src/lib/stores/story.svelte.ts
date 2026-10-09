import { replaceUser, replaceLoreUser, type CardImportDraft } from '$lib/services/storySetup/draft'
import { mergeVisualDescriptors } from '$lib/utils/visualDescriptors'
import type {
  Story,
  StoryEntry,
  Character,
  Location,
  Item,
  StoryBeat,
  Chapter,
  Checkpoint,
  Branch,
  MemoryConfig,
  StoryMode,
  StorySettings,
  Entry,
  TimeTracker,
  PersistentCharacterSnapshot,
  WorldStateDelta,
  WorldStateSnapshot,
  CharacterBeforeState,
  LocationBeforeState,
  ItemBeforeState,
  StoryBeatBeforeState,
  ImageGenerationMode,
  TargetLength,
  StoryEntryVariant,
  StoryEntryVariantSet,
} from '$lib/types'
import { database, type DatabaseService } from '$lib/services/database'
import { storyBasicsUpdate, type StoryBasicsDraft } from '$lib/services/storyBasics'
import { rollbackService } from '$lib/services/rollbackService'
import { ui } from './ui.svelte'
import { settings } from './settings.svelte'
import { extractInlineCustomVars } from '$lib/services/ai/sdk/schemas/runtime-variables'
import type { ClassificationResult } from '$lib/services/ai/sdk/schemas/classifier'
import type { RuntimeVariable } from '$lib/services/packs/types'
import { DEFAULT_MEMORY_CONFIG } from '$lib/services/ai/generation/MemoryService'
import { chapterReadBudget } from '$lib/services/ai/core/defaults'
import { LorebookImportExport } from '$lib/services/lorebookImportExport'
import { countTokens } from '$lib/services/tokenizer'
import type { STChatMessage } from '$lib/services/stChatImporter'
import { packService } from '$lib/services/packs/pack-service'
import {
  eventBus,
  emitStoryLoaded,
  emitModeChanged,
  emitStateUpdated,
  emitChapterCreated,
  type CheckpointCreatedEvent,
  type StoryCreatedEvent,
  type BranchSwitchedEvent,
} from '$lib/services/events'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { aiService } from '$lib/services/ai'
import {
  ChapterBatchService,
  buildLoreManagementCallbacks,
  buildLoreManagementUICallbacks,
  resolveCharacterPresence,
  type WorldState,
} from '$lib/services/generation'
import { createLogger } from '$lib/log'
import { sameEntityName } from '$lib/utils/text'
import { grammarService } from '$lib/services/grammar'
import { clearTier3SelectionCache } from '$lib/services/ai'
import { clearImageMarkerCache } from '$lib/services/image'
import { assertWriteScopeCurrent, type ScopedWriteOptions } from '$lib/utils/branchScope'
import { createStateMaintenanceRecord } from '$lib/services/collaborativeStateMaintenance'
import { planStateRollback } from '$lib/services/collaborativeStateMaintenance'
import {
  collaborativeStateRollbackStatements,
  collaborativeTruncationPlanStatements,
} from '$lib/services/collaborativeTransactions'
import {
  createDefaultCollaborativeWorkflow,
  isCollaborativeStory,
  normalizeCollaborativeStory,
} from '$lib/services/generation/collaborativeWorkflow'
import {
  CollaborativeStateRebuildService,
  checkCollaborativeStateRebuildConfirmation,
  createCollaborativeStateRebuildRequest,
  type CollaborativeStateRebuildDraft,
} from '$lib/services/CollaborativeStateRebuildService'

const log = createLogger('StoryStore')

/**
 * Merge LLM-extracted inline runtime vars into entity metadata.runtimeVars.
 * Values are keyed by defId (RuntimeVariable.id), NOT variableName,
 * so renames only change the definition -- stored values follow automatically.
 *
 * @param existingMetadata - Current entity metadata (may be null)
 * @param inlineVars - LLM-extracted vars keyed by variableName (from extractInlineCustomVars)
 * @param defsByName - Lookup from variableName to RuntimeVariable definition
 * @returns Updated metadata with runtimeVars merged
 */
function mergeRuntimeVars(
  existingMetadata: Record<string, unknown> | null,
  inlineVars: Record<string, unknown> | undefined,
  defsByName: Map<string, RuntimeVariable>,
): Record<string, unknown> {
  if (!inlineVars || Object.keys(inlineVars).length === 0) {
    return existingMetadata ?? {}
  }

  const base = existingMetadata ?? {}
  const runtimeVars = { ...((base.runtimeVars as Record<string, unknown>) ?? {}) }

  for (const [key, value] of Object.entries(inlineVars)) {
    const def = defsByName.get(key)
    if (def) {
      runtimeVars[def.id] = { variableName: def.variableName, v: value }
    }
  }

  return { ...base, runtimeVars }
}

// Story Store using Svelte 5 runes
class StoryStore {
  private classificationWrite: {
    done: Promise<void>
    storyId: string
    branchId: string | null
  } | null = null

  /** Finish an already-started classification before undoing its recorded changes. */
  async drainClassificationWrites(options?: ScopedWriteOptions): Promise<void> {
    const { storyId, branchId, check } = this.captureWriteScope(options)
    const active = this.classificationWrite
    if (!active) return
    assertWriteScopeCurrent(active.storyId === storyId && active.branchId === branchId)
    await active.done
    check()
  }

  private captureWriteScope(options?: ScopedWriteOptions) {
    const storyId = options?.scope?.storyId ?? this.currentStory?.id
    const branchId = options?.scope
      ? options.scope.branchId
      : (this.currentStory?.currentBranchId ?? null)
    const loadSeq = this.storyLoadSeq
    const switchSeq = this.branchSwitchSeq
    const check = () =>
      assertWriteScopeCurrent(
        !!storyId &&
          this.currentStory?.id === storyId &&
          (this.currentStory.currentBranchId ?? null) === branchId &&
          this.storyLoadSeq === loadSeq &&
          this.branchSwitchSeq === switchSeq &&
          options?.isScopeCurrent?.() !== false,
      )
    check()
    return { storyId: storyId!, branchId, check }
  }

  /** Tail of the story-load queue — see loadStory. */
  private storyLoadChain: Promise<unknown> = Promise.resolve()
  /** Sequence of the most recently requested story load. */
  private storyLoadSeq = 0

  // Current active story
  currentStory = $state<Story | null>(null)
  entries = $state<StoryEntry[]>([])
  currentBgImage = $state<string | null>(null)

  // Lorebook entries (per design doc section 3.2)
  lorebookEntries = $state<Entry[]>([])

  // World state for current story
  characters = $state<Character[]>([])
  locations = $state<Location[]>([])
  items = $state<Item[]>([])
  storyBeats = $state<StoryBeat[]>([])

  // Memory system
  chapters = $state<Chapter[]>([])
  checkpoints = $state<Checkpoint[]>([])

  // Batch chapterization (chapterizeFromBeginning) progress/cancel state.
  // Local to the store (not ui.svelte.ts) because this is a blocking,
  // single-operation flow owned by whichever screen started it, unlike
  // ui.loreManagementProgress which tracks an ambient background task.
  chapterizationProgress = $state<{ current: number; total: number } | null>(null)
  chapterizationTimelineProgress = $state<{ current: number; total: number } | null>(null)
  chapterizationClassificationProgress = $state<{ current: number; total: number } | null>(null)
  chapterizationStatus = $state<string | null>(null)
  private chapterizationCancelRequested = $state(false)

  // Branching system
  branches = $state<Branch[]>([])

  // Story library
  allStories = $state<Story[]>([])

  // Performance caches - avoid O(n) recalculations on every access
  private _cachedWordCount: number = 0
  private _wordCountDirty = $state(true)
  private _cachedLastChapterEndIndex: number = 0
  private _lastChapterEndIndexDirty: boolean = true
  private _lastChaptersLength: number = 0
  private _lastEntriesLength: number = 0

  // Entry ID to index map for O(1) lookups
  private _entryIdToIndex: Map<string, number> = new Map()

  // Retry operation lock - prevents editing during retry restore
  private _isRetryInProgress = $state(false)

  // Public getter to check if retry is in progress
  get isRetryInProgress(): boolean {
    return this._isRetryInProgress
  }

  // Derived states
  get currentLocation(): Location | undefined {
    return this.locations.find((l) => l.current)
  }

  get activeCharacters(): Character[] {
    return this.characters.filter((c) => c.status === 'active')
  }

  get protagonist(): Character | undefined {
    return this.characters.find((c) => c.relationship === 'self')
  }

  get pov(): 'first' | 'second' | 'third' {
    const mode = this.currentStory?.mode ?? 'adventure'
    const stored = this.currentStory?.settings?.pov ?? null
    // For creative-writing mode, respect the user's stored POV choice
    // (wizard allows selecting first, second, or third person)
    if (stored) {
      return stored
    }
    // Default based on mode
    if (mode === 'creative-writing') {
      return 'third'
    }
    return 'first'
  }

  get tense(): 'past' | 'present' {
    const mode = this.currentStory?.mode ?? 'adventure'
    const stored = this.currentStory?.settings?.tense ?? null
    if (mode === 'creative-writing') {
      return 'past'
    }
    return stored ?? 'present'
  }

  get inventoryItems(): Item[] {
    return this.items.filter((i) => i.location === 'inventory')
  }

  get equippedItems(): Item[] {
    return this.items.filter((i) => i.equipped)
  }

  get pendingQuests(): StoryBeat[] {
    return this.storyBeats.filter((b) => b.status === 'pending' || b.status === 'active')
  }

  get lastUserActionId(): string | null {
    // Search from the end for efficiency
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === 'user_action') {
        return this.entries[i].id
      }
    }
    return null
  }

  get wordCount(): number {
    // This is the story's visible prose character count. Whitespace-word counting is
    // unusable for Chinese text because an entire paragraph can contain no spaces.
    if (this._wordCountDirty) {
      this._cachedWordCount = this.entries.reduce((count, entry) => {
        const plainText = entry.content.replace(/<[^>]*>/g, ' ')
        return count + Array.from(plainText.replace(/\s/gu, '')).length
      }, 0)
      this._wordCountDirty = false
    }
    return this._cachedWordCount
  }

  get proseCharacterCount(): number {
    return this.entries.reduce((count, entry) => {
      const plainText = entry.content.replace(/<[^>]*>/g, ' ')
      return count + Array.from(plainText.replace(/\s/gu, '')).length
    }, 0)
  }

  /**
   * Invalidate word count cache - call when entries are added/removed/modified
   */
  private invalidateWordCountCache(): void {
    this._wordCountDirty = true
  }

  get memoryConfig(): MemoryConfig {
    return this.currentStory?.memoryConfig || DEFAULT_MEMORY_CONFIG
  }

  /**
   * Token budget for one chapter-reading prompt, derived from *this* story's own
   * chapterization threshold. See `chapterReadBudget`.
   *
   * A getter rather than the expression at each call site because there are four of them --
   * the generation pipeline's timeline fill and chapter query, and the lore management
   * agent's chapter query in both the turn path and the bulk-chapterization path. Three of
   * those were passing nothing and silently reading against the 40,000-token fallback, which
   * on a story with a low threshold is an order of magnitude more chapter text than the
   * budget exists to allow. One expression with four readers cannot drift that way.
   */
  get chapterReadBudget(): number {
    return chapterReadBudget(this.memoryConfig.tokenThreshold)
  }

  get storyMode(): StoryMode {
    return this.currentStory?.mode || 'adventure'
  }

  get timeTracker(): TimeTracker {
    return this.currentStory?.timeTracker || { years: 0, days: 0, hours: 0, minutes: 0 }
  }

  /**
   * Get chapters filtered by current branch and its lineage.
   * Includes main branch chapters plus any ancestor/current branch chapters.
   */
  get currentBranchChapters(): Chapter[] {
    const currentBranchId = this.currentStory?.currentBranchId ?? null

    // If on main branch, only return chapters with null branchId
    if (currentBranchId === null) {
      return this.chapters.filter((ch) => ch.branchId === null)
    }

    const lineage = this.buildBranchLineage(currentBranchId)
    if (lineage.length === 0) {
      return this.chapters.filter((ch) => ch.branchId === null)
    }

    const lineageIds = new Set(lineage.map((branch) => branch.id))
    return this.chapters.filter((ch) => ch.branchId === null || lineageIds.has(ch.branchId))
  }

  /**
   * Snapshot of world state for AI calls that need it (classification, action
   * choices). Single source of truth for this shape — was previously
   * duplicated inline at each call site.
   */
  get worldStateSnapshot(): WorldState {
    return {
      characters: this.characters,
      locations: this.locations,
      items: this.items,
      storyBeats: this.storyBeats,
      currentLocation: this.currentLocation,
      chapters: this.currentBranchChapters,
      memoryConfig: this.memoryConfig,
      lorebookEntries: this.lorebookEntries,
    }
  }

  get lastChapterEndIndex(): number {
    // Use branch-filtered chapters for this computation
    const branchChapters = this.currentBranchChapters
    if (branchChapters.length === 0) return 0

    // Check if cache is valid - invalidate if chapters or entries changed
    const chaptersChanged = this.chapters.length !== this._lastChaptersLength
    const entriesChanged = this.entries.length !== this._lastEntriesLength

    if (chaptersChanged || entriesChanged || this._lastChapterEndIndexDirty) {
      this._lastChaptersLength = this.chapters.length
      this._lastEntriesLength = this.entries.length
      this._cachedLastChapterEndIndex = this._computeLastChapterEndIndex()
      this._lastChapterEndIndexDirty = false
    }

    return this._cachedLastChapterEndIndex
  }

  /**
   * Rebuild the entry ID to index map for O(1) lookups.
   * Called when entries array changes significantly.
   */
  private rebuildEntryIdIndex(): void {
    this._entryIdToIndex.clear()
    for (let i = 0; i < this.entries.length; i++) {
      this._entryIdToIndex.set(this.entries[i].id, i)
    }
  }

  /**
   * Compute lastChapterEndIndex - internal implementation.
   * Uses branch-filtered chapters for correct branch awareness.
   */
  private _computeLastChapterEndIndex(): number {
    // Use branch-filtered chapters
    const branchChapters = this.currentBranchChapters
    if (branchChapters.length === 0) return 0

    // Rebuild index map if needed
    if (this._entryIdToIndex.size !== this.entries.length) {
      this.rebuildEntryIdIndex()
    }

    // Sort chapters by number to ensure we get the actual last chapter for this branch
    const sortedChapters = [...branchChapters].sort((a, b) => a.number - b.number)
    const lastChapter = sortedChapters[sortedChapters.length - 1]

    // Use O(1) map lookup instead of O(n) find + indexOf
    const endIndex = this._entryIdToIndex.get(lastChapter.endEntryId)
    if (endIndex !== undefined) {
      return endIndex + 1
    }

    // Fallback: if endEntryId references a deleted entry, estimate based on entry counts
    log('Warning: Chapter endEntryId not found, using fallback calculation', {
      chapterId: lastChapter.id,
      chapterNumber: lastChapter.number,
      endEntryId: lastChapter.endEntryId,
    })

    // Sum up all branch chapter entry counts as a fallback estimate
    const totalChapterEntries = sortedChapters.reduce((sum, ch) => sum + ch.entryCount, 0)
    return Math.min(totalChapterEntries, this.entries.length)
  }

  /**
   * Invalidate lastChapterEndIndex cache - call when chapters change
   */
  private invalidateChapterCache(): void {
    this._lastChapterEndIndexDirty = true
    this._entryIdToIndex.clear() // Force rebuild on next access
  }

  get messagesSinceLastChapter(): number {
    return this.entries.length - this.lastChapterEndIndex
  }

  /**
   * Calculate token count since last chapter.
   * Uses stored token count (accurate) or calculates via tokenizer for legacy entries.
   */
  get tokensSinceLastChapter(): number {
    const visibleEntries = this.entries.slice(this.lastChapterEndIndex)
    return visibleEntries.reduce((total, entry) => {
      // Use stored token count if available
      if (entry.metadata?.tokenCount) {
        return total + entry.metadata.tokenCount
      }
      // Fallback for legacy entries without stored token count
      return total + countTokens(entry.content)
    }, 0)
  }

  /**
   * Get token count for entries outside the buffer (eligible for summarization).
   * Returns 0 if no entries exist outside the buffer.
   */
  get tokensOutsideBuffer(): number {
    const bufferSize = this.memoryConfig.chapterBuffer
    const visibleEntries = this.entries.slice(this.lastChapterEndIndex)

    // If all visible entries are within the buffer, nothing to summarize
    if (visibleEntries.length <= bufferSize) {
      return 0
    }

    // Count tokens for entries outside the buffer
    // Note: slice(0, -0) returns [] in JavaScript, so we need to handle bufferSize === 0 specially
    const entriesOutsideBuffer =
      bufferSize === 0 ? visibleEntries : visibleEntries.slice(0, -bufferSize)
    return entriesOutsideBuffer.reduce((total, entry) => {
      if (entry.metadata?.tokenCount) {
        return total + entry.metadata.tokenCount
      }
      // Fallback for legacy entries without stored token count
      return total + countTokens(entry.content)
    }, 0)
  }

  /**
   * Get entries that are NOT part of any chapter (visible in context).
   * These are entries after the last chapter's endEntryId.
   * Per design doc section 3.1.2: summarized entries should be excluded from context.
   */
  get visibleEntries(): StoryEntry[] {
    if (this.chapters.length === 0) {
      // No chapters yet, all entries are visible
      return this.entries
    }
    // Return only entries after the last chapter
    return this.entries.slice(this.lastChapterEndIndex)
  }

  /**
   * Check if a specific entry has been summarized into a chapter.
   * Uses O(1) map lookup for performance.
   */
  isEntrySummarized(entryId: string): boolean {
    // Ensure index map is up to date
    if (this._entryIdToIndex.size !== this.entries.length) {
      this.rebuildEntryIdIndex()
    }
    const entryIndex = this._entryIdToIndex.get(entryId)
    if (entryIndex === undefined) return false
    return entryIndex < this.lastChapterEndIndex
  }

  /**
   * Validate chapter integrity and repair issues.
   * Called after loading a story to ensure chapter data is consistent.
   * Returns true if repairs were made.
   */
  private async validateChapterIntegrity(): Promise<boolean> {
    if (this.chapters.length === 0) return false

    let repairsMade = false
    const entryIdSet = new Set(this.entries.map((e) => e.id))
    const chaptersToDelete: string[] = []

    // Sort chapters by number for proper validation
    const sortedChapters = [...this.chapters].sort((a, b) => a.number - b.number)

    for (const chapter of sortedChapters) {
      const hasValidStart = entryIdSet.has(chapter.startEntryId)
      const hasValidEnd = entryIdSet.has(chapter.endEntryId)

      if (!hasValidStart || !hasValidEnd) {
        log('Chapter has invalid entry references, marking for deletion', {
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          hasValidStart,
          hasValidEnd,
          startEntryId: chapter.startEntryId,
          endEntryId: chapter.endEntryId,
        })
        chaptersToDelete.push(chapter.id)
        repairsMade = true
      }
    }

    // Delete invalid chapters from database and local state (batched)
    if (chaptersToDelete.length > 0) {
      try {
        await database.deleteChapters(chaptersToDelete)
        log('Deleted invalid chapters:', chaptersToDelete)
        // This repair is otherwise invisible in production (the logger above is a dev-only
        // no-op), so a story can silently lose chapters with no trace for the user to report.
        ui.showToast(
          `Removed ${chaptersToDelete.length} chapter${chaptersToDelete.length === 1 ? '' : 's'} with broken entry references`,
          'warning',
        )
      } catch (error) {
        log('Failed to delete invalid chapters:', chaptersToDelete, error)
      }
    }

    if (chaptersToDelete.length > 0) {
      this.chapters = this.chapters.filter((ch) => !chaptersToDelete.includes(ch.id))
      // Invalidate chapter cache after deletions
      this.invalidateChapterCache()
    }

    // Ensure chapters are sorted by number
    this.chapters = [...this.chapters].sort((a, b) => a.number - b.number)

    if (repairsMade) {
      log('Chapter integrity validation complete', {
        deletedChapters: chaptersToDelete.length,
        remainingChapters: this.chapters.length,
      })
    }

    return repairsMade
  }

  private resetStoryState(): void {
    this.currentStory = null
    this.entries = []
    this.characters = []
    this.locations = []
    this.items = []
    this.storyBeats = []
    this.chapters = []
    this.checkpoints = []
    this.lorebookEntries = []
    this.invalidateWordCountCache()
    this.invalidateChapterCache()
    grammarService.clearEntityWords()
    clearTier3SelectionCache()
    clearImageMarkerCache()
  }

  // Close the current story and reset state
  closeStory(): void {
    this.storyLoadSeq++
    this.resetStoryState()
    // Lorebook selection belongs to the story that was just closed. Clear it together
    // with the story data so reopening a story cannot resolve a stale entry id.
    ui.resetLorebookManager()
    this.currentBgImage = null
    this.branches = []
    // The image indicators are not gated on there being a story, so anything still in
    // flight would keep counting in the library, against a story that is no longer open.
    // Late `ImageReady` events from those generations clamp at zero rather than going
    // negative.
    ui.resetImageGenerationState()
    log('Story closed')
  }

  // Load all stories for library view
  async loadAllStories(): Promise<void> {
    this.allStories = await database.getAllStories()
  }

  // Load a specific story with all its data
  async loadStory(storyId: string): Promise<void> {
    const seq = ++this.storyLoadSeq
    const run = this.storyLoadChain.then(
      () => this.performStoryLoad(storyId, seq),
      () => this.performStoryLoad(storyId, seq),
    )
    this.storyLoadChain = run.catch(() => {})
    return run
  }

  /**
   * Whether a newer load — or a close — has taken over since this one published
   * `currentStory`, in which case this load has to unpublish it too.
   *
   * Returning without that leaves the store naming the story it just published while
   * `entries`, `branches` and the world state still belong to the previous one, which the
   * story view and the navigation panel both render. Loads are serialised, so the load that
   * superseded this one has not started yet and this cannot clear a story it already
   * published; if that load then fails early, the reader gets the library rather than the
   * mismatch.
   */
  private supersededAfterPublish(seq: number): boolean {
    if (seq === this.storyLoadSeq) return false
    this.currentStory = null
    return true
  }

  private async performStoryLoad(storyId: string, seq: number): Promise<void> {
    try {
      await this.runStoryLoad(storyId, seq)
    } catch (error) {
      // A load the reader has already replaced must not report its failure. Its caller sends
      // them back to the library on error, which would discard the story they switched to and
      // explain it with the name of the one they left. The newer load speaks for itself.
      if (seq !== this.storyLoadSeq) return
      // A load that failed *after* publishing leaves the store naming a story whose entries and
      // world state it never loaded. The caller shows the library, so the mismatch is invisible
      // but latent — tear it down rather than leave it for the next reader of the store.
      if (this.currentStory?.id === storyId) this.closeStory()
      throw error
    }
  }

  private async runStoryLoad(storyId: string, seq: number): Promise<void> {
    // Serialize loads and let the most recent request win. This prevents a slower
    // earlier selection from publishing after the story the reader selected last.
    if (seq !== this.storyLoadSeq) return

    const loadedStory = await database.getStory(storyId)
    if (seq !== this.storyLoadSeq) return
    if (!loadedStory) {
      throw new Error(`Story not found: ${storyId}`)
    }
    const story = normalizeCollaborativeStory(loadedStory)
    if (
      story.mode !== loadedStory.mode ||
      JSON.stringify(story.settings) !== JSON.stringify(loadedStory.settings)
    ) {
      await database.updateStory(story.id, { mode: story.mode, settings: story.settings })
    }

    // Clean up any orphaned embedded_images before loading
    // (fixes FK constraint issues from older data)
    await database.cleanupOrphanedEmbeddedImages()
    if (seq !== this.storyLoadSeq) return

    // Whatever the previous story left cached is about a pool this one does not have.
    clearTier3SelectionCache()
    clearImageMarkerCache()

    // A remembered desktop panel must not briefly cover a story as it starts loading on a
    // narrow display. Do this before publishing `currentStory`, which mounts those panels.
    ui.setMobileDefaults()
    // Entries are story-scoped but lorebook selection is global UI state. Reset it before
    // publishing the new story so a stale selection cannot race the asynchronous load.
    ui.resetLorebookManager()
    this.currentStory = story
    const backgroundImage = await database.getBackgroundForBranch(storyId, story.currentBranchId)
    if (this.supersededAfterPublish(seq)) return
    this.currentBgImage = backgroundImage

    // Load branch-independent data first
    const [characters, locations, items, storyBeats, checkpoints, lorebookEntries, branches] =
      await Promise.all([
        database.getCharacters(storyId),
        database.getLocations(storyId),
        database.getItems(storyId),
        database.getStoryBeats(storyId),
        database.getCheckpoints(storyId),
        database.getEntries(storyId),
        database.getBranches(storyId),
      ])
    if (this.supersededAfterPublish(seq)) return

    this.characters = characters
    this.locations = locations
    this.items = items
    this.storyBeats = storyBeats
    this.checkpoints = checkpoints
    this.lorebookEntries = lorebookEntries
    this.branches = branches

    // Import entity names into spell checker so they are not flagged as errors
    const entityNames = [
      ...characters.map((c) => c.name),
      ...locations.map((l) => l.name),
      ...items.map((i) => i.name),
      ...lorebookEntries.map((e) => e.name),
      ...lorebookEntries.flatMap((e) => e.aliases ?? []),
    ].filter(Boolean)
    grammarService.importEntityWords(entityNames)

    // Load entries and chapters based on current branch
    await this.reloadEntriesForCurrentBranch()
    if (this.supersededAfterPublish(seq)) return

    // Reset all caches after loading
    this.invalidateWordCountCache()
    this.invalidateChapterCache()

    log('Story loaded', {
      id: storyId,
      mode: story.mode,
      entries: this.entries.length,
      lorebookEntries: lorebookEntries.length,
      chapters: this.chapters.length,
      checkpoints: checkpoints.length,
      branches: branches.length,
      currentBranchId: story.currentBranchId,
    })

    // Load persisted activation data for this story (stickiness tracking)
    await ui.loadActivationData(storyId)
    if (this.supersededAfterPublish(seq)) return

    // Clear stale lorebook retrieval from previous story to prevent cross-story contamination
    ui.setLastLorebookRetrieval(null)

    // Set current story ID for retry backup tracking
    ui.setCurrentRetryStoryId(storyId)

    // Load retry state from DB if we don't have an in-memory backup for this story
    if (story.retryState) {
      ui.loadRetryBackupFromPersistent(storyId, story.retryState)
    }

    // Load style review state from DB
    ui.loadStyleReviewState(storyId, story.styleReviewState)

    // Validate and repair chapter integrity (handles orphaned references)
    await this.validateChapterIntegrity()
    if (this.supersededAfterPublish(seq)) return

    const collaborative = isCollaborativeStory(story)
    const collaborativeSuggestionsEnabled =
      story.settings?.collaborativeNovelWorkflow?.plotSuggestions?.enabled !== false

    // Load persisted action choices only for ordinary adventure mode.
    if (story.mode === 'adventure' && !collaborative) {
      await ui.loadActionChoices(storyId)
      if (this.supersededAfterPublish(seq)) return
    }

    // Collaborative suggestions have a story cache but are never restored when disabled.
    if ((story.mode === 'creative-writing' || collaborative) && collaborativeSuggestionsEnabled) {
      await ui.loadSuggestions(storyId)
      if (this.supersededAfterPublish(seq)) return
    } else if (collaborative) {
      ui.clearSuggestions(storyId)
    }

    // The settings-keyed cache above is empty for a story that never generated choices in this
    // app (e.g. a fresh import): fall back to the last narration entry's own suggestedActions,
    // same as switchBranch does, so an imported story doesn't open with choices silently missing.
    //
    // Restore only. Opening a story must never trigger generation: the delete-path variant would
    // also arm `suggestionsRegenerationNeeded`, which costs a model call on every open of a story
    // that legitimately has no choices — and on a story with no entries yet the flag would simply
    // stay armed until the first turn ends, firing a second, redundant round of choices on top of
    // the one the pipeline had just produced.
    //
    // Requiring the last entry to be a narration is what keeps the restore honest: with a
    // trailing user_action (an app closed mid-turn) the last narration's choices are the ones the
    // player already spent, and showing them again would also write them back to the cache.
    const hasPersistedChoices = collaborative
      ? ui.suggestions.length > 0
      : story.mode === 'adventure'
        ? ui.actionChoices.length > 0
        : ui.suggestions.length > 0
    if (
      !collaborative &&
      !hasPersistedChoices &&
      this.entries[this.entries.length - 1]?.type === 'narration'
    ) {
      this.restoreSuggestedActionsFromLastNarration()
    }

    // Emit event
    emitStoryLoaded(storyId, story.mode)
  }

  // Create a new story
  async createStory(
    title: string,
    templateId?: string,
    genre?: string,
    mode: StoryMode = 'adventure',
  ): Promise<Story> {
    const storyData = await database.createStory({
      id: crypto.randomUUID(),
      title,
      description: null,
      genre: genre ?? null,
      templateId: templateId ?? null,
      mode,
      settings: null,
      memoryConfig: DEFAULT_MEMORY_CONFIG,
      retryState: null,
      styleReviewState: null,
      timeTracker: null,
      currentBranchId: null,
      currentBgImage: null,
    })

    this.allStories = [storyData, ...this.allStories]

    // Emit event
    eventBus.emit<StoryCreatedEvent>({ type: 'StoryCreated', storyId: storyData.id, mode })

    return storyData
  }

  /**
   * Import a SillyTavern chat into the current story, replacing all existing
   * main-branch entries. The current story must be loaded before calling this.
   */
  async importSTChat(messages: STChatMessage[]): Promise<void> {
    if (!this.currentStory) {
      throw new Error('No story loaded')
    }

    const storyId = this.currentStory.id

    // Branches fork off main-branch entries via fork_entry_id.
    // Deleting all main-branch entries would leave every branch with a
    // dangling FK reference — block the import if any branches exist.
    if (this.branches.length > 0) {
      throw new Error(
        `Cannot import: this story has ${this.branches.length} branch${this.branches.length === 1 ? '' : 'es'}. ` +
          'Delete all branches before importing a SillyTavern chat.',
      )
    }

    // Wipe all existing main-branch entries (and any chapters that
    // referenced them — clearStoryEntries deletes both, see database.ts)
    const droppedCheckpoints = this.checkpointsAnchoredTo(new Set(this.entries.map((e) => e.id)))
    await database.clearStoryEntries(
      storyId,
      droppedCheckpoints.map((cp) => cp.id),
    )
    this.forgetCheckpoints(droppedCheckpoints)
    this.chapters = this.chapters.filter((ch) => ch.branchId !== null)
    this.invalidateChapterCache()

    // Build entry objects up front, then bulk-insert in batches
    // (O(n/50) IPC calls instead of O(n))
    const entries: Omit<StoryEntry, 'createdAt'>[] = messages.map((msg, i) => ({
      id: crypto.randomUUID(),
      storyId,
      type: msg.type,
      content: msg.content,
      parentId: null,
      position: i,
      metadata: { source: 'sillytavern_import' },
      branchId: null,
    }))
    await database.bulkInsertStoryEntries(entries)

    // Bump the story's updatedAt so the library view reflects the import
    await database.updateStory(storyId, {})
    this.currentStory.updatedAt = Date.now()

    // Reload entries into the store
    await this.reloadEntriesForCurrentBranch()
  }

  /**
   * Trigger suggested-action generation after a SillyTavern import.
   * Called by the modal once the user has made their world-state choice,
   * so generation doesn't start before that dialog is resolved.
   */
  triggerSuggestionsAfterImport(): void {
    this.restoreSuggestedActionsAfterDelete()
  }

  /**
   * Reset mutable world state after a SillyTavern chat import.
   * Clears locations, items, story beats, and the time tracker.
   * Characters and lorebook entries are intentionally preserved.
   */
  async resetWorldStateAfterImport(): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    await database.resetWorldStateForImport(this.currentStory.id)
    this.locations = []
    this.items = []
    this.storyBeats = []
    this.currentStory = { ...this.currentStory, timeTracker: null }
  }

  // Add a new story entry
  // The optional id parameter allows pre-generating the entry ID before streaming starts,
  // which is needed for inline image generation during streaming
  async addEntry(
    type: StoryEntry['type'],
    content: string,
    metadata?: StoryEntry['metadata'],
    reasoning?: string,
    id?: string,
    options?: ScopedWriteOptions,
  ): Promise<StoryEntry> {
    if (!this.currentStory) {
      throw new Error('No story loaded')
    }

    const { storyId, branchId, check } = this.captureWriteScope(options)

    // Count tokens for accurate auto-summarize threshold detection
    const tokenCount = countTokens(content)

    // Capture current story time as timeStart for this entry
    // timeEnd defaults to timeStart; for narration entries, timeEnd is updated after classification
    const timeStart = this.currentStory.timeTracker
      ? { ...this.currentStory.timeTracker }
      : { years: 0, days: 0, hours: 0, minutes: 0 }
    const timeEnd = { ...timeStart }

    const position = await database.getNextEntryPosition(storyId, branchId)
    check()
    const entry = await database.addStoryEntry({
      id: id ?? crypto.randomUUID(),
      storyId,
      type,
      content,
      parentId: null,
      position,
      metadata: { ...metadata, tokenCount, timeStart, timeEnd },
      branchId,
      reasoning,
    })

    check()
    this.entries = [...this.entries, entry]

    // Invalidate caches
    this.invalidateWordCountCache()
    this.invalidateChapterCache()

    // Update story's updatedAt
    await database.updateStory(storyId, {})
    check()

    return entry
  }

  private flatVariantSet(set: StoryEntryVariantSet): StoryEntryVariantSet {
    return {
      ...set,
      variants: set.variants.map((variant) => {
        if (!variant.metadata) return { ...variant }
        const metadata = { ...variant.metadata } as Record<string, unknown>
        delete metadata.variantSet
        return { ...variant, metadata }
      }),
    }
  }

  /** Return a normalized variant set, treating legacy entries as a single version. */
  private variantSetForEntry(entry: StoryEntry): StoryEntryVariantSet {
    const existing = entry.metadata?.variantSet
    if (existing && existing.version === 1 && Array.isArray(existing.variants)) {
      // Entries are wrapped by Svelte's reactive proxies in the UI. `structuredClone`
      // rejects those proxies in Chromium, so clone the persisted JSON shape instead.
      return JSON.parse(JSON.stringify(this.flatVariantSet(existing))) as StoryEntryVariantSet
    }

    const legacyMetadata = { ...(entry.metadata ?? {}) }
    delete legacyMetadata.variantSet
    return {
      version: 1,
      activeVariantId: `legacy-${entry.id}`,
      variants: [
        {
          id: `legacy-${entry.id}`,
          content: entry.content,
          reasoning: entry.reasoning,
          translatedContent: entry.translatedContent,
          translationLanguage: entry.translationLanguage,
          metadata: legacyMetadata,
          classificationResult: null,
          worldStateDelta: entry.worldStateDelta,
          suggestedActions: entry.suggestedActions,
          createdAt: entry.createdAt,
        },
      ],
    }
  }

  private mirrorVariant(entry: StoryEntry, set: StoryEntryVariantSet): StoryEntry {
    set = this.flatVariantSet(set)
    const active =
      set.variants.find((variant) => variant.id === set.activeVariantId) ?? set.variants[0]
    if (!active) return entry
    const variantMetadata = { ...(active.metadata ?? {}) } as Record<string, unknown>
    delete variantMetadata.variantSet
    const metadata = { ...variantMetadata, variantSet: set }
    return {
      ...entry,
      content: active.content,
      reasoning: active.reasoning,
      translatedContent: active.translatedContent ?? null,
      translationLanguage: active.translationLanguage ?? null,
      metadata,
      worldStateDelta: active.worldStateDelta ?? null,
      suggestedActions: active.suggestedActions ?? null,
    }
  }

  /** Append a generated alternate to an existing narration entry. */
  async appendNarrationVariant(
    entryId: string,
    variant: StoryEntryVariant,
    options?: { activate?: boolean },
  ): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { branchId, check } = this.captureWriteScope()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到可追加版本的正文。')
    if ((entry.branchId ?? null) !== branchId) throw new Error('不能修改继承正文的版本。')

    const set = this.variantSetForEntry(entry)
    const activate = options?.activate !== false
    const next = set.variants.filter((candidate) => candidate.id !== variant.id)
    next.push({
      ...variant,
      state: variant.state ?? (activate ? 'stored' : 'pending'),
      metadata: variant.metadata ? { ...variant.metadata } : null,
    })
    const nextSet: StoryEntryVariantSet = {
      version: 1,
      activeVariantId: activate ? variant.id : set.activeVariantId,
      variants: next,
    }
    const mirrored = this.mirrorVariant(entry, nextSet)
    check()
    await database.updateStoryEntry(entryId, {
      content: mirrored.content,
      reasoning: mirrored.reasoning,
      translatedContent: mirrored.translatedContent,
      translationLanguage: mirrored.translationLanguage,
      metadata: mirrored.metadata,
      worldStateDelta: mirrored.worldStateDelta,
      suggestedActions: mirrored.suggestedActions,
    })
    check()
    this.entries = this.entries.map((candidate) =>
      candidate.id === entryId ? mirrored : candidate,
    )
    return mirrored
  }

  /** Update fields belonging to the active variant without creating another entry. */
  async updateNarrationVariant(
    entryId: string,
    patch: Partial<StoryEntryVariant>,
    options?: { variantId?: string },
  ): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { check } = this.captureWriteScope()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到正文版本。')
    const set = this.variantSetForEntry(entry)
    const activeId = options?.variantId ?? set.activeVariantId
    const nextSet: StoryEntryVariantSet = {
      ...set,
      variants: set.variants.map((variant) =>
        variant.id === activeId
          ? {
              ...variant,
              ...patch,
              metadata: patch.metadata
                ? (() => {
                    const merged = { ...(variant.metadata ?? {}), ...patch.metadata } as Record<
                      string,
                      unknown
                    >
                    delete merged.variantSet
                    return merged as StoryEntryVariant['metadata']
                  })()
                : variant.metadata,
            }
          : variant,
      ),
    }
    const mirrored = this.mirrorVariant(entry, nextSet)
    check()
    await database.updateStoryEntry(entryId, {
      content: mirrored.content,
      reasoning: mirrored.reasoning,
      translatedContent: mirrored.translatedContent,
      translationLanguage: mirrored.translationLanguage,
      metadata: mirrored.metadata,
      worldStateDelta: mirrored.worldStateDelta,
      suggestedActions: mirrored.suggestedActions,
    })
    check()
    this.entries = this.entries.map((candidate) =>
      candidate.id === entryId ? mirrored : candidate,
    )
    return mirrored
  }

  /** Activate a variant without touching world state. Used while a newly generated
   * variant is waiting for its classification result. */
  async activateNarrationVariant(entryId: string, variantId: string): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { check } = this.captureWriteScope()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到可激活的正文。')
    const set = this.variantSetForEntry(entry)
    if (!set.variants.some((variant) => variant.id === variantId))
      throw new Error('正文版本不存在。')
    const nextSet: StoryEntryVariantSet = { ...set, activeVariantId: variantId }
    const activated = this.mirrorVariant(entry, nextSet)
    check()
    await database.updateStoryEntry(entryId, {
      content: activated.content,
      reasoning: activated.reasoning,
      translatedContent: activated.translatedContent,
      translationLanguage: activated.translationLanguage,
      metadata: activated.metadata,
      worldStateDelta: activated.worldStateDelta,
      suggestedActions: activated.suggestedActions,
    })
    check()
    this.entries = this.entries.map((candidate) =>
      candidate.id === entryId ? activated : candidate,
    )
    return activated
  }

  /** Remove an uncommitted reroll variant and restore the requested active variant. */
  async discardNarrationVariant(
    entryId: string,
    variantId: string,
    restoreVariantId?: string,
  ): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { check } = this.captureWriteScope()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到要清理的正文。')
    const set = this.variantSetForEntry(entry)
    const remaining = set.variants.filter((variant) => variant.id !== variantId)
    if (remaining.length === 0) throw new Error('不能删除正文的最后一个版本。')
    const activeVariantId =
      restoreVariantId && remaining.some((variant) => variant.id === restoreVariantId)
        ? restoreVariantId
        : remaining[0].id
    const restored = this.mirrorVariant(entry, { version: 1, activeVariantId, variants: remaining })
    await database.updateStoryEntry(entryId, {
      content: restored.content,
      reasoning: restored.reasoning,
      translatedContent: restored.translatedContent,
      translationLanguage: restored.translationLanguage,
      metadata: restored.metadata,
      worldStateDelta: restored.worldStateDelta,
      suggestedActions: restored.suggestedActions,
    })
    check()
    this.entries = this.entries.map((candidate) =>
      candidate.id === entryId ? restored : candidate,
    )
    return restored
  }

  /**
   * Switch the active version of the current tail narration. For generated variants,
   * roll back the current delta and re-apply the saved classification result; opening
   * variants intentionally carry no classification and only change visible prose.
   */
  async switchNarrationVariant(entryId: string, variantId: string): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    this.assertNotBusy('切换正文版本')
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到可切换的正文。')
    if (this.entries[this.entries.length - 1]?.id !== entryId) {
      throw new Error('历史正文请先创建分支后再切换版本。')
    }
    const set = this.variantSetForEntry(entry)
    const target = set.variants.find((variant) => variant.id === variantId)
    const active = set.variants.find((variant) => variant.id === set.activeVariantId)
    if (!target || !active) throw new Error('正文版本不存在。')
    if (target.id === active.id) return entry

    const nextSet: StoryEntryVariantSet = { ...set, activeVariantId: target.id }
    const beforeEntries = this.entries
    const beforeCharacters = this.characters
    const beforeLocations = this.locations
    const beforeItems = this.items
    const beforeStoryBeats = this.storyBeats
    const beforeStory = this.currentStory
    try {
      const { storyId, branchId, check } = this.captureWriteScope()
      const activeEntry = this.mirrorVariant(entry, set)
      const rollbackPlan = activeEntry.worldStateDelta
        ? planStateRollback([activeEntry], activeEntry.position)
        : {
            valid: true as const,
            plan: {
              entries: [],
              operations: [],
              targetTimeTracker: undefined,
              targetCurrentLocationId: undefined,
            },
            issues: [] as never[],
          }
      if (!rollbackPlan.valid) throw new Error('当前正文缺少可安全回退的事实状态记录。')

      // Align the in-memory world with the pre-entry state before classification computes
      // its before-state. The same inverse operations are staged in the DB transaction.
      this.applyRollbackPlanInMemory(rollbackPlan.plan)
      const finalSetPreview: StoryEntryVariantSet = {
        ...nextSet,
        variants: nextSet.variants.map((variant) =>
          variant.id === target.id ? { ...target } : variant,
        ),
      }
      this.entries = this.entries.map((candidate) =>
        candidate.id === entryId ? this.mirrorVariant(entry, finalSetPreview) : candidate,
      )

      await database.collectAtomicWrites(async (writer) => {
        if (
          rollbackPlan.plan.operations.length > 0 ||
          rollbackPlan.plan.targetTimeTracker !== undefined
        ) {
          writer.stageAtomicStatements(
            collaborativeStateRollbackStatements({
              scope: { storyId, branchId },
              plan: rollbackPlan.plan,
            }),
          )
        }
        const targetClassification =
          target.classificationResult && !target.classificationResult._error
            ? target.classificationResult
            : null
        if (targetClassification) {
          await this.applyClassificationResultMutating(
            targetClassification,
            entryId,
            {
              scope: { storyId, branchId },
              isScopeCurrent: () => {
                check()
                return true
              },
            },
            writer,
          )
        }
        const applied = this.entries.find((candidate) => candidate.id === entryId)
        const appliedTarget: StoryEntryVariant = {
          ...target,
          ...(applied?.worldStateDelta !== undefined
            ? { worldStateDelta: applied.worldStateDelta }
            : {}),
          metadata: {
            ...(target.metadata ?? {}),
            ...(applied?.metadata ?? {}),
          },
        }
        const finalSet: StoryEntryVariantSet = {
          ...nextSet,
          variants: nextSet.variants.map((variant) =>
            variant.id === target.id
              ? {
                  ...appliedTarget,
                  state: targetClassification ? 'stored' : 'pending',
                }
              : variant,
          ),
        }
        const finalEntry = this.mirrorVariant(
          this.entries.find((candidate) => candidate.id === entryId) ?? entry,
          finalSet,
        )
        writer.stageAtomicStatements([
          {
            sql: 'UPDATE story_entries SET content = ?, reasoning = ?, translated_content = ?, translation_language = ?, metadata = ?, world_state_delta = ?, suggested_actions = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
            params: [
              finalEntry.content,
              finalEntry.reasoning ?? null,
              finalEntry.translatedContent ?? null,
              finalEntry.translationLanguage ?? null,
              finalEntry.metadata ? JSON.stringify(finalEntry.metadata) : null,
              finalEntry.worldStateDelta ? JSON.stringify(finalEntry.worldStateDelta) : null,
              finalEntry.suggestedActions ?? null,
              entryId,
              storyId,
              branchId,
            ],
            expectedRows: 1,
          },
        ])
        this.entries = this.entries.map((candidate) =>
          candidate.id === entryId ? finalEntry : candidate,
        )
      })
      check()
      await this.refreshWorldState()
      const finalEntry = this.entries.find((candidate) => candidate.id === entryId)
      if (!finalEntry) throw new Error('切换后的正文未找到。')
      return finalEntry
    } catch (error) {
      this.characters = beforeCharacters
      this.locations = beforeLocations
      this.items = beforeItems
      this.storyBeats = beforeStoryBeats
      this.entries = beforeEntries
      this.currentStory = beforeStory
      throw error
    }
  }

  /** Re-apply an already active variant after a reroll preparation was rolled back but
   * Director/Writer failed before a replacement could be committed. */
  async restoreNarrationVariantState(entryId: string, variantId: string): Promise<StoryEntry> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { check } = this.captureWriteScope()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到要恢复的正文版本。')
    const set = this.variantSetForEntry(entry)
    const target = set.variants.find((variant) => variant.id === variantId)
    if (!target) throw new Error('要恢复的正文版本不存在。')
    if (target.classificationResult && !target.classificationResult._error) {
      if (set.activeVariantId !== variantId) await this.activateNarrationVariant(entryId, variantId)
      check()
      await this.applyClassificationResult(target.classificationResult, entryId)
      check()
      const applied = this.entries.find((candidate) => candidate.id === entryId)
      await this.updateNarrationVariant(entryId, {
        state: 'stored',
        classificationResult: target.classificationResult,
        worldStateDelta: applied?.worldStateDelta ?? null,
        metadata: applied?.metadata ?? target.metadata,
      })
    } else {
      const restoredSet: StoryEntryVariantSet = { ...set, activeVariantId: target.id }
      const restored = this.mirrorVariant(entry, restoredSet)
      await database.updateStoryEntry(entryId, {
        content: restored.content,
        reasoning: restored.reasoning,
        translatedContent: restored.translatedContent,
        translationLanguage: restored.translationLanguage,
        metadata: restored.metadata,
        worldStateDelta: restored.worldStateDelta,
        suggestedActions: restored.suggestedActions,
      })
      check()
      this.entries = this.entries.map((candidate) =>
        candidate.id === entryId ? restored : candidate,
      )
    }
    const restored = this.entries.find((candidate) => candidate.id === entryId)
    if (!restored) throw new Error('恢复后的正文未找到。')
    return restored
  }

  async settleNarrationReroll(entryId: string, previousVariantId: string): Promise<void> {
    const { check } = this.captureWriteScope()
    await this.drainClassificationWrites()
    check()
    let entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry) return
    const set = this.variantSetForEntry(entry)
    const active = set.variants.find((variant) => variant.id === set.activeVariantId)
    if (!active) return
    if (
      active.id === previousVariantId &&
      entry.metadata?.collaborativeStateMaintenance?.status === 'failed' &&
      !entry.worldStateDelta &&
      active.classificationResult &&
      !active.classificationResult._error
    ) {
      await this.restoreNarrationVariantState(entryId, previousVariantId)
      check()
      entry = this.entries.find((candidate) => candidate.id === entryId)
      if (!entry) return
    }
    const maintenance =
      entry.metadata?.collaborativeStateMaintenance ??
      createStateMaintenanceRecord('failed', {
        error: '重写已终止，正文已保留，事实与状态提取未完成；可单独重试提取。',
      })
    await this.updateNarrationVariant(entryId, {
      state: maintenance.status === 'failed' ? 'pending' : 'stored',
      metadata: { ...entry.metadata, collaborativeStateMaintenance: maintenance },
      worldStateDelta: maintenance.status === 'applied' ? entry.worldStateDelta : null,
      classificationResult:
        maintenance.status === 'applied'
          ? ((entry.worldStateDelta?.classificationResult as ClassificationResult | undefined) ??
            active.classificationResult)
          : active.classificationResult,
    })
    check()
    if (maintenance.status === 'failed') {
      ui.showToast(
        '正文已保留，但事实状态尚未恢复；可以重新生成、删除，或单独重试事实与状态提取。',
        'warning',
      )
    }
  }

  /** Apply a pure rollback plan to the in-memory world before a transactional re-apply. */
  private applyRollbackPlanInMemory(
    plan: import('$lib/services/collaborativeStateMaintenance').StateRollbackPlan,
  ) {
    for (const operation of plan.operations) {
      if (operation.action === 'delete') {
        if (operation.entity === 'character')
          this.characters = this.characters.filter((item) => item.id !== operation.id)
        if (operation.entity === 'location')
          this.locations = this.locations.filter((item) => item.id !== operation.id)
        if (operation.entity === 'item')
          this.items = this.items.filter((item) => item.id !== operation.id)
        if (operation.entity === 'storyBeat')
          this.storyBeats = this.storyBeats.filter((item) => item.id !== operation.id)
        continue
      }
      if (operation.entity === 'character')
        this.characters = this.characters.map((item) =>
          item.id === operation.id
            ? {
                ...item,
                ...operation.before,
                status: operation.before.status as Character['status'],
              }
            : item,
        )
      if (operation.entity === 'location')
        this.locations = this.locations.map((item) =>
          item.id === operation.id ? { ...item, ...operation.before } : item,
        )
      if (operation.entity === 'item')
        this.items = this.items.map((item) =>
          item.id === operation.id ? { ...item, ...operation.before } : item,
        )
      if (operation.entity === 'storyBeat')
        this.storyBeats = this.storyBeats.map((item) =>
          item.id === operation.id
            ? {
                ...item,
                ...operation.before,
                status: operation.before.status as StoryBeat['status'],
              }
            : item,
        )
    }
    if (plan.targetCurrentLocationId !== undefined) {
      this.locations = this.locations.map((location) => ({
        ...location,
        current: location.id === plan.targetCurrentLocationId,
      }))
    }
    if (plan.targetTimeTracker !== undefined && this.currentStory) {
      this.currentStory = {
        ...this.currentStory,
        timeTracker: plan.targetTimeTracker ? { ...plan.targetTimeTracker } : null,
      }
    }
  }

  // Update a story entry
  async updateEntry(entryId: string, content: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    this.assertNotBusy('edit an entry')

    const existingEntry = this.entries.find((e) => e.id === entryId)
    if (!existingEntry) throw new Error('Entry not found')

    // Prevent modifying inherited entries on a branch
    // An entry is inherited if its branchId doesn't match the current branch
    const currentBranchId = this.currentStory.currentBranchId
    if ((existingEntry.branchId ?? null) !== currentBranchId) {
      throw new Error(
        'Cannot edit inherited entries. This entry belongs to ' +
          (existingEntry.branchId === null ? 'the main branch' : 'a parent branch') +
          '. Create new content on this branch instead.',
      )
    }

    // Recalculate token count when content changes
    const tokenCount = countTokens(content)
    const updatedMetadata = { ...existingEntry.metadata, tokenCount }

    const existingVariants = existingEntry.metadata?.variantSet
    if (existingVariants?.variants?.length) {
      const nextSet: StoryEntryVariantSet = {
        ...this.variantSetForEntry(existingEntry),
        variants: existingVariants.variants.map((variant) =>
          variant.id === existingVariants.activeVariantId
            ? {
                ...variant,
                content,
                metadata: { ...(variant.metadata ?? {}), tokenCount },
              }
            : variant,
        ),
      }
      const mirrored = this.mirrorVariant({ ...existingEntry, metadata: updatedMetadata }, nextSet)
      await database.updateStoryEntry(entryId, {
        content: mirrored.content,
        metadata: mirrored.metadata,
      })
      this.entries = this.entries.map((e) => (e.id === entryId ? mirrored : e))
      this.invalidateWordCountCache()
      await database.updateStory(this.currentStory.id, {})
      return
    }

    await database.updateStoryEntry(entryId, { content, metadata: updatedMetadata })
    this.entries = this.entries.map((e) =>
      e.id === entryId ? { ...e, content, metadata: updatedMetadata } : e,
    )

    // Invalidate word count cache (content changed)
    this.invalidateWordCountCache()

    // Update story's updatedAt
    await database.updateStory(this.currentStory.id, {})
  }

  /**
   * Restore suggested actions from the last narration entry's own `suggestedActions`.
   *
   * Pure restore: it does not clear anything and does not request regeneration, so a caller that
   * merely opened a story cannot end up spending a model call. `restoreSuggestedActionsAfterDelete`
   * is the variant that adds those two effects, and it is the only one that should be used after
   * time-travel. Returns true if saved actions were found.
   */
  private restoreSuggestedActionsFromLastNarration(): boolean {
    if (!this.currentStory) return false

    // Actions attach to narration entries
    const lastNarration = [...this.entries].reverse().find((e) => e.type === 'narration')
    if (!lastNarration) return false

    const restored = ui.restoreSuggestedActionsFromEntry(
      this.storyMode,
      lastNarration.suggestedActions,
      this.currentStory.id,
    )
    if (restored) {
      log('Restored suggested actions from entry at position', lastNarration.position)
    }
    return restored
  }

  /**
   * Restore suggested actions from the new last narration entry after time-travel (delete).
   * Returns true if saved actions were found and restored, false if regeneration is needed.
   */
  private restoreSuggestedActionsAfterDelete(): boolean {
    if (!this.currentStory) return false

    const storyMode = this.storyMode
    const storyId = this.currentStory.id

    if (this.restoreSuggestedActionsFromLastNarration()) {
      return true
    }

    // No saved actions found — clear current ones so stale actions don't persist
    if (storyMode === 'adventure') {
      ui.clearActionChoices(storyId)
    } else {
      ui.clearSuggestions(storyId)
    }
    // Request auto-regeneration from the UI component
    ui.suggestionsRegenerationNeeded = true
    log('No saved suggested actions found after delete — requesting regeneration')
    return false
  }

  /**
   * Every destructive operation that removes entries from a position onward runs this first,
   * before any rollback: a branch forked at or after that position would survive with a fork
   * point that no longer exists, and a rollback already applied cannot be taken back.
   */
  private assertNoBranchForkAtOrAfter(position: number): void {
    const forked = this.branches.find((b) =>
      this.entries.some((e) => e.id === b.forkEntryId && e.position >= position),
    )
    if (forked) {
      throw new Error(
        `Cannot remove these entries because branch "${forked.name}" forks from one of them. ` +
          `Delete the branch first.`,
      )
    }
  }

  /**
   * The same check, for a caller that mutates other state before it reaches the entries — a
   * retry restores lorebook activation first, and would otherwise leave that half-applied.
   */
  assertEntriesRemovable(position: number): void {
    this.assertNoBranchForkAtOrAfter(position)
  }

  /**
   * A checkpoint restores to its `lastEntryId`, so one whose entry is gone can only produce a
   * branch with a dangling fork point. Callers hand these to the delete that removes the
   * entries, so both land together, and then drop them from memory with `forgetCheckpoints`.
   */
  private checkpointsAnchoredTo(entryIds: Set<string>): Checkpoint[] {
    return this.checkpoints.filter((cp) => entryIds.has(cp.lastEntryId))
  }

  private forgetCheckpoints(removed: Checkpoint[]): void {
    if (removed.length === 0) return
    const ids = new Set(removed.map((cp) => cp.id))
    this.checkpoints = this.checkpoints.filter((cp) => !ids.has(cp.id))
    log('Deleted checkpoints whose entry was removed:', removed.length)
  }

  /**
   * Common cleanup logic after an entry is deleted.
   * Restores suggested actions from the new last narration entry and invalidates the retry backup.
   */
  private postDeleteCleanup(): void {
    this.restoreSuggestedActionsAfterDelete()
    ui.clearRetryBackup(true)
  }

  /**
   * Editing and deleting race with a generation or a retry restore rewriting the same entries.
   * `isRetryInProgress` and `ui.isGenerating` let the UI disable the affordance up front; this
   * refuses the ones that get through, rather than returning as if the work had been done.
   */
  private assertNotBusy(action: string): void {
    if (this._isRetryInProgress || ui.isGenerating) {
      throw new Error(`Cannot ${action} while a generation or retry is in progress`)
    }
  }

  /** Every precondition for removing an entry, in one place. Returns the validated entry. */
  private assertEntryDeletable(entryId: string): StoryEntry {
    this.assertNotBusy('delete an entry')

    const entry = this.entries.find((e) => e.id === entryId)
    if (!entry) throw new Error('Entry not found')

    // An entry is inherited if its branchId doesn't match the current branch
    if ((entry.branchId ?? null) !== (this.currentStory?.currentBranchId ?? null)) {
      throw new Error(
        'Cannot delete inherited entries. This entry belongs to ' +
          (entry.branchId === null ? 'the main branch' : 'a parent branch') +
          '. You can only delete entries created on the current branch.',
      )
    }

    const branchUsingEntry = this.branches.find((b) => b.forkEntryId === entryId)
    if (branchUsingEntry) {
      throw new Error(
        `Cannot delete this entry because it is the fork point for branch "${branchUsingEntry.name}". ` +
          `Delete the branch first if you want to remove this entry.`,
      )
    }

    return entry
  }

  // Delete a story entry
  async deleteEntry(entryId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    await this.drainClassificationWrites()

    this.assertEntryDeletable(entryId)

    // Phase 2: Rollback on delete — cascade delete from this position with world state undo
    const rollbackEnabled =
      (settings.experimentalFeatures.stateTracking &&
        settings.experimentalFeatures.rollbackOnDelete) ||
      isCollaborativeStory(this.currentStory)

    if (rollbackEnabled) {
      await this.truncateCollaborativeBranchFrom(entryId)
      return
    }

    // Legacy behavior: delete just this one entry (no world state changes)
    //
    // A chapter holds foreign keys to the entries at its boundaries. Deleting those rows along
    // with the entry — which is what the cascade path does — is only safe there because that
    // path removes a contiguous *suffix*, so the chapters it drops are trailing and the entries
    // they covered go with them. One entry out of the middle is not that: it would delete a
    // chapter and its generated summary while the entries around it survive, leaving a gap in
    // the numbering. Refuse, naming what is in the way, rather than lose the summary silently.
    const boundaryChapters = this.chapters.filter(
      (ch) => ch.startEntryId === entryId || ch.endEntryId === entryId,
    )
    if (boundaryChapters.length > 0) {
      const named = boundaryChapters
        .map((ch) => (ch.title ? `${ch.number} ("${ch.title}")` : `${ch.number}`))
        .join(', ')
      throw new Error(
        `Cannot delete this entry: it is the boundary of chapter ${named}, and deleting it ` +
          `would discard that chapter's summary. Delete from this entry onward instead.`,
      )
    }

    const droppedCheckpoints = this.checkpointsAnchoredTo(new Set([entryId]))
    await database.deleteEntriesWithDependents({
      entryIds: [entryId],
      checkpointIds: droppedCheckpoints.map((cp) => cp.id),
    })
    this.forgetCheckpoints(droppedCheckpoints)
    this.entries = this.entries.filter((e) => e.id !== entryId)

    // Invalidate caches
    this.invalidateWordCountCache()
    this.invalidateChapterCache()

    // Update story's updatedAt
    await database.updateStory(this.currentStory.id, {})

    this.postDeleteCleanup()
  }

  /** Atomically remove one collaborative branch suffix and reverse all recorded state changes. */
  async truncateCollaborativeBranchFrom(entryId: string, preserved?: StoryEntry): Promise<void> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    await this.drainClassificationWrites()
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry) throw new Error('Entry not found')
    this.assertNoBranchForkAtOrAfter(entry.position)
    const { storyId, branchId, check } = this.captureWriteScope()
    const settingsValue: StorySettings = { ...(this.currentStory.settings ?? {}) }
    if (settingsValue.collaborativeNovelPlan) {
      settingsValue.collaborativeNovelPlan = {
        ...settingsValue.collaborativeNovelPlan,
        needsReview: true,
      }
    }
    if (settingsValue.collaborativeNovelPattern) {
      settingsValue.collaborativeNovelPattern = {
        ...settingsValue.collaborativeNovelPattern,
        needsReview: true,
      }
    }
    const rollback = planStateRollback(this.entries, entry.position)
    if (!rollback.valid) {
      const snapshot = await database.getLatestSnapshotBefore(storyId, branchId, entry.position - 1)
      const snapshotEntry = snapshot
        ? this.entries.find((candidate) => candidate.id === snapshot.entryId)
        : undefined
      const rebuild = snapshotEntry?.metadata?.collaborativeStateRebuild
      const currentHash = rebuild
        ? createCollaborativeStateRebuildRequest({
            storyId,
            branchId,
            targetEntryId: snapshotEntry!.id,
            targetPosition: snapshotEntry!.position,
            entries: this.entries,
            storyInitial: {
              title: this.currentStory.title,
              description: this.currentStory.description,
              genre: this.currentStory.genre,
              settings: this.currentStory.settings,
            },
            manualLorebook: this.lorebookEntries.filter((value) => value.createdBy !== 'ai'),
          }).historyHash
        : null
      const narrationsBetween = snapshot
        ? this.entries.some(
            (candidate) =>
              candidate.type === 'narration' &&
              candidate.position > snapshot.entryPosition &&
              candidate.position < entry.position,
          )
        : true
      if (
        snapshot &&
        rebuild?.historyHash === currentHash &&
        snapshot.entryPosition < entry.position &&
        !narrationsBetween
      ) {
        await this.truncateFromConfirmedRebuild(entry, snapshot, settingsValue, preserved)
        return
      }
      const positions = Array.from(
        new Set(
          rollback.issues.map((issue) => issue.position).filter((value) => value !== undefined),
        ),
      ).sort((a, b) => a! - b!)
      throw new Error(
        `无法安全删除：第 ${positions.join('、') || entry.position} 条正文缺少完整状态记录。请先重建到目标位置的状态。`,
      )
    }

    const statements = collaborativeTruncationPlanStatements({
      scope: { storyId, branchId },
      fromPosition: entry.position,
      plan: rollback.plan,
      updatedAt: Date.now(),
      settings: settingsValue,
      preservedEntryId: preserved?.id,
    })
    if (preserved) {
      await database.collectAtomicWrites(async (writer) => {
        writer.stageAtomicStatements(statements)
        await writer.updateStoryEntry(preserved.id, preserved)
      })
    } else {
      await database.transaction(statements)
    }
    check()
    this.currentStory = { ...this.currentStory, settings: settingsValue }
    await this.reloadEntriesForCurrentBranch()
    const freshStory = await database.getStory(storyId)
    check()
    if (freshStory) this.currentStory = freshStory
    ui.clearGenerationCaches()
    ui.clearSuggestions(storyId)
    clearTier3SelectionCache()
    clearImageMarkerCache()
    this.postDeleteCleanup()
  }

  private async truncateFromConfirmedRebuild(
    entry: StoryEntry,
    snapshot: WorldStateSnapshot,
    settingsValue: StorySettings,
    preserved?: StoryEntry,
  ): Promise<void> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    const { storyId, branchId, check } = this.captureWriteScope()
    const scopeParams = [storyId, branchId]
    await database.collectAtomicWrites(async (writer) => {
      writer.stageAtomicStatements([
        {
          sql: 'DELETE FROM characters WHERE story_id = ? AND branch_id IS ?',
          params: scopeParams,
        },
        { sql: 'DELETE FROM locations WHERE story_id = ? AND branch_id IS ?', params: scopeParams },
        { sql: 'DELETE FROM items WHERE story_id = ? AND branch_id IS ?', params: scopeParams },
        {
          sql: 'DELETE FROM story_beats WHERE story_id = ? AND branch_id IS ?',
          params: scopeParams,
        },
      ])
      for (const value of snapshot.charactersSnapshot) await writer.addCharacter(value)
      for (const value of snapshot.locationsSnapshot) await writer.addLocation(value)
      for (const value of snapshot.itemsSnapshot) await writer.addItem(value)
      for (const value of snapshot.storyBeatsSnapshot) await writer.addStoryBeat(value)
      if (snapshot.timeTrackerSnapshot) {
        await writer.saveTimeTracker(storyId, snapshot.timeTrackerSnapshot)
      } else {
        await writer.clearTimeTracker(storyId)
      }
      writer.stageAtomicStatements(
        collaborativeTruncationPlanStatements({
          scope: { storyId, branchId },
          fromPosition: entry.position,
          plan: {
            entries: [],
            operations: [],
            targetCurrentLocationId: undefined,
            targetTimeTracker: undefined,
          },
          updatedAt: Date.now(),
          settings: settingsValue,
          preservedEntryId: preserved?.id,
        }),
      )
      if (preserved) await writer.updateStoryEntry(preserved.id, preserved)
    })
    check()
    await this.reloadEntriesForCurrentBranch()
    const freshStory = await database.getStory(storyId)
    if (freshStory) this.currentStory = freshStory
    ui.clearGenerationCaches()
    ui.clearSuggestions(storyId)
    clearTier3SelectionCache()
    clearImageMarkerCache()
    this.postDeleteCleanup()
  }

  /**
   * Undo a narration and the world state its classification applied, so it can be
   * regenerated from the same user action.
   *
   * Distinct from `deleteEntry`, whose rollback is gated on the `rollbackOnDelete`
   * preference: that flag is about what a *manual* delete should do, and answering "no"
   * to it does not mean the user wants a regenerate to stack a second set of world state
   * changes on top of the first. Undoing is intrinsic to regenerating, so it is not
   * optional here.
   *
   * How much can actually be undone depends on what was recorded:
   * - With `stateTracking` on, the entry carries a `worldStateDelta` and
   *   `rollbackFromPosition` reverses created/updated entities and the time tracker.
   * - Without it there is no delta and entity changes are unrecoverable -- but the time
   *   tracker still is, from the entry's own `metadata.timeStart`, captured in `addEntry`
   *   when the narration was appended and therefore *before* its classification ran
   *   `applyTimeProgression`. That progression is applied unconditionally, so leaving it
   *   in place would advance story time twice for one user action.
   *
   * Returns what was reversed so the caller can tell the user what it could not undo.
   */
  async undoNarrationForRegenerate(
    entryId: string,
    options?: { preserveEntry?: boolean },
  ): Promise<{ entitiesUndone: boolean; timeUndone: boolean }> {
    if (!this.currentStory) throw new Error('No story loaded')
    await this.drainClassificationWrites()
    this.assertNotBusy('regenerate')

    const entry = this.entries.find((e) => e.id === entryId)
    if (!entry) throw new Error('Entry not found')
    if (entry.type !== 'narration') throw new Error('Only a narration entry can be regenerated')

    const collaborative = isCollaborativeStory(this.currentStory)
    if (collaborative) {
      let preserved: StoryEntry | undefined
      if (options?.preserveEntry) {
        const set = this.variantSetForEntry(entry)
        const active = set.variants.find((variant) => variant.id === set.activeVariantId)
        if (!active) throw new Error('找不到当前正文版本。')
        const metadata = { ...entry.metadata }
        delete metadata.variantSet
        const status = metadata.collaborativeStateMaintenance?.status
        metadata.timeEnd = entry.worldStateDelta?.previousState.timeTracker ??
          metadata.timeStart ?? {
            years: 0,
            days: 0,
            hours: 0,
            minutes: 0,
          }
        active.classificationResult =
          status === 'applied'
            ? ((entry.worldStateDelta?.classificationResult as ClassificationResult | undefined) ??
              active.classificationResult)
            : (active.classificationResult ?? null)
        if (status !== 'disabled' && status !== 'no_changes') {
          metadata.collaborativeStateMaintenance = createStateMaintenanceRecord('failed', {
            error: '重写准备已撤销此版本的事实状态；若重写中断，可恢复原版本或单独重试提取。',
          })
        }
        Object.assign(active, {
          content: entry.content,
          reasoning: entry.reasoning,
          translatedContent: entry.translatedContent,
          translationLanguage: entry.translationLanguage,
          suggestedActions: entry.suggestedActions,
          state: metadata.collaborativeStateMaintenance?.status === 'failed' ? 'pending' : 'stored',
          metadata,
          worldStateDelta: null,
        })
        preserved = this.mirrorVariant(entry, set)
      }
      this._isRetryInProgress = true
      try {
        await this.truncateCollaborativeBranchFrom(entryId, preserved)
      } finally {
        this._isRetryInProgress = false
      }
      return { entitiesUndone: true, timeUndone: true }
    }

    // Must be the very last entry, not merely the last *narration*: regenerating one with
    // a trailing user_action after it would append the new narration below that action,
    // leaving it answering an earlier prompt than the one it sits under.
    if (this.entries[this.entries.length - 1]?.id !== entryId) {
      throw new Error('Only the last entry in the story can be regenerated')
    }

    const currentBranchId = this.currentStory.currentBranchId
    if ((entry.branchId ?? null) !== currentBranchId) {
      throw new Error('Cannot regenerate an entry inherited from another branch')
    }

    const branchUsingEntry = this.branches.find((b) => b.forkEntryId === entryId)
    if (branchUsingEntry) {
      throw new Error(
        `Cannot regenerate this entry because it is the fork point for branch "${branchUsingEntry.name}".`,
      )
    }

    this.assertNoBranchForkAtOrAfter(entry.position)

    let entitiesUndone = false
    let timeUndone = false

    try {
      const summary = await rollbackService.rollbackFromPosition(
        this.currentStory.id,
        currentBranchId ?? null,
        entry.position,
        this.entries,
      )
      log('Regenerate rollback summary:', summary)
      entitiesUndone = summary.entriesWithDelta > 0
      timeUndone = summary.restoredTimeTracker
    } catch (error) {
      // Never delete the narration after an incomplete rollback.
      throw error
    }

    // Fallback for the no-delta case, and for a delta that recorded no time tracker.
    if (!timeUndone && entry.metadata?.timeStart) {
      await this.restoreTimeTrackerSnapshot(entry.metadata.timeStart)
      timeUndone = true
    }

    // Cascade-delete rather than removing the one entry: this also clears chapters whose
    // start/end reference it, which the single-entry path does not.
    await this.deleteEntriesFromPosition(entry.position, { skipRollback: true })
    await this.reloadEntriesForCurrentBranch()

    const freshStory = await database.getStory(this.currentStory.id)
    if (freshStory) {
      this.currentStory = { ...this.currentStory, timeTracker: freshStory.timeTracker }
    }

    this.postDeleteCleanup()

    return { entitiesUndone, timeUndone }
  }

  /**
   * Update an entry's timeEnd metadata after classification applies time progression.
   * Called after applyClassificationResult to record the story time after the entry's events.
   */
  async updateEntryTimeEnd(entryId: string, options?: ScopedWriteOptions): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { check } = this.captureWriteScope(options)

    const entry = this.entries.find((e) => e.id === entryId)
    if (!entry) {
      log('updateEntryTimeEnd: Entry not found', entryId)
      return
    }

    // Capture current story time as timeEnd
    const timeEnd = this.currentStory.timeTracker
      ? { ...this.currentStory.timeTracker }
      : { years: 0, days: 0, hours: 0, minutes: 0 }

    const updatedMetadata = { ...entry.metadata, timeEnd }

    await database.updateStoryEntry(entryId, { metadata: updatedMetadata })
    check()
    this.entries = this.entries.map((e) =>
      e.id === entryId ? { ...e, metadata: updatedMetadata } : e,
    )

    log('Entry timeEnd updated', { entryId, timeEnd })
  }

  /**
   * Update an entry's reasoning content and persist to database.
   */
  async updateEntryReasoning(entryId: string, reasoning: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === entryId)
    if (!entry) return

    const existingVariants = entry.metadata?.variantSet
    if (existingVariants?.variants?.length) {
      const nextSet: StoryEntryVariantSet = {
        ...this.variantSetForEntry(entry),
        variants: existingVariants.variants.map((variant) =>
          variant.id === existingVariants.activeVariantId ? { ...variant, reasoning } : variant,
        ),
      }
      const mirrored = this.mirrorVariant(entry, nextSet)
      this.entries = this.entries.map((e) => (e.id === entryId ? mirrored : e))
      await database.updateStoryEntry(entryId, {
        reasoning: mirrored.reasoning,
        metadata: mirrored.metadata,
      })
      return
    }

    // Update in-memory state
    this.entries = this.entries.map((e) => (e.id === entryId ? { ...e, reasoning } : e))

    // Persist to database
    await database.updateStoryEntry(entryId, { reasoning })
  }

  /**
   * Refresh a single entry from the database to pick up changes made directly.
   * Used when background processes update entries (e.g., translation).
   */
  async refreshEntry(entryId: string): Promise<void> {
    const updatedEntry = await database.getStoryEntry(entryId)
    if (!updatedEntry) return

    // Update in-memory state
    this.entries = this.entries.map((e) => (e.id === entryId ? updatedEntry : e))
  }

  /**
   * Update the current background image for the story and persist to database.
   */
  async updateCurrentBackgroundImage(imageData: string | null): Promise<void> {
    if (!this.currentStory) return

    log('Updating background image...', { hasData: !!imageData })
    this.currentBgImage = imageData

    // Keep the currentStory object in sync to prevent any potential inconsistency
    if (this.currentStory) {
      this.currentStory.currentBgImage = imageData
    }

    await database.saveBackground(
      this.currentStory.id,
      this.currentStory.currentBranchId,
      null,
      imageData,
    )
    log('Background image updated and persisted')
  }

  /**
   * Refresh world state (characters, locations, items, story beats) from the database.
   * Used when background processes update translations.
   */
  async refreshWorldState(): Promise<void> {
    if (!this.currentStory) return

    const storyId = this.currentStory.id
    const branchId = this.currentStory.currentBranchId

    let characters: Character[]
    let locations: Location[]
    let items: Item[]
    let storyBeats: StoryBeat[]

    if (branchId && settings.experimentalFeatures.lightweightBranches) {
      const currentBranch = this.branches.find((b) => b.id === branchId)
      if (currentBranch?.snapshotComplete) {
        // Snapshot isolation: branch has its own complete entity set
        ;[characters, locations, items, storyBeats] = await Promise.all([
          database.getCharactersForBranch(storyId, branchId),
          database.getLocationsForBranch(storyId, branchId),
          database.getItemsForBranch(storyId, branchId),
          database.getStoryBeatsForBranch(storyId, branchId),
        ])
      } else {
        // Legacy COW: resolve through lineage (pre-snapshot branches)
        const lineage = this.buildBranchLineage(branchId)
        ;[characters, locations, items, storyBeats] = await Promise.all([
          database.getCharactersResolved(storyId, lineage),
          database.getLocationsResolved(storyId, lineage),
          database.getItemsResolved(storyId, lineage),
          database.getStoryBeatsResolved(storyId, lineage),
        ])
      }
    } else if (branchId) {
      // Legacy branch: direct loading
      ;[characters, locations, items, storyBeats] = await Promise.all([
        database.getCharactersForBranch(storyId, branchId),
        database.getLocationsForBranch(storyId, branchId),
        database.getItemsForBranch(storyId, branchId),
        database.getStoryBeatsForBranch(storyId, branchId),
      ])
    } else {
      // Main branch — only load entities with null branch_id
      ;[characters, locations, items, storyBeats] = await Promise.all([
        database.getCharactersForBranch(storyId, null),
        database.getLocationsForBranch(storyId, null),
        database.getItemsForBranch(storyId, null),
        database.getStoryBeatsForBranch(storyId, null),
      ])
    }

    this.characters = characters
    this.locations = locations
    this.items = items
    this.storyBeats = storyBeats

    // Filter out tombstoned entities when COW is enabled
    // (COW resolution already handles this for branch paths, but main branch loads raw data)
    if (settings.experimentalFeatures.lightweightBranches) {
      this.characters = this.characters.filter((c) => !c.deleted)
      this.locations = this.locations.filter((l) => !l.deleted)
      this.items = this.items.filter((i) => !i.deleted)
      this.storyBeats = this.storyBeats.filter((b) => !b.deleted)
    }

    log('World state refreshed', {
      characters: characters.length,
      locations: locations.length,
      items: items.length,
      storyBeats: storyBeats.length,
    })
  }

  /**
   * Delete all entries from a given position onward.
   * Used for entry-only retry restore (persistent retry).
   */
  async deleteEntriesFromPosition(
    position: number,
    options?: { skipRollback?: boolean },
  ): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { storyId, branchId, check } = this.captureWriteScope()
    const currentStory = this.currentStory
    await this.drainClassificationWrites()
    check()

    this.assertNoBranchForkAtOrAfter(position)
    // Capture after draining so rollback includes the classification's persisted delta.
    const entries = [...this.entries]
    const chapters = [...this.chapters]
    const entriesToDelete = entries.filter((e) => e.position >= position)
    const entryIdsToDelete = new Set(entriesToDelete.map((e) => e.id))
    const chaptersToDelete = chapters.filter(
      (ch) => entryIdsToDelete.has(ch.startEntryId) || entryIdsToDelete.has(ch.endEntryId),
    )
    const droppedCheckpoints = this.checkpointsAnchoredTo(entryIdsToDelete)

    const collaborative = isCollaborativeStory(currentStory)
    if (collaborative && !options?.skipRollback) {
      const firstEntry = entries.find((entry) => entry.position >= position)
      if (firstEntry) {
        await this.truncateCollaborativeBranchFrom(firstEntry.id)
        return
      }
    }

    // Phase 2: Rollback world state before deleting entries
    // Skip if caller already performed rollback (e.g. deleteEntry)
    const rollbackEnabled =
      !options?.skipRollback &&
      ((settings.experimentalFeatures.stateTracking &&
        settings.experimentalFeatures.rollbackOnDelete) ||
        isCollaborativeStory(currentStory))

    if (rollbackEnabled) {
      try {
        const rollbackSummary = await rollbackService.rollbackFromPosition(
          storyId,
          branchId,
          position,
          entries,
        )
        check()
        log('Rollback before deleteEntriesFromPosition:', rollbackSummary)
      } catch (error) {
        console.error('[StoryStore] Rollback failed; refusing to delete entries:', error)
        throw error
      }
    }

    log('Deleting entries from position', {
      position,
      entriesToDelete: entriesToDelete.length,
      totalEntries: entries.length,
    })

    log('Deleting entries and the rows that reference them', {
      chaptersToDelete: chaptersToDelete.length,
      chapterNumbers: chaptersToDelete.map((ch) => ch.number),
      checkpointsToDelete: droppedCheckpoints.length,
    })

    await database.deleteEntriesWithDependents({
      entryIds: Array.from(entryIdsToDelete),
      chapterIds: chaptersToDelete.map((ch) => ch.id),
      checkpointIds: droppedCheckpoints.map((cp) => cp.id),
    })
    check()

    this.chapters = chapters.filter((ch) => !chaptersToDelete.some((d) => d.id === ch.id))
    this.forgetCheckpoints(droppedCheckpoints)

    // Update in-memory state
    this.entries = entries.filter((e) => e.position < position)

    // Invalidate caches
    this.invalidateWordCountCache()
    this.invalidateChapterCache()

    // Update story's updatedAt
    await database.updateStory(storyId, {})
    check()

    // Restore suggested actions from the new last narration entry
    this.restoreSuggestedActionsAfterDelete()
  }

  /**
   * Delete entities that were created after the backup.
   * Used for persistent retry restore to remove AI-extracted entities.
   * Compares current entity IDs against the saved ID lists and deletes any not in the lists.
   * NOTE: Lorebook entries are NOT included as they are independent of retry operations
   * (they are based on permanent chapters, not current chat).
   */
  async deleteEntitiesCreatedAfterBackup(savedIds: {
    characterIds: string[]
    locationIds: string[]
    itemIds: string[]
    storyBeatIds: string[]
    embeddedImageIds?: string[]
  }): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const characterIdsSet = new Set(savedIds.characterIds)
    const locationIdsSet = new Set(savedIds.locationIds)
    const itemIdsSet = new Set(savedIds.itemIds)
    const storyBeatIdsSet = new Set(savedIds.storyBeatIds)
    const embeddedImageIdsSet = new Set(savedIds.embeddedImageIds ?? [])

    // Find entities to delete (not in saved lists)
    const charactersToDelete = this.characters.filter((c) => !characterIdsSet.has(c.id))
    const locationsToDelete = this.locations.filter((l) => !locationIdsSet.has(l.id))
    const itemsToDelete = this.items.filter((i) => !itemIdsSet.has(i.id))
    const storyBeatsToDelete = this.storyBeats.filter((sb) => !storyBeatIdsSet.has(sb.id))

    // Embedded images are not in memory - fetch from database to find ones to delete
    // Note: Many embedded images may already be deleted via CASCADE when entries are deleted
    const currentEmbeddedImages = await database.getEmbeddedImageMetaForStory(this.currentStory.id)
    const embeddedImagesToDelete = savedIds.embeddedImageIds
      ? currentEmbeddedImages.filter((ei) => !embeddedImageIdsSet.has(ei.id))
      : []

    log('Deleting entities created after backup', {
      characters: charactersToDelete.length,
      locations: locationsToDelete.length,
      items: itemsToDelete.length,
      storyBeats: storyBeatsToDelete.length,
      embeddedImages: embeddedImagesToDelete.length,
    })

    // Delete from database (batched: one query per entity type, not one per id)
    await database.deleteCharacters(charactersToDelete.map((c) => c.id))
    await database.deleteLocations(locationsToDelete.map((l) => l.id))
    await database.deleteItems(itemsToDelete.map((i) => i.id))
    await database.deleteStoryBeats(storyBeatsToDelete.map((sb) => sb.id))
    await database.deleteEmbeddedImages(embeddedImagesToDelete.map((ei) => ei.id))

    // Update in-memory state
    this.characters = this.characters.filter((c) => characterIdsSet.has(c.id))
    this.locations = this.locations.filter((l) => locationIdsSet.has(l.id))
    this.items = this.items.filter((i) => itemIdsSet.has(i.id))
    this.storyBeats = this.storyBeats.filter((sb) => storyBeatIdsSet.has(sb.id))

    // Update story's updatedAt
    await database.updateStory(this.currentStory.id, {})
  }

  // ===== COW (Copy-on-Write) Branch Helpers =====

  /**
   * Check if we're currently on a COW-enabled branch.
   * Returns true if on a non-main branch with lightweightBranches enabled.
   */
  private isCowBranch(): boolean {
    return !!this.currentStory?.currentBranchId && settings.experimentalFeatures.lightweightBranches
  }

  /**
   * Ensure a character is owned by the current branch (COW).
   * If the character is inherited from a parent branch, creates an override.
   * Returns the owned character (either the original or the new override).
   */
  private async cowCharacter(
    entity: Character,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<{ entity: Character; wasCowed: boolean }> {
    const { branchId, check } = this.captureWriteScope(options)
    if (
      !branchId ||
      entity.branchId === branchId ||
      !settings.experimentalFeatures.lightweightBranches
    ) {
      return { entity, wasCowed: false }
    }

    const override: Character = {
      ...entity,
      id: crypto.randomUUID(),
      branchId,
      overridesId: entity.overridesId ?? entity.id,
    }
    await writeDatabase.addCharacter(override)
    check()
    this.characters = this.characters.map((c) => (c.id === entity.id ? override : c))
    log(
      'COW: Created character override',
      override.name,
      override.id,
      '→ overrides',
      override.overridesId,
    )
    return { entity: override, wasCowed: true }
  }

  /**
   * Ensure a location is owned by the current branch (COW).
   */
  private async cowLocation(
    entity: Location,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<{ entity: Location; wasCowed: boolean }> {
    const { branchId, check } = this.captureWriteScope(options)
    if (
      !branchId ||
      entity.branchId === branchId ||
      !settings.experimentalFeatures.lightweightBranches
    ) {
      return { entity, wasCowed: false }
    }

    const override: Location = {
      ...entity,
      id: crypto.randomUUID(),
      branchId,
      overridesId: entity.overridesId ?? entity.id,
    }
    await writeDatabase.addLocation(override)
    check()
    this.locations = this.locations.map((l) => (l.id === entity.id ? override : l))
    log(
      'COW: Created location override',
      override.name,
      override.id,
      '→ overrides',
      override.overridesId,
    )
    return { entity: override, wasCowed: true }
  }

  /**
   * Ensure an item is owned by the current branch (COW).
   */
  private async cowItem(
    entity: Item,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<{ entity: Item; wasCowed: boolean }> {
    const { branchId, check } = this.captureWriteScope(options)
    if (
      !branchId ||
      entity.branchId === branchId ||
      !settings.experimentalFeatures.lightweightBranches
    ) {
      return { entity, wasCowed: false }
    }

    const override: Item = {
      ...entity,
      id: crypto.randomUUID(),
      branchId,
      overridesId: entity.overridesId ?? entity.id,
    }
    await writeDatabase.addItem(override)
    check()
    this.items = this.items.map((i) => (i.id === entity.id ? override : i))
    log(
      'COW: Created item override',
      override.name,
      override.id,
      '→ overrides',
      override.overridesId,
    )
    return { entity: override, wasCowed: true }
  }

  /**
   * Ensure a story beat is owned by the current branch (COW).
   */
  private async cowStoryBeat(
    entity: StoryBeat,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<{ entity: StoryBeat; wasCowed: boolean }> {
    const { branchId, check } = this.captureWriteScope(options)
    if (
      !branchId ||
      entity.branchId === branchId ||
      !settings.experimentalFeatures.lightweightBranches
    ) {
      return { entity, wasCowed: false }
    }

    const override: StoryBeat = {
      ...entity,
      id: crypto.randomUUID(),
      branchId,
      overridesId: entity.overridesId ?? entity.id,
    }
    await writeDatabase.addStoryBeat(override)
    check()
    this.storyBeats = this.storyBeats.map((b) => (b.id === entity.id ? override : b))
    log(
      'COW: Created story beat override',
      override.title,
      override.id,
      '→ overrides',
      override.overridesId,
    )
    return { entity: override, wasCowed: true }
  }

  /**
   * Ensure a lorebook entry is owned by the current branch (COW).
   */
  private async cowLorebookEntry(entity: Entry): Promise<{ entity: Entry; wasCowed: boolean }> {
    const branchId = this.currentStory?.currentBranchId
    if (
      !branchId ||
      entity.branchId === branchId ||
      !settings.experimentalFeatures.lightweightBranches
    ) {
      return { entity, wasCowed: false }
    }

    const now = Date.now()
    const override: Entry = {
      ...entity,
      id: crypto.randomUUID(),
      branchId,
      overridesId: entity.overridesId ?? entity.id,
      updatedAt: now,
    }
    await database.addEntry(override)
    this.lorebookEntries = this.lorebookEntries.map((e) => (e.id === entity.id ? override : e))
    log(
      'COW: Created lorebook entry override',
      override.name,
      override.id,
      '→ overrides',
      override.overridesId,
    )
    return { entity: override, wasCowed: true }
  }

  // Add a character
  async addCharacter(
    name: string,
    description?: string,
    relationship?: string,
  ): Promise<Character> {
    if (!this.currentStory) throw new Error('No story loaded')

    const character: Character = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      name,
      description: description ?? null,
      relationship: relationship ?? null,
      traits: [],
      status: 'active',
      metadata: null,
      visualDescriptors: {},
      portrait: null,
      branchId: this.currentStory.currentBranchId,
    }

    await database.addCharacter(character)
    this.characters = [...this.characters, character]
    return character
  }

  // Update an existing character (except protagonist swap)
  async updateCharacter(id: string, updates: Partial<Character>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.characters.find((c) => c.id === id)
    if (!existing) throw new Error('Character not found')

    if (updates.relationship !== undefined) {
      if (updates.relationship === 'self' && existing.relationship !== 'self') {
        throw new Error('Use setProtagonist to assign a protagonist')
      }
      if (existing.relationship === 'self' && updates.relationship !== 'self') {
        throw new Error('Swap protagonists before changing the current one')
      }
    }

    // COW: ensure entity is owned by current branch before updating
    const { entity: owned } = await this.cowCharacter(existing)
    await database.updateCharacter(owned.id, updates)
    this.characters = this.characters.map((c) => (c.id === owned.id ? { ...c, ...updates } : c))
  }

  // Delete a character (protagonist cannot be deleted)
  async deleteCharacter(id: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.characters.find((c) => c.id === id)
    if (!existing) throw new Error('Character not found')
    if (existing.relationship === 'self') {
      throw new Error('Swap protagonists before deleting the current one')
    }

    if (settings.experimentalFeatures.lightweightBranches) {
      // COD: tombstone instead of hard-deleting to preserve row for sibling/child branches
      if (existing.branchId === this.currentStory.currentBranchId) {
        // Entity is owned by current branch (or main) — mark deleted in place
        await database.markCharacterDeleted(id)
      } else {
        // Entity is inherited from another branch — create tombstone override
        const { entity: owned } = await this.cowCharacter(existing)
        await database.markCharacterDeleted(owned.id)
      }
    } else {
      await database.deleteCharacter(id)
    }
    this.characters = this.characters.filter((c) => c.id !== id)
  }

  // Add a location
  async addLocation(name: string, description?: string, makeCurrent = false): Promise<Location> {
    if (!this.currentStory) throw new Error('No story loaded')

    const location: Location = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      name,
      description: description ?? null,
      visited: makeCurrent,
      current: makeCurrent,
      connections: [],
      metadata: null,
      branchId: this.currentStory.currentBranchId,
    }

    await database.addLocation(location)

    if (makeCurrent) {
      // Update other locations to not be current
      this.locations = this.locations.map((l) => ({ ...l, current: false }))
    }

    this.locations = [...this.locations, location]
    return location
  }

  // Update a location's details
  async updateLocation(id: string, updates: Partial<Location>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.locations.find((l) => l.id === id)
    if (!existing) throw new Error('Location not found')

    // COW: ensure entity is owned by current branch before updating
    const { entity: owned } = await this.cowLocation(existing)

    if (updates.current === true) {
      if (this.isCowBranch()) {
        // COW-aware: targeted updates instead of blanket clear
        const prevCurrent = this.locations.find((l) => l.current && l.id !== owned.id)
        if (prevCurrent) {
          const { entity: ownedPrev } = await this.cowLocation(prevCurrent)
          await database.updateLocation(ownedPrev.id, { current: false })
          this.locations = this.locations.map((l) =>
            l.id === ownedPrev.id ? { ...l, current: false } : l,
          )
        }
        await database.updateLocation(owned.id, { ...updates, visited: true })
        this.locations = this.locations.map((l) =>
          l.id === owned.id ? { ...l, ...updates, current: true, visited: true } : l,
        )
      } else {
        await database.setCurrentLocation(this.currentStory.id, owned.id)
        this.locations = this.locations.map((l) => ({
          ...l,
          current: l.id === owned.id,
          visited: l.id === owned.id ? true : l.visited,
        }))
      }
    } else {
      await database.updateLocation(owned.id, updates)
      this.locations = this.locations.map((l) => (l.id === owned.id ? { ...l, ...updates } : l))
    }
  }

  // Set current location
  async setCurrentLocation(locationId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    if (this.isCowBranch()) {
      // COW-aware: targeted updates instead of blanket clear
      const target = this.locations.find((l) => l.id === locationId)
      const prevCurrent = this.locations.find((l) => l.current && l.id !== locationId)

      if (target) {
        const { entity: ownedTarget } = await this.cowLocation(target)
        await database.updateLocation(ownedTarget.id, { current: true, visited: true })
        this.locations = this.locations.map((l) =>
          l.id === ownedTarget.id ? { ...l, current: true, visited: true } : l,
        )
      }
      if (prevCurrent) {
        const { entity: ownedPrev } = await this.cowLocation(prevCurrent)
        await database.updateLocation(ownedPrev.id, { current: false })
        this.locations = this.locations.map((l) =>
          l.id === ownedPrev.id ? { ...l, current: false } : l,
        )
      }
    } else {
      await database.setCurrentLocation(this.currentStory.id, locationId)
      this.locations = this.locations.map((l) => ({
        ...l,
        current: l.id === locationId,
        visited: l.id === locationId ? true : l.visited,
      }))
    }
  }

  // Toggle location visited status
  async toggleLocationVisited(locationId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const location = this.locations.find((l) => l.id === locationId)
    if (!location) throw new Error('Location not found')

    const newVisited = !location.visited
    await database.updateLocation(locationId, { visited: newVisited })
    this.locations = this.locations.map((l) =>
      l.id === locationId ? { ...l, visited: newVisited } : l,
    )
    log('Location visited toggled:', location.name, newVisited)
  }

  // Delete a location
  async deleteLocation(locationId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const location = this.locations.find((l) => l.id === locationId)
    if (!location) throw new Error('Location not found')

    if (settings.experimentalFeatures.lightweightBranches) {
      if (location.branchId === this.currentStory.currentBranchId) {
        await database.markLocationDeleted(locationId)
      } else {
        const { entity: owned } = await this.cowLocation(location)
        await database.markLocationDeleted(owned.id)
      }
    } else {
      await database.deleteLocation(locationId)
    }
    this.locations = this.locations.filter((l) => l.id !== locationId)
    log('Location deleted:', location.name)
  }

  // Add an item to inventory
  async addItem(name: string, description?: string, quantity = 1): Promise<Item> {
    if (!this.currentStory) throw new Error('No story loaded')

    const item: Item = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      name,
      description: description ?? null,
      quantity,
      equipped: false,
      location: 'inventory',
      metadata: null,
      branchId: this.currentStory.currentBranchId,
    }

    await database.addItem(item)
    this.items = [...this.items, item]
    return item
  }

  // Update an existing item
  async updateItem(id: string, updates: Partial<Item>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.items.find((i) => i.id === id)
    if (!existing) throw new Error('Item not found')

    // COW: ensure entity is owned by current branch before updating
    const { entity: owned } = await this.cowItem(existing)
    await database.updateItem(owned.id, updates)
    this.items = this.items.map((i) => (i.id === owned.id ? { ...i, ...updates } : i))
  }

  // Delete an item
  async deleteItem(id: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.items.find((i) => i.id === id)
    if (!existing) throw new Error('Item not found')

    if (settings.experimentalFeatures.lightweightBranches) {
      if (existing.branchId === this.currentStory.currentBranchId) {
        await database.markItemDeleted(id)
      } else {
        const { entity: owned } = await this.cowItem(existing)
        await database.markItemDeleted(owned.id)
      }
    } else {
      await database.deleteItem(id)
    }
    this.items = this.items.filter((i) => i.id !== id)
  }

  // Add a story beat
  async addStoryBeat(
    title: string,
    type: StoryBeat['type'],
    description?: string,
  ): Promise<StoryBeat> {
    if (!this.currentStory) throw new Error('No story loaded')

    const beat: StoryBeat = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      title,
      description: description ?? null,
      type,
      status: 'pending',
      triggeredAt: null,
      resolvedAt: null,
      metadata: null,
      branchId: this.currentStory.currentBranchId,
    }

    await database.addStoryBeat(beat)
    this.storyBeats = [...this.storyBeats, beat]
    return beat
  }

  // Update a story beat
  async updateStoryBeat(id: string, updates: Partial<StoryBeat>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.storyBeats.find((b) => b.id === id)
    if (!existing) throw new Error('Story beat not found')

    const resolvedUpdates: Partial<StoryBeat> = { ...updates }
    if (updates.status) {
      if (updates.status === 'completed' || updates.status === 'failed') {
        if (updates.resolvedAt === undefined) {
          resolvedUpdates.resolvedAt = Date.now()
        }
      } else if (updates.resolvedAt === undefined) {
        resolvedUpdates.resolvedAt = null
      }
    }

    // COW: ensure entity is owned by current branch before updating
    const { entity: owned } = await this.cowStoryBeat(existing)
    await database.updateStoryBeat(owned.id, resolvedUpdates)
    this.storyBeats = this.storyBeats.map((b) =>
      b.id === owned.id ? { ...b, ...resolvedUpdates } : b,
    )
  }

  // Delete a story beat
  async deleteStoryBeat(id: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.storyBeats.find((b) => b.id === id)
    if (!existing) throw new Error('Story beat not found')

    if (settings.experimentalFeatures.lightweightBranches) {
      if (existing.branchId === this.currentStory.currentBranchId) {
        await database.markStoryBeatDeleted(id)
      } else {
        const { entity: owned } = await this.cowStoryBeat(existing)
        await database.markStoryBeatDeleted(owned.id)
      }
    } else {
      await database.deleteStoryBeat(id)
    }
    this.storyBeats = this.storyBeats.filter((b) => b.id !== id)
  }

  // Swap the protagonist to another character, updating the old label
  async setProtagonist(newCharacterId: string, previousRelationshipLabel?: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const currentProtagonist = this.characters.find((c) => c.relationship === 'self') ?? null
    const newProtagonist = this.characters.find((c) => c.id === newCharacterId)
    if (!newProtagonist) throw new Error('Character not found')

    if (currentProtagonist?.id === newCharacterId) return

    let label: string | null = null
    if (currentProtagonist) {
      label = previousRelationshipLabel?.trim() ?? null
      if (!label || label.toLowerCase() === 'self') {
        throw new Error('Provide a relationship label for the previous protagonist')
      }
      // COW: ensure old protagonist is owned by current branch
      const { entity: ownedOld } = await this.cowCharacter(currentProtagonist)
      await database.updateCharacter(ownedOld.id, { relationship: label })
    }

    // COW: ensure new protagonist is owned by current branch
    const { entity: ownedNew } = await this.cowCharacter(newProtagonist)
    await database.updateCharacter(ownedNew.id, { relationship: 'self' })

    this.characters = this.characters.map((c) => {
      if (
        currentProtagonist &&
        (c.overridesId === currentProtagonist.overridesId ||
          c.overridesId === currentProtagonist.id ||
          c.id === currentProtagonist.id)
      ) {
        // Find the current in-memory version that replaced the old protagonist
        if (c.relationship !== 'self') return c
        return { ...c, relationship: label! }
      }
      if (c.id === ownedNew.id) {
        return { ...c, relationship: 'self' }
      }
      return c
    })
  }

  // ===== Lorebook Entry CRUD Methods =====

  private invalidateRetrievalCache() {
    ui.setLastRetrievalResult(null)
  }

  /**
   * Add a new lorebook entry.
   * @param entryData - Entry data. branchId is optional and defaults to current branch.
   */
  async addLorebookEntry(
    entryData: Omit<Entry, 'id' | 'storyId' | 'createdAt' | 'updatedAt' | 'branchId'> & {
      id?: string
      branchId?: string | null
    },
  ): Promise<Entry> {
    if (!this.currentStory) throw new Error('No story loaded')

    const now = Date.now()
    const entry: Entry = {
      ...entryData,
      id: entryData.id ?? crypto.randomUUID(),
      storyId: this.currentStory.id,
      createdAt: now,
      updatedAt: now,
      // Use provided branchId or default to current branch
      branchId: entryData.branchId ?? this.currentStory.currentBranchId,
    }

    await database.addEntry(entry)
    this.lorebookEntries = [...this.lorebookEntries, entry]
    this.invalidateRetrievalCache()
    log('Lorebook entry added:', entry.name)
    return entry
  }

  async addLorebookEntries(
    entriesData: Omit<Entry, 'id' | 'storyId' | 'createdAt' | 'updatedAt' | 'branchId'>[],
  ): Promise<number> {
    if (!this.currentStory) throw new Error('No story loaded')
    if (entriesData.length === 0) return 0

    const now = Date.now()
    const branchId = this.currentStory.currentBranchId
    const storyId = this.currentStory.id
    const entries: Entry[] = entriesData.map((entryData) => ({
      ...entryData,
      id: crypto.randomUUID(),
      storyId,
      createdAt: now,
      updatedAt: now,
      branchId,
    }))

    await database.bulkInsertEntries(entries)
    this.lorebookEntries = [...this.lorebookEntries, ...entries]
    this.invalidateRetrievalCache()
    log('Lorebook entries bulk added:', entries.length)
    return entries.length
  }

  /**
   * Update a lorebook entry.
   */
  async updateLorebookEntry(id: string, updates: Partial<Entry>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const existing = this.lorebookEntries.find((e) => e.id === id)
    if (!existing) throw new Error('Lorebook entry not found')

    // COW: ensure entity is owned by current branch before updating
    const { entity: owned } = await this.cowLorebookEntry(existing)

    const updatesWithTimestamp = {
      ...updates,
      updatedAt: Date.now(),
    }

    await database.updateEntry(owned.id, updatesWithTimestamp)
    this.lorebookEntries = this.lorebookEntries.map((e) =>
      e.id === owned.id ? { ...e, ...updatesWithTimestamp } : e,
    )
    this.invalidateRetrievalCache()
    log('Lorebook entry updated:', owned.id)
  }

  /**
   * Delete a lorebook entry.
   */
  async deleteLorebookEntry(id: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    if (settings.experimentalFeatures.lightweightBranches) {
      const existing = this.lorebookEntries.find((e) => e.id === id)
      if (existing) {
        if (existing.branchId === this.currentStory.currentBranchId) {
          await database.markEntryDeleted(id)
        } else {
          const { entity: owned } = await this.cowLorebookEntry(existing)
          await database.markEntryDeleted(owned.id)
        }
      } else {
        await database.deleteEntry(id)
      }
    } else {
      await database.deleteEntry(id)
    }
    this.lorebookEntries = this.lorebookEntries.filter((e) => e.id !== id)
    this.invalidateRetrievalCache()
    log('Lorebook entry deleted:', id)
  }

  /**
   * Delete multiple lorebook entries (bulk operation).
   */
  async deleteLorebookEntries(ids: string[]): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    if (settings.experimentalFeatures.lightweightBranches) {
      // COD: process each entry individually for correct tombstone handling
      for (const id of ids) {
        const existing = this.lorebookEntries.find((e) => e.id === id)
        if (existing) {
          if (existing.branchId === this.currentStory.currentBranchId) {
            await database.markEntryDeleted(id)
          } else {
            const { entity: owned } = await this.cowLorebookEntry(existing)
            await database.markEntryDeleted(owned.id)
          }
        } else {
          await database.deleteEntry(id)
        }
      }
    } else {
      await Promise.all(ids.map((id) => database.deleteEntry(id)))
    }
    this.lorebookEntries = this.lorebookEntries.filter((e) => !ids.includes(e.id))
    this.invalidateRetrievalCache()
    log('Lorebook entries deleted:', ids.length)
  }

  /**
   * Get a single lorebook entry by ID.
   */
  getLorebookEntry(id: string): Entry | undefined {
    return this.lorebookEntries.find((e) => e.id === id)
  }

  /**
   * Helper to wrap entity updates in try-catch with toast notifications.
   * Prevents database errors from breaking the entire classification pipeline.
   */
  private classificationErrors = 0

  private async wrapUpdate(label: string, entityName: string, fn: () => Promise<void>) {
    try {
      await fn()
      this.classificationErrors = 0
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      this.classificationErrors++
      console.error(`[StoryStore] ${label} failed for ${entityName}:`, err)
      ui.showToast(`${label} failed: ${entityName}`, 'warning')
      if (this.classificationErrors >= 3) {
        const count = this.classificationErrors
        this.classificationErrors = 0
        throw new Error(`Classification pipeline aborted after ${count} consecutive failures`)
      }
    }
  }

  /**
   * Apply classification results to update world state.
   * This is Phase 4 of the processing pipeline per design doc.
   */
  async applyClassificationResult(
    result: ClassificationResult,
    entryId?: string,
    options?: ScopedWriteOptions,
  ): Promise<void> {
    if (!this.currentStory && !options) return
    const { storyId, branchId, check } = this.captureWriteScope(options)
    const identity = this.captureWriteScope({ scope: { storyId, branchId } })
    assertWriteScopeCurrent(!this.classificationWrite && !this._isRetryInProgress)
    const active = { storyId, branchId, done: Promise.resolve() }
    this.classificationWrite = active
    active.done = Promise.resolve().then(() => {
      check()
      // Once mutation begins, a same-scope stop drains through delta persistence.
      // Navigation still cancels: never refill or continue against another story.
      return this.applyClassificationResultScoped(result, entryId, {
        scope: { storyId, branchId },
        isScopeCurrent: () => {
          identity.check()
          return true
        },
      })
    })
    try {
      await active.done
    } finally {
      if (this.classificationWrite === active) this.classificationWrite = null
    }
  }

  /** Retry fact/state extraction for a saved collaborative narration without regenerating prose. */
  async retryCollaborativeStateExtraction(entryId: string): Promise<void> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    if (!isCollaborativeStory(this.currentStory)) throw new Error('仅中文写作支持单独重试提取。')
    this.assertNotBusy('重试事实与状态提取')
    const { storyId, branchId, check } = this.captureWriteScope()
    const extractionEnabled = () =>
      this.currentStory?.settings?.collaborativeNovelWorkflow?.factStateExtractor?.enabled !== false
    if (!extractionEnabled()) {
      throw new Error('正文事实与状态提取已关闭。')
    }
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.type !== 'narration') throw new Error('找不到可重试的正文。')
    if ((entry.branchId ?? null) !== branchId) {
      throw new Error('继承正文需要使用当前分支的状态重建，不能回写父分支提取记录。')
    }
    if (
      entry.metadata?.collaborativeStateMaintenance?.status !== 'failed' ||
      entry.worldStateDelta
    ) {
      throw new Error('只能重试未应用状态的失败提取；已应用状态需要使用状态重建。')
    }
    const lastNarration = [...this.entries]
      .reverse()
      .find((candidate) => candidate.type === 'narration')
    if (lastNarration?.id !== entry.id) {
      throw new Error('只能直接重试当前末尾正文；更早正文需要使用状态重建。')
    }
    const result = await aiService.classifyResponse(
      entry.content,
      '只从已生成正文提取实际发生的事实。作者意图、未来规划和被否决版本不是事实。',
      this.worldStateSnapshot,
      this.currentStory,
      this.entries.filter(
        (candidate) => candidate.type === 'narration' && candidate.position < entry.position,
      ),
      entry.metadata?.timeStart ?? this.currentStory.timeTracker,
    )
    check()
    this.assertNotBusy('重试事实与状态提取')
    const currentEntry = this.entries.find((candidate) => candidate.id === entry.id)
    assertWriteScopeCurrent(
      isCollaborativeStory(this.currentStory) &&
        extractionEnabled() &&
        currentEntry?.content === entry.content &&
        currentEntry?.metadata?.variantSet?.activeVariantId ===
          entry.metadata?.variantSet?.activeVariantId &&
        currentEntry?.metadata?.collaborativeStateMaintenance?.status === 'failed' &&
        !currentEntry?.worldStateDelta &&
        this.entries.filter((candidate) => candidate.type === 'narration').at(-1)?.id === entry.id,
    )
    await this.applyClassificationResult(result, entry.id, {
      scope: { storyId, branchId },
      isScopeCurrent: () => {
        check()
        return true
      },
    })
    check()
    const refreshed = this.entries.find((candidate) => candidate.id === entry.id)
    if (refreshed?.metadata?.variantSet) {
      await this.updateNarrationVariant(entry.id, {
        classificationResult: result,
        worldStateDelta: refreshed.worldStateDelta,
        metadata: refreshed.metadata,
      })
    }
  }

  async createCollaborativeStateRebuildDraft(
    entryId: string,
  ): Promise<CollaborativeStateRebuildDraft> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    if (
      this.currentStory.settings?.collaborativeNovelWorkflow?.factStateExtractor?.enabled === false
    ) {
      throw new Error('正文事实与状态提取已关闭。')
    }
    const target = this.entries.find((entry) => entry.id === entryId)
    if (!target || target.type !== 'narration') throw new Error('只能重建到已保存的正文。')
    const service = new CollaborativeStateRebuildService((request) =>
      aiService.generateCollaborativeStateRebuild(this.currentStory!.id, request),
    )
    return service.createDraft({
      storyId: this.currentStory.id,
      branchId: this.currentStory.currentBranchId,
      targetEntryId: target.id,
      targetPosition: target.position,
      entries: this.entries,
      storyInitial: {
        title: this.currentStory.title,
        description: this.currentStory.description,
        genre: this.currentStory.genre,
        settings: this.currentStory.settings,
      },
      manualLorebook: this.lorebookEntries.filter((entry) => entry.createdBy !== 'ai'),
      currentState: {
        characters: this.characters,
        locations: this.locations,
        items: this.items,
        storyBeats: this.storyBeats,
        currentLocationId: this.currentLocation?.id ?? null,
        storyTime: this.currentStory.timeTracker,
      },
    })
  }

  /** Confirm an AI-inferred historical snapshot. Preview generation never calls this method. */
  async confirmCollaborativeStateRebuild(draft: CollaborativeStateRebuildDraft): Promise<void> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    await this.drainClassificationWrites()
    this.assertNotBusy('confirm state rebuild')
    const { storyId, branchId, check } = this.captureWriteScope()
    const confirmation = checkCollaborativeStateRebuildConfirmation(draft, {
      storyId,
      branchId,
      targetEntryId: draft.targetEntryId,
      targetPosition: draft.targetPosition,
      entries: this.entries,
      storyInitial: {
        title: this.currentStory.title,
        description: this.currentStory.description,
        genre: this.currentStory.genre,
        settings: this.currentStory.settings,
      },
      manualLorebook: this.lorebookEntries.filter((entry) => entry.createdBy !== 'ai'),
    })
    if (!confirmation.valid) throw new Error('故事或正文历史已变化，重建草稿已失效。')
    if (draft.diff.uncertain.length > 0) throw new Error('候选状态仍有不确定实体，不能确认写入。')
    const target = this.entries.find((entry) => entry.id === draft.targetEntryId)!
    const mapId = new SvelteMap<string, string>()
    const allocate = (id: string | null, name: string) => {
      const key = id ?? `name:${name.normalize('NFKC').trim().toLowerCase()}`
      if (!mapId.has(key)) mapId.set(key, id ?? crypto.randomUUID())
      return mapId.get(key)!
    }
    const characters = draft.candidate.characters.map((value) => ({
      ...value,
      id: allocate(value.id, value.name),
      storyId,
      branchId,
      portrait: null,
    })) as Character[]
    const locations = draft.candidate.locations.map((value) => ({
      ...value,
      id: allocate(value.id, value.name),
      storyId,
      branchId,
      connections: value.connections.map((id) => mapId.get(id) ?? id),
    })) as Location[]
    const items = draft.candidate.items.map((value) => ({
      ...value,
      id: allocate(value.id, value.name),
      storyId,
      branchId,
      location:
        value.location === 'inventory'
          ? 'inventory'
          : (mapId.get(value.location) ?? value.location),
    })) as Item[]
    const storyBeats = draft.candidate.storyBeats.map((value) => ({
      ...value,
      id: allocate(value.id, value.title),
      storyId,
      branchId,
      triggeredAt: value.triggeredAt ?? draft.createdAt,
    })) as StoryBeat[]
    const metadata = {
      ...target.metadata,
      collaborativeStateRebuild: {
        version: 1 as const,
        historyHash: draft.historyHash,
        targetEntryId: target.id,
        rebuiltAt: Date.now(),
        source: 'ai_confirmed' as const,
      },
    }
    const snapshot: WorldStateSnapshot = {
      id: crypto.randomUUID(),
      storyId,
      branchId,
      entryId: target.id,
      entryPosition: target.position,
      charactersSnapshot: characters,
      locationsSnapshot: locations,
      itemsSnapshot: items,
      storyBeatsSnapshot: storyBeats,
      lorebookEntriesSnapshot: this.lorebookEntries.map((entry) => ({ ...entry })),
      timeTrackerSnapshot: draft.candidate.storyTime,
      createdAt: Date.now(),
    }
    check()
    await database.collectAtomicWrites(async (writer) => {
      await writer.createWorldStateSnapshot(snapshot)
      writer.stageAtomicStatements([
        {
          sql: 'UPDATE story_entries SET metadata = ? WHERE id = ? AND story_id = ? AND branch_id IS ?',
          params: [JSON.stringify(metadata), target.id, storyId, branchId],
          expectedRows: 1,
        },
      ])
    })
    check()
    this.entries = this.entries.map((entry) =>
      entry.id === target.id ? { ...entry, metadata } : entry,
    )
  }

  private async applyClassificationResultScoped(
    result: ClassificationResult,
    entryId?: string,
    options?: ScopedWriteOptions,
  ): Promise<void> {
    const collaborative = isCollaborativeStory(this.currentStory)
    if (!collaborative || !entryId) {
      if (collaborative && result._error) throw new Error(result._error)
      return this.applyClassificationResultMutating(result, entryId, options)
    }
    const { check } = this.captureWriteScope(options)

    const before = {
      characters: this.characters,
      locations: this.locations,
      items: this.items,
      storyBeats: this.storyBeats,
      entries: this.entries,
      currentStory: this.currentStory,
    }
    try {
      if (result._error) throw new Error(result._error)
      await database.collectAtomicWrites((writer) =>
        this.applyClassificationResultMutating(result, entryId, options, writer),
      )
    } catch (error) {
      check()

      this.characters = before.characters
      this.locations = before.locations
      this.items = before.items
      this.storyBeats = before.storyBeats
      this.entries = before.entries
      this.currentStory = before.currentStory

      const entry = this.entries.find((candidate) => candidate.id === entryId)
      if (entry) {
        const message = error instanceof Error ? error.message : String(error)
        const maintenance = entry.metadata?.collaborativeStateMaintenance
        const hasCommittedState =
          !!entry.worldStateDelta ||
          maintenance?.status === 'applied' ||
          maintenance?.status === 'no_changes'
        const metadata = {
          ...entry.metadata,
          ...(hasCommittedState
            ? maintenance
              ? { collaborativeStateMaintenance: { ...maintenance, warning: message } }
              : {}
            : {
                collaborativeStateMaintenance: createStateMaintenanceRecord('failed', {
                  error: message,
                }),
              }),
        }
        const worldStateDelta = entry.worldStateDelta ?? null
        await database.updateStoryEntry(entryId, { metadata, worldStateDelta })
        check()
        this.entries = this.entries.map((candidate) =>
          candidate.id === entryId ? { ...candidate, metadata, worldStateDelta } : candidate,
        )
      }
      throw error
    }
  }

  private async applyClassificationResultMutating(
    result: ClassificationResult,
    entryId?: string,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<void> {
    const database = writeDatabase
    if (!this.currentStory && !options) {
      log('applyClassificationResult: No story loaded, skipping')
      return
    }
    const { storyId, branchId, check } = this.captureWriteScope(options)
    const scoped: ScopedWriteOptions = {
      scope: { storyId, branchId },
      isScopeCurrent: () => {
        check()
        return true
      },
    }
    // Check in finally too: a failed old request must not resume on the new story.
    const write = async <T>(operation: () => Promise<T>): Promise<T> => {
      check()
      try {
        return await operation()
      } finally {
        check()
      }
    }
    const guardedUpdate = (label: string, name: string, operation: () => Promise<void>) =>
      this.wrapUpdate(label, name, () => write(operation))
    if (!this.currentStory) {
      log('applyClassificationResult: No story loaded, skipping')
      return
    }

    log('applyClassificationResult called', {
      characterUpdates: result.entryUpdates.characterUpdates.length,
      locationUpdates: result.entryUpdates.locationUpdates.length,
      itemUpdates: result.entryUpdates.itemUpdates.length,
      storyBeatUpdates: result.entryUpdates.storyBeatUpdates.length,
      newCharacters: result.entryUpdates.newCharacters.length,
      newLocations: result.entryUpdates.newLocations.length,
      newItems: result.entryUpdates.newItems.length,
      newStoryBeats: result.entryUpdates.newStoryBeats.length,
      scene: result.scene,
    })

    const trackingEnabled =
      (settings.experimentalFeatures.stateTracking || isCollaborativeStory(this.currentStory)) &&
      !!entryId

    // Extract runtime variable definitions attached by ClassifierService (if any)
    const runtimeVarDefs: RuntimeVariable[] | undefined = result._runtimeVarDefs
    const defsByName = new Map<string, RuntimeVariable>(
      runtimeVarDefs?.map((d) => [d.variableName, d]) ?? [],
    )

    // Phase 1: Capture before-state for entities that will be modified
    const charactersBefore: CharacterBeforeState[] = []
    const locationsBefore: LocationBeforeState[] = []
    const itemsBefore: ItemBeforeState[] = []
    const storyBeatsBefore: StoryBeatBeforeState[] = []
    const createdCharacterIds: string[] = []
    const createdLocationIds: string[] = []
    const createdItemIds: string[] = []
    const createdStoryBeatIds: string[] = []
    let currentLocationIdBefore: string | null = null
    let timeTrackerBefore: TimeTracker | null = null

    if (trackingEnabled) {
      // Snapshot current location
      const currentLoc = this.locations.find((l) => l.current)
      currentLocationIdBefore = currentLoc?.id ?? null

      // Snapshot time tracker
      timeTrackerBefore = this.currentStory.timeTracker
        ? { ...this.currentStory.timeTracker }
        : null

      // Snapshot characters that will be updated
      for (const update of result.entryUpdates.characterUpdates) {
        const existing = this.characters.find((c) => sameEntityName(c.name, update.name))
        if (existing) {
          charactersBefore.push({
            id: existing.id,
            name: existing.name,
            status: existing.status,
            relationship: existing.relationship,
            traits: [...existing.traits],
            visualDescriptors: { ...existing.visualDescriptors },
            metadata: existing.metadata ? { ...existing.metadata } : null,
          })
        }
      }

      // Snapshot locations that will be updated
      for (const update of result.entryUpdates.locationUpdates) {
        const existing = this.locations.find((l) => sameEntityName(l.name, update.name))
        if (existing) {
          locationsBefore.push({
            id: existing.id,
            name: existing.name,
            visited: existing.visited,
            current: existing.current,
            description: existing.description,
            metadata: existing.metadata ? { ...existing.metadata } : null,
          })
        }
      }

      // Snapshot items that will be updated
      for (const update of result.entryUpdates.itemUpdates) {
        const existing = this.items.find((i) => sameEntityName(i.name, update.name))
        if (existing) {
          itemsBefore.push({
            id: existing.id,
            name: existing.name,
            quantity: existing.quantity,
            equipped: existing.equipped,
            location: existing.location,
            metadata: existing.metadata ? { ...existing.metadata } : null,
          })
        }
      }

      // Snapshot story beats that will be updated
      for (const update of result.entryUpdates.storyBeatUpdates) {
        const existing = this.storyBeats.find((b) => sameEntityName(b.title, update.title))
        if (existing) {
          storyBeatsBefore.push({
            id: existing.id,
            title: existing.title,
            status: existing.status,
            description: existing.description,
            resolvedAt: existing.resolvedAt ?? null,
            metadata: existing.metadata ? { ...existing.metadata } : null,
          })
        }
      }

      // Also snapshot locations that might be affected by currentLocationName scene change
      if (result.scene.currentLocationName) {
        const locationName = result.scene.currentLocationName
        const loc = this.locations.find((l) => sameEntityName(l.name, locationName))
        if (loc && !locationsBefore.some((lb) => lb.id === loc.id)) {
          locationsBefore.push({
            id: loc.id,
            name: loc.name,
            visited: loc.visited,
            current: loc.current,
            description: loc.description,
            metadata: loc.metadata ? { ...loc.metadata } : null,
          })
        }
      }
    }

    // Apply character updates
    for (const update of result.entryUpdates.characterUpdates) {
      check()
      await guardedUpdate('Update character', update.name, async () => {
        let existing = this.characters.find((c) => sameEntityName(c.name, update.name))

        // If character doesn't exist yet, create it first
        if (!existing) {
          const newCharData = result.entryUpdates.newCharacters.find((nc) =>
            sameEntityName(nc.name, update.name),
          )
          log('Creating character from update (not found):', update.name)
          const charMetadata: Record<string, unknown> = { source: 'classifier' }
          if (newCharData) {
            const newCharInlineVars = extractInlineCustomVars(
              newCharData as unknown as Record<string, unknown>,
              defsByName,
            )
            if (Object.keys(newCharInlineVars).length > 0) {
              Object.assign(charMetadata, mergeRuntimeVars(null, newCharInlineVars, defsByName))
            }
          }
          const character: Character = {
            id: crypto.randomUUID(),
            storyId,
            name: newCharData?.name ?? update.name,
            description: newCharData?.description ?? null,
            relationship: newCharData?.relationship ?? null,
            traits: newCharData?.traits ?? [],
            visualDescriptors: newCharData?.visualDescriptors ?? {},
            status:
              (newCharData?.status as Character['status']) ??
              (isCollaborativeStory(this.currentStory) ? 'inactive' : 'active'),
            metadata: charMetadata,
            portrait: null,
            branchId,
          }
          await write(() => database.addCharacter(character))
          check()
          this.characters = [...this.characters, character]
          if (trackingEnabled) createdCharacterIds.push(character.id)
          existing = character
        }

        if (existing) {
          log('Updating character:', update.name, update.changes)
          const changes: Partial<Character> = {}
          if (update.changes.status) changes.status = update.changes.status
          if (update.changes.relationship) {
            if (existing.relationship === 'self') {
              // Preserve protagonist relationship; only set via explicit swap.
            } else if (update.changes.relationship !== 'self') {
              changes.relationship = update.changes.relationship
            }
          }
          if (update.changes.newTraits?.length || update.changes.removeTraits?.length) {
            let traits = [...existing.traits]
            if (update.changes.removeTraits?.length) {
              const toRemove = new Set(update.changes.removeTraits.map((t) => t.toLowerCase()))
              traits = traits.filter((t) => !toRemove.has(t.toLowerCase()))
            }
            if (update.changes.newTraits?.length) {
              traits = [...traits, ...update.changes.newTraits]
            }
            const traitMap = new Map(traits.map((t) => [t.toLowerCase(), t]))
            changes.traits = Array.from(traitMap.values())
          }
          // Handle visual descriptor updates for image generation
          // Collaborative extraction patches evidenced categories; adventure replaces the object.
          if (
            update.changes.visualDescriptors &&
            Object.keys(update.changes.visualDescriptors).length > 0
          ) {
            changes.visualDescriptors = isCollaborativeStory(this.currentStory)
              ? mergeVisualDescriptors(existing.visualDescriptors, update.changes.visualDescriptors)
              : update.changes.visualDescriptors
          }
          // Merge inline runtime variable values into metadata if present
          const charInlineVars = extractInlineCustomVars(
            update.changes as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(charInlineVars).length > 0) {
            changes.metadata = mergeRuntimeVars(existing.metadata, charInlineVars, defsByName)
          }
          // COW: ensure entity is owned by current branch before updating
          const { entity: ownedChar, wasCowed: charWasCowed } = await this.cowCharacter(
            existing,
            scoped,
            writeDatabase,
          )
          await write(() => database.updateCharacter(ownedChar.id, changes))
          check()
          this.characters = this.characters.map((c) =>
            c.id === ownedChar.id ? { ...c, ...changes } : c,
          )
          // If COW'd, track override as created (rollback = delete override)
          if (charWasCowed && trackingEnabled) {
            createdCharacterIds.push(ownedChar.id)
            const idx = charactersBefore.findIndex((cb) => cb.id === existing.id)
            if (idx !== -1) charactersBefore.splice(idx, 1)
          }
        }
      })
    }

    // Apply location updates
    for (const update of result.entryUpdates.locationUpdates) {
      check()
      await guardedUpdate('Update location', update.name, async () => {
        let existing = this.locations.find((l) => sameEntityName(l.name, update.name))

        // If location doesn't exist yet, create it first
        if (!existing) {
          // Check if newLocations has data for this name
          const newLocData = result.entryUpdates.newLocations.find((nl) =>
            sameEntityName(nl.name, update.name),
          )
          log('Creating location from update (not found):', update.name)
          const locMetadata: Record<string, unknown> = { source: 'classifier' }
          if (newLocData) {
            const newLocInlineVars = extractInlineCustomVars(
              newLocData as unknown as Record<string, unknown>,
              defsByName,
            )
            if (Object.keys(newLocInlineVars).length > 0) {
              Object.assign(locMetadata, mergeRuntimeVars(null, newLocInlineVars, defsByName))
            }
          }
          const location: Location = {
            id: crypto.randomUUID(),
            storyId,
            name: newLocData?.name ?? update.name,
            description: newLocData?.description ?? null,
            visited: newLocData?.visited ?? false,
            // Only `scene.currentLocationName` moves the scene.
            current: false,
            connections: [],
            metadata: locMetadata,
            branchId,
          }
          await write(() => database.addLocation(location))
          check()
          this.locations = [...this.locations, location]
          if (trackingEnabled) createdLocationIds.push(location.id)
          existing = location
        }

        if (existing) {
          log('Updating location:', update.name, update.changes)
          const changes: Partial<Location> = {}
          if (update.changes.visited !== undefined) changes.visited = update.changes.visited
          if (update.changes.description) {
            changes.description = update.changes.description
          }
          if (update.changes.descriptionAddition) {
            const addition = update.changes.descriptionAddition.trim()
            if (addition) {
              changes.description =
                (changes.description ?? existing.description)
                  ? `${changes.description ?? existing.description} ${addition}`
                  : addition
            }
          }
          // Merge inline runtime variable values into metadata if present
          const locInlineVars = extractInlineCustomVars(
            update.changes as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(locInlineVars).length > 0) {
            changes.metadata = mergeRuntimeVars(existing.metadata, locInlineVars, defsByName)
          }

          // COW: ensure entity is owned by current branch before updating
          const { entity: ownedLoc, wasCowed: locWasCowed } = await this.cowLocation(
            existing,
            scoped,
            writeDatabase,
          )
          check()

          if (Object.keys(changes).length === 0) {
            // Even if no changes, track COW if it happened
            if (locWasCowed && trackingEnabled) {
              createdLocationIds.push(ownedLoc.id)
              const idx = locationsBefore.findIndex((lb) => lb.id === existing.id)
              if (idx !== -1) locationsBefore.splice(idx, 1)
            }
            return
          }
          await write(() => database.updateLocation(ownedLoc.id, changes))
          check()
          this.locations = this.locations.map((l) =>
            l.id === ownedLoc.id ? { ...l, ...changes } : l,
          )
          if (locWasCowed && trackingEnabled) {
            createdLocationIds.push(ownedLoc.id)
            const idx = locationsBefore.findIndex((lb) => lb.id === existing.id)
            if (idx !== -1) locationsBefore.splice(idx, 1)
          }
        }
      })
    }

    // Apply item updates
    for (const update of result.entryUpdates.itemUpdates) {
      check()
      await guardedUpdate('Update item', update.name, async () => {
        let existing = this.items.find((i) => sameEntityName(i.name, update.name))

        // If item doesn't exist yet, create it first
        if (!existing) {
          const newItemData = result.entryUpdates.newItems.find((ni) =>
            sameEntityName(ni.name, update.name),
          )
          log('Creating item from update (not found):', update.name)
          const itemMetadata: Record<string, unknown> = { source: 'classifier' }
          if (newItemData) {
            const newItemInlineVars = extractInlineCustomVars(
              newItemData as unknown as Record<string, unknown>,
              defsByName,
            )
            if (Object.keys(newItemInlineVars).length > 0) {
              Object.assign(itemMetadata, mergeRuntimeVars(null, newItemInlineVars, defsByName))
            }
          }
          const item: Item = {
            id: crypto.randomUUID(),
            storyId,
            name: newItemData?.name ?? update.name,
            description: newItemData?.description ?? null,
            quantity: newItemData?.quantity ?? 1,
            equipped: false,
            location: newItemData?.location ?? 'inventory',
            metadata: itemMetadata,
            branchId,
          }
          await write(() => database.addItem(item))
          check()
          this.items = [...this.items, item]
          if (trackingEnabled) createdItemIds.push(item.id)
          existing = item
        }

        if (existing) {
          log('Updating item:', update.name, update.changes)
          const changes: Partial<Item> = {}
          if (update.changes.quantity !== undefined) changes.quantity = update.changes.quantity
          if (update.changes.equipped !== undefined) changes.equipped = update.changes.equipped
          if (update.changes.location) changes.location = update.changes.location
          // Merge inline runtime variable values into metadata if present
          const itemInlineVars = extractInlineCustomVars(
            update.changes as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(itemInlineVars).length > 0) {
            changes.metadata = mergeRuntimeVars(existing.metadata, itemInlineVars, defsByName)
          }
          // COW: ensure entity is owned by current branch before updating
          const { entity: ownedItem, wasCowed: itemWasCowed } = await this.cowItem(
            existing,
            scoped,
            writeDatabase,
          )
          await write(() => database.updateItem(ownedItem.id, changes))
          check()
          this.items = this.items.map((i) => (i.id === ownedItem.id ? { ...i, ...changes } : i))
          if (itemWasCowed && trackingEnabled) {
            createdItemIds.push(ownedItem.id)
            const idx = itemsBefore.findIndex((ib) => ib.id === existing.id)
            if (idx !== -1) itemsBefore.splice(idx, 1)
          }
        }
      })
    }

    // Apply story beat updates (mark as completed/failed)
    for (const update of result.entryUpdates.storyBeatUpdates) {
      check()
      await guardedUpdate('Update story beat', update.title, async () => {
        let existing = this.storyBeats.find((b) => sameEntityName(b.title, update.title))

        // If story beat doesn't exist yet, create it first
        if (!existing) {
          const newBeatData = result.entryUpdates.newStoryBeats.find((nb) =>
            sameEntityName(nb.title, update.title),
          )
          log('Creating story beat from update (not found):', update.title)
          const beatMetadata: Record<string, unknown> = { source: 'classifier' }
          if (newBeatData) {
            const newBeatInlineVars = extractInlineCustomVars(
              newBeatData as unknown as Record<string, unknown>,
              defsByName,
            )
            if (Object.keys(newBeatInlineVars).length > 0) {
              Object.assign(beatMetadata, mergeRuntimeVars(null, newBeatInlineVars, defsByName))
            }
          }
          const beat: StoryBeat = {
            id: crypto.randomUUID(),
            storyId,
            title: newBeatData?.title ?? update.title,
            description: newBeatData?.description ?? null,
            type: newBeatData?.type ?? 'event',
            status: newBeatData?.status ?? 'active',
            triggeredAt: Date.now(),
            metadata: beatMetadata,
            branchId,
          }
          await write(() => database.addStoryBeat(beat))
          check()
          this.storyBeats = [...this.storyBeats, beat]
          if (trackingEnabled) createdStoryBeatIds.push(beat.id)
          existing = beat
        }

        if (existing) {
          log('Updating story beat:', update.title, update.changes)
          const changes: Partial<StoryBeat> = {}
          if (update.changes.status) {
            changes.status = update.changes.status
            // Set resolvedAt timestamp when completing or failing
            if (update.changes.status === 'completed' || update.changes.status === 'failed') {
              changes.resolvedAt = Date.now()
            }
          }
          if (update.changes.description) changes.description = update.changes.description
          // Merge inline runtime variable values into metadata if present
          const beatInlineVars = extractInlineCustomVars(
            update.changes as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(beatInlineVars).length > 0) {
            changes.metadata = mergeRuntimeVars(existing.metadata, beatInlineVars, defsByName)
          }
          // COW: ensure entity is owned by current branch before updating
          const { entity: ownedBeat, wasCowed: beatWasCowed } = await this.cowStoryBeat(
            existing,
            scoped,
            writeDatabase,
          )
          await write(() => database.updateStoryBeat(ownedBeat.id, changes))
          check()
          this.storyBeats = this.storyBeats.map((b) =>
            b.id === ownedBeat.id ? { ...b, ...changes } : b,
          )
          if (beatWasCowed && trackingEnabled) {
            createdStoryBeatIds.push(ownedBeat.id)
            const idx = storyBeatsBefore.findIndex((sb) => sb.id === existing.id)
            if (idx !== -1) storyBeatsBefore.splice(idx, 1)
          }
        }
      })
    }

    // Add new characters (check for duplicates)
    for (const newChar of result.entryUpdates.newCharacters) {
      check()
      await guardedUpdate('Add character', newChar.name, async () => {
        const exists = this.characters.some((c) => sameEntityName(c.name, newChar.name))
        if (!exists) {
          log('Adding new character:', newChar.name)
          const charMetadata: Record<string, unknown> = { source: 'classifier' }
          const newCharInlineVars = extractInlineCustomVars(
            newChar as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(newCharInlineVars).length > 0) {
            Object.assign(charMetadata, mergeRuntimeVars(null, newCharInlineVars, defsByName))
          }
          const character: Character = {
            id: crypto.randomUUID(),
            storyId,
            name: newChar.name,
            description: newChar.description ?? null,
            relationship: newChar.relationship ?? null,
            traits: newChar.traits ?? [],
            visualDescriptors: newChar.visualDescriptors ?? {},
            status: isCollaborativeStory(this.currentStory)
              ? (newChar.status ?? 'inactive')
              : 'active',
            metadata: charMetadata,
            portrait: null,
            branchId,
          }
          await write(() => database.addCharacter(character))
          check()
          this.characters = [...this.characters, character]
          if (trackingEnabled) createdCharacterIds.push(character.id)
        }
      })
    }

    // Handle scene.currentLocationName - update current location if specified
    // Runs before newLocations so stubs are available for merging
    if (result.scene.currentLocationName) {
      check()
      await guardedUpdate('Set scene location', result.scene.currentLocationName, async () => {
        const locationName = result.scene.currentLocationName!
        let currentLoc = this.locations.find((l) => sameEntityName(l.name, locationName))

        // If location doesn't exist yet, create a stub
        if (!currentLoc) {
          log(
            'Creating stub location from scene.currentLocationName:',
            result.scene.currentLocationName,
          )
          const stubLocation: Location = {
            id: crypto.randomUUID(),
            storyId,
            name: result.scene.currentLocationName!,
            description: null,
            visited: true,
            current: false,
            connections: [],
            metadata: { source: 'classifier' },
            branchId,
          }
          await write(() => database.addLocation(stubLocation))
          check()
          this.locations = [...this.locations, stubLocation]
          if (trackingEnabled) createdLocationIds.push(stubLocation.id)
          currentLoc = stubLocation
        }

        if (currentLoc && !currentLoc.current) {
          log('Setting current location from scene:', currentLoc.name)
          if (this.isCowBranch()) {
            // COW-aware: targeted updates
            const { entity: ownedTarget, wasCowed: targetWasCowed } = await this.cowLocation(
              currentLoc,
              scoped,
              writeDatabase,
            )
            check()
            const prevCurrent = this.locations.find((l) => l.current && l.id !== ownedTarget.id)
            if (prevCurrent) {
              const { entity: ownedPrev, wasCowed: prevWasCowed } = await this.cowLocation(
                prevCurrent,
                scoped,
                writeDatabase,
              )
              await write(() => database.updateLocation(ownedPrev.id, { current: false }))
              check()
              this.locations = this.locations.map((l) =>
                l.id === ownedPrev.id ? { ...l, current: false } : l,
              )
              if (prevWasCowed && trackingEnabled) {
                createdLocationIds.push(ownedPrev.id)
                const idx = locationsBefore.findIndex((lb) => lb.id === prevCurrent.id)
                if (idx !== -1) locationsBefore.splice(idx, 1)
              }
            }
            await write(() =>
              database.updateLocation(ownedTarget.id, { current: true, visited: true }),
            )
            check()
            this.locations = this.locations.map((l) =>
              l.id === ownedTarget.id ? { ...l, current: true, visited: true } : l,
            )
            if (targetWasCowed && trackingEnabled) {
              createdLocationIds.push(ownedTarget.id)
              const idx = locationsBefore.findIndex((lb) => lb.id === currentLoc!.id)
              if (idx !== -1) locationsBefore.splice(idx, 1)
            }
          } else {
            // The database's story-wide setter also clears sibling branches.
            for (const previous of this.locations.filter(
              (location) => location.current && location.id !== currentLoc!.id,
            )) {
              await write(() => database.updateLocation(previous.id, { current: false }))
              check()
              this.locations = this.locations.map((location) =>
                location.id === previous.id ? { ...location, current: false } : location,
              )
            }
            await write(() =>
              database.updateLocation(currentLoc!.id, { current: true, visited: true }),
            )
            check()
            this.locations = this.locations.map((l) => ({
              ...l,
              current: l.id === currentLoc!.id,
              visited: l.id === currentLoc!.id ? true : l.visited,
            }))
          }
        }
      })
    }

    // Add new locations (check for duplicates, merge into recently created)
    for (const newLoc of result.entryUpdates.newLocations) {
      check()
      await guardedUpdate('Add location', newLoc.name, async () => {
        const existing = this.locations.find((l) => sameEntityName(l.name, newLoc.name))
        if (existing && createdLocationIds.includes(existing.id)) {
          // Merge into location created earlier in this classification run
          // (e.g. stub from scene.currentLocationName or from update handler)
          log('Merging new location into recently created:', newLoc.name)
          const changes: Partial<Location> = {}
          if (newLoc.description && !existing.description) {
            changes.description = newLoc.description
          }
          if (newLoc.visited !== undefined && newLoc.visited !== existing.visited) {
            changes.visited = newLoc.visited
          }
          // Merge inline runtime variable values into metadata if present
          const newLocInlineVars = extractInlineCustomVars(
            newLoc as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(newLocInlineVars).length > 0) {
            changes.metadata = mergeRuntimeVars(existing.metadata, newLocInlineVars, defsByName)
          }
          if (Object.keys(changes).length > 0) {
            await write(() => database.updateLocation(existing.id, changes))
            check()
            this.locations = this.locations.map((l) =>
              l.id === existing.id ? { ...l, ...changes } : l,
            )
          }
        } else if (!existing) {
          log('Adding new location:', newLoc.name)
          const locMetadata: Record<string, unknown> = { source: 'classifier' }
          const newLocInlineVars = extractInlineCustomVars(
            newLoc as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(newLocInlineVars).length > 0) {
            Object.assign(locMetadata, mergeRuntimeVars(null, newLocInlineVars, defsByName))
          }
          const location: Location = {
            id: crypto.randomUUID(),
            storyId,
            name: newLoc.name,
            description: newLoc.description ?? null,
            visited: newLoc.visited ?? false,
            // Only `scene.currentLocationName` moves the scene, and it runs before this.
            current: false,
            connections: [],
            metadata: locMetadata,
            branchId,
          }
          await write(() => database.addLocation(location))
          check()
          this.locations = [...this.locations, location]
          if (trackingEnabled) createdLocationIds.push(location.id)
        }
      })
    }

    // Add new items (check for duplicates)
    for (const newItem of result.entryUpdates.newItems) {
      check()
      await guardedUpdate('Add item', newItem.name, async () => {
        const exists = this.items.some((i) => sameEntityName(i.name, newItem.name))
        if (!exists) {
          log('Adding new item:', newItem.name)
          const itemMetadata: Record<string, unknown> = { source: 'classifier' }
          const newItemInlineVars = extractInlineCustomVars(
            newItem as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(newItemInlineVars).length > 0) {
            Object.assign(itemMetadata, mergeRuntimeVars(null, newItemInlineVars, defsByName))
          }
          const item: Item = {
            id: crypto.randomUUID(),
            storyId,
            name: newItem.name,
            description: newItem.description ?? null,
            quantity: newItem.quantity ?? 1,
            equipped: false,
            location: newItem.location ?? 'inventory',
            metadata: itemMetadata,
            branchId,
          }
          await write(() => database.addItem(item))
          check()
          this.items = [...this.items, item]
          if (trackingEnabled) createdItemIds.push(item.id)
        }
      })
    }

    // Add new story beats (check for duplicates)
    for (const newBeat of result.entryUpdates.newStoryBeats) {
      check()
      await guardedUpdate('Add story beat', newBeat.title, async () => {
        const exists = this.storyBeats.some((b) => sameEntityName(b.title, newBeat.title))
        if (!exists) {
          log('Adding new story beat:', newBeat.title)
          const beatMetadata: Record<string, unknown> = { source: 'classifier' }
          const newBeatInlineVars = extractInlineCustomVars(
            newBeat as unknown as Record<string, unknown>,
            defsByName,
          )
          if (Object.keys(newBeatInlineVars).length > 0) {
            Object.assign(beatMetadata, mergeRuntimeVars(null, newBeatInlineVars, defsByName))
          }
          const beat: StoryBeat = {
            id: crypto.randomUUID(),
            storyId,
            title: newBeat.title,
            description: newBeat.description ?? null,
            type: newBeat.type ?? 'event',
            status: newBeat.status ?? 'active',
            triggeredAt: Date.now(),
            metadata: beatMetadata,
            branchId,
          }
          await write(() => database.addStoryBeat(beat))
          check()
          this.storyBeats = [...this.storyBeats, beat]
          if (trackingEnabled) createdStoryBeatIds.push(beat.id)
        }
      })
    }

    // Reconcile who is in the scene. Last, so the characters this classification created
    // are already in `this.characters` and the explicit updates above have had their say.
    check()
    const presenceChanges = resolveCharacterPresence({
      characters: this.characters,
      presentNames: result.scene.presentCharacterNames ?? [],
      newNames: isCollaborativeStory(this.currentStory)
        ? []
        : result.entryUpdates.newCharacters.map((character) => character.name),
      explicitStatusNames: [
        ...result.entryUpdates.characterUpdates
          .filter((update) => update.changes.status !== undefined)
          .map((update) => update.name),
        ...(isCollaborativeStory(this.currentStory)
          ? result.entryUpdates.newCharacters
              .filter((character) => character.status !== undefined)
              .map((character) => character.name)
          : []),
      ],
      hadError: !!result._error,
    })

    for (const change of presenceChanges) {
      check()
      const char = this.characters.find((c) => c.id === change.id)
      if (!char) continue

      await guardedUpdate(
        change.to === 'active' ? 'Character enters scene' : 'Character leaves scene',
        char.name,
        async () => {
          if (trackingEnabled && !charactersBefore.some((cb) => cb.id === char.id)) {
            charactersBefore.push({
              id: char.id,
              name: char.name,
              status: char.status,
              relationship: char.relationship,
              traits: [...char.traits],
              visualDescriptors: { ...char.visualDescriptors },
              metadata: char.metadata ? { ...char.metadata } : null,
            })
          }

          const { entity: ownedChar, wasCowed } = await this.cowCharacter(
            char,
            scoped,
            writeDatabase,
          )
          await write(() => database.updateCharacter(ownedChar.id, { status: change.to }))
          check()
          this.characters = this.characters.map((c) =>
            c.id === ownedChar.id ? { ...c, status: change.to } : c,
          )

          if (wasCowed && trackingEnabled) {
            createdCharacterIds.push(ownedChar.id)
            const idx = charactersBefore.findIndex((cb) => cb.id === char.id)
            if (idx !== -1) charactersBefore.splice(idx, 1)
          }
        },
      )
    }

    // Apply time progression from scene data
    if (result.scene.timeProgression && result.scene.timeProgression !== 'none') {
      await this.applyTimeProgression(result.scene.timeProgression, scoped, writeDatabase)
    }
    check()

    // Phase 1: Save world state delta on the entry
    if (trackingEnabled && entryId) {
      try {
        const delta: WorldStateDelta = {
          version: 2,
          classificationResult: result as unknown as Record<string, unknown>,
          previousState: {
            characters: charactersBefore,
            locations: locationsBefore,
            items: itemsBefore,
            storyBeats: storyBeatsBefore,
            currentLocationId: currentLocationIdBefore,
            timeTracker: timeTrackerBefore,
          },
          createdEntities: {
            characterIds: createdCharacterIds,
            locationIds: createdLocationIds,
            itemIds: createdItemIds,
            storyBeatIds: createdStoryBeatIds,
          },
        }

        const hasRecordedChanges =
          charactersBefore.length > 0 ||
          locationsBefore.length > 0 ||
          itemsBefore.length > 0 ||
          storyBeatsBefore.length > 0 ||
          createdCharacterIds.length > 0 ||
          createdLocationIds.length > 0 ||
          createdItemIds.length > 0 ||
          createdStoryBeatIds.length > 0 ||
          currentLocationIdBefore !==
            (this.locations.find((location) => location.current)?.id ?? null) ||
          JSON.stringify(timeTrackerBefore) !==
            JSON.stringify(this.currentStory.timeTracker ?? null)
        const maintenance = createStateMaintenanceRecord(
          hasRecordedChanges ? 'applied' : 'no_changes',
          result._error ? { warning: result._error } : undefined,
        )
        const existingEntry = this.entries.find((entry) => entry.id === entryId)
        const metadata = {
          ...existingEntry?.metadata,
          timeEnd: this.currentStory.timeTracker
            ? { ...this.currentStory.timeTracker }
            : { years: 0, days: 0, hours: 0, minutes: 0 },
          collaborativeStateMaintenance: maintenance,
        }
        await write(() =>
          database.updateStoryEntry(entryId, {
            worldStateDelta: hasRecordedChanges ? delta : null,
            metadata,
          }),
        )
        check()
        // Update in-memory entry
        this.entries = this.entries.map((e) =>
          e.id === entryId
            ? { ...e, worldStateDelta: hasRecordedChanges ? delta : null, metadata }
            : e,
        )

        log('World state delta saved for entry', {
          entryId,
          updatedCharacters: charactersBefore.length,
          updatedLocations: locationsBefore.length,
          updatedItems: itemsBefore.length,
          updatedStoryBeats: storyBeatsBefore.length,
          createdCharacters: createdCharacterIds.length,
          createdLocations: createdLocationIds.length,
          createdItems: createdItemIds.length,
          createdStoryBeats: createdStoryBeatIds.length,
        })

        // Auto-snapshot if interval reached
        await this.maybeCreateAutoSnapshot(entryId, scoped, writeDatabase)
      } catch (error) {
        check()
        console.error('[StoryStore] Failed to save world state delta:', error)
        // A restore must not delete the entry when its undo record could not be saved.
        throw error
      }
    }

    check()
    log('applyClassificationResult complete', {
      characters: this.characters.length,
      locations: this.locations.length,
      items: this.items.length,
      storyBeats: this.storyBeats.length,
    })

    // Emit state updated event if there were any changes
    const hasChanges =
      result.entryUpdates.newCharacters.length > 0 ||
      result.entryUpdates.newLocations.length > 0 ||
      result.entryUpdates.newItems.length > 0 ||
      result.entryUpdates.newStoryBeats.length > 0 ||
      result.entryUpdates.characterUpdates.length > 0 ||
      result.entryUpdates.locationUpdates.length > 0 ||
      result.entryUpdates.itemUpdates.length > 0 ||
      result.entryUpdates.storyBeatUpdates.length > 0 ||
      // Presence is inferred from `scene`, not from `entryUpdates`, so a turn whose only
      // effect is someone walking out wrote statuses and announced nothing.
      presenceChanges.length > 0

    if (hasChanges) {
      emitStateUpdated({
        characters:
          result.entryUpdates.newCharacters.length +
          result.entryUpdates.characterUpdates.length +
          presenceChanges.length,
        locations:
          result.entryUpdates.newLocations.length + result.entryUpdates.locationUpdates.length,
        items: result.entryUpdates.newItems.length + result.entryUpdates.itemUpdates.length,
        storyBeats:
          result.entryUpdates.newStoryBeats.length + result.entryUpdates.storyBeatUpdates.length,
      })
    }
  }

  // Clear current story (when switching or closing)
  clearCurrentStory(): void {
    this.storyLoadSeq++
    this.resetStoryState()

    // Clear current retry story ID (backups are kept per-story)
    ui.setCurrentRetryStoryId(null)

    // Clear all generation caches (style review, retrieval, lorebook debug)
    ui.clearGenerationCaches()
  }

  // Update story mode
  async setStoryMode(mode: StoryMode): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const nextSettings = { ...(this.currentStory.settings ?? {}) }
    if (mode === 'creative-writing')
      nextSettings.collaborativeNovelWorkflow = createDefaultCollaborativeWorkflow(
        nextSettings.collaborativeNovelWorkflow,
      )
    else delete nextSettings.collaborativeNovelWorkflow
    await database.updateStory(this.currentStory.id, { mode, settings: nextSettings })
    this.currentStory = { ...this.currentStory, mode, settings: nextSettings }
    log('Story mode updated:', mode)

    // Emit event
    emitModeChanged(mode)
  }

  // Update memory configuration
  async setMemoryConfig(config: MemoryConfig): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    await database.updateStory(this.currentStory.id, { memoryConfig: config })
    this.currentStory = { ...this.currentStory, memoryConfig: config }
    log('Memory config updated:', config)
  }

  // Add a chapter
  async addChapter(chapter: Chapter, options?: ScopedWriteOptions): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    if (options?.scope) this.captureWriteScope(options)
    const { check } = this.captureWriteScope({
      ...options,
      scope: { storyId: chapter.storyId, branchId: chapter.branchId ?? null },
    })

    await database.addChapter(chapter)
    check()
    this.chapters = [...this.chapters, chapter]

    // Invalidate chapter cache
    this.invalidateChapterCache()

    log('Chapter added:', chapter.number, chapter.title)

    // Emit event
    emitChapterCreated(chapter.id, chapter.number, chapter.title)
  }

  // Get the next chapter number from the database (handles deletions correctly)
  async getNextChapterNumber(options?: ScopedWriteOptions): Promise<number> {
    if (!this.currentStory) throw new Error('No story loaded')
    this.captureWriteScope(options)

    // Use branch-filtered chapters to determine next chapter number
    // this.chapters is already filtered to current branch view (inherited + branch-specific)
    if (this.chapters.length === 0) {
      return 1
    }

    // Find the maximum chapter number in the current branch view
    const maxNumber = Math.max(...this.chapters.map((ch) => ch.number))
    return maxNumber + 1
  }

  // Update a chapter's summary
  async updateChapterSummary(chapterId: string, summary: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    await database.updateChapter(chapterId, { summary })
    this.chapters = this.chapters.map((ch) => (ch.id === chapterId ? { ...ch, summary } : ch))
    log('Chapter summary updated:', chapterId)
  }

  // Update a chapter with multiple fields
  async updateChapter(chapterId: string, updates: Partial<Chapter>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    await database.updateChapter(chapterId, updates)
    this.chapters = this.chapters.map((ch) => (ch.id === chapterId ? { ...ch, ...updates } : ch))
    log('Chapter updated:', chapterId, updates)
  }

  // Get entries for a specific chapter
  // Uses O(1) map lookups for performance
  getChapterEntries(chapter: Chapter): StoryEntry[] {
    // Ensure index map is up to date
    if (this._entryIdToIndex.size !== this.entries.length) {
      this.rebuildEntryIdIndex()
    }
    const startIdx = this._entryIdToIndex.get(chapter.startEntryId)
    const endIdx = this._entryIdToIndex.get(chapter.endEntryId)
    if (startIdx === undefined || endIdx === undefined) return []
    return this.entries.slice(startIdx, endIdx + 1)
  }

  /**
   * Entries after the last chapter's end -- the tail that hasn't been chapterized yet.
   *
   * Anything that walks the story chapter by chapter (retrieval, grep) is otherwise
   * blind to it, which is backwards: that tail is the most recent material and the most
   * likely to be what a question is about. Returns [] when every entry is chapterized.
   */
  getUnchapterizedEntries(): StoryEntry[] {
    if (this._entryIdToIndex.size !== this.entries.length) {
      this.rebuildEntryIdIndex()
    }

    const chapters = this.currentBranchChapters
    let lastChapterEnd = -1
    let resolved = 0
    for (const chapter of chapters) {
      const endIdx = this._entryIdToIndex.get(chapter.endEntryId)
      if (endIdx === undefined) continue
      resolved++
      if (endIdx > lastChapterEnd) lastChapterEnd = endIdx
    }

    // Chapters exist but none could be placed (broken endEntryId refs): returning
    // everything would label the whole story "not yet chapterized" and make grep count
    // it twice. Better to return nothing than to lie about what it is.
    if (chapters.length > 0 && resolved === 0) return []

    return this.entries.slice(lastChapterEnd + 1)
  }

  // Delete a chapter
  async deleteChapter(chapterId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    await database.deleteChapter(chapterId)
    this.chapters = this.chapters.filter((ch) => ch.id !== chapterId)

    // Invalidate chapter cache
    this.invalidateChapterCache()

    log('Chapter deleted:', chapterId)
  }

  // Update memory configuration (partial updates)
  async updateMemoryConfig(updates: Partial<MemoryConfig>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const newConfig = { ...this.memoryConfig, ...updates }
    await database.updateStory(this.currentStory.id, { memoryConfig: newConfig })
    this.currentStory = { ...this.currentStory, memoryConfig: newConfig }
    log('Memory config updated via updateMemoryConfig:', updates)
  }

  // Update story settings (partial updates)
  async updateStoryBasics(draft: StoryBasicsDraft): Promise<void> {
    this.assertNotBusy('保存故事基础设定')
    if (ui.submissionScope) throw new Error('生成准备期间不能保存故事设定。')
    const current = this.currentStory
    if (!current) throw new Error('没有已加载的故事。')
    const updates = storyBasicsUpdate(current, draft)
    await database.updateStory(current.id, updates)
    this.allStories = this.allStories.map((value) =>
      value.id === current.id ? { ...value, ...updates } : value,
    )
    if (this.currentStory?.id === current.id)
      this.currentStory = { ...this.currentStory, ...updates }
  }

  async updateStorySettings(updates: Partial<StorySettings>): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const newSettings = { ...(this.currentStory.settings ?? {}), ...updates }
    if (this.currentStory.mode === 'creative-writing')
      newSettings.collaborativeNovelWorkflow = createDefaultCollaborativeWorkflow(
        newSettings.collaborativeNovelWorkflow,
      )
    else delete newSettings.collaborativeNovelWorkflow
    await database.updateStory(this.currentStory.id, { settings: newSettings })
    this.currentStory = { ...this.currentStory, settings: newSettings }
    log('Story settings updated via updateStorySettings:', updates)
  }

  /** Apply reviewed source material atomically; manual/legacy name matches are never overwritten. */
  async applyImportOrganization(
    card: CardImportDraft,
    scope: {
      storyId: string
      branchId: string | null
      rawJson: string
      packId?: string
      variables?: Record<string, string>
    },
  ): Promise<{ charactersAdded: number; charactersUpdated: number; loreEntriesAdded: number }> {
    this.assertNotBusy('采用导入整理')
    if (ui.submissionScope) throw new Error('生成准备期间不能采用导入整理。')
    const { storyId, branchId, check } = this.captureWriteScope({ scope })
    const current = this.currentStory!
    const source = current.settings?.importSource
    if (!source || source.organizationEnabled === false)
      throw new Error('此故事已关闭 AI 导入整理。')
    if (source.rawCardJson !== scope.rawJson || card.rawJson !== source.rawCardJson)
      throw new Error('导入来源已经变化，请重新整理。')
    const before = JSON.stringify([current, this.characters, this.lorebookEntries])
    if (scope.packId) {
      const [pack, variables] = await Promise.all([
        database.getStoryPackId(storyId),
        database.getStoryCustomVariables(storyId),
      ])
      check()
      if (
        (pack || 'default-pack') !== scope.packId ||
        JSON.stringify(variables ?? {}) !== JSON.stringify(scope.variables ?? {})
      )
        throw new Error('提示词包或变量已经变化，请重新整理。')
    }
    const replacement =
      source.userReplacement !== undefined
        ? source.userReplacement
        : this.characters.find((c) => c.relationship === 'self')?.name
    const allowed = source.selections ?? { characters: true, scenario: true, lorebook: true }
    const excluded = new Set(source.excludedSourceKeys ?? [])
    for (const item of [...card.characters, ...card.lore])
      if (!item.selected) excluded.add(item.key)
    const names = new Set(this.characters.map((c) => c.name.trim().toLowerCase()))
    const chars: Character[] = []
    const updates: { previous: Character; value: Character; copy: boolean }[] = []
    if (allowed.characters && card.selections.characters)
      for (const item of card.characters) {
        const name = replaceUser(item.value.name ?? '', replacement).trim()
        if (!item.selected || excluded.has(item.key) || !name) continue
        const existing = this.characters.find(
          (c) => c.metadata?.importSourceKey === item.key && c.relationship !== 'self',
        )
        if (!existing && names.has(name.toLowerCase())) continue
        const value: Character = {
          ...existing,
          id: existing?.id ?? crypto.randomUUID(),
          storyId,
          branchId: existing?.branchId ?? branchId,
          name,
          description: replaceUser(item.value.description ?? '', replacement) || null,
          relationship:
            existing?.relationship ??
            (item.value.relationship === 'self' ? null : (item.value.relationship ?? null)),
          traits: (item.value.traits ?? []).map((v) => replaceUser(v, replacement)),
          status: existing?.status ?? 'active',
          visualDescriptors: item.value.visualDescriptors ?? existing?.visualDescriptors ?? {},
          portrait: item.value.portrait ?? existing?.portrait ?? null,
          metadata: { ...existing?.metadata, importSourceKey: item.key },
        }
        if (existing) {
          const copy =
            !!branchId &&
            existing.branchId !== branchId &&
            settings.experimentalFeatures.lightweightBranches
          if (copy) {
            value.id = crypto.randomUUID()
            value.branchId = branchId
            value.overridesId = existing.overridesId ?? existing.id
          }
          updates.push({ previous: existing, value, copy })
        } else {
          chars.push(value)
          names.add(name.toLowerCase())
        }
      }
    const map = { ...source.entryIdsBySourceKey }
    const existingNames = new Map(
      this.lorebookEntries.map((e) => [
        replaceUser(e.name, replacement).trim().toLowerCase(),
        e.id,
      ]),
    )
    const newEntries: Entry[] = []
    if (allowed.lorebook && card.selections.lorebook)
      for (const item of card.lore) {
        if (!item.selected || excluded.has(item.key)) continue
        const value = replaceLoreUser(item.value, replacement)
        const key = value.name.trim().toLowerCase()
        const mapped = map[item.key]
        const existing =
          this.lorebookEntries.find((e) => e.id === mapped || e.overridesId === mapped)?.id ??
          existingNames.get(key)
        if (existing) {
          map[item.key] = existing
          continue
        }
        const data = LorebookImportExport.convertToEntries([value], 'import')[0]!
        const entry: Entry = { ...data, id: crypto.randomUUID(), storyId, branchId }
        newEntries.push(entry)
        existingNames.set(key, entry.id)
        map[item.key] = entry.id
      }
    const updatedSource = {
      ...source,
      excludedSourceKeys: [...excluded],
      entryIdsBySourceKey: map,
      status: 'organized' as const,
      lastError: null,
    }
    const updatedSettings = { ...current.settings, importSource: updatedSource }
    const background =
      allowed.scenario && card.selections.scenario
        ? replaceUser(card.background, replacement).trim()
        : ''
    const adoptingBackground = allowed.scenario && card.selections.scenario
    const description =
      adoptingBackground &&
      source.backgroundText &&
      current.description?.includes(source.backgroundText)
        ? current.description.replace(source.backgroundText, () => background).trim() || null
        : background && !current.description?.includes(background)
          ? [current.description, background].filter(Boolean).join('\n\n')
          : current.description
    if (adoptingBackground) updatedSource.backgroundText = background
    await database.collectAtomicWrites(async (writer) => {
      for (const character of chars) await writer.addCharacter(character)
      for (const { value, copy } of updates) {
        if (copy) await writer.addCharacter(value)
        else await writer.updateCharacter(value.id, value)
      }
      await writer.bulkInsertEntries(newEntries)
      await writer.updateStory(storyId, { settings: updatedSettings, description })
      check()
      this.assertNotBusy('采用导入整理')
      if (ui.submissionScope) throw new Error('生成准备期间不能采用导入整理。')
      if (before !== JSON.stringify([this.currentStory, this.characters, this.lorebookEntries]))
        throw new Error('故事资料已经变化，请重新整理。')
    })
    check()
    this.currentStory = { ...current, description, settings: updatedSettings }
    this.characters = [
      ...this.characters.map((c) => updates.find((u) => u.previous.id === c.id)?.value ?? c),
      ...chars,
    ]
    this.lorebookEntries = [...this.lorebookEntries, ...newEntries]
    this.invalidateRetrievalCache()
    return {
      charactersAdded: chars.length,
      charactersUpdated: updates.length,
      loreEntriesAdded: newEntries.length,
    }
  }

  /**
   * Normalize time values, converting overflow/underflow between units.
   * Handles both positive overflow (60 min → 1 hour) and negative underflow (borrowing).
   * 60 minutes → 1 hour, 24 hours → 1 day, 365 days → 1 year
   */
  private normalizeTime(time: TimeTracker): TimeTracker {
    let { years, days, hours, minutes } = time

    // Handle negative minutes by borrowing from hours
    while (minutes < 0 && hours > 0) {
      hours -= 1
      minutes += 60
    }

    // Handle negative hours by borrowing from days
    while (hours < 0 && days > 0) {
      days -= 1
      hours += 24
    }

    // Handle negative days by borrowing from years
    while (days < 0 && years > 0) {
      years -= 1
      days += 365
    }

    // Clamp any remaining negatives to 0 (can't have negative time)
    years = Math.max(0, years)
    days = Math.max(0, days)
    hours = Math.max(0, hours)
    minutes = Math.max(0, minutes)

    // Normalize overflow: minutes to hours
    if (minutes >= 60) {
      hours += Math.floor(minutes / 60)
      minutes = minutes % 60
    }

    // Normalize overflow: hours to days
    if (hours >= 24) {
      days += Math.floor(hours / 24)
      hours = hours % 24
    }

    // Normalize overflow: days to years
    if (days >= 365) {
      years += Math.floor(days / 365)
      days = days % 365
    }

    return { years, days, hours, minutes }
  }

  // Set time tracker directly
  async setTimeTracker(time: TimeTracker): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    const normalized = this.normalizeTime(time)
    await database.saveTimeTracker(this.currentStory.id, normalized)
    this.currentStory = { ...this.currentStory, timeTracker: normalized }
    log('Time tracker set:', normalized)
  }

  // Update time tracker with partial values (adds to current time)
  async addTime(updates: Partial<TimeTracker>, options?: ScopedWriteOptions): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { storyId, check } = this.captureWriteScope(options)

    const current = this.timeTracker
    const newTime: TimeTracker = {
      years: current.years + (updates.years ?? 0),
      days: current.days + (updates.days ?? 0),
      hours: current.hours + (updates.hours ?? 0),
      minutes: current.minutes + (updates.minutes ?? 0),
    }

    const normalized = this.normalizeTime(newTime)
    await database.saveTimeTracker(storyId, normalized)
    check()
    this.currentStory = { ...this.currentStory, timeTracker: normalized }
    log('Time added:', updates, '→', normalized)
  }

  /**
   * Apply time progression from classifier result.
   * Adds a default amount based on the progression type.
   */
  async applyTimeProgression(
    progression: 'none' | 'minutes' | 'hours' | 'days',
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<void> {
    if (progression === 'none') return

    // Default increments for each progression type
    const increments: Record<string, Partial<TimeTracker>> = {
      minutes: { minutes: 15 }, // ~15 minutes for minor actions
      hours: { hours: 2 }, // ~2 hours for moderate time passage
      days: { days: 1 }, // 1 day for significant time jumps
    }

    const increment = increments[progression]
    if (increment) {
      await this.addTimeWithDatabase(increment, options, writeDatabase)
    }
  }

  private async addTimeWithDatabase(
    updates: Partial<TimeTracker>,
    options: ScopedWriteOptions | undefined,
    writeDatabase: DatabaseService,
  ): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { storyId, check } = this.captureWriteScope(options)
    const current = this.timeTracker
    const normalized = this.normalizeTime({
      years: current.years + (updates.years ?? 0),
      days: current.days + (updates.days ?? 0),
      hours: current.hours + (updates.hours ?? 0),
      minutes: current.minutes + (updates.minutes ?? 0),
    })
    await writeDatabase.saveTimeTracker(storyId, normalized)
    check()
    this.currentStory = { ...this.currentStory, timeTracker: normalized }
  }

  /**
   * Restore or clear the story time tracker from a snapshot.
   * Undefined means "skip", null means "clear".
   */
  async restoreTimeTrackerSnapshot(
    snapshot: TimeTracker | null | undefined,
    options?: ScopedWriteOptions,
  ): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { storyId, check } = this.captureWriteScope(options)
    if (snapshot === undefined) return

    if (snapshot === null) {
      await database.clearTimeTracker(storyId)
      check()
      this.currentStory = { ...this.currentStory, timeTracker: null }
      log('Time tracker cleared from snapshot')
      return
    }

    const normalized = this.normalizeTime(snapshot)
    await database.saveTimeTracker(storyId, normalized)
    check()
    this.currentStory = { ...this.currentStory, timeTracker: normalized }
    log('Time tracker restored from snapshot:', normalized)
  }

  /**
   * Phase 1: Maybe create an automatic world state snapshot.
   * Called after saving a delta. Creates a snapshot every N entries (configured interval).
   */
  private async maybeCreateAutoSnapshot(
    entryId: string,
    options?: ScopedWriteOptions,
    writeDatabase: DatabaseService = database,
  ): Promise<void> {
    if (!this.currentStory) return
    const { storyId, branchId, check } = this.captureWriteScope(options)
    if (!settings.experimentalFeatures.stateTracking) return

    const entry = this.entries.find((e) => e.id === entryId)
    if (!entry) return

    const interval = settings.experimentalFeatures.autoSnapshotInterval
    if (interval <= 0) return

    // Only snapshot at interval boundaries
    if (entry.position % interval !== 0) return

    try {
      const snapshot: WorldStateSnapshot = {
        id: crypto.randomUUID(),
        storyId,
        branchId,
        entryId,
        entryPosition: entry.position,
        charactersSnapshot: this.characters.map((c) => ({ ...c })),
        locationsSnapshot: this.locations.map((l) => ({ ...l })),
        itemsSnapshot: this.items.map((i) => ({ ...i })),
        storyBeatsSnapshot: this.storyBeats.map((b) => ({ ...b })),
        lorebookEntriesSnapshot: this.lorebookEntries.map((e) => ({ ...e })),
        timeTrackerSnapshot: this.currentStory.timeTracker
          ? { ...this.currentStory.timeTracker }
          : null,
        createdAt: Date.now(),
      }

      await writeDatabase.createWorldStateSnapshot(snapshot)
      check()
      log('Auto-snapshot created at position', entry.position)
    } catch (error) {
      check()
      console.error('[StoryStore] Failed to create auto-snapshot:', error)
      // Non-fatal
    }
  }

  /**
   * Build a chapter summary for entries[startIndex, endIndex) and persist it.
   * Shared by createManualChapter (single, user-triggered) and
   * chapterizeFromBeginning (batch, sequential loop) — both use a
   * deterministic boundary and a single summarizeChapter call, never
   * analyzeForChapter.
   */
  private async buildAndSaveChapter(startIndex: number, endIndex: number): Promise<Chapter> {
    if (!this.currentStory) throw new Error('No story loaded')

    const chapterEntries = this.entries.slice(startIndex, endIndex)
    if (chapterEntries.length === 0) {
      throw new Error('No entries to create chapter from')
    }

    // Get previous chapters for context (branch-filtered)
    const previousChapters = [...this.currentBranchChapters].sort((a, b) => a.number - b.number)

    // Generate summary with previous chapters as context
    const chapterData = await aiService.summarizeChapter(
      this.currentStory?.id,
      chapterEntries,
      previousChapters,
      this.currentStory?.mode ?? 'adventure',
      this.pov,
      this.tense,
      this.memoryConfig.summaryDetail,
    )

    // Get the next chapter number
    const chapterNumber = await this.getNextChapterNumber()

    // Extract time range from entries' metadata
    const firstEntry = chapterEntries[0]
    const lastEntry = chapterEntries[chapterEntries.length - 1]
    const startTime = firstEntry.metadata?.timeStart ?? null
    const endTime = lastEntry.metadata?.timeEnd ?? null

    // Create the chapter
    const chapter: Chapter = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      number: chapterNumber,
      title: chapterData.title || null,
      startEntryId: chapterEntries[0].id,
      endEntryId: chapterEntries[chapterEntries.length - 1].id,
      entryCount: chapterEntries.length,
      summary: chapterData.summary,
      startTime,
      endTime,
      keywords: chapterData.keywords,
      characters: chapterData.characters,
      locations: chapterData.locations,
      plotThreads: chapterData.plotThreads,
      emotionalTone: chapterData.emotionalTone || null,
      branchId: this.currentStory.currentBranchId,
      createdAt: Date.now(),
    }

    await this.addChapter(chapter)
    return chapter
  }

  // Create a manual chapter at a specific entry index
  /** @returns whether a chapter was actually written; false is a refusal, not a failure. */
  async createManualChapter(endEntryIndex: number): Promise<boolean> {
    if (!this.currentStory) throw new Error('No story loaded')

    // The button is disabled while a turn's background tasks run, but that is the visible
    // half: the check that has to hold is here, because both paths call
    // `buildAndSaveChapter` over `lastChapterEndIndex`, and two of them racing produce two
    // chapters covering the same entries.
    if (ui.backgroundTasksActiveFor(this.currentStory.id, this.currentStory.currentBranchId)) {
      log('Background chapter work in flight, refusing manual chapter creation')
      // Said out loud as well as returned: the caller closes the modal either way, so a
      // silent refusal looks exactly like a chapter that was created.
      ui.showToast(
        'A chapter is already being written for this turn. Try again once it is done.',
        'warning',
      )
      return false
    }

    // Find the start index (after the last chapter or beginning)
    const startIndex = this.lastChapterEndIndex

    // Validate the end index
    if (endEntryIndex <= startIndex || endEntryIndex > this.entries.length) {
      throw new Error('Invalid entry index for chapter creation')
    }

    const chapter = await this.buildAndSaveChapter(startIndex, endEntryIndex)
    log('Manual chapter created:', chapter.number, chapter.title)
    return true
  }

  /**
   * Batch-create chapters for the entire un-chaptered history, starting from
   * lastChapterEndIndex. Never uses analyzeForChapter: boundaries are
   * precomputed deterministically from memoryConfig.tokenThreshold/chapterBuffer.
   * Used after a SillyTavern import to backfill chapters for the whole
   * imported history. Runs strictly sequentially (never in parallel) since
   * each chapter depends on state (lastChapterEndIndex, chapter numbering)
   * written by the previous one.
   */
  async chapterizeFromBeginning(options: {
    includeLorebook: boolean
    includeTimeline: boolean
    includeClassification: boolean
  }): Promise<{ chaptersCreated: number; cancelled: boolean }> {
    if (!this.currentStory) throw new Error('No story loaded')

    this.chapterizationCancelRequested = false
    this.chapterizationProgress = { current: 0, total: 0 }

    try {
      const service = new ChapterBatchService({
        buildAndSaveChapter: this.buildAndSaveChapter.bind(this),
        runLoreManagement: aiService.runLoreManagement.bind(aiService),
        estimateChapterTimeline: aiService.estimateChapterTimeline.bind(aiService),
        getTimeTracker: () => this.timeTracker,
        setTimeTracker: this.setTimeTracker.bind(this),
        updateChapterTimes: (id, startTime, endTime) =>
          this.updateChapter(id, { startTime, endTime }),
        getChapterEntries: this.getChapterEntries.bind(this),
        classifyChapter: (content, currentTime) =>
          aiService.classifyResponse(
            content,
            '', // no single userAction maps onto a whole chapter
            this.worldStateSnapshot,
            this.currentStory ?? undefined,
            undefined, // no "recent chat history" framing — the chapter content IS the input
            currentTime,
          ),
        applyClassificationResult: (result) => this.applyClassificationResult(result),
      })

      const result = await service.run(
        {
          entries: this.entries,
          startIndex: this.lastChapterEndIndex,
          tokenThreshold: this.memoryConfig.tokenThreshold,
          chapterBuffer: this.memoryConfig.chapterBuffer,
          includeLorebook: options.includeLorebook,
          includeTimeline: options.includeTimeline,
          includeClassification: options.includeClassification,
          storyId: this.currentStory.id,
          currentBranchId: this.currentStory.currentBranchId,
          getLorebookEntries: () => this.lorebookEntries,
          mode: this.currentStory.mode ?? 'adventure',
          pov: this.pov,
          tense: this.tense,
        },
        {
          isCancelled: () => this.chapterizationCancelRequested,
          onChapterProgress: (current, total) => {
            this.chapterizationProgress = { current, total }
          },
          onTimelineProgress: (current, total) => {
            this.chapterizationTimelineProgress = { current, total }
          },
          onClassificationProgress: (current, total) => {
            this.chapterizationClassificationProgress = { current, total }
          },
          loreCallbacks: buildLoreManagementCallbacks({
            storyId: this.currentStory.id,
            branchId: this.currentStory.currentBranchId,
          }),
          loreUICallbacks: buildLoreManagementUICallbacks({
            onStatus: (status) => {
              this.chapterizationStatus = status
            },
          }),
        },
      )

      log('Batch chapterization complete', {
        chaptersCreated: result.chapters.length,
        cancelled: result.cancelled,
      })

      return { chaptersCreated: result.chapters.length, cancelled: result.cancelled }
    } finally {
      this.chapterizationProgress = null
      this.chapterizationTimelineProgress = null
      this.chapterizationClassificationProgress = null
      this.chapterizationStatus = null
    }
  }

  // Request cancellation of an in-progress batch chapterization.
  // Takes effect between chapters, not mid AI-call.
  requestChapterizationCancel(): void {
    this.chapterizationCancelRequested = true
  }

  // Create a checkpoint (snapshot of current state)
  async createCheckpoint(name: string): Promise<Checkpoint> {
    if (!this.currentStory) throw new Error('No story loaded')

    const lastEntry = this.entries[this.entries.length - 1]
    if (!lastEntry) throw new Error('No entries to checkpoint')

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      branchId: this.currentStory.currentBranchId,
      name,
      lastEntryId: lastEntry.id,
      lastEntryPreview: lastEntry.content.substring(0, 100),
      entryCount: this.entries.length,
      entriesSnapshot: [...this.entries],
      charactersSnapshot: [...this.characters],
      locationsSnapshot: [...this.locations],
      itemsSnapshot: [...this.items],
      storyBeatsSnapshot: [...this.storyBeats],
      chaptersSnapshot: [...this.chapters],
      timeTrackerSnapshot: this.currentStory.timeTracker
        ? { ...this.currentStory.timeTracker }
        : null,
      lorebookEntriesSnapshot: [...this.lorebookEntries],
      createdAt: Date.now(),
    }

    await database.createCheckpoint(checkpoint)
    this.checkpoints = [checkpoint, ...this.checkpoints]

    // Save current background for this checkpoint
    if (this.currentBgImage) {
      log('Saving background for checkpoint:', name)
      await database.saveBackground(
        this.currentStory.id,
        this.currentStory.currentBranchId,
        checkpoint.id,
        this.currentBgImage,
      )
    }

    log('Checkpoint created:', name)

    // Emit event
    eventBus.emit<CheckpointCreatedEvent>({
      type: 'CheckpointCreated',
      checkpointId: checkpoint.id,
      name,
    })

    return checkpoint
  }

  async renameCheckpoint(checkpointId: string, newName: string): Promise<void> {
    await database.renameCheckpoint(checkpointId, newName)
    this.checkpoints = this.checkpoints.map((checkpoint) =>
      checkpoint.id === checkpointId ? { ...checkpoint, name: newName } : checkpoint,
    )
    log('Checkpoint renamed:', checkpointId, 'to', newName)
  }

  /**
   * @deprecated Checkpoint restoration is no longer supported.
   * Use createBranchFromCheckpoint() instead to explore alternate timelines.
   * This prevents data loss issues when restoring across branches.
   */
  async restoreCheckpoint(_checkpointId: string): Promise<void> {
    throw new Error(
      'Checkpoint restoration is no longer supported. ' +
        'To explore alternate paths, create a new branch from a checkpoint instead.',
    )
  }

  // Delete a checkpoint
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await database.deleteCheckpoint(checkpointId)
    this.checkpoints = this.checkpoints.filter((cp) => cp.id !== checkpointId)
    log('Checkpoint deleted:', checkpointId)
  }

  // ===== Branch Management =====

  /**
   * Get the current branch, or null if on the main branch (for legacy stories)
   */
  get currentBranch(): Branch | null {
    if (!this.currentStory?.currentBranchId) return null
    return this.branches.find((b) => b.id === this.currentStory!.currentBranchId) ?? null
  }

  /**
   * Create a new branch from an existing checkpoint.
   * Only entries with checkpoints can be branched from.
   */
  async createBranchFromCheckpoint(
    name: string,
    forkEntryId: string,
    checkpointId: string,
  ): Promise<Branch> {
    if (!this.currentStory) throw new Error('No story loaded')

    // Verify the checkpoint exists in memory
    const checkpoint = this.checkpoints.find((cp) => cp.id === checkpointId)
    if (!checkpoint) {
      throw new Error('Checkpoint not found in memory')
    }

    // Verify the checkpoint matches the fork entry
    if (checkpoint.lastEntryId !== forkEntryId) {
      throw new Error('Checkpoint does not match fork entry')
    }

    // Verify all foreign key references exist in the database
    const dbCheckpoint = await database.getCheckpoint(checkpointId)
    if (!dbCheckpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found in database`)
    }

    const dbEntry = await database.getStoryEntry(forkEntryId)
    if (!dbEntry) {
      throw new Error(`Fork entry ${forkEntryId} not found in database`)
    }

    const dbStory = await database.getStory(this.currentStory.id)
    if (!dbStory) {
      throw new Error(`Story ${this.currentStory.id} not found in database`)
    }

    // Determine parent branch (current branch, or null for main)
    // IMPORTANT: Ensure it's explicitly null, not undefined
    const parentBranchId = this.currentStory.currentBranchId ?? null

    // If there's a parent branch, verify it exists
    if (parentBranchId !== null) {
      const dbParentBranch = await database.getBranch(parentBranchId)
      if (!dbParentBranch) {
        throw new Error(`Parent branch ${parentBranchId} not found in database`)
      }
    }

    // Create the branch
    const branch: Branch = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      name,
      parentBranchId,
      forkEntryId,
      checkpointId,
      createdAt: Date.now(),
    }

    await database.addBranch(branch)
    this.branches = [...this.branches, branch]

    // Inherit background from checkpoint
    const checkpointBg = await database.getBackgroundForCheckpoint(
      this.currentStory.id,
      checkpointId,
    )
    if (checkpointBg) {
      log('Inheriting background from checkpoint for new branch:', branch.name)
      await database.saveBackground(this.currentStory.id, branch.id, null, checkpointBg)
    }

    // Copy world state from checkpoint into database with the new branch_id
    // This ensures the branch has its own copy of the world state at the fork point
    if (settings.experimentalFeatures.lightweightBranches) {
      // Snapshot isolation: copy all entities from checkpoint into the new branch.
      // Each branch gets its own complete entity set for full isolation.
      log('COW branch: copying entity snapshot for branch isolation')

      // Copy characters
      for (const char of checkpoint.charactersSnapshot) {
        const branchChar: Character = {
          ...char,
          id: crypto.randomUUID(),
          branchId: branch.id,
          overridesId: null,
        }
        await database.addCharacter(branchChar)
      }

      // Copy locations — remap connection IDs to new location IDs
      const locationIdMap = new SvelteMap<string, string>()
      for (const loc of checkpoint.locationsSnapshot) {
        locationIdMap.set(loc.id, crypto.randomUUID())
      }
      for (const loc of checkpoint.locationsSnapshot) {
        const newId = locationIdMap.get(loc.id)!
        const branchLoc: Location = {
          ...loc,
          id: newId,
          branchId: branch.id,
          overridesId: null,
          connections: loc.connections.map((connId) => locationIdMap.get(connId) ?? connId),
        }
        await database.addLocation(branchLoc)
      }

      // Copy items — remap location IDs to the new branch's locations
      for (const item of checkpoint.itemsSnapshot) {
        const remappedLocation =
          item.location === 'inventory'
            ? 'inventory'
            : (locationIdMap.get(item.location) ?? item.location)
        const branchItem: Item = {
          ...item,
          id: crypto.randomUUID(),
          branchId: branch.id,
          overridesId: null,
          location: remappedLocation,
        }
        await database.addItem(branchItem)
      }

      // Copy story beats
      for (const beat of checkpoint.storyBeatsSnapshot) {
        const branchBeat: StoryBeat = {
          ...beat,
          id: crypto.randomUUID(),
          branchId: branch.id,
          overridesId: null,
        }
        await database.addStoryBeat(branchBeat)
      }

      // Copy lorebook entries
      if (checkpoint.lorebookEntriesSnapshot) {
        for (const entry of checkpoint.lorebookEntriesSnapshot) {
          const branchEntry: Entry = {
            ...entry,
            id: crypto.randomUUID(),
            branchId: branch.id,
            overridesId: null,
          }
          await database.addEntry(branchEntry)
        }
      }

      // Mark branch as snapshot-complete so loading uses direct queries (no lineage resolution)
      await database.setBranchSnapshotComplete(branch.id)
      this.branches = this.branches.map((b) =>
        b.id === branch.id ? { ...b, snapshotComplete: true } : b,
      )

      log('COW branch: entity snapshot complete', {
        characters: checkpoint.charactersSnapshot.length,
        locations: checkpoint.locationsSnapshot.length,
        items: checkpoint.itemsSnapshot.length,
        storyBeats: checkpoint.storyBeatsSnapshot.length,
        lorebookEntries: checkpoint.lorebookEntriesSnapshot?.length ?? 0,
      })

      // Create a world state snapshot at the fork point for rollback support
      if (settings.experimentalFeatures.stateTracking) {
        try {
          const snapshot: WorldStateSnapshot = {
            id: crypto.randomUUID(),
            storyId: this.currentStory.id,
            branchId: branch.id,
            entryId: forkEntryId,
            entryPosition: dbEntry.position,
            charactersSnapshot: checkpoint.charactersSnapshot,
            locationsSnapshot: checkpoint.locationsSnapshot,
            itemsSnapshot: checkpoint.itemsSnapshot,
            storyBeatsSnapshot: checkpoint.storyBeatsSnapshot,
            lorebookEntriesSnapshot: checkpoint.lorebookEntriesSnapshot,
            timeTrackerSnapshot: checkpoint.timeTrackerSnapshot ?? null,
            createdAt: Date.now(),
          }
          await database.createWorldStateSnapshot(snapshot)
          log('COW branch: created fork-point snapshot')
        } catch (error) {
          console.error('[StoryStore] Failed to create fork-point snapshot:', error)
        }
      }
    } else {
      // Legacy path: full copy of all entities from checkpoint
      log('Copying world state from checkpoint to branch:', branch.name)

      // Copy characters
      for (const char of checkpoint.charactersSnapshot) {
        const branchChar: Character = { ...char, id: crypto.randomUUID(), branchId: branch.id }
        await database.addCharacter(branchChar)
      }

      // Copy locations - need to remap connection IDs to new location IDs
      const locationIdMap = new SvelteMap<string, string>() // old ID -> new ID
      for (const loc of checkpoint.locationsSnapshot) {
        const newId = crypto.randomUUID()
        locationIdMap.set(loc.id, newId)
      }
      for (const loc of checkpoint.locationsSnapshot) {
        const newId = locationIdMap.get(loc.id)!
        const branchLoc: Location = {
          ...loc,
          id: newId,
          branchId: branch.id,
          // Remap connections to use new location IDs
          connections: loc.connections.map((connId) => locationIdMap.get(connId) ?? connId),
        }
        await database.addLocation(branchLoc)
      }

      // Copy items (remap location IDs to the new branch's locations)
      for (const item of checkpoint.itemsSnapshot) {
        const remappedLocation =
          item.location === 'inventory'
            ? 'inventory'
            : (locationIdMap.get(item.location) ?? item.location)
        const branchItem: Item = {
          ...item,
          id: crypto.randomUUID(),
          branchId: branch.id,
          location: remappedLocation,
        }
        await database.addItem(branchItem)
      }

      // Copy story beats
      for (const beat of checkpoint.storyBeatsSnapshot) {
        const branchBeat: StoryBeat = { ...beat, id: crypto.randomUUID(), branchId: branch.id }
        await database.addStoryBeat(branchBeat)
      }

      // Copy lorebook entries (if snapshot exists)
      if (checkpoint.lorebookEntriesSnapshot) {
        for (const entry of checkpoint.lorebookEntriesSnapshot) {
          const branchEntry: Entry = { ...entry, id: crypto.randomUUID(), branchId: branch.id }
          await database.addEntry(branchEntry)
        }
      }
    }

    // Switch to the new branch. This reloads entries and world state from the database,
    // pulling the copied items into memory — so subscribers of BranchSwitched (and the
    // suggested-action restore inside switchBranch) see the new branch's entries.
    await this.switchBranch(branch.id)

    // Restore time tracker from checkpoint
    if (checkpoint.timeTrackerSnapshot) {
      this.currentStory = {
        ...this.currentStory!,
        timeTracker: { ...checkpoint.timeTrackerSnapshot },
      }
      await database.updateStory(this.currentStory!.id, {
        timeTracker: checkpoint.timeTrackerSnapshot,
      })
      log('Time tracker restored from checkpoint:', checkpoint.timeTrackerSnapshot)
    }

    log('Branch created:', name, 'from checkpoint:', checkpointId, {
      characters: checkpoint.charactersSnapshot.length,
      locations: checkpoint.locationsSnapshot.length,
      items: checkpoint.itemsSnapshot.length,
      storyBeats: checkpoint.storyBeatsSnapshot.length,
      lorebookEntries: checkpoint.lorebookEntriesSnapshot?.length ?? 0,
    })
    return branch
  }

  /** Create an isolated branch from the state immediately after any visible narration entry. */
  async createCollaborativeBranchFromEntry(entryId: string, name: string): Promise<Branch> {
    if (!this.currentStory) throw new Error('没有打开故事。')
    await this.drainClassificationWrites()
    this.assertNotBusy('create a branch')
    const target = this.entries.find((entry) => entry.id === entryId)
    if (!target || target.type !== 'narration') throw new Error('只能从已保存的正文创建分支。')
    const later = this.entries.filter((entry) => entry.position > target.position)
    const rollback = planStateRollback(later, target.position + 1)
    const confirmedRebuild = target.metadata?.collaborativeStateRebuild
    const rebuiltSnapshot = confirmedRebuild
      ? await database.getLatestSnapshotBefore(
          this.currentStory.id,
          this.currentStory.currentBranchId,
          target.position,
        )
      : null
    const currentTargetHash = confirmedRebuild
      ? createCollaborativeStateRebuildRequest({
          storyId: this.currentStory.id,
          branchId: this.currentStory.currentBranchId,
          targetEntryId: target.id,
          targetPosition: target.position,
          entries: this.entries,
        }).historyHash
      : null
    const canUseRebuild =
      !!confirmedRebuild &&
      confirmedRebuild.historyHash === currentTargetHash &&
      rebuiltSnapshot?.entryId === target.id &&
      rebuiltSnapshot.entryPosition === target.position
    const inheritedTarget =
      (target.branchId ?? null) !== (this.currentStory.currentBranchId ?? null)
    if (inheritedTarget && !canUseRebuild) {
      throw new Error('继承正文使用父分支实体 ID；请先重建到此处的状态，再创建分支。')
    }
    if (!rollback.valid && !canUseRebuild) {
      const positions = Array.from(
        new Set(
          rollback.issues.map((issue) => issue.position).filter((value) => value !== undefined),
        ),
      ).sort((a, b) => a! - b!)
      throw new Error(
        `无法安全创建分支：第 ${positions.join('、') || target.position} 条正文缺少完整状态记录。请先重建到目标正文的状态。`,
      )
    }

    const clone = <T>(value: T): T => structuredClone(value)
    let characters = canUseRebuild
      ? clone(rebuiltSnapshot!.charactersSnapshot)
      : clone(this.characters)
    let locations = canUseRebuild
      ? clone(rebuiltSnapshot!.locationsSnapshot)
      : clone(this.locations)
    let items = canUseRebuild ? clone(rebuiltSnapshot!.itemsSnapshot) : clone(this.items)
    let storyBeats = canUseRebuild
      ? clone(rebuiltSnapshot!.storyBeatsSnapshot)
      : clone(this.storyBeats)
    for (const operation of rollback.valid && !canUseRebuild ? rollback.plan.operations : []) {
      const remove = <T extends { id: string }>(values: T[]) =>
        values.filter((value) => value.id !== operation.id)
      const restore = <T extends { id: string }>(values: T[], before: T) =>
        values.map((value) => (value.id === before.id ? { ...value, ...before } : value))
      if (operation.action === 'delete') {
        if (operation.entity === 'character') characters = remove(characters)
        if (operation.entity === 'location') locations = remove(locations)
        if (operation.entity === 'item') items = remove(items)
        if (operation.entity === 'storyBeat') storyBeats = remove(storyBeats)
      } else if (operation.entity === 'character') {
        characters = restore(characters, operation.before as Character)
      } else if (operation.entity === 'location') {
        locations = restore(locations, operation.before as Location)
      } else if (operation.entity === 'item') {
        items = restore(items, operation.before as Item)
      } else {
        storyBeats = restore(storyBeats, operation.before as StoryBeat)
      }
    }
    if (rollback.valid && !canUseRebuild && rollback.plan.targetCurrentLocationId !== undefined) {
      locations = locations.map((location) => ({
        ...location,
        current: location.id === rollback.plan.targetCurrentLocationId,
      }))
    }

    const sourceParentId = target.branchId ?? null
    const branch: Branch = {
      id: crypto.randomUUID(),
      storyId: this.currentStory.id,
      name: name.trim(),
      parentBranchId: sourceParentId,
      forkEntryId: target.id,
      checkpointId: null,
      createdAt: Date.now(),
      snapshotComplete: true,
    }
    if (!branch.name) throw new Error('分支名称不能为空。')
    const idMap = new SvelteMap<string, string>()
    for (const entity of [
      ...characters,
      ...locations,
      ...items,
      ...storyBeats,
      ...this.lorebookEntries,
    ]) {
      idMap.set(entity.id, crypto.randomUUID())
    }
    const remapId = (id: string) => idMap.get(id) ?? id
    const branchCharacters = characters.map((character) => ({
      ...character,
      id: remapId(character.id),
      branchId: branch.id,
      overridesId: null,
    }))
    const branchLocations = locations.map((location) => ({
      ...location,
      id: remapId(location.id),
      branchId: branch.id,
      overridesId: null,
      connections: location.connections.map(remapId),
    }))
    const branchItems = items.map((item) => ({
      ...item,
      id: remapId(item.id),
      branchId: branch.id,
      overridesId: null,
      location: item.location === 'inventory' ? 'inventory' : remapId(item.location),
    }))
    const branchBeats = storyBeats.map((beat) => ({
      ...beat,
      id: remapId(beat.id),
      branchId: branch.id,
      overridesId: null,
    }))
    const branchLore = this.lorebookEntries.map((entry) => ({
      ...entry,
      id: remapId(entry.id),
      branchId: branch.id,
      overridesId: null,
    }))
    const timeTracker: TimeTracker | null = canUseRebuild
      ? clone(rebuiltSnapshot!.timeTrackerSnapshot)
      : rollback.valid && rollback.plan.targetTimeTracker === undefined
        ? clone(this.currentStory.timeTracker)
        : clone(rollback.valid ? (rollback.plan.targetTimeTracker ?? null) : null)
    const snapshot: WorldStateSnapshot = {
      id: crypto.randomUUID(),
      storyId: branch.storyId,
      branchId: branch.id,
      entryId: target.id,
      entryPosition: target.position,
      charactersSnapshot: branchCharacters,
      locationsSnapshot: branchLocations,
      itemsSnapshot: branchItems,
      storyBeatsSnapshot: branchBeats,
      lorebookEntriesSnapshot: branchLore,
      timeTrackerSnapshot: timeTracker,
      createdAt: Date.now(),
    }

    await database.collectAtomicWrites(async (writer) => {
      await writer.addBranch(branch)
      for (const value of branchCharacters) await writer.addCharacter(value)
      for (const value of branchLocations) await writer.addLocation(value)
      for (const value of branchItems) await writer.addItem(value)
      for (const value of branchBeats) await writer.addStoryBeat(value)
      for (const value of branchLore) await writer.addEntry(value)
      await writer.createWorldStateSnapshot(snapshot)
    })
    this.branches = [...this.branches, branch]
    await this.switchBranch(branch.id)
    await this.restoreTimeTrackerSnapshot(timeTracker)
    const settingsValue = this.currentStory?.settings
    if (settingsValue) {
      await this.updateStorySettings({
        collaborativeNovelPlan: settingsValue.collaborativeNovelPlan
          ? { ...settingsValue.collaborativeNovelPlan, needsReview: true }
          : undefined,
        collaborativeNovelPattern: settingsValue.collaborativeNovelPattern
          ? { ...settingsValue.collaborativeNovelPattern, needsReview: true }
          : undefined,
      })
    }
    return branch
  }

  private buildBranchLineage(branchId: string): Branch[] {
    const lineage: Branch[] = []
    let current: Branch | null = this.branches.find((b) => b.id === branchId) ?? null
    const visited = new SvelteSet<string>()

    while (current) {
      if (visited.has(current.id)) break
      visited.add(current.id)
      lineage.unshift(current)
      const parentId = current.parentBranchId
      if (!parentId) break
      current = this.branches.find((b) => b.id === parentId) ?? null
    }

    return lineage
  }

  private async getForkEntryPositions(
    lineage: Branch[],
  ): Promise<SvelteMap<string, number | null>> {
    const entries = await Promise.all(
      lineage.map((branch) => database.getStoryEntry(branch.forkEntryId)),
    )
    const positions = new SvelteMap<string, number | null>()
    entries.forEach((entry, index) => {
      positions.set(lineage[index].id, entry?.position ?? null)
    })
    return positions
  }

  private getCheckpointBranchId(checkpoint: Checkpoint): string | null {
    const lastEntry = checkpoint.entriesSnapshot.find((e) => e.id === checkpoint.lastEntryId)
    return lastEntry?.branchId ?? null
  }

  /** Tail of the branch-switch queue — see switchBranch. */
  private branchSwitchChain: Promise<unknown> = Promise.resolve()
  /** Sequence of the most recently requested switch; older queued ones are superseded. */
  private branchSwitchSeq = 0

  /**
   * Switch to a different branch.
   * This reloads entries from the database filtered by the target branch.
   * NO data is deleted - branches coexist in the database with different branch_ids.
   * Entries are always reloaded before BranchSwitched is emitted, so subscribers
   * never observe the previous branch's entries.
   * Calls are serialized and last-one-wins: when switches queue up, only the most
   * recent target is loaded — superseded requests resolve without doing any work.
   * @param branchId - The branch to switch to (null for main branch)
   */
  async switchBranch(branchId: string | null): Promise<void> {
    // Overlapping switches would interleave their reloads: reloadEntriesForCurrentBranch
    // reads currentBranchId when it starts and assigns this.entries when its queries
    // resolve, so the slower call assigns last and leaves entries out of step with
    // currentBranchId — with BranchSwitched announcing a branch whose entries aren't
    // loaded. Queue each switch behind the one before it.
    const seq = ++this.branchSwitchSeq
    // Bind the request to the story it was made for: by the time it reaches the front
    // of the queue the user may have opened a different story, and a null branchId
    // would sail past the branch validation and write onto that story instead.
    const storyId = this.currentStory?.id ?? null
    const run = this.branchSwitchChain.then(
      () => this.performBranchSwitch(branchId, seq, storyId),
      // Run regardless of whether the previous switch settled or threw
      () => this.performBranchSwitch(branchId, seq, storyId),
    )
    // Keep the chain resolved so one failure can't poison later switches; the
    // caller still observes the error through `run`.
    this.branchSwitchChain = run.catch(() => {})
    return run
  }

  private async performBranchSwitch(
    branchId: string | null,
    seq: number,
    storyId: string | null,
  ): Promise<void> {
    // Last one wins: a newer switch was requested while this one waited in the queue.
    // Skip the database write, the reload and the event — the newer request loads the
    // final target, so doing this one's work first would only be discarded.
    if (seq !== this.branchSwitchSeq) return

    // The story changed under a queued switch; it no longer refers to anything current
    if (this.currentStory?.id !== storyId) return

    if (!this.currentStory) throw new Error('No story loaded')
    await this.drainClassificationWrites()
    if (seq !== this.branchSwitchSeq || this.currentStory?.id !== storyId) return

    // Validate branch exists (if not null)
    if (branchId !== null) {
      const branch = this.branches.find((b) => b.id === branchId)
      if (!branch) throw new Error('Branch not found')
    }

    // Update story's current branch in database
    await database.setStoryCurrentBranch(this.currentStory.id, branchId)
    this.currentStory = { ...this.currentStory, currentBranchId: branchId }

    // Reload entries from the database for the target branch
    await this.reloadEntriesForCurrentBranch()

    // Invalidate caches
    this.invalidateWordCountCache()
    this.invalidateChapterCache()
    // Two branches commonly sit at the same position with the same lorebook and differ
    // only in history, which is the easiest way to hand one branch the other's Tier 3
    // verdict. The key covers this on its own now; clearing keeps the cache from
    // depending on that alone, as it already does on story switch.
    clearTier3SelectionCache()
    clearImageMarkerCache()

    // Announce once entries and caches are correct. Emitted before the
    // background/suggestion restores below so a failure in either can't
    // silently swallow the notification.
    eventBus.emit<BranchSwitchedEvent>({ type: 'BranchSwitched', branchId })

    // Reload background from database for the branch
    this.currentBgImage = await database.getBackgroundForBranch(this.currentStory.id, branchId)

    // Restore suggested actions from the new branch's last narration entry
    // Without this, stale actions from the previous branch persist in the UI
    this.restoreSuggestedActionsAfterDelete()

    log('Switched to branch:', branchId ?? 'main')
  }

  /**
   * Reload entries and world state from database for the current branch.
   * World state is now persisted per-branch in the database via branch_id columns.
   * - For main branch: loads only items with null branch_id
   * - For other branches: loads inherited items (null branch_id) + branch-specific items
   */
  private async reloadEntriesForCurrentBranch(options?: ScopedWriteOptions): Promise<void> {
    const check = options ? this.captureWriteScope(options).check : () => {}
    if (!this.currentStory) return

    const storyId = this.currentStory.id
    const branchId = this.currentStory.currentBranchId

    if (branchId === null) {
      // Main branch: load all data with null branch_id
      const [entries, chapters, characters, locations, items, storyBeats, lorebookEntries] =
        await Promise.all([
          database.getStoryEntriesForBranch(storyId, null),
          database.getChaptersForBranch(storyId, null),
          database.getCharactersForBranch(storyId, null),
          database.getLocationsForBranch(storyId, null),
          database.getItemsForBranch(storyId, null),
          database.getStoryBeatsForBranch(storyId, null),
          database.getEntriesForBranch(storyId, null),
        ])
      check()

      this.entries = entries
      this.chapters = chapters
      this.characters = characters
      this.locations = locations
      this.items = items
      this.storyBeats = storyBeats
      this.lorebookEntries = lorebookEntries

      // Filter out tombstoned entities when COW is enabled
      if (settings.experimentalFeatures.lightweightBranches) {
        this.characters = this.characters.filter((c) => !c.deleted)
        this.locations = this.locations.filter((l) => !l.deleted)
        this.items = this.items.filter((i) => !i.deleted)
        this.storyBeats = this.storyBeats.filter((b) => !b.deleted)
        this.lorebookEntries = this.lorebookEntries.filter((e) => !e.deleted)
      }
    } else {
      // Non-main branch: load entries across branch lineage (main -> ancestors -> current)
      const lineage = this.buildBranchLineage(branchId)
      if (lineage.length === 0) return

      const forkPositions = await this.getForkEntryPositions(lineage)
      check()
      const rootForkPosition = forkPositions.get(lineage[0].id)

      const inheritedEntries = await database.getStoryEntriesForBranch(
        storyId,
        null,
        rootForkPosition ?? undefined,
      )
      check()

      const branchEntries: StoryEntry[] = []
      for (let i = 0; i < lineage.length; i++) {
        const branch = lineage[i]
        const childForkPosition =
          i < lineage.length - 1 ? forkPositions.get(lineage[i + 1].id) : undefined
        const entries = await database.getStoryEntriesForBranch(
          storyId,
          branch.id,
          childForkPosition ?? undefined,
        )
        check()
        branchEntries.push(...entries)
      }

      this.entries = [...inheritedEntries, ...branchEntries].sort((a, b) => a.position - b.position)

      const entryPositions = new SvelteMap<string, number>()
      for (const entry of this.entries) {
        entryPositions.set(entry.id, entry.position)
      }

      const chapters: Chapter[] = []
      const mainChapters = await database.getChaptersForBranch(storyId, null)
      check()
      if (rootForkPosition === null || rootForkPosition === undefined) {
        chapters.push(...mainChapters)
      } else {
        chapters.push(
          ...mainChapters.filter((ch) => {
            const endPosition = entryPositions.get(ch.endEntryId)
            return endPosition !== undefined && endPosition <= rootForkPosition
          }),
        )
      }

      for (let i = 0; i < lineage.length; i++) {
        const branch = lineage[i]
        const childForkPosition =
          i < lineage.length - 1 ? forkPositions.get(lineage[i + 1].id) : undefined
        const branchChapters = await database.getChaptersForBranch(storyId, branch.id)
        check()
        if (childForkPosition === null || childForkPosition === undefined) {
          chapters.push(...branchChapters)
        } else {
          chapters.push(
            ...branchChapters.filter((ch) => {
              const endPosition = entryPositions.get(ch.endEntryId)
              return endPosition !== undefined && endPosition <= childForkPosition
            }),
          )
        }
      }

      this.chapters = chapters.sort((a, b) => a.number - b.number)

      // Load world state from database
      // COW branches use resolved loading (walks lineage), legacy branches use direct loading
      let characters: Character[]
      let locations: Location[]
      let items: Item[]
      let storyBeats: StoryBeat[]
      let lorebookEntries: Entry[]

      if (settings.experimentalFeatures.lightweightBranches) {
        const currentBranchInfo = this.branches.find((b) => b.id === branchId)
        if (currentBranchInfo?.snapshotComplete) {
          // Snapshot isolation: branch has its own complete entity set
          ;[characters, locations, items, storyBeats, lorebookEntries] = await Promise.all([
            database.getCharactersForBranch(storyId, branchId),
            database.getLocationsForBranch(storyId, branchId),
            database.getItemsForBranch(storyId, branchId),
            database.getStoryBeatsForBranch(storyId, branchId),
            database.getEntriesForBranch(storyId, branchId),
          ])
          check()
          // Filter out tombstoned entities
          characters = characters.filter((c) => !c.deleted)
          locations = locations.filter((l) => !l.deleted)
          items = items.filter((i) => !i.deleted)
          storyBeats = storyBeats.filter((b) => !b.deleted)
          lorebookEntries = lorebookEntries.filter((e) => !e.deleted)
          log('Snapshot isolation: loaded entities for branch:', branchId, {
            characters: characters.length,
            locations: locations.length,
            items: items.length,
            storyBeats: storyBeats.length,
            lorebookEntries: lorebookEntries.length,
          })
        } else {
          // Legacy COW: resolve through lineage (pre-snapshot branches)
          ;[characters, locations, items, storyBeats, lorebookEntries] = await Promise.all([
            database.getCharactersResolved(storyId, lineage),
            database.getLocationsResolved(storyId, lineage),
            database.getItemsResolved(storyId, lineage),
            database.getStoryBeatsResolved(storyId, lineage),
            database.getLorebookEntriesResolved(storyId, lineage),
          ])
          check()
          log('COW: Resolved world state through lineage for branch:', branchId, {
            lineageDepth: lineage.length,
            characters: characters.length,
            locations: locations.length,
            items: items.length,
            storyBeats: storyBeats.length,
            lorebookEntries: lorebookEntries.length,
          })
        }
      } else {
        // Legacy path: direct branch loading (entities were fully copied at branch creation)
        ;[characters, locations, items, storyBeats, lorebookEntries] = await Promise.all([
          database.getCharactersForBranch(storyId, branchId),
          database.getLocationsForBranch(storyId, branchId),
          database.getItemsForBranch(storyId, branchId),
          database.getStoryBeatsForBranch(storyId, branchId),
          database.getEntriesForBranch(storyId, branchId),
        ])
        check()
      }

      this.characters = characters
      this.locations = locations
      this.items = items
      this.storyBeats = storyBeats
      this.lorebookEntries = lorebookEntries

      // Get the current branch name from lineage for logging
      const currentBranch = lineage[lineage.length - 1]
      log('Loaded world state for branch:', currentBranch?.name ?? branchId, {
        characters: characters.length,
        locations: locations.length,
        items: items.length,
        storyBeats: storyBeats.length,
        lorebookEntries: lorebookEntries.length,
      })
    }

    // Restore time tracker from the last entry's metadata
    await this.restoreTimeFromLastEntry(options)
    check()
  }

  /**
   * Restore time tracker from the last entry's timeEnd metadata.
   * Called after loading entries for a branch to ensure time consistency.
   */
  private async restoreTimeFromLastEntry(options?: ScopedWriteOptions): Promise<void> {
    const check = options ? this.captureWriteScope(options).check : () => {}
    if (!this.currentStory || this.entries.length === 0) return
    const storyId = this.currentStory.id

    const lastEntry = this.entries[this.entries.length - 1]
    const timeEnd = lastEntry.metadata?.timeEnd

    if (timeEnd && typeof timeEnd === 'object') {
      const newTime = timeEnd as TimeTracker
      // Only update if different to avoid unnecessary DB writes
      const current = this.currentStory.timeTracker
      if (
        !current ||
        current.years !== newTime.years ||
        current.days !== newTime.days ||
        current.hours !== newTime.hours ||
        current.minutes !== newTime.minutes
      ) {
        this.currentStory = { ...this.currentStory, timeTracker: newTime }
        await database.updateStory(storyId, { timeTracker: newTime })
        check()
        log('Time tracker restored from last entry:', newTime)
      }
    }
  }

  /**
   * Rename a branch.
   */
  async renameBranch(branchId: string, newName: string): Promise<void> {
    await database.updateBranch(branchId, { name: newName })
    this.branches = this.branches.map((b) => (b.id === branchId ? { ...b, name: newName } : b))
    log('Branch renamed:', branchId, 'to', newName)
  }

  /**
   * Delete a branch.
   * Cannot delete the main branch (null), the current branch, or branches with children.
   */
  async deleteBranch(branchId: string): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')

    // Cannot delete current branch
    if (this.currentStory.currentBranchId === branchId) {
      throw new Error('Cannot delete the current branch')
    }

    // Cannot delete branches that have child branches
    const childBranches = this.branches.filter((b) => b.parentBranchId === branchId)
    if (childBranches.length > 0) {
      const childNames = childBranches.map((b) => `"${b.name}"`).join(', ')
      throw new Error(
        `Cannot delete this branch because it has child branches: ${childNames}. ` +
          `Delete the child branches first.`,
      )
    }

    // Delete associated checkpoints first
    const checkpointsToDelete = this.checkpoints.filter(
      (checkpoint) => this.getCheckpointBranchId(checkpoint) === branchId,
    )
    await Promise.all(checkpointsToDelete.map((cp) => database.deleteCheckpoint(cp.id)))
    this.checkpoints = this.checkpoints.filter(
      (checkpoint) => this.getCheckpointBranchId(checkpoint) !== branchId,
    )

    // Delete the branch from database
    await database.deleteBranch(branchId)

    // Update in-memory state: remove deleted branch
    // Note: We already checked that there are no child branches, so no reparenting needed
    this.branches = this.branches.filter((b) => b.id !== branchId)

    log('Branch deleted:', branchId)
  }

  /**
   * Get the total entry count for a branch including inherited history.
   */
  async getBranchEntryCount(branchId: string | null): Promise<number> {
    if (!this.currentStory) return 0

    if (branchId === null) {
      const entries = await database.getStoryEntriesForBranch(this.currentStory.id, null)
      return entries.length
    }

    const lineage = this.buildBranchLineage(branchId)
    if (lineage.length === 0) return 0

    const forkPositions = await this.getForkEntryPositions(lineage)
    const rootForkPosition = forkPositions.get(lineage[0].id)

    let count = 0
    const mainEntries = await database.getStoryEntriesForBranch(
      this.currentStory.id,
      null,
      rootForkPosition ?? undefined,
    )
    count += mainEntries.length

    for (let i = 0; i < lineage.length; i++) {
      const branch = lineage[i]
      const childForkPosition =
        i < lineage.length - 1 ? forkPositions.get(lineage[i + 1].id) : undefined
      const entries = await database.getStoryEntriesForBranch(
        this.currentStory.id,
        branch.id,
        childForkPosition ?? undefined,
      )
      count += entries.length
    }

    return count
  }

  /**
   * Get the branch tree structure for UI display.
   * Returns branches organized by parent-child relationships.
   */
  getBranchTree(): { branch: Branch | null; children: Branch[] }[] {
    // Build tree starting from root (null parent = main branch children)
    const rootBranches = this.branches.filter((b) => b.parentBranchId === null)
    const tree: { branch: Branch | null; children: Branch[] }[] = []

    // Main branch (implicit)
    tree.push({
      branch: null, // null represents main branch
      children: rootBranches,
    })

    // Add all branches with their children
    for (const branch of this.branches) {
      const children = this.branches.filter((b) => b.parentBranchId === branch.id)
      tree.push({ branch, children })
    }

    return tree
  }

  /**
   * Restore story state from a retry backup.
   * Used by the "retry last message" feature to restore state before a user action
   * and allow regeneration.
   */
  async restoreFromRetryBackup(backup: {
    entries: StoryEntry[]
    characters: Character[]
    locations: Location[]
    items: Item[]
    storyBeats: StoryBeat[]
    lorebookEntries?: Entry[] // Optional - lorebook entries persist across retry operations
    timeTracker?: TimeTracker | null
    entryCountBeforeAction: number
  }): Promise<void> {
    if (!this.currentStory) throw new Error('No story loaded')
    const { storyId, branchId, check } = this.captureWriteScope()
    const scoped: ScopedWriteOptions = {
      scope: { storyId, branchId },
      isScopeCurrent: () => {
        check()
        return true
      },
    }

    // Lock editing during retry restore to prevent race conditions
    this._isRetryInProgress = true
    log('Retry restore started - editing locked')

    try {
      await this.drainClassificationWrites(scoped)
      check()
      // Debug: Log character visual descriptors before restore
      const currentCharDescriptors = this.characters.map((c) => ({
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      }))
      const backupCharDescriptors = backup.characters.map((c) => ({
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      }))
      log('RESTORE DEBUG - Before restore:', {
        currentCharDescriptors,
        backupCharDescriptors,
      })

      // Determine entries to delete (those added since the backup)
      const entriesToDelete = this.entries.filter(
        (e) => e.position >= backup.entryCountBeforeAction,
      )
      const entryIdsToDelete = entriesToDelete.map((e) => e.id)
      const droppedCheckpoints = this.checkpointsAnchoredTo(new Set(entryIdsToDelete))

      log('Restoring from retry backup...', {
        entriesCount: backup.entries.length,
        currentEntriesCount: this.entries.length,
        entriesToDelete: entryIdsToDelete.length,
      })

      this.assertNoBranchForkAtOrAfter(backup.entryCountBeforeAction)

      // Restore to database (branch-aware: only delete/restore world state for current branch)
      await database.restoreRetryBackup(
        entryIdsToDelete,
        storyId,
        branchId,
        backup.characters,
        backup.locations,
        backup.items,
        backup.storyBeats,
      )
      check()

      if (droppedCheckpoints.length > 0) {
        await database.deleteCheckpoints(droppedCheckpoints.map((cp) => cp.id))
        check()
        this.forgetCheckpoints(droppedCheckpoints)
      }

      // Reload from database using branch-aware method for clean state
      await this.reloadEntriesForCurrentBranch(scoped)
      check()

      // Debug: Log what we got back from database
      const dbCharDescriptors = this.characters.map((c) => ({
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      }))
      log('RESTORE DEBUG - After DB reload:', {
        dbCharDescriptors,
      })

      // Invalidate caches after state restore
      this.invalidateWordCountCache()
      this.invalidateChapterCache()

      // Debug: Verify memory state matches
      const finalCharDescriptors = this.characters.map((c) => ({
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      }))
      log('RESTORE DEBUG - Final state:', {
        finalCharDescriptors,
      })

      // Restore time tracker if provided (null clears)
      await this.restoreTimeTrackerSnapshot(backup.timeTracker, scoped)
      check()

      log('Retry backup restored', {
        entries: this.entries.length,
        characters: this.characters.length,
        locations: this.locations.length,
      })
    } finally {
      // Always unlock editing when restore completes or fails
      this._isRetryInProgress = false
      log('Retry restore completed - editing unlocked')
    }
  }

  /**
   * Lock editing during retry operations.
   * Used by persistent restore path that doesn't call restoreFromRetryBackup.
   */
  lockRetryInProgress(): void {
    this._isRetryInProgress = true
    log('Retry operation locked - editing disabled')
  }

  /**
   * Unlock editing after retry operations complete.
   * Used by persistent restore path that doesn't call restoreFromRetryBackup.
   */
  unlockRetryInProgress(): void {
    this._isRetryInProgress = false
    log('Retry operation unlocked - editing enabled')
  }

  /**
   * Restore character state fields from persistent retry snapshots.
   * Used for retry restores that don't have full state snapshots.
   */
  async restoreCharacterSnapshots(snapshots?: PersistentCharacterSnapshot[]): Promise<void> {
    log('restoreCharacterSnapshots called', {
      hasCurrentStory: !!this.currentStory,
      snapshotsCount: snapshots?.length ?? 0,
      snapshots: snapshots?.map((s) => ({ id: s.id, visualDescriptors: s.visualDescriptors })),
      currentCharacters: this.characters.map((c) => ({
        id: c.id,
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      })),
    })

    if (!this.currentStory || !snapshots || snapshots.length === 0) {
      log('restoreCharacterSnapshots: early return - no story or no snapshots')
      return
    }

    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
    const updates: Array<{ id: string; updates: Partial<Character> }> = []

    for (const character of this.characters) {
      const snapshot = snapshotById.get(character.id)
      if (!snapshot) continue

      let relationship = snapshot.relationship ?? character.relationship
      if (character.relationship === 'self' && relationship !== 'self') {
        relationship = 'self'
      }

      updates.push({
        id: character.id,
        updates: {
          traits: snapshot.traits ?? [],
          status: snapshot.status ?? character.status,
          relationship,
          visualDescriptors: snapshot.visualDescriptors ?? {},
          portrait: snapshot.portrait,
        },
      })
    }

    for (const update of updates) {
      await database.updateCharacter(update.id, update.updates)
    }

    this.characters = this.characters.map((character) => {
      const snapshot = snapshotById.get(character.id)
      if (!snapshot) return character

      let relationship = snapshot.relationship ?? character.relationship
      if (character.relationship === 'self' && relationship !== 'self') {
        relationship = 'self'
      }

      return {
        ...character,
        traits: snapshot.traits ?? character.traits,
        status: snapshot.status ?? character.status,
        relationship,
        visualDescriptors: snapshot.visualDescriptors ?? character.visualDescriptors,
        portrait: snapshot.portrait, // Use snapshot value directly (null means no portrait)
      }
    })

    log('restoreCharacterSnapshots complete', {
      updatedCount: updates.length,
      finalCharacters: this.characters.map((c) => ({
        id: c.id,
        name: c.name,
        visualDescriptors: c.visualDescriptors,
      })),
    })
  }

  // Delete a story
  async deleteStory(storyId: string): Promise<void> {
    await database.deleteStory(storyId)
    this.allStories = this.allStories.filter((s) => s.id !== storyId)

    if (this.currentStory?.id === storyId) {
      this.clearCurrentStory()
    }
  }

  // Rename a story
  async renameStory(storyId: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) return

    await database.updateStory(storyId, { title: trimmed })

    // updateStory always stamps updated_at, so mirror that onto both in-memory copies
    // rather than letting the library card and the open story disagree about it.
    const updatedAt = Date.now()
    this.allStories = this.allStories.map((s) =>
      s.id === storyId ? { ...s, title: trimmed, updatedAt } : s,
    )

    if (this.currentStory?.id === storyId) {
      this.currentStory = { ...this.currentStory, title: trimmed, updatedAt }
    }
  }

  /**
   * Create a new story from wizard data.
   * This handles the full initialization from the setup wizard including
   * dynamically generated settings, protagonist, characters, and opening scene.
   */
  async createStoryFromWizard(data: {
    title: string
    genre: string
    description?: string
    mode: StoryMode
    settings: {
      pov: 'first' | 'second' | 'third'
      tense: 'past' | 'present'
      tone?: string
      themes?: string[]
      visualProseMode?: boolean
      imageGenerationMode?: ImageGenerationMode
      backgroundImagesEnabled?: boolean
      referenceMode?: boolean
      targetLength?: TargetLength
    }
    protagonist: Partial<Character>
    startingLocation: Partial<Location>
    initialItems: Partial<Item>[]
    openingScene?: string
    initialUserInput?: string
    openingVariants?: string[]
    selectedOpeningVariantId?: string
    characters: Partial<Character>[]
    importedEntries?: LorebookImportExport.ImportedEntry[]
    packId?: string | null
    customVariableValues?: Record<string, string> | null
    chatMessages?: STChatMessage[]
    importEntrySourceKeys?: string[]
    importSource?: import('$lib/types').StoryImportSource
    // Translation data (optional)
    translations?: {
      language: string
      openingScene?: string
      protagonist?: {
        name?: string
        description?: string
        traits?: string[]
        visualDescriptors?: string[]
      }
      startingLocation?: { name?: string; description?: string }
      characters?: {
        [originalName: string]: {
          name?: string
          description?: string
          relationship?: string
          traits?: string[]
          visualDescriptors?: string[]
        }
      }
    }
  }): Promise<Story> {
    log('createStoryFromWizard called', {
      title: data.title,
      genre: data.genre,
      mode: data.mode,
      pov: data.settings.pov,
      visualProseMode: data.settings.visualProseMode,
      imageGenerationMode: data.settings.imageGenerationMode,
      backgroundImagesEnabled: data.settings.backgroundImagesEnabled,
      referenceMode: data.settings.referenceMode,
    })

    // Creative stories always use the managed AIRP pack, even when callers omit packId.
    // This keeps direct integrations and the advanced wizard consistent with Quick Start.
    const resolvedPackId =
      data.mode === 'creative-writing'
        ? (data.packId ?? (await packService.ensureCollaborativePack()).id)
        : (data.packId ?? null)

    const { storyData, openingEntry } = await database.collectAtomicWrites(async (writer) => {
      const importSource = data.importSource ? structuredClone(data.importSource) : undefined
      // Create the base story with custom system prompt stored in settings
      const storyData = await writer.createStory({
        id: crypto.randomUUID(),
        title: data.title,
        description: data.description ?? null,
        genre: data.genre,
        templateId: 'wizard-generated',
        mode: data.mode,
        settings: {
          pov: data.settings.pov,
          tense: data.settings.tense,
          tone: data.settings.tone,
          themes: data.settings.themes,
          visualProseMode: data.settings.visualProseMode,
          imageGenerationMode: data.settings.imageGenerationMode,
          backgroundImagesEnabled: data.settings.backgroundImagesEnabled,
          referenceMode: data.settings.referenceMode,
          targetLength: data.settings.targetLength,
          ...(importSource ? { importSource } : {}),
          ...(data.mode === 'creative-writing'
            ? { collaborativeNovelWorkflow: createDefaultCollaborativeWorkflow() }
            : {}),
        },
        memoryConfig: DEFAULT_MEMORY_CONFIG,
        retryState: null,
        styleReviewState: null,
        timeTracker: null,
        currentBranchId: null,
        currentBgImage: null,
        packId: resolvedPackId,
        customVariableValues: data.customVariableValues ?? null,
      })

      const storyId = storyData.id

      // Add protagonist
      if (data.protagonist.name) {
        const protagonistTranslation = data.translations?.protagonist
        const protagonist: Character = {
          id: crypto.randomUUID(),
          storyId,
          name: data.protagonist.name,
          description: data.protagonist.description ?? null,
          relationship: 'self',
          traits: data.protagonist.traits ?? [],
          status: 'active',
          metadata: { source: 'wizard' },
          visualDescriptors: data.protagonist.visualDescriptors ?? {},
          portrait: data.protagonist.portrait ?? null,
          branchId: null, // New stories start on main branch
          translatedName: protagonistTranslation?.name ?? null,
          translatedDescription: protagonistTranslation?.description ?? null,
          translatedTraits: protagonistTranslation?.traits ?? null,
          translatedVisualDescriptors: undefined, // Translations not supported for structured visual descriptors yet
          translationLanguage: protagonistTranslation
            ? (data.translations?.language ?? null)
            : null,
        }
        await writer.addCharacter(protagonist)
        log('Added protagonist:', protagonist.name)
      }

      // Add starting location
      if (data.startingLocation.name) {
        const locationTranslation = data.translations?.startingLocation
        log('Starting location translation data:', {
          hasTranslations: !!data.translations,
          hasStartingLocation: !!locationTranslation,
          translatedName: locationTranslation?.name,
          translatedDesc: locationTranslation?.description?.substring(0, 50),
        })
        const location: Location = {
          id: crypto.randomUUID(),
          storyId,
          name: data.startingLocation.name,
          description: data.startingLocation.description ?? null,
          visited: true,
          current: true,
          connections: [],
          metadata: { source: 'wizard' },
          branchId: null, // New stories start on main branch
          translatedName: locationTranslation?.name ?? null,
          translatedDescription: locationTranslation?.description ?? null,
          translationLanguage: locationTranslation ? (data.translations?.language ?? null) : null,
        }
        log('Location object being stored:', {
          name: location.name,
          translatedName: location.translatedName,
          translatedDesc: location.translatedDescription?.substring(0, 50),
          translationLanguage: location.translationLanguage,
        })
        await writer.addLocation(location)
        log(
          'Added starting location:',
          location.name,
          'with translation:',
          !!location.translatedDescription,
        )
      }

      // Add initial items
      for (const itemData of data.initialItems) {
        if (!itemData.name) continue
        const item: Item = {
          id: crypto.randomUUID(),
          storyId,
          name: itemData.name,
          description: itemData.description ?? null,
          quantity: itemData.quantity ?? 1,
          equipped: itemData.equipped ?? false,
          location: itemData.location ?? 'inventory',
          metadata: { source: 'wizard' },
          branchId: null, // New stories start on main branch
        }
        await writer.addItem(item)
      }

      // Add supporting characters
      for (const charData of data.characters) {
        if (!charData.name) continue
        const charTranslation = data.translations?.characters?.[charData.name]
        const character: Character = {
          id: crypto.randomUUID(),
          storyId,
          name: charData.name,
          description: charData.description ?? null,
          relationship: charData.relationship === 'self' ? null : (charData.relationship ?? null),
          traits: charData.traits ?? [],
          status: 'active',
          metadata: { ...charData.metadata, source: 'wizard' },
          visualDescriptors: charData.visualDescriptors ?? {},
          portrait: charData.portrait ?? null,
          branchId: null, // New stories start on main branch
          translatedName: charTranslation?.name ?? null,
          translatedDescription: charTranslation?.description ?? null,
          translatedRelationship: charTranslation?.relationship ?? null,
          translatedTraits: charTranslation?.traits ?? null,
          translatedVisualDescriptors: undefined, // Translations not supported for structured visual descriptors yet
          translationLanguage: charTranslation ? (data.translations?.language ?? null) : null,
        }
        await writer.addCharacter(character)
        log('Added supporting character:', character.name)
      }

      // Add opening scene as first narration entry. Quick-start stories may be
      // intentionally empty; do not manufacture placeholder prose for them.
      let openingEntry: StoryEntry | undefined = undefined
      if (data.openingScene && !data.chatMessages?.length) {
        const tokenCount = countTokens(data.openingScene)
        const baseTime = storyData.timeTracker ?? { years: 0, days: 0, hours: 0, minutes: 0 }
        const openingTexts =
          data.openingVariants && data.openingVariants.length > 0
            ? data.openingVariants
            : [data.openingScene]
        const selectedOpeningId =
          data.selectedOpeningVariantId &&
          openingTexts.some((_, index) => `opening-${index}` === data.selectedOpeningVariantId)
            ? data.selectedOpeningVariantId
            : 'opening-0'
        const openingVariants: StoryEntryVariant[] = openingTexts.map((content, index) => ({
          id: `opening-${index}`,
          content,
          metadata: {
            source: 'wizard',
            tokenCount: countTokens(content),
            timeStart: { ...baseTime },
            timeEnd: { ...baseTime },
          },
          classificationResult: null,
          worldStateDelta: null,
          suggestedActions: null,
          createdAt: Date.now(),
        }))
        const variantSet: StoryEntryVariantSet = {
          version: 1,
          activeVariantId: selectedOpeningId,
          variants: openingVariants,
        }
        const selectedOpening =
          openingVariants.find((variant) => variant.id === selectedOpeningId) ?? openingVariants[0]!
        openingEntry = await writer.addStoryEntry({
          id: crypto.randomUUID(),
          storyId,
          type: 'narration',
          content: selectedOpening.content,
          parentId: null,
          position: 0,
          metadata: {
            source: 'wizard',
            tokenCount: selectedOpening.metadata?.tokenCount ?? tokenCount,
            timeStart: { ...baseTime },
            timeEnd: { ...baseTime },
            variantSet,
          },
          branchId: null,
          translatedContent: data.translations?.openingScene ?? null,
          translationLanguage: data.translations?.openingScene
            ? (data.translations?.language ?? null)
            : null,
        })
        log('Added opening scene')
      }

      // Add imported lorebook entries
      if (data.importedEntries && data.importedEntries.length > 0) {
        const entries = LorebookImportExport.convertToEntries(data.importedEntries, 'import')
        for (const [index, entryData] of entries.entries()) {
          const entry: Entry = {
            ...entryData,
            id: crypto.randomUUID(),
            storyId,
          }
          await writer.addEntry(entry)
          const key = data.importEntrySourceKeys?.[index]
          if (importSource && key) {
            importSource.entryIdsBySourceKey ??= {}
            importSource.entryIdsBySourceKey[key] = entry.id
          }
        }
        log('Added imported entries:', data.importedEntries.length)
      }

      if (data.chatMessages?.length) {
        await writer.bulkInsertStoryEntries(
          data.chatMessages.map((message, position) => ({
            id: crypto.randomUUID(),
            storyId,
            type: message.type,
            content: message.content,
            parentId: null,
            position,
            metadata: { source: 'sillytavern_import' },
            branchId: null,
          })),
        )
      }
      if (importSource) await writer.updateStory(storyId, { settings: storyData.settings })
      return { storyData, openingEntry }
    })
    const storyId = storyData.id
    this.allStories = [storyData, ...this.allStories]
    this.currentStory = storyData
    // The quick-start input is kept as a draft until the user explicitly
    // submits it from the normal ActionInput. This preserves the distinction
    // between author intent and persisted story history.
    if (data.initialUserInput?.trim()) {
      ui.setPendingCreativeInput(storyId, data.initialUserInput.trim())
    } else if (data.mode === 'creative-writing') {
      ui.requestCreativeInputFocus(storyId)
    }

    // Generate background image from opening scene
    if (data.openingScene && openingEntry && storyData.settings?.backgroundImagesEnabled) {
      aiService.analyzeBackgroundChangeAndGenerateImage(storyId, [openingEntry], (image) => {
        if (
          this.currentStory?.id === storyId &&
          this.currentStory.settings?.backgroundImagesEnabled
        )
          void this.updateCurrentBackgroundImage(image)
      })
      log('Generated background image')
    }

    // Emit event
    eventBus.emit<StoryCreatedEvent>({ type: 'StoryCreated', storyId, mode: data.mode })

    log('Story created from wizard:', storyId)
    return storyData
  }
}

export const story = new StoryStore()
