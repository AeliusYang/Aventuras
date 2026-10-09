<script lang="ts">
  import { slide } from 'svelte/transition'
  import { FileJson, Loader2, Check, Sparkles, PenTool, Book, X, ChevronDown } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import * as Card from '$lib/components/ui/card'
  import * as ScrollArea from '$lib/components/ui/scroll-area'
  import { Badge } from '$lib/components/ui/badge'

  import type { StoryMode, POV, Tense } from '$lib/types'
  import type {
    ExpandedSetting,
    GeneratedOpening,
    GeneratedProtagonist,
  } from '$lib/services/ai/sdk'
  import type { Genre } from '$lib/services/ai/wizard'
  import type { POVOption } from '../wizardTypes'
  import { styleUserPlaceholders, tenseOptions } from '../wizardTypes'

  interface Props {
    // State
    storyTitle: string
    openingGuidance: string
    generatedOpening: GeneratedOpening | null
    isGeneratingOpening: boolean
    isRefiningOpening: boolean
    isEditingOpening: boolean
    openingDraft: string
    openingError: string | null
    manualOpeningText: string

    // Card import
    cardImportedFirstMessage: string | null
    cardImportedAlternateGreetings: string[]
    selectedGreetingIndex: number

    // Story context for summary
    selectedMode: StoryMode
    selectedGenre: Genre
    customGenre: string
    selectedPOV: POV
    selectedTense: Tense
    expandedSetting: ExpandedSetting | null
    protagonist: GeneratedProtagonist | null
    importedEntriesCount: number

    // Handlers
    onTitleChange: (value: string) => void
    onGuidanceChange: (value: string) => void
    onSelectedGreetingChange: (index: number) => void
    onGenerateOpening: () => void
    onRefineOpening: () => void
    onStartEdit: () => void
    onCancelEdit: () => void
    onSaveEdit: () => void
    onDraftChange: (value: string) => void
    onUseCardOpening: () => void
    onClearCardOpening: () => void
    onManualOpeningChange: (value: string) => void
    onClearGenerated: () => void
  }

  let {
    storyTitle,
    openingGuidance,
    generatedOpening,
    isGeneratingOpening,
    isRefiningOpening,
    isEditingOpening,
    openingDraft,
    openingError,
    manualOpeningText,
    cardImportedFirstMessage,
    cardImportedAlternateGreetings,
    selectedGreetingIndex,
    selectedMode,
    selectedGenre,
    customGenre,
    selectedPOV,
    selectedTense,
    expandedSetting,
    protagonist,
    importedEntriesCount,
    onTitleChange,
    onGuidanceChange,
    onSelectedGreetingChange,
    onGenerateOpening,
    onRefineOpening,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onDraftChange,
    onUseCardOpening,
    onClearCardOpening,
    onClearGenerated,
    onManualOpeningChange,
  }: Props = $props()

  let showExpandOptions = $state(false)

  // POV options for summary
  const povOptions: POVOption[] = [
    { id: 'first', label: '第一人称', example: '' },
    { id: 'second', label: '第二人称', example: '' },
    { id: 'third', label: '第三人称', example: '' },
  ]
</script>

<div class="space-y-4 p-1">
  <p class="text-muted-foreground">为故事命名，并自行撰写开场或使用 AI 生成。</p>

  <div class="space-y-2">
    <Label>故事标题</Label>
    <Input
      type="text"
      value={storyTitle}
      oninput={(e) => onTitleChange(e.currentTarget.value)}
      placeholder="输入故事标题…"
    />
  </div>

  <!-- Imported Opening Scene from Character Card -->
  {#if cardImportedFirstMessage}
    <Card.Root class="bg-surface-800/50 border-surface-700">
      <Card.Content class="space-y-3 p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <FileJson class="text-accent-400 h-4 w-4" />
            <h4 class="text-foreground font-medium">导入的开场</h4>
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="text-muted-foreground hover:text-foreground h-auto p-0 text-xs"
            onclick={onClearCardOpening}
          >
            清空
          </Button>
        </div>

        <!-- Greeting Selection (if alternate greetings exist) -->
        {#if cardImportedAlternateGreetings.length > 0}
          <div>
            <Label class="text-muted-foreground mb-2 block text-xs font-medium">选择开场</Label>
            <div class="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={selectedGreetingIndex === 0 ? 'default' : 'secondary'}
                class="h-7 text-xs"
                onclick={() => onSelectedGreetingChange(0)}
              >
                默认
              </Button>
              {#each cardImportedAlternateGreetings as _, i (i)}
                <Button
                  size="sm"
                  variant={selectedGreetingIndex === i + 1 ? 'default' : 'secondary'}
                  class="h-7 text-xs"
                  onclick={() => onSelectedGreetingChange(i + 1)}
                >
                  备选 {i + 1}
                </Button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Preview of selected opening -->
        <Card.Root class="bg-surface-900 border-none">
          <Card.Content class="p-3">
            <ScrollArea.Root class="h-48">
              <div class="text-muted-foreground text-sm whitespace-pre-wrap">
                {@html styleUserPlaceholders(
                  selectedGreetingIndex === 0
                    ? cardImportedFirstMessage || ''
                    : cardImportedAlternateGreetings[selectedGreetingIndex - 1] || '',
                )}
              </div>
            </ScrollArea.Root>
          </Card.Content>
        </Card.Root>

        {#if (selectedGreetingIndex === 0 ? cardImportedFirstMessage : cardImportedAlternateGreetings[selectedGreetingIndex - 1])?.includes('{{user}}')}
          <p class="text-muted-foreground flex items-center gap-1 text-xs">
            <Badge
              variant="outline"
              class="bg-primary/20 text-primary border-primary/30 rounded px-1 py-0.5 font-mono text-[10px]"
            >
              {'{{user}}'}
            </Badge>
            将替换为你的角色姓名
          </p>
        {/if}

        <Button size="sm" class="gap-2" onclick={onUseCardOpening}>
          <Check class="h-3 w-3" />
          使用此开场
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Manual Opening Entry or AI Generation -->
  {#if storyTitle.trim()}
    <Card.Root class="bg-surface-900 border-surface-700">
      <Card.Content class="space-y-3 p-4">
        <h4 class="text-foreground font-medium">故事开场</h4>
        <p class="text-muted-foreground text-sm">自行撰写开场，或使用 AI 生成</p>

        <!-- Manual Text Entry -->
        <div class="space-y-2">
          <Label>自行撰写开场</Label>
          <Textarea
            value={manualOpeningText}
            oninput={(e) => onManualOpeningChange(e.currentTarget.value)}
            placeholder="在这里撰写故事开场…可以描绘场景、引入角色、确定氛围。这将成为故事的第一段正文。"
            class="min-h-[140px] text-sm"
            rows={6}
            disabled={isGeneratingOpening || isRefiningOpening || generatedOpening !== null}
          />
          {#if generatedOpening}
            <p class="text-xs text-amber-400">
              当前使用 AI 生成的开场。清除下方内容后，可自行撰写。
            </p>
          {:else if manualOpeningText.trim()}
            <p class="text-xs text-green-400">✓ 自定义开场已准备好</p>
          {/if}
        </div>

        <!-- Expand with AI -->
        <div class="flex items-center gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            class="text-muted-foreground gap-2"
            onclick={() => (showExpandOptions = !showExpandOptions)}
          >
            <Sparkles class="h-3.5 w-3.5" />
            {showExpandOptions ? '收起 AI 选项' : '用 AI 扩写'}
            <ChevronDown
              class="h-3 w-3 transition-transform {showExpandOptions ? 'rotate-180' : ''}"
            />
          </Button>
        </div>

        <!-- AI Expansion Panel -->
        {#if showExpandOptions}
          <div
            class="text-card-foreground bg-muted/10 space-y-3 rounded-lg border px-3 pt-1 pb-3 shadow-sm"
            transition:slide={{ duration: 150 }}
          >
            <div class="space-y-1.5">
              <Label for="opening-ai-guidance" class="text-xs">AI 创作要求（选填）</Label>
              <Textarea
                id="opening-ai-guidance"
                value={openingGuidance}
                oninput={(e) => onGuidanceChange(e.currentTarget.value)}
                placeholder="例如：以一场紧张的对峙开场，将场景设在雨中的小巷…"
                class="mt-1 h-16 resize-none text-sm"
              />
            </div>
            <div class="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                class="w-full gap-2"
                onclick={onGenerateOpening}
                disabled={isGeneratingOpening || isRefiningOpening}
              >
                {#if isGeneratingOpening}
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                  正在生成…
                {:else}
                  <Sparkles class="h-3.5 w-3.5" />
                  {generatedOpening ? '重新生成开场' : '用 AI 生成开场'}
                {/if}
              </Button>
              {#if generatedOpening}
                <Button
                  variant="secondary"
                  size="icon"
                  class="shrink-0"
                  onclick={onClearGenerated}
                  title="清除 AI 生成的开场"
                >
                  <X class="h-4 w-4" />
                </Button>
              {/if}
            </div>
          </div>
        {/if}

        {#if !generatedOpening && !isGeneratingOpening && !manualOpeningText.trim() && !cardImportedFirstMessage}
          <span class="text-center text-sm text-amber-400"> 请自行撰写开场，或使用 AI 生成 </span>
        {/if}
      </Card.Content>
    </Card.Root>
  {:else}
    <p class="text-muted-foreground -mt-3 text-sm">请填写标题后继续*</p>
  {/if}

  {#if openingError}
    <p class="text-sm text-red-400">{openingError}</p>
  {/if}

  {#if generatedOpening}
    <Card.Root class="bg-surface-900 border-surface-700">
      <Card.Content class="space-y-3 p-4">
        <div class="flex items-start justify-between gap-3">
          <h3 class="text-foreground font-semibold">
            {generatedOpening?.title || storyTitle}
          </h3>
          {#if !isEditingOpening}
            <div class="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground hover:text-foreground h-auto gap-1 px-2 py-1 text-xs"
                onclick={onStartEdit}
                title="编辑开场正文"
              >
                <PenTool class="h-3 w-3" />
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-accent-400 hover:text-accent-300 hover:bg-accent-950/20 h-auto gap-1 px-2 py-1 text-xs"
                onclick={onRefineOpening}
                disabled={isRefiningOpening || isGeneratingOpening}
                title="根据当前开场继续润色"
              >
                {#if isRefiningOpening}
                  <Loader2 class="h-3 w-3 animate-spin" />
                  正在润色…
                {:else}
                  <Sparkles class="h-3 w-3" />
                  继续润色
                {/if}
              </Button>
            </div>
          {/if}
        </div>
        {#if isEditingOpening}
          <Textarea
            value={openingDraft ?? ''}
            oninput={(e) => onDraftChange(e.currentTarget.value)}
            class="min-h-[140px] text-sm"
            rows={6}
          />
          <div class="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onclick={onCancelEdit}>取消</Button>
            <Button size="sm" onclick={onSaveEdit} disabled={!openingDraft?.trim()}>
              保存修改
            </Button>
          </div>
        {:else}
          <ScrollArea.Root class="h-64">
            <div class="prose prose-invert prose-sm max-w-none">
              <p class="text-muted-foreground whitespace-pre-wrap">
                {generatedOpening?.scene || ''}
              </p>
            </div>
          </ScrollArea.Root>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Summary -->
  <Card.Root class="bg-surface-800 border-surface-700">
    <Card.Content class="space-y-2 p-4 text-sm">
      <h4 class="text-foreground font-medium">故事概览</h4>
      <div class="text-muted-foreground grid grid-cols-2 gap-2">
        <div>
          <strong class="text-foreground">模式：</strong>
          {selectedMode === 'adventure' ? '冒险模式' : '中文写作'}
        </div>
        <div>
          <strong class="text-foreground">题材：</strong>
          {selectedGenre === 'custom' ? customGenre : selectedGenre}
        </div>
        <div>
          <strong class="text-foreground">人称：</strong>
          {povOptions.find((p) => p.id === selectedPOV)?.label}
        </div>
        <div>
          <strong class="text-foreground">时态：</strong>
          {tenseOptions.find((t) => t.id === selectedTense)?.label}
        </div>
        {#if expandedSetting}
          <div class="col-span-2">
            <strong class="text-foreground">设定：</strong>
            {expandedSetting.name}
          </div>
        {/if}
        {#if protagonist}
          <div class="col-span-2">
            <strong class="text-foreground">主角：</strong>
            {protagonist.name}
          </div>
        {/if}
        {#if importedEntriesCount > 0}
          <div class="col-span-2 flex items-center gap-2">
            <Book class="text-accent-400 h-4 w-4" />
            <strong class="text-foreground">世界书：</strong>
            {importedEntriesCount} 个待导入条目
          </div>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>
</div>
