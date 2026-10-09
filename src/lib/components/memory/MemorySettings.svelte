<script lang="ts">
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { onDestroy } from 'svelte'
  import { slide } from 'svelte/transition'
  import { createDebouncedSave } from '$lib/utils/debounce'
  import { Card, CardContent } from '$lib/components/ui/card'
  import { Slider } from '$lib/components/ui/slider'
  import { Label } from '$lib/components/ui/label'
  import { ToggleGroup, ToggleGroupItem } from '$lib/components/ui/toggle-group'

  /**
   * Threshold bounds. The ceiling was 100,000, which nothing could use: a chapter is built to
   * be about one threshold's worth of tokens, and the chapter-read budget is 2.5x it, so a
   * 100k threshold asks for a 250k-token read.
   *
   * A story saved with a higher value keeps it until the control is touched — the slider
   * shows the ceiling, the debounced save only runs on interaction.
   */
  const THRESHOLD_MIN = 4000
  const THRESHOLD_MAX = 32000

  // Local state for editing — seeded from store, written back on debounced save
  let localThreshold = $state(Math.min(story.memoryConfig.tokenThreshold, THRESHOLD_MAX))
  let localBuffer = $state(story.memoryConfig.chapterBuffer)

  const detailOptions = [
    { value: 'concise', label: '简洁' },
    { value: 'auto', label: '自动' },
    { value: 'precise', label: '详细' },
  ] as const

  function saveDetail(val: string) {
    if (val === 'concise' || val === 'auto' || val === 'precise') {
      story.updateMemoryConfig({ summaryDetail: val })
    }
  }

  // Single debounced save: flushes both values in one call
  const { trigger, flush } = createDebouncedSave(() =>
    story.updateMemoryConfig({ tokenThreshold: localThreshold, chapterBuffer: localBuffer }),
  )

  function scheduleThresholdSave(value: number) {
    localThreshold = value
    trigger()
  }

  function scheduleBufferSave(value: number) {
    localBuffer = value
    trigger()
  }

  onDestroy(() => flush())

  function formatNumber(num: number): string {
    return num.toLocaleString()
  }

  // Threshold presets
  const thresholdPresets = [
    { label: '8K', value: 8000 },
    { label: '16K', value: 16000 },
    { label: '24K', value: 24000 },
    { label: '32K', value: 32000 },
  ]
</script>

{#if ui.memorySettingsOpen}
  <div transition:slide={{ duration: 200 }}>
    <Card class="mt-4">
      <CardContent class="space-y-4 p-4">
        <h3 class="text-foreground text-sm font-medium">记忆设置</h3>

        <!-- Token Threshold -->
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <Label for="token-threshold" class="text-muted-foreground">Token 阈值</Label>
            <span class="text-foreground text-sm font-medium">{formatNumber(localThreshold)}</span>
          </div>

          <Slider
            id="token-threshold"
            value={localThreshold}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={1000}
            type="single"
            onValueChange={(vals) => scheduleThresholdSave(vals)}
          />

          <ToggleGroup
            type="single"
            value={localThreshold.toString()}
            onValueChange={(val) => val && scheduleThresholdSave(parseInt(val))}
            class="flex-wrap justify-start"
          >
            {#each thresholdPresets as preset (preset.value)}
              <ToggleGroupItem value={preset.value.toString()} size="sm" class="h-7 px-2 text-xs">
                {preset.label}
              </ToggleGroupItem>
            {/each}
          </ToggleGroup>

          <p class="text-muted-foreground text-xs">上下文 Token 数超过此阈值时，触发自动摘要。</p>
        </div>

        <!-- Summary Detail -->
        <div class="space-y-4">
          <Label class="text-muted-foreground">摘要详细程度</Label>

          <ToggleGroup
            type="single"
            value={story.memoryConfig.summaryDetail ?? 'auto'}
            onValueChange={saveDetail}
            class="justify-start"
          >
            {#each detailOptions as option (option.value)}
              <ToggleGroupItem value={option.value} size="sm" class="h-7 px-3 text-xs">
                {option.label}
              </ToggleGroupItem>
            {/each}
          </ToggleGroup>

          <p class="text-muted-foreground text-xs">
            控制章节摘要保留的细节量。更详细的摘要有助于保留长章节中的剧情信息。
          </p>
        </div>

        <!-- Buffer Messages -->
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <Label for="buffer-messages" class="text-muted-foreground">保留的近期消息数</Label>
            <span class="text-foreground text-sm font-medium">{localBuffer}</span>
          </div>

          <Slider
            id="buffer-messages"
            value={localBuffer}
            type="single"
            min={0}
            max={50}
            step={1}
            onValueChange={(val) => scheduleBufferSave(val)}
          />

          <p class="text-muted-foreground text-xs">
            这些近期消息暂不纳入章节摘要。数值越大，保留的近期原文越多，每章包含的内容越少。
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
{/if}
