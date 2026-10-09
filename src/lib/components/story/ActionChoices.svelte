<script lang="ts">
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { Sword, MessageCircle, Search, MapPin, Loader2 } from '@lucide/svelte'
  import type { ActionChoice } from '$lib/services/ai/sdk/schemas/actionchoices'
  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils/cn'
  import { aiService } from '$lib/services/ai'
  import { database } from '$lib/services/database'
  import { onDestroy } from 'svelte'
  import { historyKey } from '$lib/services/generation/collaborative'

  let pendingRequest = $state<{
    id: string
    storyId: string
    branchId: string | null
    turnId?: string
  } | null>(null)

  function releaseRequest() {
    if (!pendingRequest) return
    pendingRequest = null
    ui.setActionChoicesLoading(false)
  }

  $effect(() => {
    if (
      pendingRequest &&
      (story.currentStory?.id !== pendingRequest.storyId ||
        (story.currentStory?.currentBranchId ?? null) !== pendingRequest.branchId ||
        ui.generationScope?.turnId !== pendingRequest.turnId ||
        ui.isGenerating)
    )
      releaseRequest()
  })
  onDestroy(releaseRequest)

  async function requestChoices() {
    const current = story.currentStory
    const narration = story.entries.findLast((entry) => entry.type === 'narration')
    if (!current || !narration || ui.isGenerating || ui.actionChoicesLoading) return
    const branchId = current.currentBranchId ?? null
    const requestId = crypto.randomUUID()
    const turnId = ui.generationScope?.turnId
    const entries = [...story.entries]
    const fingerprint = historyKey(entries)
    pendingRequest = { id: requestId, storyId: current.id, branchId, turnId }
    const isCurrent = () =>
      pendingRequest?.id === requestId &&
      !ui.isGenerating &&
      ui.generationScope?.turnId === turnId &&
      historyKey(story.entries) === fingerprint &&
      story.currentStory?.id === current.id &&
      (story.currentStory.currentBranchId ?? null) === branchId &&
      story.entries.findLast((entry) => entry.type === 'narration')?.id === narration.id
    ui.setActionChoicesLoading(true)
    try {
      const result = await aiService.generateActionChoices(
        entries,
        {
          characters: story.characters,
          locations: story.locations,
          items: story.items,
          storyBeats: story.storyBeats,
        },
        narration.content,
        story.lorebookEntries,
        {
          mode: current.mode ?? 'creative-writing',
          pov: story.pov,
          tense: story.tense,
          protagonistName:
            story.characters.find((character) => character.relationship === 'self')?.name ?? '主角',
        },
        story.pov,
        current.id,
      )
      if (!isCurrent()) return
      ui.setActionChoices(result.choices, current.id)
      if (result.choices.length && (narration.branchId ?? null) === branchId)
        await database.updateStoryEntry(narration.id, {
          suggestedActions: JSON.stringify(result.choices),
        })
    } catch {
      if (isCurrent()) ui.showToast('行动选项生成失败，请重试。', 'warning')
    } finally {
      if (pendingRequest?.id === requestId) releaseRequest()
    }
  }

  // Icon mapping for choice types
  const typeIcons = {
    action: Sword,
    dialogue: MessageCircle,
    examine: Search,
    move: MapPin,
  }

  // Style classes for choice types
  const typeStyles = {
    action: 'border-l-red-500/50 hover:border-l-red-400',
    dialogue: 'border-l-blue-500/50 hover:border-l-blue-400',
    examine: 'border-l-yellow-500/50 hover:border-l-yellow-400',
    move: 'border-l-green-500/50 hover:border-l-green-400',
  }

  function handleChoiceClick(choice: ActionChoice) {
    // Set the pending action choice - ActionInput will pick this up and submit
    ui.setPendingActionChoice(choice.text, story.currentStory?.id)
  }

  // Key bindings for quick selection (1-4)
  function handleKeydown(event: KeyboardEvent) {
    if (ui.actionChoices.length === 0) return

    const target = (event.target ?? document.activeElement) as HTMLElement | null
    if (
      target &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
    ) {
      return
    }

    const keyNum = parseInt(event.key)
    if (keyNum >= 1 && keyNum <= ui.actionChoices.length) {
      event.preventDefault()
      handleChoiceClick(ui.actionChoices[keyNum - 1])
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Button
  variant="outline"
  size="sm"
  onclick={requestChoices}
  disabled={ui.isGenerating || ui.actionChoicesLoading}
>
  {ui.actionChoices.length ? '换一组行动选项' : '生成行动选项'}
</Button>

{#if ui.actionChoicesLoading}
  <div class="text-muted-foreground flex items-center justify-center gap-2 py-4">
    <Loader2 class="h-4 w-4 animate-spin" />
    <span class="text-sm">正在生成选项…</span>
  </div>
{:else if ui.actionChoices.length > 0}
  <div
    class="border-border border-l-muted-foreground/20 mt-3 space-y-2 rounded-lg border border-l-4 p-3 shadow-sm sm:mt-4 sm:p-4 {story.currentBgImage &&
    story.currentStory?.settings?.backgroundImagesEnabled
      ? 'bg-card/60 backdrop-blur-md'
      : 'bg-card'}"
  >
    <div class="text-muted-foreground mb-2 flex items-center gap-2 text-xs tracking-wide uppercase">
      <span>你打算怎么做？</span>
      <span class="text-muted-foreground/60 hidden sm:inline"
        >（按 1-{ui.actionChoices.length} 快速选择）</span
      >
    </div>

    {#each ui.actionChoices as choice, index (index)}
      {@const Icon = typeIcons[choice.type]}
      <Button
        variant="secondary"
        class={cn(
          'group relative flex h-auto min-h-13 w-full justify-start space-x-1 overflow-hidden px-3 py-3 transition-all duration-150 sm:px-4',
          'border-border/40 rounded-l-none border border-l-4',
          'bg-secondary/30 hover:bg-secondary/60',
          typeStyles[choice.type],
        )}
        onclick={() => handleChoiceClick(choice)}
      >
        <span
          class="bg-background/50 text-muted-foreground group-hover:bg-background group-hover:text-foreground flex h-6 w-6 shrink-0
                     items-center justify-center rounded font-mono text-sm"
        >
          {index + 1}
        </span>
        <Icon class="text-muted-foreground group-hover:text-foreground h-4 w-4 shrink-0" />
        <span
          class="text-foreground text-left text-sm wrap-break-word whitespace-normal sm:text-base"
        >
          {choice.text}
        </span>
      </Button>
    {/each}
  </div>
{/if}
