<script lang="ts">
  import type { PackUpdateSummary } from '$lib/services/packs/update-summary'
  import type { PackExport } from '$lib/services/packs/validation'
  import type { PresetPack } from '$lib/services/packs/types'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Alert from '$lib/components/ui/alert'
  import { AlertTriangle, Download } from '@lucide/svelte'

  interface Props {
    open: boolean
    pack: PresetPack | null
    packData: PackExport | null
    summary: PackUpdateSummary | null
    exporting: boolean
    updating: boolean
    onExportFirst: () => void
    onConfirm: () => void
    onCancel: () => void
  }

  let {
    open,
    pack,
    packData,
    summary,
    exporting,
    updating,
    onExportFirst,
    onConfirm,
    onCancel,
  }: Props = $props()

  let stories = $derived(summary?.storyCount ?? 0)
  let edited = $derived(summary?.editedTemplates ?? 0)
</script>

<ResponsiveModal.Root
  {open}
  onOpenChange={(v) => {
    if (!v) onCancel()
  }}
>
  <ResponsiveModal.Content class="p-0 sm:max-w-lg">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title>从文件更新“{pack?.name}”？</ResponsiveModal.Title>
      <ResponsiveModal.Description>
        提示词包名称和故事绑定保持不变，模板与变量将替换为文件中的版本。
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>

    {#if pack && packData && summary}
      <div class="flex flex-col gap-3 px-6 py-4">
        <div class="flex items-center gap-2">
          <Badge variant="secondary">{packData.templates.length} 个模板</Badge>
          <Badge variant="secondary">{packData.variables.length} 个变量</Badge>
          {#if packData.author}
            <span class="text-muted-foreground text-sm">作者： {packData.author}</span>
          {/if}
        </div>

        {#if edited > 0}
          <Alert.Root variant="destructive">
            <AlertTriangle class="h-4 w-4" />
            <Alert.Title>
              {edited}
              {edited === 1 ? '个模板包含' : '个模板包含'} 你的修改
            </Alert.Title>
            <Alert.Description>
              这些模板将被文件中的版本替换。如需保留你的修改，请先导出提示词包。
            </Alert.Description>
          </Alert.Root>
        {/if}

        <ul class="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>
            {#if stories === 0}
              没有故事使用此提示词包。
            {:else}
              {stories}
              个故事将从下一轮开始使用新提示词。
            {/if}
          </li>
          {#if summary.addedVariables.length > 0}
            <li>
              新增变量： <span class="font-mono text-xs">{summary.addedVariables.join(', ')}</span>
            </li>
          {/if}
          {#if summary.removedVariables.length > 0}
            <li>
              移除变量：
              <span class="font-mono text-xs">{summary.removedVariables.join(', ')}</span>
            </li>
          {/if}
          <li>各实体的运行时变量值不受影响。</li>
        </ul>
      </div>

      <ResponsiveModal.Footer class="border-t px-6 py-4">
        <Button variant="ghost" onclick={onCancel} disabled={updating}>取消</Button>
        <Button variant="outline" onclick={onExportFirst} disabled={exporting || updating}>
          <Download class="mr-2 h-4 w-4" />
          {exporting ? '正在导出…' : '导出当前提示词包'}
        </Button>
        <Button variant="destructive" onclick={onConfirm} disabled={updating}>
          {updating ? '正在更新…' : '更新'}
        </Button>
      </ResponsiveModal.Footer>
    {/if}
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
