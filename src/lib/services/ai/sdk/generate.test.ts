import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import type { APIProfile, GenerationPreset } from '$lib/types'

const log = vi.hoisted(() => vi.fn())

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    apiSettings: {
      mainNarrativeProfileId: 'main',
      defaultModel: 'main-model',
      temperature: 0.8,
      maxTokens: 4096,
      reasoningEffort: 'medium',
      manualBody: '{"top_p":0.9}',
      llmTimeoutMs: 300000,
    },
    advancedRequestSettings: { manualMode: false },
    getMainNarrativeProfile: vi.fn(),
    getPresetConfig: vi.fn(),
    getProfile: vi.fn(),
    getProfileModels: vi.fn(() => []),
  },
}))
vi.mock('$lib/log', () => ({ createLogger: () => log }))
vi.mock('$lib/stores/debug.svelte', () => ({ debug: { addDebugResponse: vi.fn() } }))
vi.mock('./providers', () => ({ createModelFromProfile: vi.fn(() => ({ modelId: 'mock' })) }))
vi.mock('./middleware', () => ({
  loggingMiddleware: vi.fn(),
  patchResponseMiddleware: vi.fn(),
  promptSchemaMiddleware: vi.fn(),
}))
vi.mock('./middleware/retryMiddleware', () => ({ retryOn429Middleware: {} }))
vi.mock('ai', () => ({
  extractJsonMiddleware: vi.fn(),
  extractReasoningMiddleware: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  wrapLanguageModel: vi.fn(({ model }) => model),
  Output: { object: vi.fn(({ schema }) => schema) },
}))

import { generateText, streamText } from 'ai'
import { settings } from '$lib/stores/settings.svelte'
import { debug } from '$lib/stores/debug.svelte'
import { createModelFromProfile } from './providers'
import { collaborativeClassificationResultSchema } from './schemas/classifier'
import {
  generateNarrative,
  generateCollaborativeJsonText,
  generateCollaborativeText,
  generatePlainText,
  generateStructured,
  streamNarrative,
} from './generate'

const mainProfile = { id: 'main', providerType: 'openai-compatible' } as APIProfile
const workflowProfile = { id: 'workflow', providerType: 'zhipu' } as APIProfile
const taskPreset: GenerationPreset = {
  id: 'task',
  name: 'Task',
  description: null,
  profileId: 'main',
  model: 'task-model',
  temperature: 0.2,
  maxTokens: 512,
  reasoningEffort: 'none',
  manualBody: '',
}
const override: GenerationPreset = {
  ...taskPreset,
  id: 'collaborative:writer',
  profileId: 'workflow',
  model: 'workflow-model',
  temperature: 0.95,
  maxTokens: 8192,
  reasoningEffort: 'high',
  manualBody: '{"top_p":0.7}',
}
const input = { system: 'System', prompt: 'Prompt', signal: new AbortController().signal }

beforeEach(() => {
  vi.clearAllMocks()
  settings.advancedRequestSettings.manualMode = false
  vi.mocked(settings.getMainNarrativeProfile).mockReturnValue(mainProfile)
  vi.mocked(settings.getProfile).mockImplementation((id) =>
    id === 'main' ? mainProfile : id === 'workflow' ? workflowProfile : undefined,
  )
  vi.mocked(settings.getPresetConfig).mockReturnValue(taskPreset)
  vi.mocked(generateText).mockResolvedValue({ text: 'Prose', output: { ok: true } } as never)
})

describe('structured generation', () => {
  const options = { ...input, presetId: 'task', schema: z.object({ ok: z.boolean() }) }

  it('keeps generic task resolution for ordinary structured and plain text requests', async () => {
    expect(await generateStructured(options, 'classification')).toEqual({ ok: true })
    expect(settings.getPresetConfig).toHaveBeenCalledWith('task', 'classification')
    expect(await generatePlainText(options, 'summary')).toBe('Prose')
    expect(settings.getPresetConfig).toHaveBeenCalledWith('task', 'summary')
    expect(generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        system: input.system,
        prompt: input.prompt,
        temperature: 0.2,
        maxOutputTokens: 512,
        reasoning: 'none',
        abortSignal: input.signal,
      }),
    )
  })

  it('passes an explicit preset through to actual model and request options', async () => {
    expect(
      await generateStructured({ ...options, presetOverride: override }, 'classification'),
    ).toEqual({ ok: true })
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
    expect(createModelFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: workflowProfile,
        modelId: 'workflow-model',
        manualBody: '{"top_p":0.7}',
      }),
    )
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.95,
        maxOutputTokens: 8192,
        reasoning: 'high',
        providerOptions: { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } },
        abortSignal: input.signal,
      }),
    )
  })

  it.each([false, true])(
    'preserves structured binding with global manualMode=%s',
    async (manualMode) => {
      settings.advancedRequestSettings.manualMode = manualMode
      await generateStructured({ ...options, presetOverride: override }, 'classification')
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: override.temperature,
          maxOutputTokens: override.maxTokens,
          providerOptions: { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } },
        }),
      )
      expect(settings.advancedRequestSettings.manualMode).toBe(manualMode)
      expect(settings.getPresetConfig).not.toHaveBeenCalled()
    },
  )

  it('still omits ordinary structured request settings in global manual mode', async () => {
    settings.advancedRequestSettings.manualMode = true
    await generateStructured(options, 'classification')
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: undefined,
        maxOutputTokens: undefined,
        providerOptions: undefined,
      }),
    )
  })
})

describe('collaborative JSON text generation', () => {
  it('does not report success after dropping an unsupported fact field', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({
        entryUpdates: {
          characterUpdates: [{ name: '周平', changes: { description: '尚未表态' } }],
        },
        scene: { timeProgression: 'none' },
      }),
      finishReason: 'stop',
    } as never)
    await expect(
      generateCollaborativeJsonText(
        {
          ...input,
          presetId: 'task',
          schema: collaborativeClassificationResultSchema,
          presetOverride: override,
        },
        'collaborative-fact-extractor',
      ),
    ).rejects.toThrow('entryUpdates.characterUpdates[0].changes.description')
    expect(generateText).toHaveBeenCalledOnce()
  })
  it('keeps other JSON services and the fact-extractor request contract unchanged', async () => {
    const response = { text: '{"ok":true,"extra":"not in schema"}', finishReason: 'stop' }
    vi.mocked(generateText).mockResolvedValue(response as never)
    const options = {
      ...input,
      presetId: 'task',
      schema: z.object({ ok: z.boolean() }),
      presetOverride: override,
    }
    await expect(
      generateCollaborativeJsonText(options, 'collaborative-fact-extractor'),
    ).rejects.toThrow('extra')
    await expect(
      generateCollaborativeJsonText(options, 'collaborative-suggestions'),
    ).resolves.toEqual({ ok: true })
    expect(vi.mocked(generateText).mock.calls[0][0]).toEqual(
      vi.mocked(generateText).mock.calls[1][0],
    )
    expect(generateText).toHaveBeenCalledTimes(2)
  })
  it.each(['other', 'error', undefined])(
    'does not apply a valid JSON object without successful completion: %s',
    async (finishReason) => {
      vi.mocked(generateText).mockResolvedValueOnce({ text: '{"ok":true}', finishReason } as never)
      await expect(
        generateCollaborativeJsonText(
          {
            ...input,
            presetId: 'task',
            schema: z.object({ ok: z.boolean() }),
            presetOverride: override,
          },
          'collaborative-fact-extractor',
        ),
      ).rejects.toThrow('未正常完成')
      expect(generateText).toHaveBeenCalledOnce()
    },
  )

  it('rejects token-truncated extraction even when the partial object is repairable', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{"ok":true',
      finishReason: 'length',
    } as never)
    await expect(
      generateCollaborativeJsonText(
        {
          ...input,
          presetId: 'task',
          schema: z.object({ ok: z.boolean() }),
          presetOverride: override,
        },
        'collaborative-fact-extractor',
      ),
    ).rejects.toThrow('尚未完成')
    expect(generateText).toHaveBeenCalledOnce()
  })

  it('uses a normal text request and validates repaired JSON locally', async () => {
    const schema = z.object({ ok: z.boolean() })
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '```json\n{"ok":true,}\n```',
      finishReason: 'stop',
    } as never)

    await expect(
      generateCollaborativeJsonText(
        {
          ...input,
          presetId: 'task',
          schema,
          presetOverride: override,
        },
        'collaborative-scene-director',
      ),
    ).resolves.toEqual({ ok: true })

    const request = vi.mocked(generateText).mock.calls[0][0]
    expect(request).not.toHaveProperty('output')
    expect(request).not.toHaveProperty('responseFormat')
    expect(request.prompt).toContain('interface Response')
    expect(request.prompt).toContain('valid JSON object')
  })

  it('keeps malformed or schema-invalid text failures non-retrying', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{"ok":"wrong"}',
      finishReason: 'stop',
    } as never)
    await expect(
      generateCollaborativeJsonText(
        {
          ...input,
          presetId: 'task',
          schema: z.object({ ok: z.boolean() }),
          presetOverride: override,
        },
        'collaborative-scene-director',
      ),
    ).rejects.toThrow()
    expect(generateText).toHaveBeenCalledOnce()
  })
})

describe('collaborative Director text streaming', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['pending', 'reject', 'throw'] as const)(
    'preserves the provider error when iterator cleanup will %s',
    async (cleanup) => {
      const error = new Error('original provider failure')
      const close = vi.fn(() => {
        if (cleanup === 'throw') throw new Error('cleanup failure')
        if (cleanup === 'reject') return Promise.reject(new Error('cleanup failure'))
        return new Promise(() => {})
      })
      vi.mocked(streamText).mockReturnValueOnce({
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false, value: { type: 'error', error } }),
            return: close,
          }),
        },
        finishReason: new Promise(() => {}),
      } as never)
      await expect(
        generateCollaborativeText({
          ...input,
          presetId: 'task',
          presetOverride: override,
          requestBudgetMs: 1000,
        }),
      ).rejects.toBe(error)
      expect(close).toHaveBeenCalledOnce()
      expect(streamText).toHaveBeenCalledOnce()
    },
  )

  it('rejects an abort event even after visible text and stop metadata', async () => {
    const onDiagnostic = vi.fn()
    vi.mocked(streamText).mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'text-delta', text: '半份简报' }
        yield { type: 'abort', reason: '用户取消' }
      })(),
      finishReason: Promise.resolve('stop'),
    } as never)
    await expect(
      generateCollaborativeText({
        ...input,
        presetId: 'task',
        presetOverride: override,
        requestBudgetMs: 1000,
        onDiagnostic,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', message: '用户取消' })
    expect(onDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamCompleted: true }),
    )
  })

  it('does not hand off nonempty but token-truncated control text', async () => {
    vi.mocked(streamText).mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'text-delta', text: '未完成的导演简报' }
      })(),
      finishReason: Promise.resolve('length'),
    } as never)
    await expect(
      generateCollaborativeText({
        ...input,
        presetId: 'task',
        presetOverride: override,
        requestBudgetMs: 180000,
      }),
    ).rejects.toThrow('尚未完成')
    expect(streamText).toHaveBeenCalledOnce()
  })

  it.each([4096, 16384, 32768])(
    'keeps Director reasoning and the configured output budget: %s',
    async (maxTokens) => {
      vi.mocked(streamText).mockReturnValueOnce({
        stream: (async function* () {
          yield { type: 'text-delta', text: '【用户意图】\n继续\n【场景安排】\n承接后果' }
        })(),
        finishReason: Promise.resolve('stop'),
      } as never)

      await expect(
        generateCollaborativeText({
          ...input,
          presetId: 'task',
          presetOverride: { ...override, maxTokens, reasoningEffort: 'low' },
          serviceId: 'collaborative:sceneDirector',
        }),
      ).resolves.toContain('【场景安排】')

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: maxTokens,
          reasoning: 'low',
          providerOptions: { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'low' } },
        }),
      )
    },
  )

  it('enforces the deadline even when iterator cleanup ignores cancellation', async () => {
    vi.useFakeTimers()
    const close = vi.fn(() => new Promise(() => {}))
    vi.mocked(streamText).mockReturnValueOnce({
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: close,
        }),
      },
    } as never)
    const pending = generateCollaborativeText({
      ...input,
      presetId: 'task',
      presetOverride: override,
      requestBudgetMs: 123000,
    }).then(
      () => null,
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(123000)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    { presetTimeout: 600000, requestBudget: undefined, expected: 600000 },
    { presetTimeout: undefined, requestBudget: undefined, expected: 300000 },
    { presetTimeout: 600000, requestBudget: 180000, expected: 180000 },
  ])(
    'uses the resolved Director deadline without a hidden cap: $expected ms',
    async ({ presetTimeout, requestBudget, expected }) => {
      vi.useFakeTimers()
      const close = vi.fn(() => new Promise(() => {}))
      vi.mocked(streamText).mockReturnValueOnce({
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}),
            return: close,
          }),
        },
      } as never)
      let settled = false
      const pending = generateCollaborativeText({
        ...input,
        presetId: 'task',
        presetOverride: { ...override, timeoutMs: presetTimeout },
        serviceId: 'collaborative:sceneDirector',
        requestBudgetMs: requestBudget,
      }).then(
        () => {
          settled = true
          return null
        },
        (error) => {
          settled = true
          return error
        },
      )
      await vi.advanceTimersByTimeAsync(120000)
      expect(settled).toBe(false)
      expect(close).not.toHaveBeenCalled()
      expect(createModelFromProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeoutMs: expected }),
      )
      await vi.advanceTimersByTimeAsync(expected - 120000 - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toMatchObject({
        name: 'TimeoutError',
        message: `collaborative:sceneDirector request timed out after ${expected}ms`,
      })
      expect(close).toHaveBeenCalledOnce()
    },
  )

  it('allows a Director stream to complete after two minutes within its Profile timeout', async () => {
    vi.useFakeTimers()
    vi.mocked(streamText).mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'text-delta', text: '开头' }
        await new Promise((resolve) => setTimeout(resolve, 150000))
        yield { type: 'text-delta', text: '完整简报' }
      })(),
      finishReason: Promise.resolve('stop'),
    } as never)
    const result = generateCollaborativeText({
      ...input,
      presetId: 'task',
      presetOverride: { ...override, timeoutMs: 600000 },
      serviceId: 'collaborative:sceneDirector',
    })
    const assertion = expect(result).resolves.toBe('开头完整简报')
    await vi.advanceTimersByTimeAsync(150000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes cleanup after a completed stream in the same request deadline', async () => {
    vi.useFakeTimers()
    const close = vi.fn(() => new Promise(() => {}))
    vi.mocked(streamText).mockReturnValueOnce({
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockResolvedValue({ done: true }),
          return: close,
        }),
      },
      finishReason: Promise.resolve('stop'),
    } as never)
    let settled = false
    let failure: unknown
    const pending = generateCollaborativeText({
      ...input,
      presetId: 'task',
      presetOverride: override,
      requestBudgetMs: 1000,
    }).catch((error) => {
      failure = error
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(close).toHaveBeenCalledOnce()
    expect(settled).toBe(true)
    expect(failure).toMatchObject({ name: 'TimeoutError' })
    await pending
  })

  it('does not wait beyond the budget for finish metadata after text', async () => {
    vi.useFakeTimers()
    vi.mocked(streamText).mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'text-delta', text: '尚未收到完成信号' }
      })(),
      finishReason: new Promise(() => {}),
    } as never)
    const pending = generateCollaborativeText({
      ...input,
      presetId: 'task',
      presetOverride: override,
      requestBudgetMs: 1000,
    }).then(
      () => null,
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
  })
  it('forwards every raw text delta in order without reconstruction or retry', async () => {
    vi.mocked(streamText).mockReturnValueOnce({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '  第一段' }
          yield { type: 'text-delta', text: '\n\n第二段  ' }
        },
      },
      finishReason: Promise.resolve('stop'),
    } as never)
    const onChunk = vi.fn()

    await expect(
      generateCollaborativeText({
        ...input,
        presetId: 'task',
        presetOverride: override,
        requestBudgetMs: 90_000,
        serviceId: 'collaborative:sceneDirector',
        onChunk,
      }),
    ).resolves.toBe('  第一段\n\n第二段  ')

    expect(onChunk.mock.calls.map(([chunk]) => chunk)).toEqual(['  第一段', '\n\n第二段  '])
    expect(streamText).toHaveBeenCalledOnce()
  })
})

describe.each(['stream', 'generate'] as const)('%s narrative', (mode) => {
  const run = mode === 'stream' ? streamNarrative : generateNarrative
  const request = mode === 'stream' ? streamText : generateText

  it('preserves the ordinary main narrative configuration', async () => {
    await run(input)
    expect(settings.getMainNarrativeProfile).toHaveBeenCalledOnce()
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
    expect(createModelFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: mainProfile,
        modelId: 'main-model',
        manualBody: '{"top_p":0.9}',
        presetId: 'narrative',
      }),
    )
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.8,
        maxOutputTokens: 4096,
        reasoning: 'medium',
        abortSignal: input.signal,
      }),
    )
  })

  it('uses workflow profile/model and request settings without changing global settings', async () => {
    const before = JSON.stringify(settings.apiSettings)
    await run({ ...input, presetOverride: override })
    expect(settings.getMainNarrativeProfile).not.toHaveBeenCalled()
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
    expect(createModelFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: workflowProfile,
        modelId: 'workflow-model',
        manualBody: '{"top_p":0.7}',
      }),
    )
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        system: input.system,
        prompt: input.prompt,
        temperature: 0.95,
        maxOutputTokens: 8192,
        reasoning: 'high',
        abortSignal: input.signal,
        providerOptions: { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } },
      }),
    )
    expect(JSON.stringify(settings.apiSettings)).toBe(before)
  })

  it('rejects missing explicit profiles rather than using the main narrator', async () => {
    await expect(async () =>
      run({ ...input, presetOverride: { ...override, profileId: 'missing' } }),
    ).rejects.toThrow('Profile not found: missing')
    expect(createModelFromProfile).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('retains the existing manual-mode behavior', async () => {
    settings.advancedRequestSettings.manualMode = true
    await run(input)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: mode === 'stream' ? undefined : 0.8,
        maxOutputTokens: mode === 'stream' ? undefined : 4096,
        providerOptions: undefined,
      }),
    )
  })

  it('keeps the override binding in global manual mode', async () => {
    settings.advancedRequestSettings.manualMode = true
    await run({ ...input, presetOverride: override })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: override.temperature,
        maxOutputTokens: override.maxTokens,
        reasoning: override.reasoningEffort,
        providerOptions: { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } },
      }),
    )
    expect(createModelFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'collaborative-chinese-writer',
        modelId: override.model,
        profile: workflowProfile,
      }),
    )
    expect(settings.advancedRequestSettings.manualMode).toBe(true)
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
  })
})

describe('stream narrative debug identity', () => {
  it.each([undefined, override])(
    'pairs request and summary without logging prompts',
    async (presetOverride) => {
      streamNarrative({ ...input, presetOverride })
      const modelOptions = vi.mocked(createModelFromProfile).mock.calls[0][0]
      const requestOptions = vi.mocked(streamText).mock.calls[0][0]
      const serviceId = presetOverride ? 'collaborative-chinese-writer' : 'narrative'
      expect(modelOptions.presetId).toBe(serviceId)
      expect(modelOptions.debugId).toEqual(expect.any(String))
      const result = {
        finishReason: 'stop',
        usage: { totalTokens: 42 },
        providerMetadata: { provider: { echoedPrompt: 'Private provider prompt' } },
        text: 'Private prose',
        request: { body: 'Private prompt' },
      }
      await requestOptions.onFinish!(result as never)
      expect(debug.addDebugResponse).toHaveBeenCalledExactlyOnceWith(
        modelOptions.debugId,
        `${serviceId}:result`,
        {
          _note: 'This is the final SDK summary. Look at the other log entry for the raw response.',
          finishReason: result.finishReason,
          usage: result.usage,
          providerMetadata: presetOverride ? undefined : result.providerMetadata,
        },
        expect.any(Number),
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain(input.prompt)
      expect(JSON.stringify(log.mock.calls)).not.toContain(input.system)
      if (presetOverride) {
        expect(JSON.stringify(vi.mocked(debug.addDebugResponse).mock.calls)).not.toContain(
          'Private',
        )
      }
    },
  )
})
