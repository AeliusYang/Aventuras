<script lang="ts">
  import { Users, Map, BookOpen, Loader2, AlertCircle, Check, RefreshCw } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import * as Alert from '$lib/components/ui/alert'
  import { Switch } from '$lib/components/ui/switch'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { CharacterCardImport } from '$lib/services/characterCardImport'

  interface Props {
    cardParsedData: CharacterCardImport.ParsedCard | null
    cardPortrait: string | null
    sanitizedDescription: string | null
    hasEmbeddedLorebook: boolean
    embeddedLorebookEntryCount: number
    importCharacters: boolean
    importScenario: boolean
    importLorebook: boolean
    isProcessingCard: boolean
    cardImportResult: CharacterCardImport.CardImportResult | null
    cardProcessError: string | null
    onImportCharactersChange: (v: boolean) => void
    onImportScenarioChange: (v: boolean) => void
    onImportLorebookChange: (v: boolean) => void
    onProcessCard: () => void
  }

  let {
    cardParsedData,
    cardPortrait,
    sanitizedDescription,
    hasEmbeddedLorebook,
    embeddedLorebookEntryCount,
    importCharacters,
    importScenario,
    importLorebook,
    isProcessingCard,
    cardImportResult,
    cardProcessError,
    onImportCharactersChange,
    onImportScenarioChange,
    onImportLorebookChange,
    onProcessCard,
  }: Props = $props()

  // Auto-trigger processing when entering this step with a card and no result yet
  $effect(() => {
    if (cardParsedData && !cardImportResult && !isProcessingCard && !cardProcessError) {
      onProcessCard()
    }
  })
</script>

<div class="space-y-5">
  <div class="flex items-center justify-between">
    <p class="text-muted-foreground">
      选择要导入的内容，来源： <strong>{cardParsedData?.name}</strong> ，并检查提取结果。
    </p>
    {#if !isProcessingCard}
      <Button variant="outline" size="sm" class="shrink-0 gap-1.5" onclick={onProcessCard}>
        <RefreshCw class="h-3 w-3" />
        重新处理
      </Button>
    {/if}
  </div>

  {#if isProcessingCard}
    <Card.Root>
      <Card.Content class="flex items-center gap-3 p-6">
        <Loader2 class="text-primary h-5 w-5 animate-spin" />
        <div>
          <p class="text-sm font-medium">正在处理角色卡…</p>
          <p class="text-muted-foreground text-xs">使用 AI 提取角色、世界设定和场景信息。</p>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Import Toggles with Previews -->
    <div class="space-y-3">
      <!-- Characters -->
      <Card.Root
        class="transition-colors {importCharacters
          ? 'border-primary/30 bg-primary/5'
          : 'opacity-60'}"
      >
        <Card.Content class="p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-8 w-8 items-center justify-center rounded-lg {importCharacters
                  ? 'bg-primary/20'
                  : 'bg-muted'}"
              >
                <Users
                  class="h-4 w-4 {importCharacters ? 'text-primary' : 'text-muted-foreground'}"
                />
              </div>
              <div>
                <p class="text-sm font-medium">角色（作为配角导入）</p>
                <p class="text-muted-foreground text-xs">
                  {#if cardImportResult}
                    {cardImportResult.primaryCharacterName}
                    {#if cardImportResult.npcs.length > 0}
                      + {cardImportResult.npcs.length} 名提取的 NPC
                    {/if}
                  {:else}
                    角色卡主体与提取的 NPC
                  {/if}
                </p>
              </div>
            </div>
            <Switch
              checked={importCharacters}
              onCheckedChange={(v) => onImportCharactersChange(v)}
            />
          </div>

          <!-- Character Preview -->
          {#if importCharacters && cardImportResult}
            <div class="border-border mt-3 space-y-2 border-t pt-3">
              <!-- Primary card character -->
              <div class="flex items-center gap-3">
                {#if cardPortrait}
                  <img
                    src={cardPortrait}
                    alt={cardImportResult.primaryCharacterName}
                    class="h-10 w-10 rounded-lg object-cover"
                  />
                {:else}
                  <div class="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
                    <Users class="text-muted-foreground h-4 w-4" />
                  </div>
                {/if}
                <div>
                  <p class="text-sm font-medium">{cardImportResult.primaryCharacterName}</p>
                  <p class="text-muted-foreground text-xs">
                    {sanitizedDescription
                      ? sanitizedDescription.slice(0, 100) +
                        (sanitizedDescription.length > 100 ? '...' : '')
                      : '角色卡主体'}
                  </p>
                </div>
              </div>
              <!-- Extracted NPCs -->
              {#if cardImportResult.npcs.length > 0}
                <div class="text-muted-foreground ml-12 text-xs">
                  <span class="font-medium">提取的 NPC：</span>
                  <ul class="mt-1 ml-4 list-disc space-y-0.5">
                    {#each cardImportResult.npcs as npc (npc.name)}
                      <li>{npc.name}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}
        </Card.Content>
      </Card.Root>

      <!-- Scenario -->
      <Card.Root
        class="transition-colors {importScenario ? 'border-primary/30 bg-primary/5' : 'opacity-60'}"
      >
        <Card.Content class="p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-8 w-8 items-center justify-center rounded-lg {importScenario
                  ? 'bg-primary/20'
                  : 'bg-muted'}"
              >
                <Map class="h-4 w-4 {importScenario ? 'text-primary' : 'text-muted-foreground'}" />
              </div>
              <div>
                <p class="text-sm font-medium">场景与设定</p>
                <p class="text-muted-foreground text-xs">世界设定与场景描述</p>
              </div>
            </div>
            <Switch checked={importScenario} onCheckedChange={(v) => onImportScenarioChange(v)} />
          </div>

          <!-- Scenario Preview -->
          {#if importScenario && cardImportResult?.settingSeed}
            <div class="border-border mt-3 border-t pt-3">
              <p class="text-muted-foreground text-xs">
                {cardImportResult.settingSeed.slice(0, 200)}{cardImportResult.settingSeed.length >
                200
                  ? '...'
                  : ''}
              </p>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>

      <!-- Lorebook -->
      <Card.Root
        class="transition-colors {importLorebook && hasEmbeddedLorebook
          ? 'border-primary/30 bg-primary/5'
          : 'opacity-60'}"
      >
        <Card.Content class="p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-8 w-8 items-center justify-center rounded-lg {importLorebook &&
                hasEmbeddedLorebook
                  ? 'bg-primary/20'
                  : 'bg-muted'}"
              >
                <BookOpen
                  class="h-4 w-4 {importLorebook && hasEmbeddedLorebook
                    ? 'text-primary'
                    : 'text-muted-foreground'}"
                />
              </div>
              <div>
                <p class="text-sm font-medium">
                  内嵌世界书
                  {#if !hasEmbeddedLorebook}
                    <Badge variant="outline" class="ml-1 text-xs">不可用</Badge>
                  {/if}
                </p>
                <p class="text-muted-foreground text-xs">
                  {#if hasEmbeddedLorebook}
                    {embeddedLorebookEntryCount} 设定 {embeddedLorebookEntryCount === 1
                      ? '条目'
                      : '条目'} 内嵌于角色卡世界书
                  {:else}
                    此角色卡没有内嵌世界书
                  {/if}
                </p>
              </div>
            </div>
            <Switch
              checked={importLorebook && hasEmbeddedLorebook}
              disabled={!hasEmbeddedLorebook}
              onCheckedChange={(v) => onImportLorebookChange(v)}
            />
          </div>
        </Card.Content>
      </Card.Root>
    </div>

    {#if cardImportResult}
      <div class="flex items-center gap-2 text-sm text-green-400">
        <Check class="h-4 w-4" />
        角色卡处理完成，详情如上。
      </div>
    {/if}
  {/if}

  {#if cardProcessError}
    <Alert.Root variant="destructive">
      <AlertCircle class="h-4 w-4" />
      <Alert.Description>{cardProcessError}</Alert.Description>
    </Alert.Root>
  {/if}
</div>
