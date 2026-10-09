<script lang="ts">
  import type {
    Entry,
    EntryType,
    EntryInjectionMode,
    EntryState,
    AdventureEntryState,
    CreativeEntryState,
  } from '$lib/types'
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { ChevronDown, ChevronUp, Plus, X } from '@lucide/svelte'

  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { Slider } from '$lib/components/ui/slider'
  import { Switch } from '$lib/components/ui/switch'
  import { Badge } from '$lib/components/ui/badge'
  import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select'
  import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group'
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from '$lib/components/ui/collapsible'
  import { cn } from '$lib/utils/cn'

  interface Props {
    entry?: Entry | null
    onSave: (entry: Entry) => void
    onCancel: () => void
  }

  let { entry = null, onSave, onCancel }: Props = $props()

  // Form state
  let name = $state('')
  let type = $state<EntryType>('character')
  let description = $state('')
  let hiddenInfo = $state('')
  let aliases = $state<string[]>([])
  let keywords = $state<string[]>([])
  let injectionMode = $state<EntryInjectionMode>('keyword')
  let priority = $state(50)
  let showHiddenInfo = $state(false)
  let loreManagementBlacklisted = $state(false)
  let loadedEntryId = $state<string | null | undefined>(undefined)

  $effect(() => {
    const nextId = entry?.id ?? null
    if (nextId === loadedEntryId) return
    loadedEntryId = nextId
    name = entry?.name ?? ''
    type = entry?.type ?? 'character'
    description = entry?.description ?? ''
    hiddenInfo = entry?.hiddenInfo ?? ''
    showHiddenInfo = !!entry?.hiddenInfo
    aliases = [...new Set(entry?.aliases ?? [])]
    keywords = [...new Set(entry?.injection.keywords ?? [])]
    injectionMode = entry?.injection.mode ?? 'keyword'
    priority = entry?.injection.priority ?? 50
    loreManagementBlacklisted = entry?.loreManagementBlacklisted ?? false
  })

  // Tag input states
  let newAlias = $state('')
  let newKeyword = $state('')

  let saving = $state(false)

  const entryTypes: Array<{ value: EntryType; label: string }> = [
    { value: 'character', label: '角色' },
    { value: 'location', label: '地点' },
    { value: 'item', label: '物品' },
    { value: 'faction', label: '阵营' },
    { value: 'concept', label: '概念' },
    { value: 'event', label: '事件' },
  ]

  const injectionModes: Array<{ value: EntryInjectionMode; label: string; description: string }> = [
    { value: 'always', label: '始终启用', description: '每次生成均包含' },
    { value: 'keyword', label: '自动', description: '按关键词或 AI 相关性匹配' },
    { value: 'never', label: '禁用', description: '不加入 AI 上下文' },
  ]

  function getDefaultState(entryType: EntryType): EntryState {
    switch (entryType) {
      case 'character':
        return {
          type: 'character',
          isPresent: false,
          lastSeenLocation: null,
          currentDisposition: null,
          relationship: { level: 0, status: 'unknown', history: [] },
          knownFacts: [],
          revealedSecrets: [],
        }
      case 'location':
        return {
          type: 'location',
          isCurrentLocation: false,
          visitCount: 0,
          changes: [],
          presentCharacters: [],
          presentItems: [],
        }
      case 'item':
        return {
          type: 'item',
          inInventory: false,
          currentLocation: null,
          condition: null,
          uses: [],
        }
      case 'faction':
        return {
          type: 'faction',
          playerStanding: 0,
          status: 'unknown',
          knownMembers: [],
        }
      case 'concept':
        return {
          type: 'concept',
          revealed: false,
          comprehensionLevel: 'unknown',
          relatedEntries: [],
        }
      case 'event':
        return {
          type: 'event',
          occurred: false,
          occurredAt: null,
          witnesses: [],
          consequences: [],
        }
    }
  }

  function getDefaultAdventureState(): AdventureEntryState {
    return { discovered: false, interactedWith: false, notes: [] }
  }

  function getDefaultCreativeState(): CreativeEntryState {
    return { arc: null, thematicRole: null, symbolism: null }
  }

  function addAlias() {
    const trimmed = newAlias.trim()
    if (trimmed && !aliases.includes(trimmed)) {
      aliases = [...aliases, trimmed]
    }
    newAlias = ''
  }

  function removeAlias(alias: string) {
    aliases = aliases.filter((a) => a !== alias)
  }

  function addKeyword() {
    const trimmed = newKeyword.trim()
    if (trimmed && !keywords.includes(trimmed)) {
      keywords = [...keywords, trimmed]
    }
    newKeyword = ''
  }

  function removeKeyword(keyword: string) {
    keywords = keywords.filter((k) => k !== keyword)
  }

  function handleAliasKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addAlias()
    }
  }

  function handleKeywordKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addKeyword()
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      ui.showToast('Name is required', 'error')
      return
    }

    saving = true

    try {
      const now = Date.now()
      const entryData: Entry = {
        id: entry?.id ?? crypto.randomUUID(),
        storyId: story.currentStory?.id ?? '',
        name: name.trim(),
        type,
        description: description.trim(),
        hiddenInfo: hiddenInfo.trim() || null,
        aliases,
        state: entry?.state?.type === type ? entry.state : getDefaultState(type),
        adventureState: entry?.adventureState ?? getDefaultAdventureState(),
        creativeState: entry?.creativeState ?? getDefaultCreativeState(),
        injection: {
          mode: injectionMode,
          keywords,
          priority,
        },
        createdBy: entry?.createdBy ?? 'user',
        createdAt: entry?.createdAt ?? now,
        updatedAt: now,
        loreManagementBlacklisted,
        branchId: entry?.branchId ?? story.currentStory?.currentBranchId ?? null,
      }

      onSave(entryData)
    } catch (err) {
      ui.showToast(err instanceof Error ? err.message : 'Failed to save entry', 'error')
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6">
  <!-- Name -->
  <div class="space-y-2">
    <Label for="entry-name">
      名称 <span class="text-red-500">*</span>
    </Label>
    <Input id="entry-name" type="text" bind:value={name} placeholder="条目名称" />
  </div>

  <!-- Type -->
  <div class="space-y-2">
    <Label for="entry-type">类型</Label>
    <Select type="single" value={type} onValueChange={(v) => (type = v as EntryType)}>
      <SelectTrigger id="entry-type">
        {entryTypes.find((t) => t.value === type)?.label ?? '选择类型'}
      </SelectTrigger>
      <SelectContent>
        {#each entryTypes as option ((option.value, option.label))}
          <SelectItem value={option.value}>{option.label}</SelectItem>
        {/each}
      </SelectContent>
    </Select>
  </div>

  <!-- Description -->
  <div class="space-y-2">
    <Label for="entry-description">说明</Label>
    <Textarea
      id="entry-description"
      bind:value={description}
      placeholder="描述此条目…"
      rows={4}
      class="resize-none"
    />
  </div>

  <!-- Aliases -->
  <div class="space-y-2">
    <Label>
      别名
      <span class="text-muted-foreground ml-1 text-xs font-normal"> 用于匹配的其他名称 </span>
    </Label>
    <div class="mb-2 flex flex-wrap gap-2">
      {#each aliases as alias (alias)}
        <Badge variant="secondary" class="gap-1 pr-1">
          {alias}
          <button class="hover:bg-muted rounded-full p-0.5" onclick={() => removeAlias(alias)}>
            <X class="h-3 w-3" />
          </button>
        </Badge>
      {/each}
    </div>
    <div class="flex gap-2">
      <Input
        type="text"
        bind:value={newAlias}
        placeholder="添加别名…"
        class="flex-1"
        onkeydown={handleAliasKeydown}
      />
      <Button variant="outline" size="icon" onclick={addAlias} disabled={!newAlias.trim()}>
        <Plus class="h-4 w-4" />
      </Button>
    </div>
  </div>

  <!-- Keywords -->
  <div class="space-y-2">
    <Label>
      关键词
      <span class="text-muted-foreground ml-1 text-xs font-normal"> 触发上下文注入的词语 </span>
    </Label>
    <div class="mb-2 flex flex-wrap gap-2">
      {#each keywords as keyword (keyword)}
        <Badge
          variant="default"
          class="bg-primary/20 text-primary hover:bg-primary/30 gap-1 border-transparent pr-1"
        >
          {keyword}
          <button
            class="hover:bg-primary/20 text-primary rounded-full p-0.5"
            onclick={() => removeKeyword(keyword)}
          >
            <X class="h-3 w-3" />
          </button>
        </Badge>
      {/each}
    </div>
    <div class="flex gap-2">
      <Input
        type="text"
        bind:value={newKeyword}
        placeholder="添加关键词…"
        class="flex-1"
        onkeydown={handleKeywordKeydown}
      />
      <Button variant="outline" size="icon" onclick={addKeyword} disabled={!newKeyword.trim()}>
        <Plus class="h-4 w-4" />
      </Button>
    </div>
  </div>

  <!-- Context Inclusion Mode -->
  <div class="space-y-3">
    <Label>上下文注入</Label>
    <RadioGroup
      value={injectionMode}
      onValueChange={(v) => (injectionMode = v as EntryInjectionMode)}
      class="grid h-full grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {#each injectionModes as mode ((mode.value, mode.label))}
        <div
          class={cn(
            'hover:bg-muted/50 flex h-full cursor-pointer items-start space-x-2 rounded-lg border transition-colors',
            injectionMode === mode.value && 'border-primary bg-primary/5',
          )}
        >
          <Label
            for={`mode-${mode.value}`}
            class="flex w-full cursor-pointer flex-col gap-1 font-normal"
          >
            <div class="flex flex-row items-center gap-3 p-3">
              <RadioGroupItem value={mode.value} id={`mode-${mode.value}`} class="mt-1" />
              <div class="flex flex-col">
                <span class="text-sm font-medium">{mode.label}</span>
                <span class="text-muted-foreground text-xs">{mode.description}</span>
              </div>
            </div>
          </Label>
        </div>
      {/each}
    </RadioGroup>

    {#if injectionMode === 'keyword'}
      <p class="text-muted-foreground mt-2 text-xs">
        关键词或别名与故事匹配，或 AI 判断条目与当前场景相关时，将其加入上下文。
      </p>
    {/if}
  </div>

  <!-- Priority -->
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <Label>
        优先级
        <span class="text-muted-foreground ml-1 text-xs font-normal">
          优先加入优先级更高的条目
        </span>
      </Label>
      <span class="w-8 text-right text-sm font-medium">{priority}</span>
    </div>
    <Slider
      value={priority}
      min={0}
      max={100}
      step={1}
      type="single"
      onValueChange={(val) => (priority = val)}
    />
  </div>

  <!-- Lore Management Blacklist -->
  <div class="bg-muted/30 flex items-center justify-between rounded-lg border p-3">
    <div class="space-y-0.5">
      <Label class="text-base">排除在 AI 世界书管理之外</Label>
      <p class="text-muted-foreground text-xs">开启后，AI 世界书管理不会读取或修改此条目</p>
    </div>
    <Switch bind:checked={loreManagementBlacklisted} />
  </div>

  <!-- Hidden Info (collapsible) -->
  <Collapsible bind:open={showHiddenInfo}>
    <CollapsibleTrigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          class="flex w-full justify-between px-0 hover:bg-transparent"
        >
          <span class="flex items-center gap-2 text-sm font-medium">
            隐藏信息
            <span class="text-muted-foreground text-xs font-normal">（主角尚不知道的秘密）</span>
          </span>
          {#if showHiddenInfo}
            <ChevronUp class="text-muted-foreground h-4 w-4" />
          {:else}
            <ChevronDown class="text-muted-foreground h-4 w-4" />
          {/if}
        </Button>
      {/snippet}
    </CollapsibleTrigger>
    <CollapsibleContent>
      <Textarea
        bind:value={hiddenInfo}
        placeholder="隐藏信息、已揭露的秘密等…"
        rows={3}
        class="mt-2 resize-none"
      />
    </CollapsibleContent>
  </Collapsible>

  <!-- Actions -->
  <div class="mt-4 flex gap-2 border-t pt-4">
    <Button variant="outline" class="flex-1" onclick={onCancel} disabled={saving}>取消</Button>
    <Button class="flex-1" onclick={handleSave} disabled={saving || !name.trim()}>
      {saving ? '正在保存…' : entry ? '保存修改' : '创建条目'}
    </Button>
  </div>
</div>
