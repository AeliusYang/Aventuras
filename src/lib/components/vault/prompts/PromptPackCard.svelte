<script lang="ts">
  import type { PresetPack } from '$lib/services/packs/types'
  import { Card, CardContent } from '$lib/components/ui/card'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Upload, Trash2, Lock, RefreshCw, Copy, Users, Star } from '@lucide/svelte'
  import { stripToPlainText } from '$lib/utils/markdown'

  interface Props {
    pack: PresetPack
    modifiedCount: number
    usageCount: number
    onclick: () => void
    onExport?: () => void
    onUpdateFromFile?: () => void
    onDelete?: () => void
    onDuplicate?: () => void
    onManageUsage?: () => void
    isImportDefault?: boolean
    importDefaultBusy?: boolean
    onImportDefault?: () => void
  }

  let {
    pack,
    modifiedCount,
    usageCount,
    onclick,
    onExport,
    onUpdateFromFile,
    onDelete,
    onDuplicate,
    onManageUsage,
    isImportDefault = false,
    importDefaultBusy = false,
    onImportDefault,
  }: Props = $props()
</script>

<button type="button" class="w-full text-left" {onclick}>
  <Card
    class="group hover:border-primary/50 h-full cursor-pointer transition-colors {pack.isDefault
      ? 'border-dashed'
      : ''}"
  >
    <CardContent class="flex h-full flex-col p-4">
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="truncate font-semibold">{pack.name}</h3>
            {#if usageCount > 0}
              <Badge variant="outline" class="border-green-500/50 text-green-500">活跃</Badge>
            {/if}
          </div>
          <p class="text-muted-foreground mt-1 line-clamp-2 text-sm">
            {#if pack.description}{stripToPlainText(pack.description)}{:else}&nbsp;{/if}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          {#if onImportDefault}
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 shrink-0"
              disabled={importDefaultBusy}
              title={isImportDefault ? '恢复中文导入系统默认' : '设为中文导入默认'}
              aria-label={isImportDefault ? '恢复中文导入系统默认' : '设为中文导入默认'}
              aria-pressed={isImportDefault}
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onImportDefault?.()
              }}
            >
              <Star class="h-4 w-4 {isImportDefault ? 'fill-amber-400 text-amber-600' : ''}" />
            </Button>
          {/if}
          {#if onExport}
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onExport?.()
              }}
              title="导出提示词包"
            >
              <Upload class="h-4 w-4" />
            </Button>
          {/if}
          {#if !pack.isDefault && onUpdateFromFile}
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onUpdateFromFile?.()
              }}
              title="从文件更新"
            >
              <RefreshCw class="h-4 w-4" />
            </Button>
          {/if}
          {#if !pack.isDefault && onDelete}
            <Button
              variant="ghost"
              size="icon"
              class="text-destructive h-8 w-8 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onDelete?.()
              }}
              title="删除提示词包"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          {/if}
          {#if onDuplicate}
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onDuplicate?.()
              }}
              title="复制提示词包"
            >
              <Copy class="h-4 w-4" />
            </Button>
          {/if}
          {#if onManageUsage}
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                onManageUsage?.()
              }}
              title="管理使用此 Pack 的故事"
            >
              <Users class="h-4 w-4" />
            </Button>
          {/if}
        </div>
      </div>
      <div class="text-muted-foreground mt-auto flex items-center gap-3 pt-3 text-xs">
        {#if isImportDefault}<span class="text-amber-600">中文导入默认</span>{/if}
        {#if pack.isDefault}
          <span class="flex items-center gap-1"><Lock class="h-3 w-3" />内置</span>
        {:else}
          <span>{modifiedCount} 已修改</span>
        {/if}
        <span class="text-muted-foreground/50">|</span>
        <span>{pack.author ?? '自定义'}</span>
      </div>
    </CardContent>
  </Card>
</button>
