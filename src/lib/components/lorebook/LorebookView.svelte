<script lang="ts">
  import type { Entry } from '$lib/types'
  import { ui } from '$lib/stores/ui.svelte'
  import { story } from '$lib/stores/story.svelte'
  import { lorebookVault } from '$lib/stores/lorebookVault.svelte'
  import { LorebookImportExport } from '$lib/services/lorebookImportExport'
  import { onMount } from 'svelte'
  import LorebookList from './LorebookList.svelte'
  import LorebookDetail from './LorebookDetail.svelte'
  import LorebookEntryForm from './LorebookEntryForm.svelte'
  import LorebookImportModal from './LorebookImportModal.svelte'
  import LorebookExportModal from './LorebookExportModal.svelte'
  import LorebookVaultImportModal from './LorebookVaultImportModal.svelte'
  import { BookOpen, Plus, ArrowLeft, Loader2, Bot, AlertCircle, RotateCcw } from '@lucide/svelte'
  import { runManualLoreManagement } from '$lib/services/generation'

  import { Button } from '$lib/components/ui/button'
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert'
  import { EmptyState } from '$lib/components/ui/empty-state'
  import { cn } from '$lib/utils/cn'

  // Lore management active state
  const isLoreManagementActive = $derived(ui.loreManagementActive)

  // Track if we're in "new entry" mode
  let creatingNew = $state(false)

  // Vault import modal open state
  let vaultImportOpen = $state(false)

  // Breakpoint for mobile/desktop
  let isMobile = $state(false)

  // Selection is global UI state, while entries belong to one story. Reset only when the
  // story identity changes; an unconditional mount microtask can clear a first click.
  let mountedStoryId = $state<string | null>(null)

  // Get selected entry
  const selectedEntry = $derived.by(() => {
    const id = ui.selectedLorebookEntryId
    if (!id) return null
    return story.lorebookEntries.find((e) => e.id === id) ?? null
  })

  // A story reload can replace the entry array while the panel is mounted. Clear a
  // selection that no longer belongs to the loaded story instead of leaving the detail
  // pane pointing at an object that can never render.
  $effect(() => {
    const selectedId = ui.selectedLorebookEntryId
    if (!selectedId || story.lorebookEntries.length === 0) return
    if (!story.lorebookEntries.some((entry) => entry.id === selectedId)) {
      ui.selectLorebookEntry(null)
    }
  })

  // Show detail panel on desktop when entry selected, or on mobile when showing detail
  const showDetail = $derived(
    (!isMobile && (selectedEntry || creatingNew)) || (isMobile && ui.lorebookShowDetail),
  )

  // Show list on desktop always, or on mobile when not showing detail
  const showList = $derived(!isMobile || !ui.lorebookShowDetail)

  function handleResize() {
    isMobile = window.innerWidth < 768
  }

  onMount(() => {
    handleResize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  })

  $effect(() => {
    const storyId = story.currentStory?.id ?? null
    if (storyId === mountedStoryId) return
    mountedStoryId = storyId
    creatingNew = false
    ui.resetLorebookManager()
  })

  function handleNewEntry() {
    // Block during lore management
    if (isLoreManagementActive) return

    creatingNew = true
    ui.selectLorebookEntry(null)
    ui.setLorebookEditMode(true)
    if (isMobile) {
      ui.showLorebookDetail()
    }
  }

  async function handleSaveNew(entry: Entry) {
    const {
      id: _id,
      storyId: _storyId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...entryData
    } = entry
    const newEntry = await story.addLorebookEntry(entryData)
    creatingNew = false
    ui.setLorebookEditMode(false)
    ui.selectLorebookEntry(newEntry.id)
  }

  function handleCancelNew() {
    creatingNew = false
    ui.setLorebookEditMode(false)
    if (isMobile) {
      ui.hideLorebookDetail()
    }
  }

  function handleImportFromVault() {
    vaultImportOpen = true
  }

  async function handleSaveToVault() {
    if (!story.currentStory || story.lorebookEntries.length === 0) return
    try {
      const vaultEntries = story.lorebookEntries.map(LorebookImportExport.entryToVaultEntry)
      const name = `${story.currentStory.title} Lorebook`
      await lorebookVault.saveFromStory(name, vaultEntries, story.currentStory.id)
      ui.showToast(
        `Saved ${vaultEntries.length} entr${vaultEntries.length === 1 ? 'y' : 'ies'} to vault as "${name}"`,
        'info',
      )
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : 'Failed to save to vault', 'error')
    }
  }

  function handleMobileBack() {
    if (creatingNew) {
      handleCancelNew()
    } else {
      ui.hideLorebookDetail()
    }
  }
</script>

<div class="bg-background flex h-full min-h-0 min-w-0 flex-col">
  <!-- Lore Management Active Banner -->
  {#if isLoreManagementActive}
    <div class="bg-accent/20 border-b p-4">
      <Alert variant="default" class="border-none bg-transparent p-0">
        <div class="text-primary flex items-center gap-2">
          <Bot class="h-5 w-5" />
          {#if ui.loreManagementProgress}
            <Loader2 class="h-4 w-4 animate-spin" />
          {/if}
          <AlertTitle class="mb-0">AI 世界书管理正在运行</AlertTitle>
        </div>
        <AlertDescription class="text-muted-foreground mt-1 flex items-center gap-2">
          <span class="truncate">
            {ui.loreManagementProgress || '正在检查故事内容…'}
          </span>
          {#if ui.loreManagementChanges > 0}
            <span class="bg-primary/20 text-primary rounded-full px-1.5 py-0.5 text-xs">
              {ui.loreManagementChanges} 项修改
            </span>
          {/if}
        </AlertDescription>
      </Alert>
    </div>
  {/if}

  <!-- Lore Management Error Banner with Retry -->
  {#if ui.loreManagementError}
    <div class="bg-destructive/10 border-destructive/20 border-b p-4">
      <Alert variant="destructive" class="border-none bg-transparent p-0">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-start gap-2.5">
            <AlertCircle class="text-destructive mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <AlertTitle class="text-destructive mb-0 text-sm font-semibold"
                >世界书管理失败</AlertTitle
              >
              <AlertDescription class="text-destructive/90 mt-0.5 text-xs">
                {ui.loreManagementError}
              </AlertDescription>
            </div>
          </div>
          <div class="flex items-center gap-2 self-end sm:self-auto">
            <!-- Retry does not dismiss the banner: `startLoreManagement` clears it once a run
                 actually begins, and one that cannot start — no story loaded, or a session
                 already going — would otherwise look like it worked. -->
            <Button
              variant="outline"
              size="sm"
              class="border-destructive/30 text-destructive hover:bg-destructive/10 h-8 text-xs"
              onclick={() => void runManualLoreManagement()}
            >
              <RotateCcw class="mr-1.5 h-3.5 w-3.5" />
              重试
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground h-8 text-xs"
              onclick={() => ui.clearLoreManagementError()}
            >
              关闭提示
            </Button>
          </div>
        </div>
      </Alert>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1">
    <!-- List panel -->
    {#if showList}
      <div class={cn('flex flex-col border-r', isMobile ? 'w-full' : 'w-72 flex-shrink-0 lg:w-80')}>
        <!-- Back to Story Header -->
        <div class="px-2 pt-0 sm:pt-3">
          <Button
            variant="ghost"
            class="text-muted-foreground hover:text-foreground flex h-8 items-center gap-2 pl-2 text-xs"
            onclick={() => {
              ui.resetLorebookManager()
              ui.setActivePanel('story')
            }}
          >
            <ArrowLeft class="h-3.5 w-3.5" />
            <span>返回故事</span>
          </Button>
        </div>

        <LorebookList
          onNewEntry={handleNewEntry}
          onImportFromVault={handleImportFromVault}
          onSaveToVault={handleSaveToVault}
        />
      </div>
    {/if}

    <!-- Detail panel -->
    {#if showDetail}
      <div
        class={cn(
          'bg-background flex min-h-0 min-w-0 flex-1 flex-col',
          isMobile && 'absolute top-0 right-0 bottom-0 left-0 z-10 w-full',
        )}
      >
        {#if creatingNew}
          <!-- New entry form -->
          <div class="flex h-full flex-col">
            <div class="flex items-center gap-3 border-b p-3 sm:p-4">
              {#if isMobile}
                <Button variant="ghost" size="icon" class="-ml-2" onclick={handleMobileBack}>
                  <ArrowLeft class="h-5 w-5" />
                </Button>
              {/if}
              <div class="bg-primary/10 text-primary rounded-lg p-2">
                <Plus class="h-5 w-5" />
              </div>
              <h2 class="text-foreground font-semibold">新建条目</h2>
            </div>
            <div class="flex-1 overflow-y-auto p-4">
              <LorebookEntryForm onSave={handleSaveNew} onCancel={handleCancelNew} />
            </div>
          </div>
        {:else if selectedEntry}
          <svelte:boundary>
            <LorebookDetail entry={selectedEntry} {isMobile} />
            {#snippet failed(error, reset)}
              <div
                class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
              >
                <p class="text-destructive font-medium">这个世界书条目暂时无法打开</p>
                <p class="text-muted-foreground max-w-md text-sm">
                  条目详情或编辑表单未能加载。故事正文和条目数据仍保留，可以返回列表查看其他条目。
                </p>
                <div class="flex items-center gap-2">
                  <Button variant="outline" size="sm" onclick={() => reset()}>重试</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => {
                      void error
                      ui.selectLorebookEntry(null)
                    }}>返回列表</Button
                  >
                </div>
              </div>
            {/snippet}
          </svelte:boundary>
        {:else}
          <!-- Empty state for desktop when no entry selected -->
          <div class="flex flex-1 items-center justify-center p-8">
            <EmptyState
              icon={BookOpen}
              title="选择条目"
              description="从列表选择条目以查看或编辑详情，也可以创建新条目。"
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Import Modal -->
{#if ui.lorebookImportModalOpen}
  <LorebookImportModal />
{/if}

<!-- Export Modal -->
{#if ui.lorebookExportModalOpen}
  <LorebookExportModal />
{/if}

<!-- Vault Import Modal -->
<LorebookVaultImportModal open={vaultImportOpen} onClose={() => (vaultImportOpen = false)} />
