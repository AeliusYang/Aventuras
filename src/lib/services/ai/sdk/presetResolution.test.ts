import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    advancedRequestSettings: {
      manualMode: false,
    },
    apiSettings: { mainNarrativeProfileId: 'main' },
    getPresetConfig: vi.fn(),
    getProfile: vi.fn(),
    getProfileModels: vi.fn(),
  },
}))

vi.mock('$lib/stores/debug.svelte', () => ({
  debugStore: {
    logApiRequest: vi.fn(),
    logApiResponse: vi.fn(),
  },
}))

import {
  buildProviderOptions,
  resolvePresetModel,
  resolveStructuredOutputs,
  thinkingNudgeApplies,
} from './presetResolution'
import { usesThinkTag } from './providers/config'
import type { APIProfile, GenerationPreset } from '$lib/types'
import { settings } from '$lib/stores/settings.svelte'
import { createModelFromProfile } from './providers'

vi.mock('./providers', () => ({ createModelFromProfile: vi.fn(() => ({ modelId: 'mock' })) }))

beforeEach(() => {
  settings.advancedRequestSettings.manualMode = false
})

describe('resolvePresetModel', () => {
  const preset: GenerationPreset = {
    id: 'task',
    name: 'Task',
    description: null,
    profileId: 'task-profile',
    model: 'task-model',
    temperature: 0.3,
    maxTokens: 1000,
    reasoningEffort: 'none',
    manualBody: '',
  }
  const override: GenerationPreset = {
    ...preset,
    id: 'collaborative:sceneDirector',
    profileId: 'workflow-profile',
    model: 'workflow-model',
    temperature: 0.9,
    maxTokens: 6000,
    reasoningEffort: 'high',
    manualBody: '{"top_p":0.8}',
    structuredOutputOverride: 'off',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(settings.getPresetConfig).mockReturnValue(preset)
    vi.mocked(settings.getProfile).mockImplementation(
      (id) => ({ id, providerType: 'openai-compatible' }) as APIProfile,
    )
    vi.mocked(settings.getProfileModels).mockReturnValue([])
  })

  it('preserves normal task/service resolution without an override', () => {
    const result = resolvePresetModel({ presetId: 'task', serviceId: 'classification' })
    expect(settings.getPresetConfig).toHaveBeenCalledExactlyOnceWith('task', 'classification')
    expect(result.preset).toBe(preset)
    expect(createModelFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ id: 'task-profile' }),
        modelId: 'task-model',
        presetId: 'classification',
        serviceId: 'classification',
        manualBody: '',
      }),
    )
  })

  it('bypasses task resolution and uses the complete override for model construction', () => {
    const snapshot = JSON.stringify(override)
    const result = resolvePresetModel({
      presetId: 'task',
      serviceId: 'classification',
      debugId: 'debug',
      presetOverride: override,
    })
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
    expect(settings.getProfileModels).toHaveBeenCalledWith('workflow-profile')
    expect(result.preset).toBe(override)
    expect(result.reasoning).toBe('high')
    expect(result.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: 'high' } })
    expect(result.supportsStructuredOutput).toBe(false)
    expect(createModelFromProfile).toHaveBeenCalledExactlyOnceWith({
      profile: { id: 'workflow-profile', providerType: 'openai-compatible' },
      modelId: 'workflow-model',
      presetId: 'classification',
      serviceId: 'classification',
      debugId: 'debug',
      structuredOutputs: false,
      manualBody: '{"top_p":0.8}',
    })
    expect(JSON.stringify(override)).toBe(snapshot)
  })

  it('uses the main narrative profile for a null override profile', () => {
    resolvePresetModel({
      presetId: 'task',
      serviceId: 'test',
      presetOverride: { ...override, profileId: null },
    })
    expect(settings.getProfile).toHaveBeenCalledWith('main')
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
  })

  it('keeps override provider options while preserving ordinary manual mode', () => {
    settings.advancedRequestSettings.manualMode = true
    expect(
      resolvePresetModel({ presetId: 'task', serviceId: 'test' }).providerOptions,
    ).toBeUndefined()
    const result = resolvePresetModel({
      presetId: 'task',
      serviceId: 'test',
      presetOverride: override,
    })
    expect(result.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: 'high' } })
    expect(settings.advancedRequestSettings.manualMode).toBe(true)
  })

  it('fails for a missing explicit override profile instead of falling back', () => {
    vi.mocked(settings.getProfile).mockReturnValue(undefined)
    expect(() =>
      resolvePresetModel({ presetId: 'task', serviceId: 'test', presetOverride: override }),
    ).toThrow('Profile not found: workflow-profile')
    expect(settings.getPresetConfig).not.toHaveBeenCalled()
    expect(createModelFromProfile).not.toHaveBeenCalled()
  })
})

describe('buildProviderOptions', () => {
  const basePreset: GenerationPreset = {
    id: 'test-preset',
    name: 'Test Preset',
    description: 'Test description',
    profileId: 'test-profile',
    manualBody: '',
    model: 'Gemma 4 31B',
    temperature: 0.7,
    maxTokens: 1000,
    reasoningEffort: 'none',
  }

  it('names the reasoning option the way @ai-sdk/openai-compatible reads it', () => {
    const resultNone = buildProviderOptions(
      { ...basePreset, reasoningEffort: 'none' },
      'openai-compatible',
    )
    expect(resultNone).toEqual({
      openaiCompatible: {
        reasoningEffort: 'none',
      },
    })

    const resultHigh = buildProviderOptions(
      { ...basePreset, reasoningEffort: 'high' },
      'openai-compatible',
    )
    expect(resultHigh).toEqual({
      openaiCompatible: {
        reasoningEffort: 'high',
      },
    })
  })

  it('uses the same key for every provider built by createOpenAICompatible', () => {
    for (const provider of [
      'llamacpp',
      'lmstudio',
      'ollama',
      'nanogpt',
      'chutes',
      'nvidia-nim',
    ] as const) {
      const result = buildProviderOptions({ ...basePreset, reasoningEffort: 'low' }, provider)
      const options = Object.values(result ?? {})[0] as Record<string, unknown>

      expect(options, `${provider} sent no reasoning option`).toHaveProperty(
        'reasoningEffort',
        'low',
      )
      expect(options, `${provider} still sends the snake_case key`).not.toHaveProperty(
        'reasoning_effort',
      )
    }
  })

  it('sends Zhipu the camelCase key alongside its own thinking switch', () => {
    // Zhipu is `createOpenAICompatible` too, but has a second, provider-specific key, so
    // it is the one branch the loop above cannot cover.
    expect(buildProviderOptions({ ...basePreset, reasoningEffort: 'high' }, 'zhipu')).toEqual({
      zhipu: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      },
    })
  })

  it('turns Zhipu thinking off for "none" rather than asking for none of it', () => {
    // The effort key is dropped here on purpose: `thinking: disabled` is what suppresses
    // it, and sending both says two things about one setting.
    expect(buildProviderOptions({ ...basePreset, reasoningEffort: 'none' }, 'zhipu')).toEqual({
      zhipu: {
        thinking: { type: 'disabled' },
      },
    })
  })

  it('carries "none" through rather than omitting it', () => {
    // `none` is what suppresses thinking, so omitting it is not equivalent to sending it.
    const result = buildProviderOptions({ ...basePreset, reasoningEffort: 'none' }, 'llamacpp')
    expect(result).toEqual({ llamacpp: { reasoningEffort: 'none' } })
  })

  it('looks up hyphenated providers under the camelCase key the SDK prefers', () => {
    expect(buildProviderOptions({ ...basePreset, reasoningEffort: 'low' }, 'nvidia-nim')).toEqual({
      nvidiaNim: { reasoningEffort: 'low' },
    })
  })

  it('keeps snake_case for Pollinations, which is not an openai-compatible provider', () => {
    // `ai-sdk-pollinations` declares `reasoning_effort` in its own settings interface.
    expect(
      buildProviderOptions({ ...basePreset, reasoningEffort: 'medium' }, 'pollinations'),
    ).toEqual({ pollinations: { reasoning_effort: 'medium', parallel_tool_calls: true } })
  })
})

describe('resolveStructuredOutputs', () => {
  const preset = (override?: 'auto' | 'on' | 'off'): GenerationPreset => ({
    id: 'p',
    name: 'p',
    description: '',
    profileId: 'x',
    manualBody: '',
    model: 'm',
    temperature: 0.7,
    maxTokens: 1000,
    reasoningEffort: 'none',
    structuredOutputOverride: override,
  })

  it('honours an explicit override whatever the catalogue says', () => {
    expect(resolveStructuredOutputs(preset('on'), 'nanogpt', false)).toBe(true)
    expect(resolveStructuredOutputs(preset('off'), 'nanogpt', true)).toBe(false)
  })

  it('trusts the per-model flag where the provider publishes one', () => {
    expect(resolveStructuredOutputs(preset('auto'), 'nanogpt', true)).toBe(true)
    expect(resolveStructuredOutputs(preset('auto'), 'nanogpt', false)).toBe(false)
  })

  it('falls back to the provider default where it does not', () => {
    // llama.cpp publishes no catalogue, so the per-model flag is meaningless there. The
    // expected value is written out rather than read back from PROVIDERS, which would make
    // the assertion agree with whatever the config says and test nothing.
    expect(resolveStructuredOutputs(preset('auto'), 'llamacpp', undefined)).toBe(true)
    expect(resolveStructuredOutputs(preset('auto'), 'llamacpp', false)).toBe(true)
  })

  it('treats a missing override as auto, which is what an older preset has stored', () => {
    expect(resolveStructuredOutputs(preset(undefined), 'nanogpt', true)).toBe(true)
  })
})

describe('thinkingNudgeApplies', () => {
  const base = {
    providerType: 'llamacpp' as const,
    reasoningEffort: 'high' as const,
    supportsStructuredOutput: false,
  }

  it('needs a think-tag provider', () => {
    expect(thinkingNudgeApplies(base)).toBe(true)
    expect(thinkingNudgeApplies({ ...base, providerType: 'anthropic' })).toBe(false)
  })

  it('needs reasoning to be on', () => {
    expect(thinkingNudgeApplies({ ...base, reasoningEffort: 'none' })).toBe(false)
    expect(thinkingNudgeApplies({ ...base, reasoningEffort: undefined })).toBe(false)
  })

  it('needs the schema to travel in the prompt, which native structured output replaces', () => {
    expect(thinkingNudgeApplies({ ...base, supportsStructuredOutput: true })).toBe(false)
  })

  it('covers the generic openai-compatible provider, whose model is unknown', () => {
    expect(thinkingNudgeApplies({ ...base, providerType: 'openai-compatible' })).toBe(true)
  })
})

describe('usesThinkTag', () => {
  it('is one expression for a condition that used to be written four times', () => {
    // The fourth, in generateNarrative, omitted the openai-compatible half entirely.
    expect(usesThinkTag('openai-compatible')).toBe(true)
    expect(usesThinkTag('anthropic')).toBe(false)
  })
})
