<script lang="ts">
  import StoryCardOrganization from './StoryCardOrganization.svelte'
  import { AlertCircle, BookOpen, Check, Loader2, Sparkles, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Switch } from '$lib/components/ui/switch'
  import * as Alert from '$lib/components/ui/alert'
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  let chapterizing = $state(false)
  let rebuilding = $state(false)
  let includeTimeline = $state(false)
  let includeClassification = $state(false)
  let includeLorebook = $state(false)
  const source = $derived(story.currentStory?.settings?.importSource)
  const dismissed = $derived(story.currentStory?.settings?.importOrganizationDismissed ?? false)
  const hasChatImport = $derived(
    story.entries.some((entry) => entry.metadata?.source === 'sillytavern_import'),
  )

  async function chapterize() {
    if (chapterizing) return
    chapterizing = true
    try {
      await story.chapterizeFromBeginning({
        includeLorebook,
        includeTimeline,
        includeClassification,
      })
      ui.showToast('章节整理完成。', 'info')
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : '章节整理失败。', 'error')
    } finally {
      chapterizing = false
    }
  }

  async function rebuildState() {
    if (rebuilding) return
    const target = story.entries.findLast((entry) => entry.type === 'narration')
    if (!target) {
      ui.showToast('当前故事还没有可重建的正文。', 'error')
      return
    }
    rebuilding = true
    try {
      const draft = await story.createCollaborativeStateRebuildDraft(target.id)
      if (draft.diff.uncertain.length > 0) {
        ui.showToast('状态重建包含不确定实体，请在对应正文条目中确认。', 'error')
        return
      }
      await story.confirmCollaborativeStateRebuild(draft)
      ui.showToast('事实与状态重建完成。', 'info')
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : '事实与状态重建失败。', 'error')
    } finally {
      rebuilding = false
    }
  }

  async function dismissPanel() {
    await story.updateStorySettings({ importOrganizationDismissed: true })
  }
</script>

{#if (source || hasChatImport) && !dismissed}
  <div class="border-border bg-card mx-auto mb-3 w-full max-w-3xl rounded-md border p-3 shadow-sm">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-start gap-2">
        <Sparkles class="text-primary mt-0.5 h-4 w-4" />
        <div>
          <p class="text-sm font-medium">导入整理</p>
          <p class="text-muted-foreground text-xs">
            原始故事已经可用。整理角色卡、状态和章节都由你主动启动。
          </p>
          <p class="text-muted-foreground mt-1 text-xs">
            原始导入内容已保存，当前正文可以继续生成。
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        {#if source?.status === 'failed'}
          <span class="text-destructive flex items-center gap-1 text-xs">
            <AlertCircle class="h-3.5 w-3.5" />{source.lastError || '上次整理失败'}
          </span>
        {:else if source?.status === 'organized'}
          <span class="flex items-center gap-1 text-xs text-emerald-500">
            <Check class="h-3.5 w-3.5" />角色卡与世界书已整理
          </span>
        {/if}
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7"
          title="关闭导入整理"
          aria-label="关闭导入整理"
          onclick={dismissPanel}
        >
          <X class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      {#if source?.rawCardJson}
        <div class="w-full space-y-3">
          <label class="flex items-center gap-2 text-sm"
            >AI 导入整理（仅按需）
            <Switch
              checked={source.organizationEnabled !== false}
              onCheckedChange={async (value) => {
                if (source)
                  await story.updateStorySettings({
                    importSource: { ...source, organizationEnabled: value },
                  })
              }}
            />
          </label>
          {#if source.organizationEnabled !== false}
            {#key (story.currentStory?.id ?? '') + ':' + (story.currentStory?.currentBranchId ?? 'main')}
              <StoryCardOrganization />
            {/key}
          {/if}
        </div>
      {/if}

      {#if hasChatImport}
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <BookOpen class="text-muted-foreground h-3.5 w-3.5" />
          <span>章节化</span>
          <label class="text-muted-foreground flex items-center gap-1.5">
            时间线
            <Switch
              checked={includeTimeline}
              onCheckedChange={(value) => (includeTimeline = value)}
            />
          </label>
          <label class="text-muted-foreground flex items-center gap-1.5">
            状态
            <Switch
              checked={includeClassification}
              onCheckedChange={(value) => (includeClassification = value)}
            />
          </label>
          <label class="text-muted-foreground flex items-center gap-1.5">
            世界书
            <Switch
              checked={includeLorebook}
              onCheckedChange={(value) => (includeLorebook = value)}
            />
          </label>
          <Button size="sm" variant="outline" disabled={chapterizing} onclick={chapterize}>
            {#if chapterizing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}开始整理
          </Button>
          <Button size="sm" variant="outline" disabled={rebuilding} onclick={rebuildState}>
            {#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles
                class="h-3.5 w-3.5"
              />{/if}
            重建事实与状态
          </Button>
        </div>
      {/if}
    </div>

    {#if story.chapterizationProgress || story.chapterizationStatus}
      <Alert.Root class="mt-3" variant="default">
        <Alert.Description>
          {story.chapterizationStatus ||
            `章节 ${story.chapterizationProgress?.current ?? 0}/${story.chapterizationProgress?.total ?? 0}`}
        </Alert.Description>
      </Alert.Root>
    {/if}
  </div>
{/if}
