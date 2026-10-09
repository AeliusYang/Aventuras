import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { GenerationPreset } from '$lib/types'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const fixture = vi.hoisted(() => ({ model: null as unknown as LanguageModelV4 }))
vi.mock('$lib/stores/settings.svelte', () => ({ settings: {} }))
vi.mock('$lib/stores/debug.svelte', () => ({ debug: {} }))
vi.mock('$lib/log', () => ({ createLogger: () => () => undefined }))
vi.mock('./providers', () => ({ createModelFromProfile: vi.fn() }))
vi.mock('./middleware', () => ({
  loggingMiddleware: () => ({}),
  patchResponseMiddleware: () => ({}),
  promptSchemaMiddleware: () => ({}),
}))
vi.mock('./presetResolution', () => ({
  resolvePresetModel: ({ presetOverride }: { presetOverride: GenerationPreset }) => ({
    preset: presetOverride,
    model: fixture.model,
    providerOptions: {},
    reasoning: presetOverride.reasoningEffort,
    useThinkTag: false,
  }),
  buildProviderOptions: vi.fn(),
  thinkingNudgeApplies: vi.fn(),
}))

import { generateCollaborativeText } from './generate'

const preset: GenerationPreset = {
  id: 'control',
  name: 'Control',
  description: null,
  model: 'fixture',
  profileId: 'fixture',
  temperature: 0.3,
  maxTokens: 8192,
  reasoningEffort: 'low',
  manualBody: '',
}
const complete = (reason: 'stop' | 'error' | 'other' | 'length'): LanguageModelV4StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 2, reasoning: 1 },
  },
})
const visible: LanguageModelV4StreamPart[] = [
  { type: 'text-start', id: 'response' },
  { type: 'text-delta', id: 'response', delta: '  原始简报\n' },
  { type: 'text-end', id: 'response' },
]
const run = (parts: LanguageModelV4StreamPart[], onChunk = vi.fn()) => {
  const doStream = vi.fn(async () => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
  }))
  fixture.model = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId: 'fixture',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream,
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const promise = generateCollaborativeText({
    presetId: preset.id,
    presetOverride: preset,
    system: '系统任务',
    prompt: '继续',
    serviceId: 'collaborative:patternReviewer',
    requestBudgetMs: 1000,
    onChunk,
  })
  return { promise, doStream, onChunk }
}
afterEach(() => vi.restoreAllMocks())

describe('collaborative control with the installed real AI SDK', () => {
  it('does not turn a provider stream error into a successful partial handoff', async () => {
    const error = new Error('provider stream failed')
    const result = run([...visible, { type: 'error', error }, complete('stop')])
    await expect(result.promise).rejects.toBe(error)
    expect(result.doStream).toHaveBeenCalledOnce()
  })

  it('preserves the real error instead of describing it as empty model text', async () => {
    const error = new Error('provider response rejected')
    const result = run([{ type: 'error', error }, complete('error')])
    await expect(result.promise).rejects.toBe(error)
  })

  it('passes only unchanged visible text, not reasoning events', async () => {
    const result = run([
      { type: 'reasoning-start', id: 'thinking' },
      { type: 'reasoning-delta', id: 'thinking', delta: 'not a handoff' },
      { type: 'reasoning-end', id: 'thinking' },
      ...visible,
      complete('stop'),
    ])
    await expect(result.promise).resolves.toBe('  原始简报\n')
    expect(result.onChunk.mock.calls).toEqual([['  原始简报\n']])
  })

  it('rejects a nonempty stream without a successful finish reason', async () => {
    const result = run([...visible, complete('other')])
    await expect(result.promise).rejects.toThrow('完成')
  })

  it('rejects a provider closing the transport without finish metadata', async () => {
    const result = run(visible)
    await expect(result.promise).rejects.toThrow('完成')
    expect(result.doStream).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'rejects a usage-only SSE ending without finish_reason, visible text=%s',
    async (hasVisibleText) => {
      const delta = hasVisibleText ? { content: '未完成简报' } : { reasoning_content: '内部推理' }
      const events = [
        { choices: [{ index: 0, delta: { role: 'assistant', ...delta } }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
      ]
      const fetch = vi.fn(
        async () =>
          new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      )
      fixture.model = createOpenAICompatible({
        name: 'fixture',
        baseURL: 'https://fixture.invalid/v1',
        fetch,
      })('fixture')
      const onDiagnostic = vi.fn()
      const onChunk = vi.fn()
      await expect(
        generateCollaborativeText({
          presetId: preset.id,
          presetOverride: preset,
          system: '系统任务',
          prompt: '继续',
          serviceId: 'collaborative:patternReviewer',
          requestBudgetMs: 1000,
          onDiagnostic,
          onChunk,
        }),
      ).rejects.toThrow('未正常完成（other）')
      expect(fetch).toHaveBeenCalledOnce()
      expect(onChunk.mock.calls).toEqual(hasVisibleText ? [['未完成简报']] : [])
      expect(onDiagnostic).toHaveBeenCalledWith({ finishReason: 'other' })
      expect(onDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ streamCompleted: true }),
      )
    },
  )
})
