<script lang="ts">
  import type { ProviderType, TextModel } from '$lib/types'
  import { PROVIDERS, hasDefaultEndpoint } from '$lib/services/ai/sdk/providers/config'
  import ProviderTypeSelector from './ProviderTypeSelector.svelte'
  import { isMobileDevice } from '$lib/utils/swipe'

  // Shadcn Components
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import { Switch } from '$lib/components/ui/switch'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { Alert, AlertDescription } from '$lib/components/ui/alert'
  import * as Dialog from '$lib/components/ui/dialog'
  import { isPingEligibleProvider } from '$lib/constants/modelHealth'
  import {
    AlertCircle,
    Box,
    ChevronRight,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    Star,
  } from '@lucide/svelte'
  import X from '@lucide/svelte/icons/x'

  interface Props {
    // Form fields (bindable)
    name: string
    providerType: ProviderType
    baseUrl: string
    apiKey: string
    fetchedModels: TextModel[]
    customModels: string[]
    hiddenModels: string[]
    favoriteModels: string[]
    pingEnabled: boolean

    // UI state (from parent)
    isFetchingModels: boolean
    fetchError: string | null

    // Callbacks
    onFetchModels: () => void
    onProviderTypeChange: (type: ProviderType) => void
    onRemoveFetchedModel: (model: string) => void
    onRemoveCustomModel: (model: string) => void
    onRestoreHiddenModel: (model: string) => void
    onToggleFavorite: (model: string) => void
    onAddCustomModel: (model: string) => void

    // Optional footer snippet (Svelte 5)
    footer?: import('svelte').Snippet
  }

  let {
    name = $bindable(),
    providerType = $bindable(),
    baseUrl = $bindable(),
    apiKey = $bindable(),
    fetchedModels = $bindable(),
    customModels = $bindable(),
    hiddenModels = $bindable(),
    favoriteModels = $bindable(),
    pingEnabled = $bindable(),
    isFetchingModels,
    fetchError,
    onFetchModels,
    onProviderTypeChange,
    onRemoveFetchedModel,
    onRemoveCustomModel,
    onRestoreHiddenModel,
    onToggleFavorite,
    onAddCustomModel,
    footer,
  }: Props = $props()

  // Local UI state
  let showHiddenModels = $state(false)
  let modelFilterInput = $state('')
  let showBaseUrlCollapsible = $state(false)
  let showCustomModelDialog = $state(false)
  let customModelDialogInput = $state('')
  let customModelDialogError = $state('')
  let visibleFetchedModels = $derived.by(() => {
    const seenIds: string[] = []
    return filterModels(
      fetchedModels.filter((model) => {
        if (hiddenModels.includes(model.id) || seenIds.includes(model.id)) return false
        seenIds.push(model.id)
        return true
      }),
    )
  })
  let visibleCustomModels = $derived.by(() => {
    const seenIds = fetchedModels.map((model) => model.id)
    return filterModels(
      customModels
        .map((id) => ({ id }))
        .filter((model) => {
          if (hiddenModels.includes(model.id) || seenIds.includes(model.id)) return false
          seenIds.push(model.id)
          return true
        }),
    )
  })

  function isSelfHostedUrl(url: string): boolean {
    if (!url) return false
    try {
      const u = new URL(url)
      const host = u.hostname
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host.startsWith('192.168.')
      )
    } catch {
      return false
    }
  }

  function sortedModels(models: TextModel[]): TextModel[] {
    const favSet = new Set(favoriteModels)
    const favs = models.filter((m) => favSet.has(m.id))
    const rest = models.filter((m) => !favSet.has(m.id))
    return [...favs, ...rest]
  }

  function filterModels(models: TextModel[], shownOnly: boolean = false): TextModel[] {
    if (!modelFilterInput.trim()) return models
    const search = modelFilterInput.toLowerCase()
    return models.filter(
      (m) => m.id.toLowerCase().includes(search) && (!shownOnly || !hiddenModels.includes(m.id)),
    )
  }

  function handleAddCustomModelFromDialog() {
    const model = customModelDialogInput.trim()
    if (!model) return
    if (customModels.includes(model) || fetchedModels.find((m) => m.id === model)) {
      customModelDialogError = `"${model}" is already in the list`
      return
    }
    customModelDialogError = ''
    onAddCustomModel(model)
    customModelDialogInput = ''
    showCustomModelDialog = false
  }

  // Reset local UI state when provider changes
  function handleProviderTypeChange(type: ProviderType) {
    showHiddenModels = false
    modelFilterInput = ''
    showBaseUrlCollapsible = false
    customModelDialogError = ''
    onProviderTypeChange(type)
  }

  let canPing = $derived(isPingEligibleProvider(providerType))
</script>

<div class="space-y-3">
  <!-- Profile Name -->
  <Input label="配置名称" placeholder="例如：OpenRouter、本地模型" bind:value={name} />

  <!-- Provider Type -->
  <ProviderTypeSelector value={providerType} onchange={handleProviderTypeChange} />

  <!-- Alert for providers without services -->
  {#if !PROVIDERS[providerType].services}
    <Alert class="border-yellow-500/50 bg-yellow-500/10">
      <AlertCircle class="h-4 w-4 text-yellow-500" />
      <AlertDescription class="text-xs">
        此服务商需要手动配置模型，请前往 <strong>生成设置</strong> 页面，为各项任务设置模型。
      </AlertDescription>
    </Alert>
  {/if}

  <!-- Base URL -->
  {#if providerType === 'openai-compatible'}
    <div class="space-y-2">
      <Label>
        API 地址 <span class="text-muted-foreground">（必填）</span>
      </Label>
      <Input
        placeholder="https://api.example.com/v1"
        bind:value={baseUrl}
        class="font-mono text-xs"
      />
    </div>
  {:else}
    <div class="space-y-1">
      <button
        class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
        onclick={() => (showBaseUrlCollapsible = !showBaseUrlCollapsible)}
      >
        <ChevronRight
          class="h-3 w-3 transition-transform {showBaseUrlCollapsible || baseUrl
            ? 'rotate-90'
            : ''}"
        />
        自定义 API 地址
        <span class="text-muted-foreground">（选填）</span>
      </button>
      {#if showBaseUrlCollapsible || baseUrl}
        <Input
          placeholder={PROVIDERS[providerType].baseUrl || 'https://api.example.com/v1'}
          bind:value={baseUrl}
          class="font-mono text-xs"
        />
        <p class="text-muted-foreground text-xs">留空则使用默认 API 地址。</p>
      {/if}
    </div>
  {/if}

  <!-- API Key -->
  <Input
    label={isSelfHostedUrl(baseUrl) ? 'API 密钥（选填）' : 'API 密钥'}
    type="password"
    placeholder="sk-..."
    bind:value={apiKey}
    class="font-mono text-xs"
  />

  <!-- Models Section -->
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <Label class="flex items-center gap-2">
        <Box class="h-4 w-4" />
        模型
      </Label>
      <div class="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            showCustomModelDialog = true
            customModelDialogInput = ''
          }}
        >
          <Plus class="h-3 w-3" />
          {isMobileDevice() ? '' : '自定义'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onclick={onFetchModels}
          disabled={isFetchingModels || (!baseUrl && !hasDefaultEndpoint(providerType))}
        >
          {#if isFetchingModels}
            <RefreshCw class="h-3 w-3 animate-spin" />
            正在获取…
          {:else}
            <RefreshCw class="h-3 w-3" />
            {isMobileDevice() ? '获取' : '获取模型'}
          {/if}
        </Button>
      </div>
    </div>

    {#if canPing}
      <div class="bg-muted/30 flex items-center gap-3 rounded-md border p-2">
        <Switch id="ping-enabled-{providerType}" bind:checked={pingEnabled} />
        <Label
          for="ping-enabled-{providerType}"
          class="cursor-pointer text-xs leading-snug font-normal"
          title="测试模型是否可用及其响应速度，在模型旁显示状态；所选模型不可用时阻止发送。每个模型每 30 分钟消耗一次 API 请求。"
        >
          <span class="font-medium">测试模型可用性</span>
          <span class="text-muted-foreground block">
            检测{providerType === 'openrouter' ? ' :free ' : ''}模型的延迟和状态。每个模型每 30
            分钟请求一次。
          </span>
        </Label>
      </div>
    {/if}

    {#if fetchError}
      <Alert variant="destructive">
        <AlertCircle class="h-4 w-4" />
        <AlertDescription class="text-xs">{fetchError}</AlertDescription>
      </Alert>
    {/if}

    <!-- Model filter (shown when there are enough models) -->
    {#if visibleFetchedModels.length + visibleCustomModels.length > 10}
      <Input
        placeholder="筛选模型…"
        bind:value={modelFilterInput}
        leftIcon={Search}
        class="text-xs"
      />
    {/if}

    <!-- Fetched Models -->
    {#if visibleFetchedModels.length > 0}
      <div class="space-y-1">
        <p class="text-muted-foreground text-xs font-medium">
          已获取的模型（{visibleFetchedModels.length})
        </p>
        <ScrollArea class="h-32 w-full rounded-md border">
          <div class="flex flex-wrap gap-1 p-2">
            {#each sortedModels(visibleFetchedModels) as model (model.id)}
              {@const isFav = favoriteModels.includes(model.id)}
              <Badge variant="secondary" class="gap-1 px-2">
                <button
                  class="p-0 transition-colors hover:text-yellow-500 {isFav
                    ? 'text-yellow-500'
                    : 'text-muted-foreground'}"
                  onclick={() => onToggleFavorite(model.id)}
                  title={isFav ? '取消收藏' : '加入收藏'}
                >
                  <Star class="h-3 w-3" fill={isFav ? 'currentColor' : 'none'} />
                </button>
                <span class="max-w-48 truncate">{model.id}</span>
                {#if !isFav}
                  <button
                    class="hover:text-destructive text-muted-foreground p-0 transition-colors"
                    onclick={() => onRemoveFetchedModel(model.id)}
                    title="隐藏模型"
                  >
                    <X class="h-3 w-3" />
                  </button>
                {/if}
              </Badge>
            {/each}
          </div>
        </ScrollArea>
      </div>
    {/if}

    <!-- Custom Models -->
    {#if visibleCustomModels.length > 0}
      <div class="space-y-1">
        <p class="text-muted-foreground text-xs font-medium">
          自定义模型（{visibleCustomModels.length})
        </p>
        <ScrollArea class="h-24 w-full rounded-md border">
          <div class="flex flex-wrap gap-1 p-2">
            {#each sortedModels(visibleCustomModels) as model (model.id)}
              {@const isFav = favoriteModels.includes(model.id)}
              <Badge variant="outline" class="gap-1 px-2">
                <button
                  class="p-0 transition-colors hover:text-yellow-500 {isFav
                    ? 'text-yellow-500'
                    : 'text-muted-foreground'}"
                  onclick={() => onToggleFavorite(model.id)}
                  title={isFav ? '取消收藏' : '加入收藏'}
                >
                  <Star class="h-3 w-3" fill={isFav ? 'currentColor' : 'none'} />
                </button>
                <span class="max-w-48 truncate">{model.id}</span>
                {#if !isFav}
                  <button
                    class="hover:text-destructive text-muted-foreground p-0 transition-colors"
                    onclick={() => onRemoveCustomModel(model.id)}
                    title="删除模型"
                  >
                    <X class="h-3 w-3" />
                  </button>
                {/if}
              </Badge>
            {/each}
          </div>
        </ScrollArea>
      </div>
    {/if}

    <!-- Hidden Models -->
    {#if hiddenModels.length > 0}
      <div class="space-y-1">
        <button
          class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
          onclick={() => (showHiddenModels = !showHiddenModels)}
        >
          <ChevronRight
            class="h-3 w-3 transition-transform {showHiddenModels ? 'rotate-90' : ''}"
          />
          已隐藏的模型（{hiddenModels.length})
        </button>
        {#if showHiddenModels}
          <ScrollArea class="h-24 w-full rounded-md border border-dashed">
            <div class="flex flex-wrap gap-1 p-2">
              {#each filterModels(hiddenModels.map((id) => ({ id }))) as model (model.id)}
                <Badge variant="outline" class="gap-1 px-2 opacity-60">
                  <span class="max-w-48 truncate">{model.id}</span>
                  <button
                    class="hover:text-primary text-muted-foreground p-0 transition-colors"
                    onclick={() => onRestoreHiddenModel(model.id)}
                    title="恢复模型"
                  >
                    <RotateCcw class="h-3 w-3" />
                  </button>
                </Badge>
              {/each}
            </div>
          </ScrollArea>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Footer snippet (Cancel/Save buttons, etc.) -->
  {#if footer}
    {@render footer()}
  {/if}
</div>

<!-- Custom Model Dialog -->
<Dialog.Root
  open={showCustomModelDialog}
  onOpenChange={(open) => {
    showCustomModelDialog = open
    if (!open) {
      customModelDialogError = ''
      customModelDialogInput = ''
    }
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>添加自定义模型</Dialog.Title>
      <Dialog.Description>输入模型标识，例如 provider/model-name</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2 py-4">
      <div class="flex gap-2">
        <Input
          placeholder="model-name 或 provider/model"
          bind:value={customModelDialogInput}
          class="flex-1"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddCustomModelFromDialog()
            }
          }}
        />
      </div>
      {#if customModelDialogError}
        <p class="text-destructive text-xs">{customModelDialogError}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (showCustomModelDialog = false)}>取消</Button>
      <Button onclick={handleAddCustomModelFromDialog} disabled={!customModelDialogInput.trim()}>
        添加
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
