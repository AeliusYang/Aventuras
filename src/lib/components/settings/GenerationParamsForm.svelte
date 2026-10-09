<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte'
  import { Brain, Settings2 } from '@lucide/svelte'
  import type { ReasoningEffort } from '$lib/types'
  import { cn } from '$lib/utils/cn'
  import { supportsReasoning, supportsCapabilityFetch } from '$lib/services/ai/sdk/providers'
  import {
    clampReasoningToCapability,
    REASONING_LEVELS,
    reasoningCapabilityFor,
    type ReasoningCapability,
  } from '$lib/services/ai/core/reasoning'

  import { Label } from '$lib/components/ui/label'
  import { Slider } from '$lib/components/ui/slider'
  import { Input } from '$lib/components/ui/input'
  import ModelSelector from './ModelSelector.svelte'

  const REASONING_LABELS: Record<ReasoningEffort, string> = {
    none: '关闭',
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
  }

  interface Props {
    profileId: string | null
    model: string
    temperature: number
    maxTokens: number
    reasoningEffort: ReasoningEffort
    timeoutMs?: number

    onProfileChange: (id: string | null) => Promise<void>
    onModelChange: (model: string) => void
    onTemperatureChange: (v: number) => void
    onMaxTokensChange: (v: number) => void
    onReasoningChange: (v: ReasoningEffort) => void
    onTimeoutChange?: (v: number) => void

    onRefreshModels: () => Promise<void>
    isRefreshingModels?: boolean
    class?: string
    isManualMode?: boolean
  }

  let {
    profileId,
    model,
    temperature,
    maxTokens,
    reasoningEffort,
    timeoutMs,
    onProfileChange,
    onModelChange,
    onTemperatureChange,
    onMaxTokensChange,
    onReasoningChange,
    onTimeoutChange,
    onRefreshModels,
    isRefreshingModels = false,
    class: className = '',
    isManualMode = false,
  }: Props = $props()

  // ============================================================================
  // Token slider — non-linear steps
  // ============================================================================

  const TOKEN_STEPS = [
    1024,
    2048,
    3072,
    4096,
    5120,
    6144,
    7168,
    8192, // step 1024 (indices 0–7)
    10240,
    12288,
    14336,
    16384, // step 2048 (indices 8–11)
    20480,
    24576,
    28672,
    32768, // step 4096 (indices 12–15)
  ]

  function snapToSliderIndex(value: number): number {
    let best = 0
    let bestDist = Math.abs(value - TOKEN_STEPS[0])
    for (let i = 1; i < TOKEN_STEPS.length; i++) {
      const dist = Math.abs(value - TOKEN_STEPS[i])
      if (dist < bestDist) {
        best = i
        bestDist = dist
      }
    }
    return best
  }

  // The slider works on indices 0–15; display value comes from TOKEN_STEPS
  let tokenSliderIndex = $derived(snapToSliderIndex(maxTokens))
  // Is the current maxTokens value outside the slider range?
  let isTokenManualOverride = $derived(!TOKEN_STEPS.includes(maxTokens))

  // Numeric override UI state
  let showNumericOverride = $state(false)
  const numericValue = {
    get value() {
      return maxTokens
    },
    set value(v: number) {
      onMaxTokensChange(v)
    },
  }

  function handleSliderTokenChange(idx: number) {
    showNumericOverride = false
    const val = TOKEN_STEPS[idx] ?? TOKEN_STEPS[TOKEN_STEPS.length - 1]
    onMaxTokensChange(val)
  }

  function handleNumericInput(e: Event) {
    const raw = parseInt((e.currentTarget as HTMLInputElement).value, 10)
    if (!isNaN(raw)) {
      numericValue.value = raw
    }
  }

  function handleNumericBlur(e: Event) {
    const raw = parseInt((e.currentTarget as HTMLInputElement).value, 10)
    if (isNaN(raw) || raw < 256) {
      numericValue.value = 256
    } else if (raw > 262144) {
      numericValue.value = 262144
    }
  }

  function toggleNumericOverride() {
    if (showNumericOverride) {
      // closing: snap slider to nearest TOKEN_STEP if within range
      showNumericOverride = false
      const snapped = TOKEN_STEPS[snapToSliderIndex(numericValue.value)]
      numericValue.value = snapped
    } else {
      showNumericOverride = true
    }
  }

  // ============================================================================
  // Reasoning
  // ============================================================================

  let effectiveProfileId = $derived(profileId || settings.getDefaultProfileIdForProvider())

  function getReasoningIndex(value?: ReasoningEffort): number {
    const index = REASONING_LEVELS.indexOf(value ?? 'none')
    return index === -1 ? 0 : index
  }

  function getReasoningValue(index: number): ReasoningEffort {
    return REASONING_LEVELS[Math.min(Math.max(0, index), REASONING_LEVELS.length - 1)]
  }

  let reasoningValue = $derived(getReasoningIndex(reasoningEffort))

  let modelReasoningCapability = $derived.by<ReasoningCapability>(() => {
    const profile = settings.getProfile(effectiveProfileId)
    if (!profile) return 'unsupported'
    return reasoningCapabilityFor({
      providerType: profile.providerType,
      modelId: model,
      providerSupportsReasoning: supportsReasoning(profile.providerType),
      providerFetchesModelCapabilities: supportsCapabilityFetch(profile.providerType),
      modelSupportsReasoning: settings
        .getProfileModels(effectiveProfileId)
        .find((x) => x.id === model)?.reasoning,
    })
  })

  // An enforced model cannot be turned off, so its slider has no 'none' stop.
  let reasoningSliderMin = $derived(modelReasoningCapability === 'enforced' ? 1 : 0)

  // Whether the badge can name the model or only the provider.
  let providerFetchesModelCapabilities = $derived.by(() => {
    const profile = settings.getProfile(effectiveProfileId)
    return !!profile && supportsCapabilityFetch(profile.providerType)
  })

  // Everything the capability implies for the chosen level lives in `clampReasoningToCapability`.
  $effect(() => {
    const clamped = clampReasoningToCapability(reasoningEffort, modelReasoningCapability)
    if (clamped !== reasoningEffort) onReasoningChange(clamped)
  })

  // ============================================================================
  // Model change logic
  // ============================================================================

  function handleModelChange(newModel: string) {
    // Enforcement logic is now handled in the $effect above
    onModelChange(newModel)
  }

  function handleTimeoutBlur(event: Event) {
    if (!onTimeoutChange) return
    const raw = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10)
    onTimeoutChange(
      Number.isFinite(raw)
        ? Math.min(Math.max(raw, 1000), 600000)
        : (timeoutMs ?? settings.apiSettings.llmTimeoutMs),
    )
  }
</script>

<div class={cn('grid gap-4', className)}>
  <!-- Profile + Model selector -->
  <ModelSelector
    class="grid-cols-1 md:grid-cols-2"
    {profileId}
    {model}
    onProfileChange={async (id) => await onProfileChange(id)}
    onModelChange={handleModelChange}
    {onRefreshModels}
    {isRefreshingModels}
  />

  <!-- Reasoning capability badge -->
  {#if modelReasoningCapability !== 'unsupported'}
    <div class="flex items-center gap-1.5 text-xs text-emerald-500">
      <Brain class="h-3.5 w-3.5" />
      {#if modelReasoningCapability === 'enforced'}
        此模型始终启用推理
      {:else if providerFetchesModelCapabilities}
        支持推理
      {:else}
        服务商支持推理，当前模型的支持情况未知
      {/if}
    </div>
  {/if}

  <!-- Temperature & Max Output Tokens row -->
  <div
    class={cn(
      'grid grid-cols-1 gap-6 border-t pt-4 md:grid-cols-2',
      isManualMode && 'pointer-events-none opacity-50',
    )}
  >
    <!-- Temperature -->
    <div class="grid gap-4">
      <div class="flex justify-between">
        <Label>温度</Label>
        <span class="text-muted-foreground text-xs">{temperature.toFixed(2)}</span>
      </div>
      <Slider
        value={temperature}
        type="single"
        min={0}
        max={2}
        step={0.05}
        onValueChange={onTemperatureChange}
      />
      <div class="text-muted-foreground flex justify-between text-xs">
        <span>更集中</span>
        <span>更多变化</span>
      </div>
    </div>

    <!-- Max Output Tokens -->
    <div class="grid gap-4">
      <div class="flex items-center justify-between">
        <div class="grid gap-0.5">
          <Label>最大输出 Token 数</Label>
          <span class="text-muted-foreground text-[10px] leading-tight">
            包含推理和回复的 Token 数
          </span>
        </div>
        <div class="flex items-center gap-1.5">
          {#if isTokenManualOverride || showNumericOverride}
            <span
              class="text-muted-foreground rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              手动
            </span>
          {:else}
            <span class="text-muted-foreground text-xs">
              {maxTokens.toLocaleString()}
            </span>
          {/if}
          <button
            type="button"
            onclick={toggleNumericOverride}
            class={cn(
              'rounded p-0.5 transition-colors',
              showNumericOverride ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            title={showNumericOverride ? '关闭手动输入，恢复到滑块档位' : '输入精确数值（高级）'}
          >
            <Settings2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <!-- Slider (disabled/dimmed when override is active) -->
      <div
        class={cn(
          'transition-opacity',
          (showNumericOverride || isTokenManualOverride) && 'pointer-events-none opacity-40',
        )}
      >
        <Slider
          value={tokenSliderIndex}
          type="single"
          min={0}
          max={TOKEN_STEPS.length - 1}
          step={1}
          onValueChange={handleSliderTokenChange}
        />
        <div class="text-muted-foreground relative mt-1 h-4 text-xs">
          <span class="absolute left-0">1K</span>
          <span class="absolute -translate-x-1/2" style="left: 20%">4K</span>
          <span class="absolute -translate-x-1/2" style="left: 46.67%">8K</span>
          <span class="absolute -translate-x-1/2" style="left: 73.33%">16K</span>
          <span class="absolute right-0">32K</span>
        </div>
      </div>

      <!-- Numeric override input (collapsible) -->
      {#if showNumericOverride || isTokenManualOverride}
        <Input
          type="number"
          class="h-8 w-full text-left"
          value={numericValue.value}
          min={256}
          max={262144}
          step={256}
          oninput={handleNumericInput}
          onblur={handleNumericBlur}
          placeholder="256 – 262144"
        />
        <p class="text-muted-foreground text-[10px]">
          高级手动设置：可输入 256 至 262,144 之间的数值
        </p>
      {/if}
    </div>
  </div>

  <!-- Thinking / Reasoning row (shown only when provider+model supports it) -->
  {#if modelReasoningCapability !== 'unsupported'}
    <div
      class={cn(
        'grid grid-cols-1 gap-6 border-t pt-4 md:grid-cols-2',
        isManualMode && 'pointer-events-none opacity-50',
      )}
    >
      <div class="grid gap-4">
        <div class="flex justify-between">
          <Label>推理强度： {REASONING_LABELS[reasoningEffort]}</Label>
        </div>
        <!-- An enforced model starts at the first level above 'none'; the ticks and the
             bounds both come from REASONING_LEVELS, so adding a level cannot desync them. -->
        <Slider
          value={reasoningValue}
          type="single"
          min={reasoningSliderMin}
          max={REASONING_LEVELS.length - 1}
          step={1}
          onValueChange={(v) => onReasoningChange(getReasoningValue(v))}
        />
        <div class="text-muted-foreground flex justify-between text-xs">
          {#each REASONING_LEVELS.slice(reasoningSliderMin) as level (level)}
            <span>{REASONING_LABELS[level]}</span>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if timeoutMs !== undefined && onTimeoutChange}
    <div class={cn('grid gap-2 border-t pt-4', isManualMode && 'pointer-events-none opacity-50')}>
      <Label for="agent-timeout-ms">请求超时（毫秒）</Label>
      <Input
        id="agent-timeout-ms"
        type="number"
        min={1000}
        max={600000}
        step={1000}
        value={timeoutMs}
        onblur={handleTimeoutBlur}
      />
      <p class="text-muted-foreground text-xs">
        此值由绑定该 Profile 的任务共同继承；中文写作 Director 也使用此值作为完整请求的超时时间。
      </p>
    </div>
  {/if}
</div>
