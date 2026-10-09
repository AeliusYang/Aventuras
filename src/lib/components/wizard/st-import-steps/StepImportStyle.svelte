<script lang="ts">
  import { Sword, Feather, MessageSquare, FileText } from '@lucide/svelte'
  import { ChevronLeft, ChevronRight } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import WritingStyleFields from '$lib/components/shared/WritingStyleFields.svelte'
  import { hasRequiredCredentials } from '$lib/services/ai/image'
  import type { StoryMode, POV, ImageGenerationMode } from '$lib/types'
  import type { Tense } from '$lib/services/ai/wizard/ScenarioService'

  interface Props {
    selectedMode: StoryMode
    selectedPOV: POV
    selectedTense: Tense
    tone: string
    visualProseMode: boolean
    imageGenerationMode: ImageGenerationMode
    backgroundImagesEnabled: boolean
    referenceMode: boolean
    importChatAsEntries: boolean
    hasChatFile: boolean
    hasCardOpening: boolean
    openingVariants: Array<{ id: string; text: string }>
    selectedOpeningVariantId: string
    chatMessageCount: number
    onModeChange: (mode: StoryMode) => void
    onPOVChange: (v: POV) => void
    onTenseChange: (v: Tense) => void
    onToneChange: (v: string) => void
    onVisualProseModeChange: (v: boolean) => void
    onImageGenerationModeChange: (v: ImageGenerationMode) => void
    onBackgroundImagesEnabledChange: (v: boolean) => void
    onReferenceModeChange: (v: boolean) => void
    onImportChatToggle: (v: boolean) => void
    onOpeningVariantChange: (id: string) => void
  }

  let {
    selectedMode,
    selectedPOV,
    selectedTense,
    tone,
    visualProseMode,
    imageGenerationMode,
    backgroundImagesEnabled,
    referenceMode,
    importChatAsEntries,
    hasChatFile,
    hasCardOpening,
    openingVariants,
    selectedOpeningVariantId,
    chatMessageCount,
    onModeChange,
    onPOVChange,
    onTenseChange,
    onToneChange,
    onVisualProseModeChange,
    onImageGenerationModeChange,
    onBackgroundImagesEnabledChange,
    onReferenceModeChange,
    onImportChatToggle,
    onOpeningVariantChange,
  }: Props = $props()

  const imageGenerationEnabled = $derived(hasRequiredCredentials())

  // Keep imported wizard behavior consistent with setup wizard when image generation is unavailable.
  $effect(() => {
    if (!imageGenerationEnabled && imageGenerationMode !== 'none') {
      onImageGenerationModeChange('none')
    }
  })

  const selectedOpeningIndex = $derived(
    Math.max(
      0,
      openingVariants.findIndex((variant) => variant.id === selectedOpeningVariantId),
    ),
  )

  function moveOpening(delta: number) {
    if (openingVariants.length === 0) return
    const next = (selectedOpeningIndex + delta + openingVariants.length) % openingVariants.length
    onOpeningVariantChange(openingVariants[next].id)
  }
</script>

<div class="flex h-full flex-col gap-5">
  <!-- Story Mode -->
  <div class="space-y-2">
    <Label>故事模式</Label>
    <div class="grid grid-cols-2 gap-3">
      <button class="w-full text-left focus:outline-none" onclick={() => onModeChange('adventure')}>
        <Card.Root
          class="h-full transition-all {selectedMode === 'adventure'
            ? 'ring-primary border-primary ring-2'
            : 'border-border hover:border-primary/40'}"
        >
          <Card.Content class="flex items-center gap-3 p-3">
            <Sword
              class="h-5 w-5 {selectedMode === 'adventure'
                ? 'text-primary'
                : 'text-muted-foreground'}"
            />
            <div>
              <p class="text-sm font-medium">冒险模式</p>
              <p class="text-muted-foreground text-xs">你扮演主角</p>
            </div>
          </Card.Content>
        </Card.Root>
      </button>
      <button
        class="w-full text-left focus:outline-none"
        onclick={() => onModeChange('creative-writing')}
      >
        <Card.Root
          class="h-full transition-all {selectedMode === 'creative-writing'
            ? 'ring-primary border-primary ring-2'
            : 'border-border hover:border-primary/40'}"
        >
          <Card.Content class="flex items-center gap-3 p-3">
            <Feather
              class="h-5 w-5 {selectedMode === 'creative-writing'
                ? 'text-primary'
                : 'text-muted-foreground'}"
            />
            <div>
              <p class="text-sm font-medium">中文写作</p>
              <p class="text-muted-foreground text-xs">Director 安排场景，Writer 撰写小说正文</p>
            </div>
          </Card.Content>
        </Card.Root>
      </button>
    </div>
  </div>

  <!-- Chat Import Mode -->
  <div class="space-y-2">
    <Label>聊天记录</Label>
    <div class="grid grid-cols-2 gap-3">
      <button
        class="w-full text-left focus:outline-none"
        onclick={() => onImportChatToggle(true)}
        disabled={!hasChatFile}
      >
        <Card.Root
          class="h-full transition-all {importChatAsEntries
            ? 'ring-primary border-primary ring-2'
            : 'border-border hover:border-primary/40'} {!hasChatFile
            ? 'cursor-not-allowed opacity-50'
            : ''}"
        >
          <Card.Content class="flex items-center gap-3 p-3">
            <MessageSquare
              class="h-5 w-5 {importChatAsEntries ? 'text-primary' : 'text-muted-foreground'}"
            />
            <div>
              <p class="text-sm font-medium">导入聊天记录</p>
              <p class="text-muted-foreground text-xs">
                {#if hasChatFile}
                  {chatMessageCount} 条消息作为故事内容
                {:else}
                  尚未上传聊天记录文件
                {/if}
              </p>
            </div>
          </Card.Content>
        </Card.Root>
      </button>
      <button
        class="w-full text-left focus:outline-none"
        onclick={() => onImportChatToggle(false)}
        disabled={!hasCardOpening}
      >
        <Card.Root
          class="h-full transition-all {!importChatAsEntries
            ? 'ring-primary border-primary ring-2'
            : 'border-border hover:border-primary/40'} {!hasCardOpening ? 'opacity-50' : ''}"
        >
          <Card.Content class="flex items-center gap-3 p-3">
            <FileText
              class="h-5 w-5 {!importChatAsEntries ? 'text-primary' : 'text-muted-foreground'}"
            />
            <div>
              <p class="text-sm font-medium">开始新故事</p>
              <p class="text-muted-foreground text-xs">
                {#if hasCardOpening}
                  使用角色卡开场白
                {:else}
                  需要带有开场白的角色卡
                {/if}
              </p>
            </div>
          </Card.Content>
        </Card.Root>
      </button>
    </div>
  </div>

  {#if selectedMode === 'creative-writing' && !importChatAsEntries && openingVariants.length > 0}
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <Label>开场白</Label>
        <span class="text-muted-foreground text-xs tabular-nums"
          >{selectedOpeningIndex + 1} / {openingVariants.length}</span
        >
      </div>
      <Card.Root>
        <Card.Content class="space-y-3 p-3">
          <div class="text-muted-foreground max-h-40 overflow-y-auto text-sm whitespace-pre-wrap">
            {openingVariants[selectedOpeningIndex].text}
          </div>
          {#if openingVariants.length > 1}
            <div class="flex items-center justify-center gap-3">
              <button
                type="button"
                class="hover:bg-muted rounded p-1"
                aria-label="上一个开场白"
                onclick={() => moveOpening(-1)}
              >
                <ChevronLeft class="h-4 w-4" />
              </button>
              <span class="text-muted-foreground text-xs">左右切换版本</span>
              <button
                type="button"
                class="hover:bg-muted rounded p-1"
                aria-label="下一个开场白"
                onclick={() => moveOpening(1)}
              >
                <ChevronRight class="h-4 w-4" />
              </button>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    </div>
  {/if}

  <ScrollArea class="h-full pr-4">
    <WritingStyleFields
      {selectedPOV}
      {selectedTense}
      {tone}
      {visualProseMode}
      {imageGenerationEnabled}
      {imageGenerationMode}
      {backgroundImagesEnabled}
      {referenceMode}
      showNarrativeControls={selectedMode === 'adventure'}
      {onPOVChange}
      {onTenseChange}
      {onToneChange}
      {onVisualProseModeChange}
      {onImageGenerationModeChange}
      {onBackgroundImagesEnabledChange}
      {onReferenceModeChange}
    />
  </ScrollArea>
</div>
