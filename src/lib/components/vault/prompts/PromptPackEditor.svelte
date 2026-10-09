<script lang="ts">
  import { untrack } from 'svelte'
  import type { FullPack } from '$lib/services/packs/types'
  import { allSamples } from './sampleContext'
  import { packService } from '$lib/services/packs/pack-service'
  import { database } from '$lib/services/database'
  import type { ClassifiedTemplates, RefreshScope } from '$lib/services/packs/staleness'
  import { ui } from '$lib/stores/ui.svelte'
  import { errMessage } from '$lib/utils/error'
  import { createIsMobile } from '$lib/hooks/is-mobile.svelte'
  import TemplateGroupList from './TemplateGroupList.svelte'
  import TemplateEditor from './TemplateEditor.svelte'
  import PromptInspector from './PromptInspector.svelte'
  import type { CollaborativeInspectionContext } from '$lib/services/ai/core/CollaborativePromptService'
  import VariableManager from './VariableManager.svelte'
  import RuntimeVariableManager from './RuntimeVariableManager.svelte'
  import VariablePalette from './VariablePalette.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Drawer from '$lib/components/ui/drawer'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Label } from '$lib/components/ui/label'
  import { renderDescription } from '$lib/utils/markdown'
  import TestVariablesModal from './TestVariablesModal.svelte'
  import RefreshTemplatesDialog from './RefreshTemplatesDialog.svelte'
  import {
    ChevronLeft,
    Menu,
    Save,
    Undo2,
    RotateCcw,
    Pencil,
    Eye,
    Check,
    X,
    Settings,
    Star,
  } from '@lucide/svelte'

  interface Props {
    packId: string
    storyId?: string
    storyContext?: CollaborativeInspectionContext
    initialTemplateId?: string
    onClose: () => void
    onDirtyChange?: (dirty: boolean) => void
    allowedTemplateIds?: readonly string[]
    collaborativeMode?: boolean
  }

  let {
    packId,
    storyId,
    storyContext,
    initialTemplateId,
    onClose,
    onDirtyChange,
    allowedTemplateIds,
    collaborativeMode = false,
  }: Props = $props()

  let selectedTemplateId = $state<string | null>(null)
  let showVariables = $state(false)
  let showRuntimeVars = $state(false)
  let fullPack = $state<FullPack | null>(null)
  let loading = $state(true)
  let packError = $state<string | null>(null)
  let importDefaultPackId = $state<string | null>(null)
  let importDefaultBusy = $state(false)

  async function setImportDefault() {
    if (importDefaultBusy || !fullPack) return
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
  let drawerOpen = $state(false)

  // Editor tab state
  let editorActiveTab = $state<'system' | 'user'>('system')
  let editorHasUserContent = $state(false)
  let mobileView = $state<'editor' | 'preview'>('editor')

  // Dirty guard state
  let isEditorDirty = $state(false)
  let showDirtyDialog = $state(false)
  let pendingAction = $state<(() => void) | null>(null)
  let editorRef = $state<TemplateEditor | null>(null)

  // Test variables state
  let showTestVars = $state(false)
  let testValues = $state<Record<string, string>>({})

  function handleTestValuesChange(values: Record<string, string>) {
    testValues = values
  }

  // Sync testValues when variables change: all samples + custom defaults as base, user overrides on top
  $effect(() => {
    const vars = fullPack?.variables
    if (!vars) return
    // Build complete defaults: system + runtime samples + custom variable defaults
    const defaults: Record<string, string> = { ...allSamples }
    for (const v of vars) {
      if (v.defaultValue) {
        defaults[v.variableName] = v.defaultValue
      }
    }
    // Read current testValues without creating a dependency (avoid infinite loop)
    const current = untrack(() => testValues)
    // Overlay existing non-empty user overrides on top of defaults
    const merged: Record<string, string> = { ...defaults }
    for (const [key, value] of Object.entries(current)) {
      if (value !== '' && key in defaults) {
        merged[key] = value
      }
    }
    testValues = merged
  })

  // Pack settings edit state
  let editingSettings = $state(false)
  let settingsDraft = $state({ name: '', author: '', description: '' })

  const isMobile = createIsMobile()

  $effect(() => {
    selectedTemplateId = initialTemplateId ?? null
    loadPack()
  })

  async function loadPack() {
    loading = true
    packError = null
    try {
      const loadedPack = await packService.getFullPack(packId)
      if (!loadedPack) {
        packError = `找不到提示词包 ${packId}。为避免误写错误来源，中文写作编辑已停止。`
        return
      }
      fullPack = loadedPack
      importDefaultPackId = await packService.getEffectiveCollaborativeImportDefaultPackId()
      if (
        collaborativeMode &&
        storyId &&
        ((await database.getStoryPackId(storyId)) ?? 'default-pack') !== packId
      ) {
        packError = '当前故事的提示词包绑定已变化，请重新打开实际绑定包。'
        return
      }
      if (
        collaborativeMode &&
        selectedTemplateId &&
        allowedTemplateIds &&
        !allowedTemplateIds.includes(selectedTemplateId)
      ) {
        selectedTemplateId = null
      }
      await loadClassification()
    } catch (error) {
      console.error('[PromptPackEditor] Failed to load pack:', error)
    } finally {
      loading = false
    }
  }

  // Which of the built-in pack's templates carry edits, and which of those the app has
  // shipped newer text for. Null until loaded; empty groups mean the pack matches shipped.
  let classified = $state<ClassifiedTemplates | null>(null)
  let refreshDialogOpen = $state(false)
  let refreshing = $state(false)

  let editedCount = $derived(
    (classified?.behind.length ?? 0) + (classified?.customised.length ?? 0),
  )
  let behindCount = $derived(classified?.behind.length ?? 0)

  async function loadClassification() {
    if (!fullPack?.pack.isDefault) {
      classified = null
      return
    }
    try {
      classified = await packService.classifyPackTemplates(packId)
    } catch (error) {
      console.error('[PromptPackEditor] Failed to classify templates:', error)
      classified = null
    }
  }

  async function handleRefresh(scope: RefreshScope) {
    refreshing = true
    try {
      const count = await packService.refreshTemplates(packId, scope)
      ui.showToast(count === 1 ? '1 template replaced' : `${count} templates replaced`, 'info')
      refreshDialogOpen = false
      // The action lives in Pack Settings, which only renders with no template open, so
      // there is no editor holding stale content to reload.
      await refreshPack()
      await loadClassification()
    } catch (e) {
      console.error('Refresh failed:', e)
      ui.showToast(`Refresh failed: ${errMessage(e)}`, 'error')
    } finally {
      refreshing = false
    }
  }

  async function refreshPack() {
    try {
      fullPack = await packService.getFullPack(packId)
      // testValues cleanup and default re-initialization handled by $effect watching fullPack.variables
    } catch (error) {
      console.error('[PromptPackEditor] Failed to refresh pack:', error)
    }
  }

  /**
   * Guard wrapper: if editor is dirty, show dialog instead of executing action.
   * If clean, execute immediately.
   */
  function guardDirty(action: () => void) {
    if (isEditorDirty) {
      pendingAction = action
      showDirtyDialog = true
    } else {
      action()
    }
  }

  function handleSelectTemplate(templateId: string) {
    if (templateId === selectedTemplateId) return
    guardDirty(() => {
      showVariables = false
      showRuntimeVars = false
      selectedTemplateId = templateId
      isEditorDirty = false
      drawerOpen = false
    })
  }

  function handleToggleVariables() {
    guardDirty(() => {
      showVariables = !showVariables
      if (showVariables) {
        selectedTemplateId = null
        showRuntimeVars = false
      }
      isEditorDirty = false
      drawerOpen = false
    })
  }

  function handleToggleRuntimeVars() {
    guardDirty(() => {
      showRuntimeVars = !showRuntimeVars
      if (showRuntimeVars) {
        selectedTemplateId = null
        showVariables = false
      }
      isEditorDirty = false
      drawerOpen = false
    })
  }

  function handleShowSettings() {
    guardDirty(() => {
      selectedTemplateId = null
      showVariables = false
      showRuntimeVars = false
      isEditorDirty = false
      drawerOpen = false
    })
  }

  const showSettings = $derived(!selectedTemplateId && !showVariables && !showRuntimeVars)

  function handleBack() {
    guardDirty(() => {
      onClose()
    })
  }

  function handleDirtyChange(dirty: boolean) {
    isEditorDirty = dirty
  }

  // Propagate dirty state to parent
  $effect(() => {
    onDirtyChange?.(isEditorDirty)
  })

  /**
   * Guard wrapper exposed to parent: show dialog if dirty, else execute immediately.
   */
  export function guardNavigation(action: () => void) {
    guardDirty(action)
  }

  // Dirty dialog actions
  async function handleSaveAndSwitch() {
    if (editorRef) {
      const saved = await editorRef.save()
      if (!saved) return
    }
    isEditorDirty = false
    showDirtyDialog = false
    pendingAction?.()
    pendingAction = null
  }

  function handleDiscardAndSwitch() {
    if (editorRef) {
      editorRef.discard()
    }
    isEditorDirty = false
    showDirtyDialog = false
    pendingAction?.()
    pendingAction = null
  }

  function handleCancelSwitch() {
    showDirtyDialog = false
    pendingAction = null
  }

  function startEditSettings() {
    settingsDraft = {
      name: fullPack?.pack.name ?? '',
      author: fullPack?.pack.author ?? '',
      description: fullPack?.pack.description ?? '',
    }
    editingSettings = true
  }

  async function saveSettings() {
    const name = settingsDraft.name.trim()
    if (!name) return
    try {
      await packService.updatePack(packId, {
        name,
        author: settingsDraft.author.trim() || null,
        description: settingsDraft.description.trim() || null,
      })
      await refreshPack()
    } catch (error) {
      console.error('[PromptPackEditor] Failed to save pack settings:', error)
    }
    editingSettings = false
  }

  function discardSettings() {
    editingSettings = false
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header Bar -->
  <div class="border-b">
    <!-- Top row: back + pack name + hamburger -->
    <div class="flex items-center gap-2 px-4 py-1.5 sm:py-2">
      <Button
        variant="ghost"
        size="icon"
        class="text-muted-foreground hover:text-foreground -ml-2 h-8 w-8 shrink-0"
        onclick={handleBack}
      >
        <ChevronLeft class="h-4 w-4" />
      </Button>

      {#if loading}
        <Skeleton class="h-5 w-32" />
      {:else if fullPack}
        <h2 class="min-w-0 shrink truncate font-semibold">{fullPack.pack.name}</h2>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 shrink-0"
          disabled={importDefaultBusy || !!packError}
          title={importDefaultPackId === packId ? '恢复中文导入系统默认' : '设为中文导入默认'}
          aria-label={importDefaultPackId === packId ? '恢复中文导入系统默认' : '设为中文导入默认'}
          aria-pressed={importDefaultPackId === packId}
          onclick={setImportDefault}
        >
          <Star
            class="h-4 w-4 {importDefaultPackId === packId ? 'fill-amber-400 text-amber-600' : ''}"
          />
        </Button>
        {#if importDefaultPackId === packId}
          <Badge variant="outline" class="hidden shrink-0 text-xs sm:inline-flex"
            >中文导入默认</Badge
          >
        {/if}
        {#if collaborativeMode}
          <div class="text-muted-foreground hidden min-w-0 truncate text-[11px] sm:block">
            active pack · ID: <code>{fullPack.pack.id}</code> · 来源：故事绑定
          </div>
        {/if}
        {#if isEditorDirty}
          <Badge variant="outline" class="shrink-0 border-yellow-500/50 text-xs text-yellow-500"
            >未保存</Badge
          >
        {/if}
      {/if}

      <!-- Desktop: System/User tabs + action buttons in header row -->
      {#if selectedTemplateId && editorRef && !isMobile.current}
        <div class="ml-auto flex items-center gap-1">
          {#if editorHasUserContent}
            <ToggleGroup.Root
              type="single"
              value={editorActiveTab}
              onValueChange={(v) => {
                if (v) editorActiveTab = v as 'system' | 'user'
              }}
              variant="outline"
              size="sm"
              class="mr-1 gap-0"
            >
              <ToggleGroup.Item value="system" class="h-7 rounded-r-none px-2.5 text-xs"
                >系统</ToggleGroup.Item
              >
              <ToggleGroup.Item value="user" class="h-7 rounded-l-none px-2.5 text-xs"
                >用户</ToggleGroup.Item
              >
            </ToggleGroup.Root>
          {/if}

          <VariablePalette
            iconOnly
            customVariables={fullPack?.variables ?? []}
            onInsert={(name) => editorRef?.insertVariable(name)}
          />

          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            disabled={!isEditorDirty}
            onclick={() => editorRef?.save()}
            title="保存"
          >
            <Save class="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            disabled={!isEditorDirty}
            onclick={() => editorRef?.discard()}
            title="放弃"
          >
            <Undo2 class="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            onclick={() => editorRef?.reset()}
            title="恢复默认值"
          >
            <RotateCcw class="h-3.5 w-3.5" />
          </Button>
        </div>
      {:else if !isMobile.current}
        <div class="ml-auto"></div>
      {/if}

      {#if isMobile.current}
        <Button
          variant="outline"
          size="icon"
          class="ml-auto h-8 w-8 shrink-0"
          onclick={() => (drawerOpen = true)}
        >
          <Menu class="h-4 w-4" />
        </Button>
      {/if}
    </div>

    <!-- Bottom toolbar (mobile only) -->
    {#if selectedTemplateId && editorRef && isMobile.current}
      <!-- Mobile: full bottom toolbar (unchanged) -->
      <div class="border-t"></div>
      <div class="flex items-center gap-1 px-4 py-1.5">
        <ToggleGroup.Root
          type="single"
          value={mobileView}
          onValueChange={(v) => {
            if (v) mobileView = v as 'editor' | 'preview'
          }}
          variant="outline"
          size="sm"
          class="gap-0"
        >
          <ToggleGroup.Item value="editor" class="h-7 w-7 rounded-r-none" title="编辑器">
            <Pencil class="h-3.5 w-3.5" />
          </ToggleGroup.Item>
          <ToggleGroup.Item value="preview" class="h-7 w-7 rounded-l-none" title="预览">
            <Eye class="h-3.5 w-3.5" />
          </ToggleGroup.Item>
        </ToggleGroup.Root>

        {#if editorHasUserContent}
          <ToggleGroup.Root
            type="single"
            value={editorActiveTab}
            onValueChange={(v) => {
              if (v) editorActiveTab = v as 'system' | 'user'
            }}
            variant="outline"
            size="sm"
            class="gap-0"
          >
            <ToggleGroup.Item value="system" class="h-7 rounded-r-none px-2.5 text-xs"
              >系统</ToggleGroup.Item
            >
            <ToggleGroup.Item value="user" class="h-7 rounded-l-none px-2.5 text-xs"
              >用户</ToggleGroup.Item
            >
          </ToggleGroup.Root>
        {/if}

        <VariablePalette
          customVariables={fullPack?.variables ?? []}
          onInsert={(name) => editorRef?.insertVariable(name)}
        />

        <div class="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            disabled={!isEditorDirty}
            onclick={() => editorRef?.save()}
            title="保存"
          >
            <Save class="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            disabled={!isEditorDirty}
            onclick={() => editorRef?.discard()}
            title="放弃"
          >
            <Undo2 class="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            onclick={() => editorRef?.reset()}
            title="恢复默认值"
          >
            <RotateCcw class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Main Content -->
  {#if loading}
    <div class="flex flex-1 items-center justify-center">
      <div class="space-y-3 text-center">
        <Skeleton class="mx-auto h-6 w-48" />
        <Skeleton class="mx-auto h-4 w-32" />
      </div>
    </div>
  {:else if packError}
    <div class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-xl space-y-2 text-center">
        <h3 class="font-medium">无法打开中文写作提示词 Workspace</h3>
        <p class="text-muted-foreground text-sm">{packError}</p>
      </div>
    </div>
  {:else if fullPack}
    <div class="flex flex-1 overflow-hidden">
      <!-- Left Panel (desktop only) -->
      {#if !isMobile.current}
        <div class="w-64 shrink-0 overflow-hidden border-r">
          <TemplateGroupList
            {selectedTemplateId}
            {showVariables}
            {showRuntimeVars}
            {showSettings}
            onSelectTemplate={handleSelectTemplate}
            onToggleVariables={handleToggleVariables}
            onToggleRuntimeVars={handleToggleRuntimeVars}
            onShowSettings={handleShowSettings}
            {allowedTemplateIds}
            hidePackTools={collaborativeMode}
          />
        </div>
      {/if}

      <!-- Right Panel -->
      <div class="flex flex-1 overflow-hidden">
        {#if showVariables}
          <div class="flex-1 overflow-hidden">
            <VariableManager
              {packId}
              variables={fullPack?.variables ?? []}
              onVariablesChanged={refreshPack}
            />
          </div>
        {:else if showRuntimeVars}
          <div class="flex-1 overflow-hidden">
            <RuntimeVariableManager
              {packId}
              runtimeVariables={fullPack?.runtimeVariables ?? []}
              onVariablesChanged={refreshPack}
            />
          </div>
        {:else if selectedTemplateId}
          <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
            <PromptInspector
              {storyId}
              {storyContext}
              {packId}
              templateId={selectedTemplateId}
              dirty={isEditorDirty}
            />
            <div class="min-h-0 flex-1 overflow-hidden">
              <TemplateEditor
                bind:this={editorRef}
                {packId}
                templateId={selectedTemplateId}
                customVariables={fullPack.variables}
                activeTab={editorActiveTab}
                {mobileView}
                {testValues}
                hasCustomVariables={(fullPack?.variables.length ?? 0) > 0}
                onTestVarsOpen={() => (showTestVars = true)}
                onDirtyChange={handleDirtyChange}
                onActiveTabChange={(tab) => (editorActiveTab = tab)}
                onHasUserContent={(has) => (editorHasUserContent = has)}
              />
            </div>
          </div>
        {:else if collaborativeMode}
          <div class="flex flex-1 items-center justify-center p-6">
            <p class="text-muted-foreground text-sm">从左侧选择一个中文写作 Agent 模板。</p>
          </div>
        {:else}
          <!-- Pack Settings (default view) -->
          <div class="flex flex-1 flex-col overflow-y-auto p-6">
            <div class="mx-auto w-full max-w-2xl space-y-6">
              <!-- Header -->
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <Settings class="text-muted-foreground h-4 w-4" />
                  <h3 class="text-sm font-medium">提示词包设置</h3>
                </div>
                {#if !editingSettings && !fullPack.pack.isDefault}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 gap-1.5 text-xs"
                    onclick={startEditSettings}
                  >
                    <Pencil class="h-3.5 w-3.5" />
                    编辑
                  </Button>
                {/if}
              </div>

              {#if fullPack.pack.isDefault && classified}
                <div class="flex flex-col gap-3 rounded-lg border p-4">
                  <div class="flex flex-col gap-1">
                    <h4 class="text-sm font-medium">内置提示词</h4>
                    {#if editedCount === 0}
                      <p class="text-muted-foreground text-sm">
                        所有模板均与当前版本的内置提示词一致。
                      </p>
                    {:else}
                      <p class="text-muted-foreground text-sm">
                        {editedCount}
                        个模板包含你的修改，
                        {#if behindCount === 0}
                          当前应用没有这些模板的更新版本。
                        {:else}
                          其中 {behindCount} 个落后于新版内置文本。
                        {/if}
                      </p>
                      <p class="text-muted-foreground text-xs">
                        编辑过的模板不会自动接收内置更新，需要手动替换。
                      </p>
                    {/if}
                  </div>
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 gap-1.5 text-xs"
                      disabled={editedCount === 0}
                      onclick={() => (refreshDialogOpen = true)}
                    >
                      <RotateCcw class="h-3.5 w-3.5" />
                      使用内置提示词更新
                    </Button>
                  </div>
                </div>
              {/if}

              {#if editingSettings}
                <!-- Edit mode -->
                <div class="space-y-4">
                  <div class="space-y-1.5">
                    <Label for="pack-name">名称</Label>
                    <Input
                      id="pack-name"
                      bind:value={settingsDraft.name}
                      placeholder="提示词包名称"
                    />
                  </div>

                  <div class="space-y-1.5">
                    <Label for="pack-author">作者</Label>
                    <Input
                      id="pack-author"
                      bind:value={settingsDraft.author}
                      placeholder="作者姓名"
                    />
                  </div>

                  <div class="space-y-1.5">
                    <Label for="pack-desc">说明</Label>
                    <p class="text-muted-foreground text-xs">支持 Markdown 和 HTML</p>
                    <Textarea
                      id="pack-desc"
                      bind:value={settingsDraft.description}
                      rows={8}
                      placeholder="描述提示词包…"
                      class="font-mono text-sm"
                    />
                  </div>

                  <div class="flex gap-2">
                    <Button size="sm" onclick={saveSettings} disabled={!settingsDraft.name.trim()}>
                      <Check class="mr-1.5 h-3.5 w-3.5" />
                      保存
                    </Button>
                    <Button variant="ghost" size="sm" onclick={discardSettings}>
                      <X class="mr-1.5 h-3.5 w-3.5" />
                      取消
                    </Button>
                  </div>
                </div>
              {:else}
                <!-- Read-only display -->
                <div class="space-y-4">
                  <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <span class="text-muted-foreground">名称</span>
                    <span>{fullPack.pack.name}</span>
                    <span class="text-muted-foreground">作者</span>
                    <span>{fullPack.pack.author || '—'}</span>
                  </div>

                  {#if fullPack.pack.description}
                    <div class="border-t pt-4">
                      <div class="prose-content text-sm">
                        {@html renderDescription(fullPack.pack.description)}
                      </div>
                    </div>
                  {:else if !fullPack.pack.isDefault}
                    <div class="text-muted-foreground border-t pt-4 text-center text-sm">
                      暂无描述，点击编辑可添加。
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center">
      <p class="text-muted-foreground text-sm">未找到提示词包</p>
    </div>
  {/if}
</div>

<!-- Mobile Drawer for template navigation -->
{#if isMobile.current}
  <Drawer.Root bind:open={drawerOpen}>
    <Drawer.Content class="h-[70vh]">
      <Drawer.Header>
        <Drawer.Title>模板</Drawer.Title>
      </Drawer.Header>
      <div class="flex-1 overflow-hidden">
        <TemplateGroupList
          {selectedTemplateId}
          {showVariables}
          {showRuntimeVars}
          {showSettings}
          onSelectTemplate={handleSelectTemplate}
          onToggleVariables={handleToggleVariables}
          onToggleRuntimeVars={handleToggleRuntimeVars}
          onShowSettings={handleShowSettings}
          {allowedTemplateIds}
          hidePackTools={collaborativeMode}
        />
      </div>
    </Drawer.Content>
  </Drawer.Root>
{/if}

<!-- Test Variables modal -->
<TestVariablesModal
  open={showTestVars}
  customVariables={fullPack?.variables ?? []}
  {testValues}
  onOpenChange={(open) => (showTestVars = open)}
  onTestValuesChange={handleTestValuesChange}
/>

<RefreshTemplatesDialog
  open={refreshDialogOpen}
  packName={fullPack?.pack.name ?? ''}
  {classified}
  {refreshing}
  templates={fullPack?.templates ?? []}
  onConfirm={handleRefresh}
  onCancel={() => (refreshDialogOpen = false)}
/>

<!-- Dirty guard dialog -->
<Dialog.Root bind:open={showDirtyDialog}>
  <Dialog.Content class="gap-4 py-6 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>有未保存的修改</Dialog.Title>
      <Dialog.Description>当前有未保存的修改，请选择处理方式。</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex gap-2 sm:justify-end">
      <Button variant="outline" onclick={handleCancelSwitch}>取消</Button>
      <Button variant="secondary" onclick={handleDiscardAndSwitch}>放弃</Button>
      <Button onclick={handleSaveAndSwitch}>保存并继续</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
