<script lang="ts">
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { RefreshCw, AlertTriangle } from '@lucide/svelte'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert'

  interface Props {
    chapterId: string | null
    onConfirm: () => void
    onClose: () => void
  }

  let { chapterId, onConfirm, onClose }: Props = $props()

  const chapter = $derived(chapterId ? story.chapters.find((c) => c.id === chapterId) : null)

  // Get previous chapters (for context display)
  const previousChapters = $derived(
    chapter
      ? story.chapters.filter((c) => c.number < chapter.number).sort((a, b) => a.number - b.number)
      : [],
  )
</script>

<ResponsiveModal.Root open={true} onOpenChange={(open) => !open && !ui.memoryLoading && onClose()}>
  <ResponsiveModal.Content class="flex max-h-[85vh] max-w-md flex-col gap-0 p-0">
    <ResponsiveModal.Header class="border-b px-4 py-4">
      <div class="flex items-center gap-2">
        <RefreshCw class="text-primary h-5 w-5" />
        <ResponsiveModal.Title>重新生成章节摘要</ResponsiveModal.Title>
      </div>
      <ResponsiveModal.Description>更新本章摘要。</ResponsiveModal.Description>
    </ResponsiveModal.Header>

    <ScrollArea class="flex-1 p-4">
      <div class="space-y-4">
        {#if chapter}
          <div class="bg-muted/50 rounded-lg border p-3">
            <div class="text-foreground text-sm font-medium">
              章节 {chapter.number}{chapter.title ? `: ${chapter.title}` : ''}
            </div>
            <p class="text-muted-foreground mt-1 line-clamp-2 text-xs">
              {chapter.summary}
            </p>
          </div>

          {#if previousChapters.length > 0}
            <div class="space-y-2">
              <p class="text-muted-foreground text-sm">
                以下 {previousChapters.length} 章{previousChapters.length === 1 ? '' : 's'} 将用作上下文：
              </p>
              <div class="max-h-32 space-y-1 overflow-y-auto pr-1">
                {#each previousChapters as prevChapter (prevChapter.id)}
                  <div class="text-muted-foreground bg-muted/30 rounded p-2 text-xs">
                    <span class="text-foreground/80 font-medium">章 {prevChapter.number}</span>
                    {#if prevChapter.title}
                      <span>: {prevChapter.title}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <Alert>
              <AlertTriangle class="h-4 w-4" />
              <AlertTitle>无先前上下文</AlertTitle>
              <AlertDescription>这是第一章，不使用先前章节作为上下文。</AlertDescription>
            </Alert>
          {/if}

          <p class="text-muted-foreground text-sm">
            新生成的摘要将替换当前摘要。本章原摘要将 <strong>不会</strong> 被加入提示词。
          </p>
        {:else}
          <div class="text-muted-foreground py-4 text-center">未找到章节。</div>
        {/if}
      </div>
    </ScrollArea>

    <ResponsiveModal.Footer class="mt-auto border-t px-4 py-4">
      {#if !ui.memoryLoading}
        <Button variant="outline" onclick={onClose}>取消</Button>
      {/if}
      <Button onclick={onConfirm} disabled={!chapter || ui.memoryLoading} class="gap-2">
        {#if ui.memoryLoading}
          <RefreshCw class="h-4 w-4 animate-spin" />
          <span>正在生成…</span>
        {:else}
          <RefreshCw class="h-4 w-4" />
          <span>重新生成摘要</span>
        {/if}
      </Button>
    </ResponsiveModal.Footer>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
