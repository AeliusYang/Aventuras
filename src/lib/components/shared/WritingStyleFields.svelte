<script lang="ts">
  import * as RadioGroup from '$lib/components/ui/radio-group'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import { ui } from '$lib/stores/ui.svelte'
  import { BookOpen, User, Eye, AlignLeft } from '@lucide/svelte'
  import type { POV, Tense, TargetLength, ImageGenerationMode } from '$lib/types'

  interface Props {
    selectedPOV: POV
    selectedTense: Tense
    tone: string
    visualProseMode: boolean
    /** Standard image slot is usable — gates the image mode choice. */
    imageGenerationEnabled: boolean
    /** Background slot is usable. Defaults to `imageGenerationEnabled`. */
    backgroundImagesAvailable?: boolean
    /** Reference-image slot is usable. Defaults to `imageGenerationEnabled`. */
    portraitReferenceAvailable?: boolean
    imageGenerationMode: ImageGenerationMode
    backgroundImagesEnabled: boolean
    referenceMode: boolean
    targetLength?: TargetLength
    /** Drives the paragraph counts shown for each length: they differ per mode. */
    mode?: 'adventure' | 'creative-writing'
    /** Set to disable the length control, e.g. a custom prompt that never renders it. */
    targetLengthDisabledReason?: string
    onPOVChange: (v: POV) => void
    onTenseChange: (v: Tense) => void
    onToneChange: (v: string) => void
    onVisualProseModeChange: (v: boolean) => void
    onImageGenerationModeChange: (v: ImageGenerationMode) => void
    onBackgroundImagesEnabledChange: (v: boolean) => void
    onReferenceModeChange: (v: boolean) => void
    onTargetLengthChange?: (v: TargetLength) => void
    disabledFields?: {
      pov?: boolean
      tense?: boolean
      visualProseMode?: boolean
    }
    disabledReason?: string
    showNarrativeControls?: boolean
    showTone?: boolean
  }

  let {
    selectedPOV,
    selectedTense,
    tone,
    visualProseMode,
    imageGenerationEnabled,
    backgroundImagesAvailable,
    portraitReferenceAvailable,
    imageGenerationMode,
    backgroundImagesEnabled,
    referenceMode,
    targetLength = 'dynamic',
    mode = 'adventure',
    targetLengthDisabledReason,
    onPOVChange,
    onTenseChange,
    onToneChange,
    onVisualProseModeChange,
    onImageGenerationModeChange,
    onBackgroundImagesEnabledChange,
    onReferenceModeChange,
    onTargetLengthChange,
    disabledFields,
    disabledReason,
    showNarrativeControls = true,
    showTone = true,
  }: Props = $props()

  const IMAGE_MODES: { value: ImageGenerationMode; label: string; description: string }[] = [
    {
      value: 'none',
      label: '纯文字',
      description: '纯文字故事，不生成图片。',
    },
    {
      value: 'agentic',
      label: '智能选图',
      description: 'AI 根据故事内容决定何时生成图片。',
    },
    {
      value: 'inline',
      label: '内嵌插图',
      description: '图片直接嵌入正文。',
    },
  ]

  const backgroundAvailable = $derived(backgroundImagesAvailable ?? imageGenerationEnabled)
  const portraitAvailable = $derived(portraitReferenceAvailable ?? imageGenerationEnabled)

  // An unconfigured option can still be turned off, never on: the current selection stays
  // reachable so a story set up on another machine isn't stuck with it.
  function modeLocked(value: ImageGenerationMode): boolean {
    return !imageGenerationEnabled && value !== 'none' && value !== imageGenerationMode
  }
  const imageProfileMissing = $derived(
    !imageGenerationEnabled || !backgroundAvailable || !portraitAvailable,
  )

  /** Must match the ranges `formatLengthInstruction` asks for, which differ per mode. */
  const LENGTH_RANGES = {
    adventure: {
      dynamic: {
        short: '自动',
        long: '根据场景节奏调整篇幅：动作场景约 1–2 段，氛围场景可达 5–6 段。',
      },
      short: { short: '1–3 段', long: '简洁、紧凑的叙述（1–3 段）。' },
      medium: { short: '2–4 段', long: '兼顾推进与细节（2–4 段）。' },
      long: {
        short: '3–6 段',
        long: '更充分地展开正文与环境描写（3–6 段）。',
      },
    },
    'creative-writing': {
      dynamic: {
        short: '自动',
        long: '随场景调整：快速交锋约 2–3 段，章节片段约 4–8 段。',
      },
      short: {
        short: '2–4 段',
        long: '集中、简练，迅速推进（2–4 段）。',
      },
      medium: {
        short: '3–6 段',
        long: '兼顾推进、人物声音与感官细节（3–6 段）。',
      },
      long: {
        short: '5–8 段以上',
        long: '充分展开文学表达、潜台词与氛围（5–8 段以上）。',
      },
    },
  } as const

  const lengthRanges = $derived(LENGTH_RANGES[mode] ?? LENGTH_RANGES.adventure)
  // Both come off disk, where the column is untyped text.
  const selectedLength = $derived<TargetLength>(
    targetLength && targetLength in lengthRanges ? targetLength : 'dynamic',
  )
  const lengthOptions: { id: TargetLength; label: string }[] = [
    { id: 'dynamic', label: '动态' },
    { id: 'short', label: '短' },
    { id: 'medium', label: '中' },
    { id: 'long', label: '长' },
  ]
</script>

<div class="space-y-4">
  <!-- Narrative Config -->
  {#if showNarrativeControls}
    <section class="grid gap-4 sm:gap-8 md:grid-cols-2">
      <!-- Perspective -->
      <div
        class="space-y-1"
        class:opacity-50={disabledFields?.pov}
        class:pointer-events-none={disabledFields?.pov}
      >
        <Label class="flex items-center gap-2 text-base font-semibold">
          <User class="h-4 w-4" />
          叙述人称
        </Label>
        <RadioGroup.Root
          value={selectedPOV}
          onValueChange={(v) => onPOVChange(v as POV)}
          class="grid grid-cols-3 gap-2"
          disabled={disabledFields?.pov}
        >
          {#each ['first', 'second', 'third'] as pov (pov)}
            <Label
              for={`pov-${pov}`}
              class="border-muted bg-popover hover:bg-accent hover:text-accent-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[:focus-visible]:ring-ring flex cursor-pointer flex-col items-center justify-center rounded-md border-2 p-3 text-center has-[:focus-visible]:ring-2"
            >
              <RadioGroup.Item
                value={pov}
                id={`pov-${pov}`}
                class="sr-only"
                disabled={disabledFields?.pov}
              />
              <span class="font-medium capitalize"
                >{pov === 'first' ? '第一人称' : pov === 'second' ? '第二人称' : '第三人称'}</span
              >
            </Label>
          {/each}
        </RadioGroup.Root>
        <p class="text-muted-foreground min-h-[1.25rem] text-xs">
          {#if selectedPOV === 'first'}
            “我拔出了剑……”
          {:else if selectedPOV === 'second'}
            “你拔出了剑……”
          {:else}
            “他／她拔出了剑……”
          {/if}
        </p>
        {#if disabledFields?.pov && disabledReason}
          <p class="text-muted-foreground/70 text-xs italic">{disabledReason}</p>
        {/if}
      </div>

      <!-- Tense -->
      <div
        class="space-y-1"
        class:opacity-50={disabledFields?.tense}
        class:pointer-events-none={disabledFields?.tense}
      >
        <Label class="flex items-center gap-2 text-base font-semibold">
          <BookOpen class="h-4 w-4" />
          时态
        </Label>
        <RadioGroup.Root
          value={selectedTense}
          onValueChange={(v) => onTenseChange(v as Tense)}
          class="grid grid-cols-2 gap-2"
          disabled={disabledFields?.tense}
        >
          {#each ['present', 'past'] as tense (tense)}
            <Label
              for={`tense-${tense}`}
              class="border-muted bg-popover hover:bg-accent hover:text-accent-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[:focus-visible]:ring-ring flex cursor-pointer flex-col items-center justify-center rounded-md border-2 p-3 text-center has-[:focus-visible]:ring-2"
            >
              <RadioGroup.Item
                value={tense}
                id={`tense-${tense}`}
                class="sr-only"
                disabled={disabledFields?.tense}
              />
              <span class="font-medium capitalize">{tense === 'present' ? '现在时' : '过去时'}</span
              >
            </Label>
          {/each}
        </RadioGroup.Root>
        <p class="text-muted-foreground min-h-[1.25rem] text-xs">
          {#if selectedTense === 'present'}
            以现在时叙述。
          {:else}
            以过去时叙述。
          {/if}
        </p>
        {#if disabledFields?.tense && disabledReason}
          <p class="text-muted-foreground/70 text-xs italic">{disabledReason}</p>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Tone -->
  {#if showTone}
    <section class="space-y-2 pt-1">
      <div class="grid w-full items-center gap-2">
        <Input
          label="叙事基调"
          id="tone"
          value={tone}
          oninput={(e) => onToneChange(e.currentTarget.value)}
          placeholder="例如：阴郁冷峻、奇诡轻盈、冷静克制"
        />
      </div>
      <div class="flex flex-wrap gap-2">
        {#each ['Dark Fantasy', 'High Adventure', 'Cozy', 'Horror', 'Cyberpunk', 'Mystery'] as t (t)}
          <Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => onToneChange(t)}>
            {t}
          </Button>
        {/each}
      </div>
    </section>

    <!-- Response Length -->
  {/if}
  {#if onTargetLengthChange && showNarrativeControls}
    {@const lengthDisabled = !!targetLengthDisabledReason}
    <section class="space-y-2 pt-1">
      <Label class="flex items-center gap-2 text-base font-semibold">
        <AlignLeft class="h-4 w-4" />
        正文长度
      </Label>
      <RadioGroup.Root
        value={selectedLength}
        onValueChange={(v) => onTargetLengthChange?.(v as TargetLength)}
        disabled={lengthDisabled}
        class="grid grid-cols-2 gap-2 sm:grid-cols-4 {lengthDisabled ? 'opacity-50' : ''}"
      >
        {#each lengthOptions as item (item.id)}
          <Label
            for={`length-${item.id}`}
            class="border-muted bg-popover has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[:focus-visible]:ring-ring flex flex-col items-center justify-center rounded-md border-2 p-3 text-center has-[:focus-visible]:ring-2 {lengthDisabled
              ? 'cursor-not-allowed'
              : 'hover:bg-accent hover:text-accent-foreground cursor-pointer'}"
          >
            <RadioGroup.Item value={item.id} id={`length-${item.id}`} class="sr-only" />
            <span class="font-medium">{item.label}</span>
            <span class="text-muted-foreground text-xs">{lengthRanges[item.id].short}</span>
          </Label>
        {/each}
      </RadioGroup.Root>
      <p
        class="min-h-[1.25rem] text-xs {lengthDisabled
          ? 'text-amber-500'
          : 'text-muted-foreground'}"
      >
        {targetLengthDisabledReason ?? lengthRanges[selectedLength].long}
      </p>
    </section>
  {/if}

  <!-- Visuals Configuration -->
  <section class="space-y-2 pt-1">
    <Label class="flex items-center gap-2 text-base font-semibold">
      <Eye class="h-4 w-4" />
      视觉呈现
    </Label>

    {#if imageProfileMissing}
      <p class="text-muted-foreground text-xs">
        尚未配置图片服务的选项只能关闭。请前往“设置 → 图片”完成配置。
      </p>
      <Button
        size="sm"
        variant="outline"
        onclick={() => {
          ui.setSettingsTab('images')
          ui.openSettings()
        }}>前往图片设置</Button
      >
    {/if}

    {#if mode === 'creative-writing'}
      <div class="flex items-center space-x-2">
        <Switch
          id="manual-images"
          checked={imageGenerationMode === 'manual'}
          disabled={!imageGenerationEnabled && imageGenerationMode !== 'manual'}
          onCheckedChange={(enabled) => onImageGenerationModeChange(enabled ? 'manual' : 'none')}
        />
        <div class="space-y-1">
          <Label for="manual-images">手动插图</Label>
          <p class="text-muted-foreground text-xs">
            开启后可在已生成正文旁手动配图，每次一张，不随续写自动调用。关闭后隐藏插图，保留已保存图片。
          </p>
        </div>
      </div>
    {/if}

    {#if mode === 'adventure'}
      <RadioGroup.Root
        value={imageGenerationMode}
        onValueChange={(v) => onImageGenerationModeChange(v as ImageGenerationMode)}
        class="grid grid-cols-1 gap-4 md:grid-cols-3"
      >
        {#each IMAGE_MODES as option (option.value)}
          {@const locked = modeLocked(option.value)}
          <div class="relative" class:opacity-50={locked}>
            <Label
              for="img-{option.value}"
              class="border-muted bg-popover has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[:focus-visible]:ring-ring flex h-full flex-col justify-between rounded-xl border-2 p-4 has-[:focus-visible]:ring-2 {locked
                ? 'cursor-not-allowed'
                : 'hover:bg-accent cursor-pointer'}"
            >
              <div class="mb-2 flex w-full items-start justify-between">
                <span class="font-semibold">{option.label}</span>
                <RadioGroup.Item
                  value={option.value}
                  id="img-{option.value}"
                  disabled={locked}
                  class="sr-only"
                />
              </div>
              <div class="text-muted-foreground text-xs font-normal">{option.description}</div>
            </Label>
          </div>
        {/each}
      </RadioGroup.Root>
    {/if}

    <!-- Extra Image Toggles -->
    <div class="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
      <div
        class="flex items-center space-x-2"
        class:opacity-50={!backgroundAvailable && !backgroundImagesEnabled}
      >
        <Switch
          id="bg-images"
          checked={backgroundImagesEnabled}
          disabled={!backgroundAvailable && !backgroundImagesEnabled}
          onCheckedChange={onBackgroundImagesEnabledChange}
        />
        <div class="grid gap-1.5 leading-none">
          <Label for="bg-images">自动场景背景</Label>
          <p class="text-muted-foreground text-xs">
            开启后随故事生成判断场景是否需要更新背景。关闭后隐藏背景，保留已保存图片。
          </p>
        </div>
      </div>

      {#if mode === 'adventure' || imageGenerationMode === 'manual'}
        <div
          class="flex items-center space-x-2"
          class:opacity-50={!portraitAvailable && !referenceMode}
        >
          <Switch
            id="reference-mode"
            checked={referenceMode}
            disabled={!portraitAvailable && !referenceMode}
            onCheckedChange={onReferenceModeChange}
          />
          <div class="grid gap-1.5 leading-none">
            <Label for="reference-mode">肖像参考模式</Label>
            <p class="text-muted-foreground text-xs">使用角色肖像作为图片参考。</p>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- Visual Prose Styling -->
  {#if mode === 'adventure'}
    <section class="space-y-2 pt-1">
      <div
        class="flex items-center space-x-2 py-4"
        class:opacity-50={disabledFields?.visualProseMode}
        class:pointer-events-none={disabledFields?.visualProseMode}
      >
        <Switch
          id="visual-prose"
          checked={visualProseMode}
          onCheckedChange={onVisualProseModeChange}
          disabled={disabledFields?.visualProseMode}
        />
        <div class="grid gap-1.5 leading-none">
          <Label for="visual-prose">可视化正文样式</Label>
          <p class="text-muted-foreground text-xs">为对白和动作启用颜色、字体等富文本样式。</p>
          {#if disabledFields?.visualProseMode && disabledReason}
            <p class="text-muted-foreground/70 text-xs italic">{disabledReason}</p>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</div>
