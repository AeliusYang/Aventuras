<script lang="ts">
  import { User, Users, Edit3, Trash2, Archive, Check } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Label } from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import VaultCharacterFormFields from '$lib/components/vault/VaultCharacterFormFields.svelte'
  import UniversalVaultBrowser from '$lib/components/vault/UniversalVaultBrowser.svelte'
  import { characterVault } from '$lib/stores/characterVault.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { GeneratedProtagonist, GeneratedCharacter } from '$lib/services/ai/sdk'
  import type { VaultCharacterInput } from '$lib/services/ai/sdk/schemas/vault'
  import type { VaultCharacter } from '$lib/types'

  interface Props {
    protagonist: GeneratedProtagonist | null
    protagonistPortrait: string | null
    manualCharacterName: string
    manualCharacterDescription: string
    manualCharacterBackground: string
    manualCharacterMotivation: string
    manualCharacterTraits: string
    showManualInput: boolean
    showVaultPicker: boolean
    supportingCharacters: GeneratedCharacter[]
    cardCharacterName: string
    characterPortraits: Map<string, string>
    onManualNameChange: (v: string) => void
    onManualDescriptionChange: (v: string) => void
    onManualBackgroundChange: (v: string) => void
    onManualMotivationChange: (v: string) => void
    onManualTraitsChange: (v: string) => void
    onUseManualCharacter: () => void
    onUpdateProtagonist: (protagonist: GeneratedProtagonist, portrait: string | null) => void
    onSelectFromVault: (character: VaultCharacter) => void
    onToggleVaultPicker: (v: boolean) => void
    onDeleteSupportingCharacter: (i: number) => void
    onUpdateSupportingCharacter: (i: number, char: GeneratedCharacter) => void
    onUpdateCharacterPortrait: (name: string, portrait: string | null) => void
  }

  let {
    protagonist,
    protagonistPortrait,
    manualCharacterName,
    manualCharacterDescription,
    manualCharacterBackground,
    manualCharacterMotivation,
    manualCharacterTraits,
    showManualInput,
    showVaultPicker,
    supportingCharacters,
    cardCharacterName,
    characterPortraits,
    onManualNameChange,
    onManualDescriptionChange,
    onManualBackgroundChange,
    onManualMotivationChange,
    onManualTraitsChange,
    onUseManualCharacter,
    onUpdateProtagonist,
    onSelectFromVault,
    onToggleVaultPicker,
    onDeleteSupportingCharacter,
    onUpdateSupportingCharacter,
    onUpdateCharacterPortrait,
  }: Props = $props()

  // Edit modal state - supports both protagonist and supporting characters
  let editingIndex = $state<number | null>(null)
  let editingProtagonist = $state(false)
  let editFormData = $state<VaultCharacterInput>({
    name: '',
    description: null,
    traits: [],
    visualDescriptors: {},
    portrait: null,
    tags: [],
  })
  // Store role/relationship separately since VaultCharacterInput doesn't have them
  let editRole = $state('')
  let editRelationship = $state('')
  // Protagonist-specific fields
  let editBackground = $state('')
  let editMotivation = $state('')
  // Track which characters were saved to vault
  let savedToVault = $state<Set<number>>(new Set())

  function startEditProtagonist() {
    if (!protagonist) return
    editingProtagonist = true
    editFormData = {
      name: protagonist.name,
      description: protagonist.description || null,
      traits: protagonist.traits || [],
      visualDescriptors: {},
      portrait: protagonistPortrait ?? null,
      tags: [],
    }
    editBackground = protagonist.background || ''
    editMotivation = protagonist.motivation || ''
  }

  function startEdit(index: number) {
    const char = supportingCharacters[index]
    editingIndex = index
    editFormData = {
      name: char.name,
      description: char.description || null,
      traits: char.traits || [],
      visualDescriptors: {},
      portrait: characterPortraits.get(char.name) ?? null,
      tags: [],
    }
    editRole = char.role || ''
    editRelationship = char.relationship || ''
  }

  function closeEdit() {
    editingIndex = null
    editingProtagonist = false
  }

  function saveEdit() {
    if (!editFormData.name.trim()) return

    if (editingProtagonist) {
      const newName = editFormData.name.trim()
      onUpdateProtagonist(
        {
          name: newName,
          description: editFormData.description?.trim() || '',
          background: editBackground.trim(),
          motivation: editMotivation.trim(),
          traits: editFormData.traits,
        },
        editFormData.portrait ?? null,
      )
      editingProtagonist = false
      return
    }

    if (editingIndex === null) return
    const oldName = supportingCharacters[editingIndex].name
    const newName = editFormData.name.trim()
    onUpdateSupportingCharacter(editingIndex, {
      name: newName,
      role: editRole.trim(),
      description: editFormData.description?.trim() || '',
      relationship: editRelationship.trim(),
      traits: editFormData.traits,
    })

    // If name changed, remove old portrait entry to avoid orphaning it
    if (oldName !== newName && characterPortraits.has(oldName)) {
      onUpdateCharacterPortrait(oldName, null)
    }
    // Persist portrait change for the new name
    onUpdateCharacterPortrait(newName, editFormData.portrait ?? null)
    editingIndex = null
  }

  async function saveCharToVault(index: number) {
    const char = supportingCharacters[index]
    try {
      if (!characterVault.isLoaded) await characterVault.load()
      await characterVault.add({
        name: char.name,
        description: char.description || null,
        traits: char.traits || [],
        visualDescriptors: { distinguishing: char.description || '' },
        portrait: characterPortraits.get(char.name) ?? null,
        tags: ['imported'],
        favorite: false,
        source: 'import',
        originalStoryId: null,
        metadata: {
          role: char.role || null,
          relationship: char.relationship || null,
        },
      })
      savedToVault.add(index)
      ui.showToast(`${char.name} saved to vault`, 'info')
    } catch (error) {
      console.error('Failed to save character to vault:', error)
      ui.showToast('Failed to save to vault', 'error')
    }
  }
</script>

<div class="space-y-5">
  <p class="text-muted-foreground">设定你的主角，并检查从角色卡导入的配角。</p>

  <!-- Protagonist Section -->
  <div class="space-y-3">
    <h4 class="flex items-center gap-2 text-sm font-medium">
      <User class="h-4 w-4" />
      主角
      <Badge variant="secondary" class="text-xs">必填</Badge>
    </h4>

    {#if protagonist && !showManualInput}
      <!-- Protagonist Card Display -->
      <Card.Root class="border-primary/20">
        <Card.Content class="p-4">
          <div class="flex items-start gap-3">
            {#if protagonistPortrait}
              <img
                src={protagonistPortrait}
                alt={protagonist.name}
                class="h-16 w-16 shrink-0 rounded-lg object-cover"
              />
            {/if}
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex items-center justify-between">
                <h5 class="font-medium">{protagonist.name}</h5>
                <Button variant="ghost" size="sm" onclick={startEditProtagonist}>
                  <Edit3 class="mr-1 h-3 w-3" />
                  编辑
                </Button>
              </div>
              <p class="text-muted-foreground text-sm">{protagonist.description}</p>
              {#if protagonist.traits.length > 0}
                <div class="mt-2 flex flex-wrap gap-1">
                  {#each protagonist.traits as trait (trait)}
                    <Badge variant="outline" class="text-xs">{trait}</Badge>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </Card.Content>
      </Card.Root>
    {:else if showVaultPicker}
      <!-- Vault Browser -->
      <Card.Root>
        <Card.Content class="p-4">
          <div class="mb-3 flex items-center justify-between">
            <p class="text-sm font-medium">从素材库选择</p>
            <Button variant="ghost" size="sm" onclick={() => onToggleVaultPicker(false)}>
              返回手动填写
            </Button>
          </div>
          <UniversalVaultBrowser type="character" onSelect={(c) => onSelectFromVault(c)} />
        </Card.Content>
      </Card.Root>
    {:else}
      <!-- Manual Input -->
      <Card.Root>
        <Card.Content class="space-y-3 p-4">
          <div class="flex items-center justify-between">
            <p class="text-muted-foreground text-xs">填写主角信息，或从素材库选择角色。</p>
            <Button
              variant="outline"
              size="sm"
              class="gap-1"
              onclick={() => onToggleVaultPicker(true)}
            >
              <Archive class="h-3 w-3" />
              来自素材库
            </Button>
          </div>
          <div>
            <Label for="protagonist-name">名称</Label>
            <Input
              id="protagonist-name"
              placeholder="角色姓名"
              value={manualCharacterName}
              oninput={(e) => onManualNameChange(e.currentTarget.value)}
            />
          </div>
          <div>
            <Label for="protagonist-desc">说明</Label>
            <Textarea
              id="protagonist-desc"
              placeholder="角色简述"
              value={manualCharacterDescription}
              oninput={(e) => onManualDescriptionChange(e.currentTarget.value)}
              rows={2}
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <Label for="protagonist-bg">背景</Label>
              <Input
                id="protagonist-bg"
                placeholder="角色背景"
                value={manualCharacterBackground}
                oninput={(e) => onManualBackgroundChange(e.currentTarget.value)}
              />
            </div>
            <div>
              <Label for="protagonist-motiv">动机</Label>
              <Input
                id="protagonist-motiv"
                placeholder="角色动机"
                value={manualCharacterMotivation}
                oninput={(e) => onManualMotivationChange(e.currentTarget.value)}
              />
            </div>
          </div>
          <div>
            <Label for="protagonist-traits">性格特征（用英文逗号分隔）</Label>
            <Input
              id="protagonist-traits"
              placeholder="勇敢, 好奇, 机敏"
              value={manualCharacterTraits}
              oninput={(e) => onManualTraitsChange(e.currentTarget.value)}
            />
          </div>
          <Button
            variant="default"
            size="sm"
            onclick={onUseManualCharacter}
            disabled={!manualCharacterName.trim()}
          >
            确认主角
          </Button>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>

  <!-- Supporting Cast Section -->
  {#if supportingCharacters.length > 0}
    <div class="space-y-3">
      <h4 class="flex items-center gap-2 text-sm font-medium">
        <Users class="h-4 w-4" />
        配角生成
        <Badge variant="outline" class="text-xs">{supportingCharacters.length}</Badge>
      </h4>

      <div class="space-y-2">
        {#each supportingCharacters as char, i (i)}
          <Card.Root class="group hover:border-primary/30 transition-all">
            <Card.Content class="p-3">
              <div class="flex items-start justify-between">
                <div class="flex min-w-0 flex-1 items-start gap-3">
                  {#if characterPortraits.has(char.name)}
                    <img
                      src={characterPortraits.get(char.name)}
                      alt={char.name}
                      class="h-10 w-10 shrink-0 rounded-lg object-cover"
                    />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <p class="text-sm font-medium">{char.name}</p>
                      {#if char.role}
                        <Badge variant="secondary" class="text-xs">{char.role}</Badge>
                      {/if}
                      {#if char.name === cardCharacterName}
                        <Badge variant="outline" class="text-xs">来自角色卡</Badge>
                      {/if}
                    </div>
                    <p class="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                      {char.description}
                    </p>
                    {#if char.relationship}
                      <p class="text-muted-foreground/70 mt-0.5 text-[10px] italic">
                        {char.relationship}
                      </p>
                    {/if}
                  </div>
                </div>
                <div
                  class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    class="text-muted-foreground hover:text-foreground h-7 w-7"
                    onclick={() => startEdit(i)}
                    title="编辑"
                  >
                    <Edit3 class="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 {savedToVault.has(i)
                      ? 'text-green-500 hover:text-green-600'
                      : 'text-muted-foreground hover:text-foreground'}"
                    onclick={() => saveCharToVault(i)}
                    disabled={savedToVault.has(i)}
                    title={savedToVault.has(i) ? '已保存到素材库' : '保存到素材库'}
                  >
                    {#if savedToVault.has(i)}
                      <Check class="h-3 w-3" />
                    {:else}
                      <Archive class="h-3 w-3" />
                    {/if}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="text-muted-foreground hover:text-destructive h-7 w-7"
                    onclick={() => onDeleteSupportingCharacter(i)}
                    title="删除"
                  >
                    <Trash2 class="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    </div>
  {/if}
</div>

<!-- Edit Character Modal -->
{#if editingIndex !== null || editingProtagonist}
  <ResponsiveModal.Root
    open={true}
    onOpenChange={(open) => {
      if (!open) closeEdit()
    }}
  >
    <ResponsiveModal.Content class="flex flex-col md:h-auto md:max-h-[90vh] md:max-w-150">
      <ResponsiveModal.Header title={editingProtagonist ? '编辑主角' : '编辑角色'} />

      <div class="flex-1 overflow-y-auto px-4 sm:pr-4">
        <form
          id="edit-char-form"
          onsubmit={(e) => {
            e.preventDefault()
            saveEdit()
          }}
        >
          {#if editingProtagonist}
            <!-- Protagonist-specific fields -->
            <div class="mb-4 grid grid-cols-2 gap-3">
              <div>
                <Label for="edit-background">背景</Label>
                <Input
                  id="edit-background"
                  value={editBackground}
                  oninput={(e) => (editBackground = e.currentTarget.value)}
                  placeholder="角色背景"
                />
              </div>
              <div>
                <Label for="edit-motivation">动机</Label>
                <Input
                  id="edit-motivation"
                  value={editMotivation}
                  oninput={(e) => (editMotivation = e.currentTarget.value)}
                  placeholder="角色动机"
                />
              </div>
            </div>
          {:else}
            <!-- Supporting character fields -->
            <div class="mb-4 grid grid-cols-2 gap-3">
              <div>
                <Label for="edit-role">角色定位</Label>
                <Input
                  id="edit-role"
                  value={editRole}
                  oninput={(e) => (editRole = e.currentTarget.value)}
                  placeholder="例如：盟友、导师、对手…"
                />
              </div>
              <div>
                <Label for="edit-relationship">关系</Label>
                <Input
                  id="edit-relationship"
                  value={editRelationship}
                  oninput={(e) => (editRelationship = e.currentTarget.value)}
                  placeholder="与主角的关系"
                />
              </div>
            </div>
          {/if}
          <VaultCharacterFormFields
            data={editFormData}
            onUpdate={(newData) => (editFormData = newData)}
          />
        </form>
      </div>

      <ResponsiveModal.Footer>
        <Button
          type="submit"
          form="edit-char-form"
          disabled={!editFormData.name.trim()}
          class="w-full"
        >
          保存修改
        </Button>
      </ResponsiveModal.Footer>
    </ResponsiveModal.Content>
  </ResponsiveModal.Root>
{/if}
