<script lang="ts">
  import type { PresetPack } from '$lib/services/packs/types'
  import { packService } from '$lib/services/packs/pack-service'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Label } from '$lib/components/ui/label'

  interface Props {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreated: (pack: PresetPack) => void
  }

  let { open, onOpenChange, onCreated }: Props = $props()

  let name = $state('')
  let description = $state('')
  let author = $state('')
  let creating = $state(false)

  let canCreate = $derived(name.trim().length > 0 && !creating)

  function resetForm() {
    name = ''
    description = ''
    author = ''
    creating = false
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      resetForm()
    }
    onOpenChange(value)
  }

  async function handleCreate() {
    if (!canCreate) return

    creating = true
    try {
      const pack = await packService.createPack(
        name.trim(),
        description.trim() || undefined,
        author.trim() || undefined,
      )
      resetForm()
      onCreated(pack)
      onOpenChange(false)
    } catch (error) {
      console.error('[CreatePackDialog] Failed to create pack:', error)
      creating = false
    }
  }
</script>

<ResponsiveModal.Root {open} onOpenChange={handleOpenChange}>
  <ResponsiveModal.Content class="p-0 sm:max-w-md">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title>创建提示词包</ResponsiveModal.Title>
      <ResponsiveModal.Description>
        新提示词包会复制默认模板，创建后可以编辑。
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>

    <div class="flex flex-col gap-4 px-6 py-4">
      <div class="flex flex-col gap-2">
        <Label for="pack-name">名称 <span class="text-destructive">*</span></Label>
        <Input id="pack-name" bind:value={name} placeholder="我的提示词包" />
      </div>

      <div class="flex flex-col gap-2">
        <Label for="pack-description">说明</Label>
        <p class="text-muted-foreground text-xs">支持 Markdown 和 HTML</p>
        <Textarea
          id="pack-description"
          bind:value={description}
          placeholder="简要介绍这个提示词包…"
          rows={3}
        />
      </div>

      <div class="flex flex-col gap-2">
        <Label for="pack-author">作者</Label>
        <Input id="pack-author" bind:value={author} placeholder="你的名字" />
      </div>
    </div>

    <ResponsiveModal.Footer class="border-t px-6 py-4">
      <Button variant="outline" onclick={() => handleOpenChange(false)}>取消</Button>
      <Button onclick={handleCreate} disabled={!canCreate}>
        {#if creating}
          正在创建…
        {:else}
          创建
        {/if}
      </Button>
    </ResponsiveModal.Footer>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
