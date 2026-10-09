<script lang="ts">
  import type { ClassifiedTemplates, RefreshScope } from '$lib/services/packs/staleness'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { describeTemplate } from './templateGroups'
  import type { PackTemplate } from '$lib/services/packs/types'
  import { packService } from '$lib/services/packs/pack-service'
  import { templateDiff } from './templateDiff'

  interface Props {
    open: boolean
    packName: string
    classified: ClassifiedTemplates | null
    refreshing: boolean
    templates: PackTemplate[]
    onConfirm: (scope: RefreshScope) => void
    onCancel: () => void
  }

  let { open, packName, classified, refreshing, templates, onConfirm, onCancel }: Props = $props()

  function listed(templateIds: string[]) {
    return templateIds
      .map((templateId) => ({ templateId, described: describeTemplate(templateId) }))
      .filter((entry) => entry.described !== null)
      .map((entry) => ({
        templateId: entry.templateId,
        label: entry.described!.isUserHalf
          ? `${entry.described!.name} (user half)`
          : entry.described!.name,
        group: entry.described!.group,
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  }

  let behind = $derived(listed(classified?.behind ?? []))
  let customised = $derived(listed(classified?.customised ?? []))
  let total = $derived(behind.length + customised.length)
</script>

<ResponsiveModal.Root
  {open}
  onOpenChange={(v) => {
    if (!v) onCancel()
  }}
>
  <ResponsiveModal.Content class="p-0 sm:max-w-lg">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title>使用内置提示词更新“{packName}”</ResponsiveModal.Title>
      <ResponsiveModal.Description>
        选中的模板将替换为当前应用的内置版本。未编辑过的模板不受影响。
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>

    <ScrollArea class="max-h-72">
      <div class="flex flex-col gap-4 px-6 py-4">
        {#if behind.length > 0}
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-medium">落后于新版内置文本</h4>
              <Badge variant="secondary">{behind.length}</Badge>
            </div>
            <p class="text-muted-foreground text-xs">这些模板经你修改过，应用也发布了更新内容。</p>
            <ul class="flex flex-col gap-1 text-sm">
              {#each behind as entry (entry.templateId)}
                <li class="space-y-1">
                  <span class="text-muted-foreground shrink-0 text-xs">{entry.group}</span>
                  <span>{entry.label}</span>
                  <details>
                    <summary class="cursor-pointer text-xs">查看替换 diff</summary>
                    <pre class="max-h-52 overflow-auto text-xs whitespace-pre-wrap">{templateDiff(
                        templates.find((t) => t.templateId === entry.templateId)?.content ?? '',
                        packService.getDefaultContent(entry.templateId) ?? '',
                      )}</pre>
                  </details>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if customised.length > 0}
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-medium">已自定义</h4>
              <Badge variant="secondary">{customised.length}</Badge>
            </div>
            <p class="text-muted-foreground text-xs">
              这些模板经你修改过，但应用没有更新内容。替换只会丢弃你的修改，恢复内置版本。
            </p>
            <ul class="flex flex-col gap-1 text-sm">
              {#each customised as entry (entry.templateId)}
                <li class="space-y-1">
                  <span class="text-muted-foreground shrink-0 text-xs">{entry.group}</span>
                  <span>{entry.label}</span>
                  <details>
                    <summary class="cursor-pointer text-xs">查看替换 diff</summary>
                    <pre class="max-h-52 overflow-auto text-xs whitespace-pre-wrap">{templateDiff(
                        templates.find((t) => t.templateId === entry.templateId)?.content ?? '',
                        packService.getDefaultContent(entry.templateId) ?? '',
                      )}</pre>
                  </details>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    </ScrollArea>

    <ResponsiveModal.Footer class="border-t px-6 py-4">
      <Button variant="ghost" onclick={onCancel} disabled={refreshing}>取消</Button>
      {#if behind.length > 0}
        <Button variant="outline" onclick={() => onConfirm('behind')} disabled={refreshing}>
          替换其中 {behind.length} 个待更新模板
        </Button>
      {/if}
      <Button variant="destructive" onclick={() => onConfirm('edited')} disabled={refreshing}>
        {refreshing ? '正在替换…' : `Replace all ${total} edited`}
      </Button>
    </ResponsiveModal.Footer>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
