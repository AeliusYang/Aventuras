<script lang="ts">
  import type { PresetPack } from '$lib/services/packs/types'
  import { packService } from '$lib/services/packs/pack-service'
  import { database } from '$lib/services/database'
  import {
    importExportService,
    type ImportValidationResult,
  } from '$lib/services/packs/import-export'
  import type { PackUpdateSummary } from '$lib/services/packs/update-summary'
  import { ui } from '$lib/stores/ui.svelte'
  import { errMessage } from '$lib/utils/error'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Button } from '$lib/components/ui/button'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { fade } from 'svelte/transition'
  import PromptPackCard from './PromptPackCard.svelte'
  import CreatePackDialog from './CreatePackDialog.svelte'
  import ImportPreviewDialog from './ImportPreviewDialog.svelte'
  import UpdatePackDialog from './UpdatePackDialog.svelte'

  interface Props {
    onOpenPack: (packId: string) => void
    showCreateDialog?: boolean
  }

  let { onOpenPack, showCreateDialog = $bindable(false) }: Props = $props()

  let packs = $state<PresetPack[]>([])
  let modifiedCounts = $state<Map<string, number>>(new Map())
  let usageCounts = $state<Map<string, number>>(new Map())
  let loading = $state(true)
  let importDefaultPackId = $state<string | null>(null)
  let importDefaultBusy = $state(false)

  async function setImportDefault(packId: string) {
    if (importDefaultBusy) return
    importDefaultBusy = true
    try {
      if (packId === importDefaultPackId) await packService.resetCollaborativeImportDefaultPack()
      else await packService.setCollaborativeImportDefaultPackId(packId)
      importDefaultPackId = await packService.getEffectiveCollaborativeImportDefaultPackId()
      ui.showToast('中文导入默认已保存', 'info')
    } catch (error) {
      ui.showToast(`导入默认包保存失败：${errMessage(error)}`, 'error')
    } finally {
      importDefaultBusy = false
    }
  }

  // Pack usage and batch reassignment state
  let usageTarget = $state<PresetPack | null>(null)
  let usageStories = $state<Awaited<ReturnType<typeof packService.getPackUsageStories>>>([])
  let usageSelectedIds = $state<string[]>([])
  let usageTargetPackId = $state('')
  let usageLoading = $state(false)
  let usageError = $state('')
  let reassigning = $state(false)

  // Delete confirmation state
  let deleteTarget = $state<PresetPack | null>(null)
  let deleteUsageStories = $state<Awaited<ReturnType<typeof packService.getPackUsageStories>>>([])
  let deleteUsageLoading = $state(false)
  let deleting = $state(false)

  // Update-from-file state
  let updateTarget = $state<PresetPack | null>(null)
  let updateValidation = $state<ImportValidationResult | null>(null)
  let updateSummary = $state<PackUpdateSummary | null>(null)
  let updateErrors = $state<ImportValidationResult | null>(null)
  let updating = $state(false)
  let exportingBeforeUpdate = $state(false)

  async function loadPacks() {
    loading = true
    try {
      const allPacks = await packService.getAllPacks()
      importDefaultPackId = await packService.getEffectiveCollaborativeImportDefaultPackId()

      // Load modified counts and usage counts in parallel for each pack
      const [modifiedResults, usageResults] = await Promise.all([
        Promise.all(
          allPacks.map(async (pack) => {
            const modified = await packService.getModifiedTemplates(pack.id)
            const count = [...modified.values()].filter(Boolean).length
            return [pack.id, count] as const
          }),
        ),
        Promise.all(
          allPacks.map(async (pack) => {
            const count = await database.getPackUsageCount(pack.id)
            return [pack.id, count] as const
          }),
        ),
      ])

      modifiedCounts = new Map(modifiedResults)
      usageCounts = new Map(usageResults)

      // Sort: default pack first, then user-created packs by name
      packs = allPacks.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1
        if (!a.isDefault && b.isDefault) return 1
        return a.name.localeCompare(b.name)
      })
    } catch (error) {
      console.error('[PromptPackList] Failed to load packs:', error)
    } finally {
      loading = false
    }
  }

  function handlePackCreated() {
    loadPacks()
  }

  async function handleDuplicatePack(pack: PresetPack) {
    try {
      const names = new Set(packs.map((item) => item.name.toLowerCase()))
      const base = `${pack.name} 副本`
      let name = base
      let suffix = 2
      while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`
      await packService.duplicatePack(pack.id, name)
      ui.showToast(`已复制“${pack.name}”`, 'info')
      await loadPacks()
    } catch (error) {
      ui.showToast(`复制失败：${errMessage(error)}`, 'error')
    }
  }

  async function openUsage(pack: PresetPack) {
    usageTarget = pack
    usageStories = []
    usageSelectedIds = []
    usageTargetPackId = packs.find((candidate) => candidate.id !== pack.id)?.id ?? ''
    usageError = ''
    usageLoading = true
    try {
      usageStories = await packService.getPackUsageStories(pack.id)
      usageSelectedIds = usageStories.map((story) => story.id)
    } catch (error) {
      usageError = errMessage(error)
    } finally {
      usageLoading = false
    }
  }

  function closeUsage() {
    if (reassigning) return
    usageTarget = null
    usageStories = []
    usageSelectedIds = []
    usageError = ''
  }

  async function handleReassignUsage() {
    if (!usageTarget || !usageTargetPackId || usageSelectedIds.length === 0 || reassigning) return
    reassigning = true
    usageError = ''
    try {
      await packService.reassignStoriesPack(usageSelectedIds, usageTargetPackId)
      ui.showToast(`已重新绑定 ${usageSelectedIds.length} 个故事`, 'info')
      reassigning = false
      closeUsage()
      await loadPacks()
    } catch (error) {
      usageError = errMessage(error)
    } finally {
      reassigning = false
    }
  }

  async function openDeleteConfirmation(pack: PresetPack) {
    deleteTarget = pack
    deleteUsageStories = []
    deleteUsageLoading = true
    try {
      deleteUsageStories = await packService.getPackUsageStories(pack.id)
    } catch (error) {
      console.error('[PromptPackList] Failed to load Pack usage before delete:', error)
    } finally {
      deleteUsageLoading = false
    }
  }

  function closeDeleteConfirmation() {
    if (deleting) return
    deleteTarget = null
    deleteUsageStories = []
    deleteUsageLoading = false
  }

  async function handleExportPack(packId: string) {
    try {
      const success = await importExportService.exportPack(packId)
      if (success) ui.showToast('Pack exported successfully', 'info')
    } catch (e) {
      console.error('Export failed:', e)
      ui.showToast(`Export failed: ${errMessage(e)}`, 'error')
    }
  }

  async function handleUpdateFromFile(pack: PresetPack) {
    const content = await importExportService.pickAndReadImportFile()
    if (!content) return

    const result = importExportService.validateImport(content)
    if (!result.valid || !result.pack) {
      updateErrors = result
      return
    }

    try {
      updateSummary = await importExportService.summarizeUpdate(pack.id, result.pack)
      updateValidation = result
      updateTarget = pack
    } catch (e) {
      console.error('[PromptPackList] Failed to summarize update:', e)
      ui.showToast(`Could not read pack: ${errMessage(e)}`, 'error')
    }
  }

  function closeUpdateDialog() {
    updateTarget = null
    updateValidation = null
    updateSummary = null
  }

  async function handleExportBeforeUpdate() {
    if (!updateTarget) return
    exportingBeforeUpdate = true
    try {
      const success = await importExportService.exportPack(updateTarget.id)
      if (success) ui.showToast('Pack exported successfully', 'info')
    } catch (e) {
      console.error('Export failed:', e)
      ui.showToast(`Export failed: ${errMessage(e)}`, 'error')
    } finally {
      exportingBeforeUpdate = false
    }
  }

  async function handleConfirmUpdate() {
    if (!updateTarget || !updateValidation?.pack) return
    updating = true
    try {
      await importExportService.updatePackFromFile(updateTarget.id, updateValidation.pack)
      ui.showToast(`Updated "${updateTarget.name}"`, 'info')
      closeUpdateDialog()
      await loadPacks()
    } catch (e) {
      console.error('Update failed:', e)
      ui.showToast(`Update failed: ${errMessage(e)}`, 'error')
    } finally {
      updating = false
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    deleting = true
    try {
      const result = await packService.deletePack(deleteTarget.id)
      if (result.deleted) {
        ui.showToast(`Deleted "${deleteTarget.name}"`, 'info')
        deleteTarget = null
        await loadPacks()
      } else {
        ui.showToast(result.reason ?? 'Could not delete pack', 'error')
      }
    } catch (e) {
      console.error('Delete failed:', e)
      ui.showToast('Delete failed', 'error')
    } finally {
      deleting = false
    }
  }

  // Load on mount
  $effect(() => {
    loadPacks()
  })
</script>

{#if loading}
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each Array(3) as _, i (i)}
      <div class="space-y-3">
        <Skeleton class="h-30 w-full rounded-xl" />
      </div>
    {/each}
  </div>
{:else}
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" in:fade>
    {#each packs as pack (pack.id)}
      <PromptPackCard
        {pack}
        modifiedCount={modifiedCounts.get(pack.id) ?? 0}
        usageCount={usageCounts.get(pack.id) ?? 0}
        isImportDefault={pack.id === importDefaultPackId}
        {importDefaultBusy}
        onImportDefault={() => setImportDefault(pack.id)}
        onclick={() => onOpenPack(pack.id)}
        onExport={() => handleExportPack(pack.id)}
        onUpdateFromFile={pack.isDefault ? undefined : () => handleUpdateFromFile(pack)}
        onDuplicate={() => handleDuplicatePack(pack)}
        onManageUsage={() => openUsage(pack)}
        onDelete={pack.isDefault
          ? undefined
          : () => {
              void openDeleteConfirmation(pack)
            }}
      />
    {/each}
  </div>
{/if}

<CreatePackDialog
  open={showCreateDialog}
  onOpenChange={(v) => (showCreateDialog = v)}
  onCreated={handlePackCreated}
/>

<UpdatePackDialog
  open={!!updateTarget}
  pack={updateTarget}
  packData={updateValidation?.pack ?? null}
  summary={updateSummary}
  exporting={exportingBeforeUpdate}
  {updating}
  onExportFirst={handleExportBeforeUpdate}
  onConfirm={handleConfirmUpdate}
  onCancel={closeUpdateDialog}
/>

<!-- A file that fails validation never reaches the update confirmation; its errors are
     reported through the import preview's error state. -->
<ImportPreviewDialog
  open={!!updateErrors}
  validationResult={updateErrors}
  conflictPack={null}
  onConfirm={() => {
    updateErrors = null
  }}
  onCancel={() => {
    updateErrors = null
  }}
/>

<!-- Delete confirmation -->
<ResponsiveModal.Root
  open={!!deleteTarget}
  onOpenChange={(v) => {
    if (!v) closeDeleteConfirmation()
  }}
>
  <ResponsiveModal.Content class="p-0 sm:max-w-sm">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title>删除提示词包</ResponsiveModal.Title>
      <ResponsiveModal.Description>
        {#if deleteUsageLoading}
          正在检查使用此 Pack 的故事…
        {:else if deleteUsageStories.length > 0}
          “{deleteTarget?.name}”仍被 {deleteUsageStories.length} 个故事使用，必须先在使用关系中重新绑定：
          {deleteUsageStories.map((story) => story.title).join('、')}。
        {:else}
          确定删除“{deleteTarget?.name}”？此操作无法撤销。
        {/if}
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>
    <ResponsiveModal.Footer class="border-t px-6 py-4">
      <Button variant="outline" onclick={closeDeleteConfirmation}>取消</Button>
      {#if deleteUsageStories.length > 0 && deleteTarget}
        <Button
          variant="secondary"
          onclick={() => {
            if (!deleteTarget) return
            const pack = deleteTarget
            closeDeleteConfirmation()
            void openUsage(pack)
          }}>管理使用关系</Button
        >
      {/if}
      <Button
        variant="destructive"
        onclick={handleConfirmDelete}
        disabled={deleting || deleteUsageLoading || deleteUsageStories.length > 0}
      >
        {deleting
          ? '正在删除…'
          : deleteUsageLoading
            ? '正在检查…'
            : deleteUsageStories.length > 0
              ? '请先重新绑定故事'
              : '删除'}
      </Button>
    </ResponsiveModal.Footer>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>

<!-- Story bindings for this Pack -->
<ResponsiveModal.Root
  open={!!usageTarget}
  onOpenChange={(open) => {
    if (!open) closeUsage()
  }}
>
  <ResponsiveModal.Content class="p-0 sm:max-w-lg">
    <ResponsiveModal.Header class="border-b px-6 py-4">
      <ResponsiveModal.Title>使用“{usageTarget?.name}”的故事</ResponsiveModal.Title>
      <ResponsiveModal.Description>
        选择故事后，可一次性切换到另一套提示词包。必填变量缺失时不会执行部分切换。
      </ResponsiveModal.Description>
    </ResponsiveModal.Header>
    <div class="max-h-[55vh] space-y-3 overflow-y-auto px-6 py-4">
      {#if usageLoading}
        <p class="text-muted-foreground text-sm">正在加载…</p>
      {:else if usageStories.length === 0}
        <p class="text-muted-foreground text-sm">暂无故事使用此 Pack。</p>
      {:else}
        {#each usageStories as usageStory (usageStory.id)}
          <label class="hover:bg-muted/40 flex items-center gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              checked={usageSelectedIds.includes(usageStory.id)}
              onchange={(event) => {
                usageSelectedIds = event.currentTarget.checked
                  ? [...usageSelectedIds, usageStory.id]
                  : usageSelectedIds.filter((id) => id !== usageStory.id)
              }}
            />
            <span class="min-w-0 flex-1 truncate text-sm">{usageStory.title}</span>
          </label>
        {/each}
        <label class="space-y-1 text-sm">
          <span>切换到</span>
          <select
            class="bg-background w-full rounded-md border px-2 py-2"
            bind:value={usageTargetPackId}
          >
            {#each packs.filter((pack) => pack.id !== usageTarget?.id) as pack (pack.id)}
              <option value={pack.id}>{pack.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if usageError}
        <p class="text-destructive text-xs whitespace-pre-line">{usageError}</p>
      {/if}
    </div>
    <ResponsiveModal.Footer class="border-t px-6 py-4">
      <Button variant="outline" onclick={closeUsage}>关闭</Button>
      <Button
        onclick={handleReassignUsage}
        disabled={reassigning || usageSelectedIds.length === 0 || !usageTargetPackId}
      >
        {reassigning ? '正在切换…' : '批量重新绑定'}
      </Button>
    </ResponsiveModal.Footer>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
