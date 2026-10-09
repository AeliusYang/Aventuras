<script lang="ts">
  import type { Entry, EntryType } from '$lib/types'
  import { ui } from '$lib/stores/ui.svelte'
  import { story } from '$lib/stores/story.svelte'
  import {
    Search,
    Plus,
    Download,
    Upload,
    Trash2,
    X,
    Filter,
    ArrowUpDown,
    Archive,
  } from '@lucide/svelte'
  import LorebookEntryCard from './LorebookEntryCard.svelte'

  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Dialog from '$lib/components/ui/dialog'
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from '$lib/components/ui/dropdown-menu'

  interface Props {
    onNewEntry?: () => void
    onImportFromVault?: () => void
    onSaveToVault?: () => void
  }

  let { onNewEntry, onImportFromVault, onSaveToVault }: Props = $props()

  let searchDebounceTimer: ReturnType<typeof setTimeout>
  let confirmingBulkDelete = $state(false)
  let deleteAllDialogOpen = $state(false)
  let isDeleting = $state(false)

  const entryTypes: Array<EntryType | 'all'> = [
    'all',
    'character',
    'location',
    'item',
    'faction',
    'concept',
    'event',
  ]
  const sortOptions: Array<{
    value: 'name' | 'type' | 'updated'
    label: string
  }> = [
    { value: 'name', label: '名称' },
    { value: 'type', label: '类型' },
    { value: 'updated', label: '最近更新' },
  ]

  // Lore management active state - disable editing actions
  const isLoreManagementActive = $derived(ui.loreManagementActive)

  // Filtered and sorted entries
  const filteredEntries = $derived.by(() => {
    let result = [...story.lorebookEntries] // Create a copy to avoid mutating original

    // Filter by type
    if (ui.lorebookTypeFilter !== 'all') {
      result = result.filter((e) => e.type === ui.lorebookTypeFilter)
    }

    // Filter by search query
    if (ui.lorebookSearchQuery.trim()) {
      const query = ui.lorebookSearchQuery.toLowerCase()
      result = result.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.aliases.some((a) => a.toLowerCase().includes(query)) ||
          e.injection.keywords.some((k) => k.toLowerCase().includes(query)),
      )
    }

    // Sort (safe since we already created a copy)
    return result.sort((a, b) => {
      switch (ui.lorebookSortBy) {
        case 'name':
          return a.name.localeCompare(b.name)
        case 'type':
          return a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
        case 'updated':
          return b.updatedAt - a.updatedAt
        default:
          return 0
      }
    })
  })

  const hasBulkSelection = $derived(ui.lorebookBulkSelection.size > 0)
  const allSelected = $derived(
    filteredEntries.length > 0 && filteredEntries.every((e) => ui.lorebookBulkSelection.has(e.id)),
  )

  function handleSearchInput(e: Event) {
    const value = (e.target as HTMLInputElement).value
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
      ui.setLorebookSearchQuery(value)
    }, 300)
  }

  function toggleSelectAll() {
    if (allSelected) {
      ui.clearBulkSelection()
    } else {
      ui.selectAllForBulk(filteredEntries.map((e) => e.id))
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(ui.lorebookBulkSelection)
    isDeleting = true
    try {
      await story.deleteLorebookEntries(ids)
      ui.clearBulkSelection()
      ui.showToast(`Deleted ${ids.length} entries`, 'info')
    } catch (error) {
      console.error('[LorebookList] Failed to delete entries:', error)
      ui.showToast(error instanceof Error ? error.message : 'Failed to delete entries', 'error')
    } finally {
      isDeleting = false
      confirmingBulkDelete = false
    }
  }

  function handleConfirmBulkDelete() {
    if (ui.lorebookBulkSelection.size === 0) return
    confirmingBulkDelete = true
  }

  function handleCancelBulkDelete() {
    confirmingBulkDelete = false
  }

  function handleClearSelection() {
    ui.clearBulkSelection()
  }

  async function handleDeleteAll() {
    isDeleting = true
    const ids = story.lorebookEntries.map((e) => e.id)
    try {
      await story.deleteLorebookEntries(ids)
      ui.clearBulkSelection()
      ui.selectLorebookEntry(null)
      deleteAllDialogOpen = false
      ui.showToast(`Deleted all ${ids.length} entries`, 'info')
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : 'Failed to delete entries', 'error')
    } finally {
      isDeleting = false
    }
  }

  function selectEntry(entry: Entry) {
    ui.selectLorebookEntry(entry.id)
  }
</script>

<div class="flex h-full flex-col">
  <!-- Search -->
  <div class="border-b px-3 pt-0 pb-3 sm:pt-3">
    <div class="relative">
      <Input
        type="text"
        placeholder="搜索条目…"
        value={ui.lorebookSearchQuery}
        oninput={handleSearchInput}
        class="w-full pr-8 pl-9"
        leftIcon={Search}
      />
      {#if ui.lorebookSearchQuery}
        <button
          class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 p-1"
          onclick={() => ui.setLorebookSearchQuery('')}
        >
          <X class="h-4 w-4" />
        </button>
      {/if}
    </div>

    <!-- Filters -->
    <div class="mt-2 flex gap-2">
      <!-- Type filter -->
      <DropdownMenu>
        <DropdownMenuTrigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" class="w-full justify-between font-normal">
              <span class="flex items-center gap-2 capitalize">
                <Filter class="text-muted-foreground h-4 w-4" />
                {ui.lorebookTypeFilter === 'all' ? '所有类型' : ui.lorebookTypeFilter}
              </span>
            </Button>
          {/snippet}
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-50" align="start">
          <DropdownMenuLabel>按类型筛选</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={ui.lorebookTypeFilter}
            onValueChange={(val) => ui.setLorebookTypeFilter(val as EntryType | 'all')}
          >
            {#each entryTypes as entryType (entryType)}
              <DropdownMenuRadioItem value={entryType} class="capitalize">
                <span>{entryType === 'all' ? '所有类型' : entryType}</span>
              </DropdownMenuRadioItem>
            {/each}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Sort -->
      <div class="flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="w-full justify-between font-normal">
                <span class="flex items-center gap-2">
                  <ArrowUpDown class="text-muted-foreground h-4 w-4" />
                  {sortOptions.find((s) => s.value === ui.lorebookSortBy)?.label}
                </span>
              </Button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-[200px]" align="start">
            <DropdownMenuLabel>条目排序</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={ui.lorebookSortBy}
              onValueChange={(val) => ui.setLorebookSortBy(val as 'name' | 'type' | 'updated')}
            >
              {#each sortOptions as option (option.value)}
                <DropdownMenuRadioItem value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              {/each}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </div>

  <!-- Action buttons -->
  <div class="flex gap-2 border-b p-3">
    <Button
      class="flex-1 gap-2"
      onclick={onNewEntry}
      disabled={isLoreManagementActive}
      title={isLoreManagementActive ? '世界书管理运行期间暂不可编辑' : undefined}
    >
      <Plus class="h-4 w-4" />
      <span class="xs:inline hidden">新建条目</span>
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            size="icon"
            disabled={isLoreManagementActive}
            title="素材库"
          >
            <Archive class="h-4 w-4" />
          </Button>
        {/snippet}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>素材库</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onclick={onImportFromVault}>
          <Download class="mr-2 h-4 w-4" />
          从素材库导入
        </DropdownMenuItem>
        <DropdownMenuItem onclick={onSaveToVault} disabled={story.lorebookEntries.length === 0}>
          <Upload class="mr-2 h-4 w-4" />
          保存到素材库
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button
      variant="outline"
      size="icon"
      onclick={() => ui.openLorebookImport()}
      disabled={isLoreManagementActive}
      title={isLoreManagementActive ? '世界书管理运行期间暂不可导入' : '从文件导入'}
    >
      <Download class="h-4 w-4" />
    </Button>
    <Button variant="outline" size="icon" onclick={() => ui.openLorebookExport()} title="导出">
      <Upload class="h-4 w-4" />
    </Button>
    {#if story.lorebookEntries.length > 0 && !isLoreManagementActive}
      <Dialog.Root bind:open={deleteAllDialogOpen}>
        <Dialog.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="icon"
              class="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              title="删除所有条目"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          {/snippet}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>删除世界书中的所有条目？</Dialog.Title>
              <Dialog.Description>
                这将永久删除全部 {story.lorebookEntries.length} 个条目 （来自本故事的世界书）。此操作无法撤销。
              </Dialog.Description>
            </Dialog.Header>
            <Dialog.Footer>
              <Dialog.Close>
                {#snippet child({ props })}
                  <Button {...props} variant="outline">取消</Button>
                {/snippet}
              </Dialog.Close>
              <Button
                class="bg-destructive text-destructive-foreground hover:bg-destructive/80"
                onclick={handleDeleteAll}
                disabled={isDeleting}
              >
                <Trash2 class="mr-2 h-4 w-4" />
                删除所有条目
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    {/if}
  </div>

  <!-- Bulk selection header -->
  {#if hasBulkSelection}
    <div class="bg-muted/30 flex items-center justify-between gap-2 border-b p-3">
      <div class="flex items-center gap-2">
        <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} />
        <span class="text-muted-foreground text-sm">{ui.lorebookBulkSelection.size} 已选</span>
      </div>
      <div class="flex items-center gap-2">
        {#if confirmingBulkDelete}
          <Button
            variant="secondary"
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={handleCancelBulkDelete}
            disabled={isDeleting}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={handleBulkDelete}
            disabled={isDeleting}
          >
            确认删除
          </Button>
        {:else}
          <Button
            variant="ghost"
            size="sm"
            class="text-destructive hover:text-destructive h-7 gap-1 px-2 text-xs"
            onclick={handleConfirmBulkDelete}
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span class="xs:inline hidden">删除</span>
          </Button>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={handleClearSelection}>
            取消
          </Button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Entry count -->
  <div class="text-muted-foreground bg-muted/10 border-b px-3 py-2 text-xs">
    {filteredEntries.length} 个条目
    {#if ui.lorebookTypeFilter !== 'all' || ui.lorebookSearchQuery}
      <span class="opacity-70">
        （筛选前共 {story.lorebookEntries.length} 个）
      </span>
    {/if}
  </div>

  <!-- Entry list -->
  <ScrollArea class="flex-1 pb-16 sm:pb-10">
    <div class="space-y-2 p-3">
      {#if filteredEntries.length === 0}
        {#if story.lorebookEntries.length === 0}
          <div class="text-muted-foreground py-8 text-center">
            <p>尚无世界书条目。</p>
            <p class="mt-1 text-sm">创建条目，或导入已有世界书。</p>
            {#if onImportFromVault}
              <Button
                variant="outline"
                class="mt-4 gap-2"
                onclick={onImportFromVault}
                disabled={isLoreManagementActive}
              >
                <Archive class="h-4 w-4" />
                从素材库导入
              </Button>
            {/if}
          </div>
        {:else}
          <div class="text-muted-foreground py-8 text-center">
            <p>没有符合筛选条件的条目。</p>
            <Button
              variant="link"
              class="mt-1 h-auto p-0 text-sm"
              onclick={() => {
                ui.setLorebookSearchQuery('')
                ui.setLorebookTypeFilter('all')
              }}
            >
              清除筛选
            </Button>
          </div>
        {/if}
      {:else}
        {#each filteredEntries as entry (entry.id)}
          <LorebookEntryCard
            {entry}
            selected={ui.selectedLorebookEntryId === entry.id}
            showCheckbox={hasBulkSelection}
            onSelect={() => selectEntry(entry)}
          />
        {/each}
      {/if}
    </div>
  </ScrollArea>
</div>
