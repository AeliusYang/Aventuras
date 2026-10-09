/**
 * Unified Generate Functions
 *
 * Central module for all AI generation operations using the Vercel AI SDK.
 * Uses explicit provider selection from APIProfile.providerType.
 */

import { createLogger } from '$lib/log'
import { debug } from '$lib/stores/debug.svelte'

import { settings } from '$lib/stores/settings.svelte'
import type { APIProfile, GenerationPreset, ProviderType, ReasoningEffort } from '$lib/types'
import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { LanguageModelMiddleware } from 'ai'
import {
  extractJsonMiddleware,
  extractReasoningMiddleware,
  generateText,
  Output,
  streamText,
  wrapLanguageModel,
} from 'ai'
import { jsonrepair } from 'jsonrepair'
import * as z from 'zod'
import { loggingMiddleware, patchResponseMiddleware, promptSchemaMiddleware } from './middleware'
import { LLM_TIMEOUT_DEFAULT } from '$lib/constants/timeout'
import { schemaToTypeScriptBlock } from './middleware/promptSchema'
import { retryOn429Middleware } from './middleware/retryMiddleware'
import {
  buildProviderOptions,
  type ResolvedPreset,
  resolvePresetModel,
  thinkingNudgeApplies,
} from './presetResolution'
import { createModelFromProfile } from './providers'
import { usesThinkTag } from './providers/config'
import { asError } from '$lib/utils/error'
import { assertNoDiscardedFactFields } from './factFieldValidation'

const log = createLogger('Generate')

/** Shared middleware instance for extracting reasoning from <think> tags */
const thinkTagMiddleware = extractReasoningMiddleware({ tagName: 'think' })

// ============================================================================
// Types
// ============================================================================

interface BaseGenerateOptions {
  presetId: string
  system: string
  prompt: string
  signal?: AbortSignal
}

interface CollaborativeWriterOptions {
  system: string
  prompt: string
  signal?: AbortSignal
  presetOverride: GenerationPreset
}

interface GenerateObjectOptions<T extends z.ZodType> extends BaseGenerateOptions {
  schema: T
  presetOverride?: GenerationPreset
}

type CollaborativeJsonOptions<T extends z.ZodType> = GenerateObjectOptions<T>

export interface CollaborativeTextOptions {
  presetId: string
  system: string
  prompt: string
  signal?: AbortSignal
  presetOverride: GenerationPreset
  requestBudgetMs?: number
  serviceId?: string
  onDiagnostic?: (diagnostic: {
    requestStarted?: boolean
    streamOpened?: boolean
    firstChunkReceived?: boolean
    streamCompleted?: boolean
    responseLength?: number
    chunkCount?: number
    presetId?: string
    profileId?: string
    profileName?: string
    model?: string
    maxOutputTokens?: number
    finishReason?: string
  }) => void
  /** Receives each visible text delta exactly as emitted by the provider stream. */
  onChunk?: (chunk: string) => void
}

/** Run a collaborative control Agent without imposing a content schema. */
export async function generateCollaborativeText(
  options: CollaborativeTextOptions,
): Promise<string> {
  const {
    presetId,
    system,
    prompt,
    signal,
    presetOverride,
    requestBudgetMs,
    serviceId = 'collaborative-text',
    onDiagnostic,
    onChunk,
  } = options
  const isSceneDirector = serviceId === 'collaborative:sceneDirector'
  const budget =
    requestBudgetMs ??
    (isSceneDirector
      ? (presetOverride.timeoutMs ?? settings.apiSettings.llmTimeoutMs ?? LLM_TIMEOUT_DEFAULT)
      : undefined)
  const config = resolvePresetModel({
    presetId,
    serviceId,
    presetOverride,
    requestTimeoutMs: budget,
  })
  const maxOutputTokens = config.preset.maxTokens
  const controller = budget ? new AbortController() : undefined
  let timedOut = false
  let rejectDeadline: ((reason?: unknown) => void) | undefined
  const deadlinePromise = budget
    ? new Promise<never>((_, reject) => {
        rejectDeadline = reject
      })
    : null
  const timeoutId = budget
    ? setTimeout(() => {
        timedOut = true
        const error = new DOMException(
          `${serviceId} request timed out after ${budget}ms`,
          'TimeoutError',
        )
        controller!.abort(error)
        // Do not rely on the provider honoring AbortSignal. Some Tauri HTTP
        // adapters leave the underlying fetch pending after abort.
        rejectDeadline?.(error)
      }, budget)
    : undefined
  const onAbort = () => {
    const reason = signal?.reason ?? new DOMException('Request aborted', 'AbortError')
    controller?.abort(reason)
    rejectDeadline?.(reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    onDiagnostic?.({ requestStarted: true, maxOutputTokens })
    const request = streamText({
      model: wrapLanguageModel({
        model: config.model,
        middleware: buildPlainTextMiddleware(config.useThinkTag, false),
      }),
      system,
      prompt,
      temperature: config.preset.temperature,
      maxOutputTokens,
      reasoning: config.reasoning,
      providerOptions: config.providerOptions,
      abortSignal: controller?.signal ?? signal,
    })
    const streamResult = await (deadlinePromise
      ? Promise.race([request, deadlinePromise])
      : request)
    onDiagnostic?.({ streamOpened: true })
    let text = ''
    let chunkCount = 0
    let streamFailed = false
    const iterator = streamResult.stream[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = iterator.next()
        const item = await (deadlinePromise ? Promise.race([next, deadlinePromise]) : next)
        if (item.done) break
        if (item.value.type === 'error') throw asError(item.value.error)
        if (item.value.type === 'abort')
          throw new DOMException(item.value.reason ?? 'Request aborted', 'AbortError')
        if (item.value.type !== 'text-delta') continue
        text += item.value.text
        chunkCount++
        onChunk?.(item.value.text)
        onDiagnostic?.({
          firstChunkReceived: true,
          responseLength: text.length,
          chunkCount,
        })
      }
    } catch (error) {
      streamFailed = true
      throw error
    } finally {
      // A provider may leave an SSE stream pending after AbortSignal fires. Close the
      // iterator explicitly so the Director call cannot keep the generation pipeline alive.
      const closing = Promise.resolve().then(() => iterator.return?.())
      if (streamFailed || timedOut || signal?.aborted) void closing.catch(() => {})
      else if (deadlinePromise) await Promise.race([closing, deadlinePromise])
      else await closing
    }
    const finishReason = await (deadlinePromise
      ? Promise.race([streamResult.finishReason, deadlinePromise])
      : streamResult.finishReason)
    signal?.throwIfAborted()
    onDiagnostic?.({ finishReason })
    if (finishReason === 'length') {
      throw new Error(`${serviceId} 输出额度已耗尽，返回文本尚未完成。`)
    }
    if (finishReason !== 'stop')
      throw new Error(`${serviceId} 未正常完成（${finishReason ?? 'unknown'}）。`)
    if (!text.trim()) throw new Error(`${serviceId} 返回空文本。`)
    onDiagnostic?.({ streamCompleted: true, responseLength: text.length, chunkCount })
    return text
  } catch (error) {
    if (controller?.signal.aborted && !signal?.aborted && timedOut) {
      throw new DOMException(`${serviceId} request timed out after ${budget}ms`, 'TimeoutError')
    }
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ============================================================================
// Config Resolution
// ============================================================================

interface NarrativeConfig {
  serviceId: string
  profile: APIProfile
  providerType: ProviderType
  model: LanguageModelV4
  temperature: number
  maxTokens: number
  providerOptions?: SharedV4ProviderOptions
  reasoning: ReasoningEffort
  useThinkTag: boolean
  timeoutMs: number
}

/**
 * The narrator has no preset row of its own -- its model, temperature and effort live in
 * `apiSettings` -- so it builds a preset-shaped value and resolves the rest the same way.
 */
function resolveNarrativeConfig(
  debugId?: string,
  presetOverride?: GenerationPreset,
): NarrativeConfig {
  const profile = presetOverride
    ? settings.getProfile(presetOverride.profileId ?? settings.apiSettings.mainNarrativeProfileId)
    : settings.getMainNarrativeProfile()

  if (!profile) {
    if (presetOverride) {
      throw new Error(
        `Profile not found: ${presetOverride.profileId ?? settings.apiSettings.mainNarrativeProfileId}`,
      )
    }
    throw new Error(
      'Main narrative profile not configured. Please set up an API profile in Settings.',
    )
  }

  const baseModelId = presetOverride?.model ?? settings.apiSettings.defaultModel
  const serviceId =
    presetOverride?.id === 'collaborative:writer'
      ? 'collaborative-chinese-writer'
      : (presetOverride?.id ?? 'narrative')

  const model = createModelFromProfile({
    profile,
    modelId: baseModelId,
    presetId: serviceId,
    debugId,
    manualBody:
      (presetOverride ? presetOverride.manualBody : settings.apiSettings.manualBody) ?? '',
    timeoutMs: presetOverride?.timeoutMs ?? settings.apiSettings.llmTimeoutMs,
  })

  const reasoningEffort = presetOverride?.reasoningEffort ?? settings.apiSettings.reasoningEffort

  const narrativePreset: GenerationPreset = presetOverride ?? {
    id: '_narrative',
    name: 'Narrative',
    description: 'Main narrative generation',
    profileId: profile.id,
    model: baseModelId,
    temperature: settings.apiSettings.temperature,
    maxTokens: settings.apiSettings.maxTokens,
    reasoningEffort: reasoningEffort,
    manualBody: settings.apiSettings.manualBody ?? '',
  }

  return {
    serviceId,
    profile,
    providerType: profile.providerType,
    model,
    temperature: narrativePreset.temperature,
    maxTokens: narrativePreset.maxTokens,
    providerOptions: buildProviderOptions(
      narrativePreset,
      profile.providerType,
      presetOverride ? false : undefined,
    ),
    reasoning: reasoningEffort,
    useThinkTag: usesThinkTag(profile.providerType),
    timeoutMs: presetOverride?.timeoutMs ?? settings.apiSettings.llmTimeoutMs,
  }
}

// ============================================================================
// Middleware
// ============================================================================

function createJsonExtractMiddleware(): LanguageModelMiddleware {
  return extractJsonMiddleware({
    transform: (text) => {
      try {
        const repaired = jsonrepair(text)
        if (repaired !== text) {
          log('JSON repaired by jsonrepair')
        }
        return repaired
      } catch (e) {
        log('jsonrepair failed:', e)
        return text
      }
    },
  })
}

/**
 * Takes the resolved config rather than a row of booleans: every flag it needs is already on
 * it, and four positional `boolean`s in a row is a swap no type error would ever catch.
 */
function buildStructuredMiddleware(config: ResolvedPreset): LanguageModelMiddleware[] {
  const { supportsStructuredOutput, useThinkTag, preset, providerType } = config

  // retryOn429Middleware is intentionally outermost: it re-invokes the whole
  // inner chain (including patchResponseMiddleware) on each retry. Do not
  // reorder without understanding this — putting retry after patchResponse
  // would cause patched state to leak across attempts.
  const base: LanguageModelMiddleware[] = [retryOn429Middleware, patchResponseMiddleware()]

  // Unconditional on purpose: a provider that claims native structured output and then wraps
  // the object in prose is common enough that `structuredOutputOverride: 'off'` exists for it.
  // On a well-behaved response the repair is a no-op.
  base.push(createJsonExtractMiddleware())

  if (useThinkTag) {
    base.push(thinkTagMiddleware)
  }
  if (!supportsStructuredOutput) {
    const nudge =
      !!preset.thinkingNudgePrompt &&
      thinkingNudgeApplies({
        providerType,
        reasoningEffort: preset.reasoningEffort,
        supportsStructuredOutput,
      })
    if (nudge) {
      base.push(
        promptSchemaMiddleware({
          instruction: `Respond with your reasoning inside <think> and </think> tags first. Then, output strictly valid JSON compatible with the TypeScript type Response from the following:\n\n{schema}\n\nOutput ONLY the JSON object after the </think> tag, no other text or markdown.`,
        }),
      )
    } else {
      base.push(promptSchemaMiddleware())
    }
  }

  base.push(loggingMiddleware())
  return base
}

function buildPlainTextMiddleware(
  useThinkTag: boolean,
  retry429 = true,
): LanguageModelMiddleware[] {
  // retryOn429Middleware is intentionally outermost: it re-invokes the whole
  // inner chain (including patchResponseMiddleware) on each retry. Do not
  // reorder without understanding this — putting retry after patchResponse
  // would cause patched state to leak across attempts.
  const base: LanguageModelMiddleware[] = [
    ...(retry429 ? [retryOn429Middleware] : []),
    patchResponseMiddleware(),
  ]
  if (useThinkTag) {
    base.push(thinkTagMiddleware)
  }
  base.push(loggingMiddleware())
  return base
}

// ============================================================================
// Generate Functions
// ============================================================================

export async function generateStructured<T extends z.ZodType>(
  options: GenerateObjectOptions<T>,
  serviceId: string,
): Promise<z.infer<T>> {
  const { presetId, schema, system, prompt, signal, presetOverride } = options
  const config = resolvePresetModel({ presetId, serviceId, debugId: undefined, presetOverride })
  const { preset, providerType, model, providerOptions, reasoning, supportsStructuredOutput } =
    config
  const manualMode = !presetOverride && settings.advancedRequestSettings.manualMode

  log('generateStructured', {
    presetId,
    model: preset.model,
    providerType,
    supportsStructuredOutput,
  })

  const result = await generateText({
    model: wrapLanguageModel({
      model: model as LanguageModelV4,
      middleware: buildStructuredMiddleware(config),
    }),
    system,
    prompt,
    output: Output.object({ schema }),
    temperature: !manualMode ? preset.temperature : undefined,
    maxOutputTokens: !manualMode ? preset.maxTokens : undefined,
    reasoning,
    providerOptions,
    abortSignal: signal,
  })

  return result.output as z.infer<T>
}

/**
 * Generate one of the collaborative control documents without using the SDK's structured-output
 * protocol. Some OpenAI-compatible gateways accept a normal chat completion but stall or reject
 * `response_format`/JSON-schema requests. The schema is therefore a prompt contract and the
 * response is validated locally, preserving the same jsonrepair/Zod failure semantics.
 */
export async function generateCollaborativeJsonText<T extends z.ZodType>(
  options: CollaborativeJsonOptions<T>,
  serviceId: string,
): Promise<z.infer<T>> {
  const { presetId, schema, system, prompt, signal, presetOverride } = options
  const config = resolvePresetModel({ presetId, serviceId, debugId: undefined, presetOverride })
  const { preset, model, providerOptions, reasoning, useThinkTag } = config
  const contract = schemaToTypeScriptBlock(
    z.toJSONSchema(schema, { io: 'output' }) as Parameters<typeof schemaToTypeScriptBlock>[0],
  )
  const contractPrompt = `${prompt}\n\nRespond strictly with one valid JSON object matching this TypeScript contract:\n\n${contract}\n\nOutput ONLY the JSON object. Do not use markdown fences or explanatory text.`

  log('generateCollaborativeJsonText', {
    presetId,
    serviceId,
    model: preset.model,
    providerType: config.providerType,
    responseFormat: false,
  })

  const { text, finishReason } = await generateText({
    model: wrapLanguageModel({ model, middleware: buildPlainTextMiddleware(useThinkTag, true) }),
    system,
    prompt: contractPrompt,
    temperature: preset.temperature,
    maxOutputTokens: preset.maxTokens,
    reasoning,
    providerOptions,
    abortSignal: signal,
  })

  if (finishReason === 'length') {
    throw new Error(`${serviceId} 输出额度已耗尽，返回文本尚未完成。`)
  }
  signal?.throwIfAborted()
  if (finishReason !== 'stop')
    throw new Error(`${serviceId} 未正常完成（${finishReason ?? 'unknown'}）。`)
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  const source = (fenced ?? trimmed).trim()
  const start = Math.min(
    ...[source.indexOf('{'), source.indexOf('[')].filter((index) => index >= 0),
  )
  const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'))
  const candidate = start !== Infinity && end >= start ? source.slice(start, end + 1) : source

  try {
    const sourceObject: unknown = JSON.parse(jsonrepair(candidate))
    const parsed = schema.parse(sourceObject)
    if (serviceId === 'collaborative-fact-extractor')
      assertNoDiscardedFactFields(sourceObject, parsed)
    return parsed as z.infer<T>
  } catch (error) {
    log('Collaborative JSON response failed local validation', {
      serviceId,
      responseLength: text.length,
      error,
    })
    throw error
  }
}

export function generateCollaborativeWriterStream(options: CollaborativeWriterOptions) {
  return streamNarrative(options)
}

export async function generatePlainText(
  options: BaseGenerateOptions,
  serviceId: string,
): Promise<string> {
  const { presetId, system, prompt, signal } = options
  const { preset, providerType, model, providerOptions, reasoning, useThinkTag } =
    resolvePresetModel({
      presetId,
      serviceId,
      debugId: undefined,
    })

  log('generatePlainText', { presetId, model: preset.model, providerType })

  const { text } = await generateText({
    model: wrapLanguageModel({
      model,
      middleware: buildPlainTextMiddleware(useThinkTag),
    }),
    system,
    prompt,
    temperature: !settings.advancedRequestSettings.manualMode ? preset.temperature : undefined,
    maxOutputTokens: !settings.advancedRequestSettings.manualMode ? preset.maxTokens : undefined,
    reasoning,
    providerOptions,
    abortSignal: signal,
  })

  return text
}

interface NarrativeGenerateOptions {
  system: string
  prompt: string
  signal?: AbortSignal
  presetOverride?: GenerationPreset
}

export function streamNarrative(options: NarrativeGenerateOptions) {
  const { system, prompt, signal, presetOverride } = options
  const debugId = crypto.randomUUID()
  const {
    serviceId,
    providerType,
    model,
    temperature,
    maxTokens,
    providerOptions,
    reasoning,
    useThinkTag,
  } = resolveNarrativeConfig(debugId, presetOverride)
  const manualMode = !presetOverride && settings.advancedRequestSettings.manualMode

  log('streamNarrative', {
    serviceId,
    model: presetOverride?.model ?? settings.apiSettings.defaultModel,
    providerType,
  })
  const startTime = Date.now()

  return streamText({
    model: wrapLanguageModel({
      model,
      middleware: buildPlainTextMiddleware(useThinkTag),
    }),
    system,
    prompt,
    temperature: !manualMode ? temperature : undefined,
    maxOutputTokens: !manualMode ? maxTokens : undefined,
    reasoning,
    providerOptions,
    abortSignal: signal,
    onFinish: (result) => {
      const collaborative = /^collaborative[-:]/.test(serviceId)
      debug.addDebugResponse(
        debugId,
        `${serviceId}:result`,
        {
          _note: 'This is the final SDK summary. Look at the other log entry for the raw response.',
          finishReason: result.finishReason,
          usage: collaborative ? { totalTokens: result.usage.totalTokens } : result.usage,
          providerMetadata: collaborative ? undefined : result.providerMetadata,
        },
        startTime,
      )
    },
  })
}

export async function generateNarrative(options: NarrativeGenerateOptions): Promise<string> {
  const { system, prompt, signal, presetOverride } = options
  const {
    serviceId,
    providerType,
    model,
    temperature,
    maxTokens,
    providerOptions,
    reasoning,
    useThinkTag,
  } = resolveNarrativeConfig(undefined, presetOverride)

  log('generateNarrative', {
    serviceId,
    model: presetOverride?.model ?? settings.apiSettings.defaultModel,
    providerType,
  })

  const { text } = await generateText({
    model: wrapLanguageModel({
      model,
      middleware: buildPlainTextMiddleware(useThinkTag),
    }),
    system,
    prompt,
    temperature,
    maxOutputTokens: maxTokens,
    reasoning,
    providerOptions,
    abortSignal: signal,
  })

  return text
}
