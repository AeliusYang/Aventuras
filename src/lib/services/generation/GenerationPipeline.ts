/**
 * GenerationPipeline - Orchestrates narrative generation phases
 * Order: pre → retrieval → narrative → [(classification ‖ translation → image) ‖ background ‖ post]
 */

import type {
  NovelDirectorChunkCallback,
  NovelPreparation,
  NovelProgressCallback,
} from './prepareNovelTurn'
import { resolveCollaborativeLength } from './collaborative'
import { recoveryScopeMatches } from './writerRecovery'
import type { NovelTurn, NovelRetry, CollaborativeWriterRecovery } from '$lib/types/collaborative'
import { createLogger } from '$lib/log'
import { asError } from '$lib/utils/error'

const log = createLogger('GenerationPipeline')

import type { GenerationEvent, GenerationContext, ErrorEvent, RetrievalResult } from './types'
import type { ActionInputType, TranslationSettings, Character, StoryBeat } from '$lib/types'
import type { StoryMode, POV, Tense } from '$lib/types'
import type { StyleReviewResult } from '$lib/services/ai/generation/StyleReviewerService'
import type { ActivationTracker } from '$lib/services/ai/retrieval/EntryRetrievalService'
import {
  PreGenerationPhase,
  RetrievalPhase,
  NarrativePhase,
  ClassificationPhase,
  TranslationPhase,
  ImagePhase,
  PostGenerationPhase,
  type RetrievalDependencies,
  type NarrativeDependencies,
  type ClassificationDependencies,
  type TranslationDependencies,
  type ImageDependencies,
  type PostGenerationDependencies,
  type PreGenerationResult,
  type NarrativeResult,
  type ClassificationPhaseResult,
  type TranslationResult2,
  type ImageResult,
  type PostGenerationResult,
  type PromptContext,
  type ImageSettings,
} from './phases'
import {
  BackgroundImagePhase,
  type BackgroundImageDependencies,
  type BackgroundImageResult,
  type BackgroundImageSettings,
} from './phases/BackgroundImagePhase'
import { mergeGenerators } from '$lib/utils/async'
import { sameEntityName } from '$lib/utils/text'

export interface PipelineDependencies
  extends
    RetrievalDependencies,
    NarrativeDependencies,
    BackgroundImageDependencies,
    ClassificationDependencies,
    TranslationDependencies,
    ImageDependencies,
    PostGenerationDependencies {
  prepareCollaborative?: (
    input: NovelPreparation,
    onProgress?: NovelProgressCallback,
    onDirectorChunk?: NovelDirectorChunkCallback,
  ) => Promise<NovelTurn>
}

export interface PipelineConfig {
  writerRecovery?: CollaborativeWriterRecovery
  novelRetry?: NovelRetry
  rawInput: string
  actionType: ActionInputType
  wasRawActionChoice: boolean
  memoryRetrievalEnabled: boolean
  storyMode: StoryMode
  pov: POV
  tense: Tense
  styleReview: StyleReviewResult | null
  activationTracker?: ActivationTracker
  translationSettings: TranslationSettings
  imageSettings: ImageSettings & BackgroundImageSettings
  promptContext: PromptContext
  disableSuggestions: boolean
  activeThreads: StoryBeat[]
  cachedRetrievalResult?: RetrievalResult | null
}

export interface PipelineResult {
  preGeneration: PreGenerationResult | null
  narrative: NarrativeResult | null
  background: BackgroundImageResult | null
  classification: ClassificationPhaseResult | null
  translation: TranslationResult2 | null
  image: ImageResult | null
  postGeneration: PostGenerationResult | null
  aborted: boolean
  fatalError: Error | null
}

export class GenerationPipeline {
  private prePhase = new PreGenerationPhase()
  private retrievalPhase = new RetrievalPhase()
  private narrativePhase: NarrativePhase
  private backgroundPhase: BackgroundImagePhase
  private classificationPhase: ClassificationPhase
  private translationPhase: TranslationPhase
  private imagePhase: ImagePhase
  private postPhase: PostGenerationPhase

  constructor(private deps: PipelineDependencies) {
    this.narrativePhase = new NarrativePhase(deps)
    this.backgroundPhase = new BackgroundImagePhase(deps)
    this.classificationPhase = new ClassificationPhase(deps)
    this.translationPhase = new TranslationPhase(deps)
    this.imagePhase = new ImagePhase(deps)
    this.postPhase = new PostGenerationPhase(deps)
  }

  async *execute(
    ctx: GenerationContext,
    cfg: PipelineConfig,
  ): AsyncGenerator<GenerationEvent, PipelineResult> {
    const r: PipelineResult = {
      preGeneration: null,
      narrative: null,
      background: null,
      classification: null,
      translation: null,
      image: null,
      postGeneration: null,
      aborted: false,
      fatalError: null,
    }

    try {
      if (cfg.writerRecovery && !recoveryScopeMatches(cfg.writerRecovery, ctx))
        throw new Error('正文恢复记录与当前故事、分支或输入不匹配。')
      r.preGeneration = yield* this.prePhase.execute({
        context: ctx,
        rawInput: cfg.rawInput,
        actionType: cfg.actionType,
        wasRawActionChoice: cfg.wasRawActionChoice,
      })
      if (ctx.abortSignal?.aborted) return { ...r, aborted: true }

      let retrieval: RetrievalResult
      if (cfg.writerRecovery || cfg.cachedRetrievalResult) {
        log('Using cached retrieval result (regenerate)')
        yield { type: 'phase_start', phase: 'retrieval' } as GenerationEvent
        retrieval = cfg.writerRecovery?.retrieval ?? cfg.cachedRetrievalResult!
        yield { type: 'phase_complete', phase: 'retrieval', result: retrieval } as GenerationEvent
      } else {
        retrieval = yield* this.retrievalPhase.execute({
          context: ctx,
          dependencies: this.deps,
          memoryRetrievalEnabled: cfg.memoryRetrievalEnabled,
          activationTracker: cfg.activationTracker,
        })
      }
      if (ctx.abortSignal?.aborted) return { ...r, aborted: true }

      let novelTurn: NovelTurn | undefined = cfg.writerRecovery
        ? JSON.parse(JSON.stringify(cfg.writerRecovery.novelTurn))
        : undefined
      const workflow = ctx.story.settings?.collaborativeNovelWorkflow
      const isCollaborative = ctx.story.mode === 'creative-writing'
      if (isCollaborative && !cfg.writerRecovery) {
        yield { type: 'phase_start', phase: 'scene_director' }
        try {
          if (!this.deps.prepareCollaborative) throw new Error('中文写作规划服务未连接。')
          // Drain callbacks while preparation runs, not after its promise resolves.
          const progress: GenerationEvent[] = []
          let wake: (() => void) | undefined
          let finished = false
          let failure: unknown
          const pending = this.deps
            .prepareCollaborative(
              { context: ctx, retrieval, retry: cfg.novelRetry, rawInput: cfg.rawInput },
              (value) => {
                if (finished || ctx.abortSignal?.aborted) return
                progress.push({ type: 'phase_progress', phase: 'scene_director', progress: value })
                wake?.()
              },
              (content) => {
                if (finished || ctx.abortSignal?.aborted || !content) return
                progress.push({ type: 'director_chunk', content })
                wake?.()
              },
            )
            .then(
              (value) => {
                novelTurn = value
              },
              (error) => {
                failure = error
              },
            )
            .finally(() => {
              finished = true
              wake?.()
            })
          while (!finished || progress.length) {
            ctx.abortSignal?.throwIfAborted()
            if (progress.length) yield progress.shift()!
            else
              await new Promise<void>((resolve) => {
                const resume = () => {
                  ctx.abortSignal?.removeEventListener('abort', resume)
                  resolve()
                }
                wake = resume
                ctx.abortSignal?.addEventListener('abort', resume, { once: true })
              })
          }
          await pending
          if (failure) throw failure
          if (!novelTurn) throw new Error('本轮导演没有返回结果。')
          const requestedLength = resolveCollaborativeLength(cfg.rawInput, workflow?.targetLength, ctx.story.settings?.targetLength)
          novelTurn.requestedLength = requestedLength
          ctx.abortSignal?.throwIfAborted()
          yield { type: 'phase_complete', phase: 'scene_director', result: novelTurn }
        } catch (error) {
          if (ctx.abortSignal?.aborted) return { ...r, aborted: true }
          const failure = asError(error, '导演阶段返回了无法识别的错误。')
          yield { type: 'error', phase: 'scene_director', error: failure, fatal: true }
          return { ...r, fatalError: failure }
        }
      }
      if (isCollaborative && cfg.writerRecovery) {
        yield { type: 'phase_complete', phase: 'scene_director', result: novelTurn }
      }
      r.narrative = yield* this.narrativePhase.execute({
        novelTurn,
        visibleEntries: ctx.visibleEntries,
        worldState: ctx.worldState,
        story: ctx.story,
        retrievalResult: retrieval,
        styleReview: isCollaborative ? null : cfg.styleReview,
        abortSignal: ctx.abortSignal,
      })
      if (!r.narrative || ctx.abortSignal?.aborted) return { ...r, aborted: true }

      // Collaborative turns retain fact extraction and independent background work,
      // but never enter the generic translation/image/post-processing chain.
      if (isCollaborative) {
        if (workflow?.factStateExtractor?.enabled !== false || !workflow) {
          r.classification = yield* this.classificationPhase.execute({
            narrativeContent: r.narrative.content,
            narrativeEntryId: ctx.narrationEntryId || ctx.userAction.entryId,
            userActionContent: ctx.userAction.content,
            worldState: ctx.worldState,
            story: ctx.story,
            visibleEntries: ctx.visibleEntries
              .filter((entry) => entry.type === 'narration')
              .map((entry) => ({ ...entry, metadata: null, reasoning: undefined })),
            abortSignal: ctx.abortSignal,
          })
        }
        if (cfg.novelRetry || cfg.writerRecovery?.variantBaseEntryId) {
          // A reroll is not committed until ActionInput has applied the new
          // classification and updated the entry/world-state transaction. Running
          // background-image analysis here would create an image for a variant that
          // can still be rejected and restored. The caller runs the same phase after
          // the commit succeeds.
          const deferred: BackgroundImageResult = {
            started: false,
            skippedReason: 'deferred_until_commit',
          }
          yield { type: 'phase_start', phase: 'image' } as GenerationEvent
          yield { type: 'phase_complete', phase: 'image', result: deferred } as GenerationEvent
          r.background = deferred
        } else {
          r.background = yield* this.backgroundPhase.execute({
            storyId: ctx.story.id,
            storyEntries: ctx.visibleEntries,
            imageSettings: cfg.imageSettings,
            abortSignal: ctx.abortSignal,
          })
        }
        return r
      }

      // All post-narrative phases run in parallel. Image needs classification
      // + translation results, so it chains after them via imagePipeline.
      // Background and postGeneration are fully independent.
      const allPhases = yield* mergeGenerators({
        // [Classification ‖ Translation] → Image (sequential dependency)
        imagePipeline: this.runImagePipeline(
          ctx,
          cfg,
          r.narrative!.content,
          r.preGeneration?.visualProseMode ?? false,
        ),
        // Independent phases
        background: this.backgroundPhase.execute({
          storyId: ctx.story.id,
          storyEntries: ctx.visibleEntries,
          imageSettings: cfg.imageSettings,
          abortSignal: ctx.abortSignal,
        }),
        postGeneration: this.postPhase.execute({
          isCollaborative,
          isCreativeMode: cfg.storyMode === 'creative-writing',
          disableSuggestions: cfg.disableSuggestions,
          storyId: ctx.story.id,
          entries: ctx.visibleEntries,
          activeThreads: cfg.activeThreads,
          lorebookEntries: ctx.worldState.lorebookEntries,
          promptContext: cfg.promptContext,
          worldState: ctx.worldState,
          narrativeResponse: r.narrative.content,
          pov: cfg.pov,
          translationSettings: cfg.translationSettings,
          abortSignal: ctx.abortSignal,
        }),
      })

      r.classification = allPhases.imagePipeline.classification
      r.translation = allPhases.imagePipeline.translation
      r.image = allPhases.imagePipeline.image
      r.background = allPhases.background
      r.postGeneration = allPhases.postGeneration
      if (ctx.abortSignal?.aborted) return { ...r, aborted: true }

      return r
    } catch (error) {
      r.fatalError = asError(error, '生成阶段返回了无法识别的错误。')
      yield { type: 'error', phase: 'pre', error: r.fatalError, fatal: true } satisfies ErrorEvent
      return r
    }
  }

  /**
   * Runs classification and translation in parallel, then image once both complete.
   * This way image starts as soon as its dependencies are ready, without waiting
   * for unrelated phases like postGeneration or background.
   */
  private async *runImagePipeline(
    ctx: GenerationContext,
    cfg: PipelineConfig,
    narrativeContent: string,
    isVisualProse: boolean,
  ): AsyncGenerator<
    GenerationEvent,
    {
      classification: ClassificationPhaseResult | null
      translation: TranslationResult2
      image: ImageResult
    }
  > {
    const imageDeps = yield* mergeGenerators({
      classification: this.classificationPhase.execute({
        narrativeContent,
        narrativeEntryId: ctx.userAction.entryId,
        userActionContent: ctx.userAction.content,
        worldState: ctx.worldState,
        story: ctx.story,
        visibleEntries: ctx.visibleEntries,
        abortSignal: ctx.abortSignal,
      }),
      translation: this.translationPhase.execute({
        storyId: ctx.story.id,
        narrativeContent,
        narrativeEntryId: ctx.userAction.entryId,
        isVisualProse,
        translationSettings: cfg.translationSettings,
        abortSignal: ctx.abortSignal,
      }),
    })

    if (ctx.abortSignal?.aborted) {
      return {
        classification: imageDeps.classification,
        translation: imageDeps.translation,
        image: { started: false, skippedReason: 'aborted' },
      }
    }

    // A creative reroll is not active until fact/state maintenance succeeds. If
    // classification failed or never returned, do not generate images from prose
    // that will be restored as a pending/rejected variant. Adventure and ordinary
    // first-pass generations retain their existing image behavior.
    if (
      cfg.novelRetry &&
      (!imageDeps.classification || imageDeps.classification.classificationResult._error)
    ) {
      yield { type: 'phase_start', phase: 'image' } as GenerationEvent
      const image = { started: false, skippedReason: 'classification_failed' as const }
      yield { type: 'phase_complete', phase: 'image', result: image } as GenerationEvent
      return {
        classification: imageDeps.classification,
        translation: imageDeps.translation,
        image,
      }
    }

    const imageInput = this.buildImageInput(
      ctx,
      cfg,
      narrativeContent,
      imageDeps.classification,
      imageDeps.translation,
    )
    const image = yield* this.imagePhase.execute(imageInput)

    return {
      classification: imageDeps.classification,
      translation: imageDeps.translation,
      image,
    }
  }

  private buildImageInput(
    ctx: GenerationContext,
    cfg: PipelineConfig,
    narrativeContent: string,
    classification: ClassificationPhaseResult | null,
    translation: TranslationResult2,
  ) {
    // Matched the way presence is matched everywhere else: an exact-string compare here
    // dropped the portrait reference for any name the model spelled differently.
    //
    // The protagonist is added rather than looked for. They are in every scene by
    // definition, so whether the classifier remembered to name them says nothing — and
    // leaving them out costs the image prompt its `isProtagonist` reference.
    const names = classification?.classificationResult?.scene?.presentCharacterNames ?? []
    const presentCharacters: Character[] = ctx.worldState.characters.filter(
      (c) => c.relationship === 'self' || names.some((name) => sameEntityName(c.name, name)),
    )
    return {
      storyId: ctx.story.id,
      entryId: ctx.narrationEntryId || ctx.userAction.entryId,
      narrativeContent,
      userAction: ctx.userAction.content,
      presentCharacters,
      currentLocation: ctx.worldState.currentLocation?.name,
      translatedNarrative: translation?.translatedContent ?? undefined,
      translationLanguage: translation?.targetLanguage ?? undefined,
      imageSettings: cfg.imageSettings,
      abortSignal: ctx.abortSignal,
    }
  }
}
