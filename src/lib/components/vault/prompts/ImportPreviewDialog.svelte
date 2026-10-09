<script lang="ts">
  import type { ImportValidationResult, ConflictStrategy } from '$lib/services/packs/import-export'
  import type { PresetPack } from '$lib/services/packs/types'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Alert from '$lib/components/ui/alert'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { AlertTriangle, Download } from '@lucide/svelte'
  import { renderDescription } from '$lib/utils/markdown'

  interface Props {
    open: boolean
    validationResult: ImportValidationResult | null
    conflictPack: PresetPack | null
    onConfirm: (strategy: ConflictStrategy) => void
    onCancel: () => void
  }

  let { open, validationResult, conflictPack, onConfirm, onCancel }: Props = $props()

  let isValid = $derived(validationResult?.valid ?? false)
  let pack = $derived(validationResult?.pack)
</script>

<ResponsiveModal.Root
  {open}
  onOpenChange={(v) => {
    if (!v) onCancel()
  }}
>
  <ResponsiveModal.Content class="p-0 sm:max-w-lg">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title class="flex items-center gap-2">
        <Download class="text-primary h-5 w-5" />
        导入提示词包
        {#if validationResult}
          {#if isValid}
            <Badge variant="default" class="bg-green-600">有效</Badge>
          {:else}
            <Badge variant="destructive">无效</Badge>
          {/if}
        {/if}
      </ResponsiveModal.Title>
      <ResponsiveModal.Description>
        {#if isValid}
          导入前请检查提示词包详情。
        {:else}
          所选文件存在错误，无法导入。
        {/if}
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>

    {#if validationResult && !isValid}
      <!-- Error state -->
      <div class="flex flex-col gap-3 px-6 py-4">
        {#if validationResult.structuralErrors.length > 0}
          <div class="flex flex-col gap-1">
            <p class="text-sm font-medium">结构错误：</p>
            <ul class="text-destructive list-disc pl-5 text-sm">
              {#each validationResult.structuralErrors as error (error)}
                <li>{error}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if validationResult.templateErrors.length > 0}
          <div class="flex flex-col gap-1">
            <p class="text-sm font-medium">模板语法错误：</p>
            <ScrollArea class="max-h-48">
              <ul class="text-destructive list-disc pl-5 text-sm">
                {#each validationResult.templateErrors as templateError (templateError.templateId)}
                  <li>
                    <span class="font-mono text-xs">{templateError.templateId}</span>:
                    {templateError.error}
                  </li>
                {/each}
              </ul>
            </ScrollArea>
          </div>
        {/if}
      </div>

      <ResponsiveModal.Footer class="border-t px-6 py-4">
        <Button variant="outline" onclick={onCancel}>关闭</Button>
      </ResponsiveModal.Footer>
    {:else if validationResult && isValid && pack}
      <!-- Valid state: pack preview -->
      <div class="flex flex-col gap-3 px-6 py-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-base font-semibold">{pack.name}</h3>
          {#if pack.description}
            <div class="prose-content text-muted-foreground text-sm">
              {@html renderDescription(pack.description)}
            </div>
          {/if}
          {#if pack.author}
            <p class="text-muted-foreground text-sm">作者： {pack.author}</p>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <Badge variant="secondary">{pack.templates.length} 个模板</Badge>
          <Badge variant="secondary">{pack.variables.length} 个变量</Badge>
        </div>

        {#if conflictPack}
          <Alert.Root variant="destructive">
            <AlertTriangle class="h-4 w-4" />
            <Alert.Title>名称重复</Alert.Title>
            <Alert.Description>
              已存在名为“{conflictPack.name}”的提示词包。导入会创建独立副本。如需用此文件替换已有内容，请使用该提示词包的“从文件更新”操作。
            </Alert.Description>
          </Alert.Root>
        {/if}
      </div>

      <ResponsiveModal.Footer class="border-t px-6 py-4">
        {#if conflictPack}
          <Button variant="ghost" onclick={onCancel}>取消</Button>
          <Button onclick={() => onConfirm('rename')}>导入为副本</Button>
        {:else}
          <Button variant="outline" onclick={onCancel}>取消</Button>
          <Button onclick={() => onConfirm('rename')}>导入</Button>
        {/if}
      </ResponsiveModal.Footer>
    {/if}
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
