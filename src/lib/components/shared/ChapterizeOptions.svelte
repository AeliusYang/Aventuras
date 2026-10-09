<script lang="ts">
  import { Library, BookOpen, Clock, ScanSearch } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import { Switch } from '$lib/components/ui/switch'

  interface Props {
    chapterizeAfterImport: boolean
    chapterizeIncludeLorebook: boolean
    chapterizeIncludeTimeline: boolean
    chapterizeIncludeClassification: boolean
    onChapterizeAfterImportChange: (v: boolean) => void
    onChapterizeIncludeLorebookChange: (v: boolean) => void
    onChapterizeIncludeTimelineChange: (v: boolean) => void
    onChapterizeIncludeClassificationChange: (v: boolean) => void
  }

  let {
    chapterizeAfterImport,
    chapterizeIncludeLorebook,
    chapterizeIncludeTimeline,
    chapterizeIncludeClassification,
    onChapterizeAfterImportChange,
    onChapterizeIncludeLorebookChange,
    onChapterizeIncludeTimelineChange,
    onChapterizeIncludeClassificationChange,
  }: Props = $props()
</script>

<Card.Root>
  <Card.Content class="space-y-3 p-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <Library class="text-muted-foreground h-4 w-4" />
        <span class="text-sm">从历史记录生成章节</span>
      </div>
      <Switch
        checked={chapterizeAfterImport}
        onCheckedChange={(v) => onChapterizeAfterImportChange(v)}
        aria-label="从历史记录生成章节"
      />
    </div>
    {#if chapterizeAfterImport}
      <div class="border-t pt-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 pl-6">
            <BookOpen class="text-muted-foreground h-4 w-4" />
            <span class="text-muted-foreground text-sm">同时更新世界书</span>
          </div>
          <Switch
            checked={chapterizeIncludeLorebook}
            onCheckedChange={(v) => onChapterizeIncludeLorebookChange(v)}
            aria-label="同时更新世界书"
          />
        </div>
        <p class="text-muted-foreground mt-1 pl-6 text-xs">
          额外调用一次 AI 分析整批内容，以创建和更新世界书条目。
        </p>
      </div>
      <div class="border-t pt-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 pl-6">
            <Clock class="text-muted-foreground h-4 w-4" />
            <span class="text-muted-foreground text-sm">估算时间线</span>
          </div>
          <Switch
            checked={chapterizeIncludeTimeline}
            onCheckedChange={(v) => onChapterizeIncludeTimelineChange(v)}
            aria-label="估算时间线"
          />
        </div>
        <p class="text-muted-foreground mt-1 pl-6 text-xs">
          估算每章经过的故事时间，每章额外调用一次 AI。
        </p>
      </div>
      <div class="border-t pt-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 pl-6">
            <ScanSearch class="text-muted-foreground h-4 w-4" />
            <span class="text-muted-foreground text-sm">补全角色、地点和物品</span>
          </div>
          <Switch
            checked={chapterizeIncludeClassification}
            onCheckedChange={(v) => onChapterizeIncludeClassificationChange(v)}
            aria-label="补全角色、地点和物品"
          />
        </div>
        <p class="text-muted-foreground mt-1 pl-6 text-xs">
          根据各章内容补全世界状态面板，每章额外调用一次 AI。
        </p>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
