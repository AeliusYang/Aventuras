<script lang="ts">
  import type { VaultCharacterInput } from '$lib/services/ai/sdk/schemas/vault'
  import { descriptorsToString, stringToDescriptors } from '$lib/utils/visualDescriptors'
  import { X, User, ImageUp, Loader2 } from '@lucide/svelte'
  import { normalizeImageDataUrl } from '$lib/utils/image'
  import TagInput from '$lib/components/tags/TagInput.svelte'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'

  import { untrack } from 'svelte'

  interface Props {
    data: VaultCharacterInput
    onUpdate: (data: VaultCharacterInput) => void
    changedFields?: Set<string>
  }

  let { data, onUpdate, changedFields }: Props = $props()

  const changed = (field: string) =>
    changedFields?.has(field)
      ? 'border-l-2 border-l-blue-400/50 bg-blue-500/5 pl-3 -ml-3 rounded-lg'
      : ''

  // Local state for complex string-to-object conversions
  let visualDescriptorsStr = $state(untrack(() => descriptorsToString(data.visualDescriptors)))
  let traitsStr = $state(untrack(() => data.traits.join(', ')))

  let uploadingPortrait = $state(false)
  let error = $state<string | null>(null)

  // True when the user has typed something that doesn't parse to any descriptor category
  let visualDescriptorsInvalid = $derived(
    visualDescriptorsStr.trim().length > 0 &&
      Object.keys(stringToDescriptors(visualDescriptorsStr)).length === 0,
  )

  // Sync internal editing state with incoming data if it changes externally,
  // but don't overwrite the user's in-progress input when the change came from handleInput itself.
  $effect(() => {
    const externalStr = descriptorsToString(data.visualDescriptors)
    const externalTraitsStr = data.traits.join(', ')
    untrack(() => {
      if (externalStr !== descriptorsToString(stringToDescriptors(visualDescriptorsStr))) {
        visualDescriptorsStr = externalStr
      }
      if (
        externalTraitsStr !==
        traitsStr
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .join(', ')
      ) {
        traitsStr = externalTraitsStr
      }
    })
  })

  function handleInput() {
    onUpdate({
      ...data,
      traits: traitsStr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      visualDescriptors: stringToDescriptors(visualDescriptorsStr),
    })
  }

  function handlePortraitUpload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      error = 'Please select an image file'
      return
    }

    uploadingPortrait = true
    error = null
    const reader = new FileReader()
    reader.onload = (e) => {
      onUpdate({
        ...data,
        portrait: e.target?.result as string,
      })
      uploadingPortrait = false
    }
    reader.onerror = () => {
      error = 'Failed to read image file'
      uploadingPortrait = false
    }
    reader.readAsDataURL(file)
    input.value = ''
  }

  function removePortrait() {
    onUpdate({
      ...data,
      portrait: null,
    })
  }
</script>

<div class="space-y-4 py-2">
  {#if error}
    <div
      class="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm"
    >
      {error}
    </div>
  {/if}

  <!-- Name -->
  <div class="space-y-2 {changed('name')}">
    <Label for="name">名称 *</Label>
    <Input
      id="name"
      type="text"
      bind:value={data.name}
      oninput={handleInput}
      placeholder="角色姓名"
    />
  </div>

  <!-- Description -->
  <div class="space-y-2 {changed('description')}">
    <Label for="description">说明</Label>
    <Textarea
      id="description"
      bind:value={() => data.description ?? '', (v) => (data.description = v || null)}
      oninput={handleInput}
      placeholder="简要描述角色"
      rows={3}
      class="resize-none"
    />
  </div>

  <!-- Traits -->
  <div class="space-y-2 {changed('traits')}">
    <Label for="traits">性格特征</Label>
    <Input
      id="traits"
      type="text"
      bind:value={traitsStr}
      oninput={handleInput}
      placeholder="勇敢, 好奇, 固执（用英文逗号分隔）"
    />
    <p class="text-muted-foreground text-[0.8rem]">性格特征，用英文逗号分隔</p>
  </div>

  <!-- Visual Descriptors -->
  <div class="space-y-2 {changed('visualDescriptors')}">
    <Label for="visualDescriptors">外貌描述</Label>
    <Input
      id="visualDescriptors"
      type="text"
      bind:value={visualDescriptorsStr}
      oninput={handleInput}
      placeholder="Face: oval, Hair: dark brown, Eyes: blue"
    />
    {#if visualDescriptorsInvalid}
      <p class="text-[0.8rem] text-amber-500">
        使用“类别: 内容”格式，例如 <span class="font-medium">Face: oval, Hair: dark</span>。类别包括
        Face（脸型）、Hair（头发）、Eyes（眼睛）、Build（体型）、Clothing（服装）、Accessories（配饰）、Distinguishing
        features（显著特征）。
      </p>
    {:else}
      <p class="text-muted-foreground text-[0.8rem]">用于生成肖像</p>
    {/if}
  </div>

  <!-- Portrait -->
  <div class="space-y-2">
    <Label>肖像</Label>
    <div class="flex items-start gap-4">
      {#if data.portrait}
        <div class="group relative">
          <img
            src={normalizeImageDataUrl(data.portrait) ?? ''}
            alt="肖像预览"
            class="ring-border h-20 w-20 rounded-md object-cover ring-1"
          />
          <button
            type="button"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90 absolute -top-2 -right-2 rounded-full p-1 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            onclick={removePortrait}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {:else}
        <div
          class="bg-muted ring-border flex h-20 w-20 items-center justify-center rounded-md ring-1"
        >
          <User class="text-muted-foreground h-8 w-8" />
        </div>
      {/if}

      <div class="flex-1">
        <Button
          variant="outline"
          class="relative w-full cursor-pointer"
          disabled={uploadingPortrait}
        >
          {#if uploadingPortrait}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {:else}
            <ImageUp class="mr-2 h-4 w-4" />
          {/if}
          上传图片
          <input
            type="file"
            accept="image/*"
            class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            onchange={handlePortraitUpload}
            disabled={uploadingPortrait}
          />
        </Button>
      </div>
    </div>
  </div>

  <!-- Tags -->
  <div class="space-y-2 {changed('tags')}">
    <Label for="tags">标签</Label>
    <TagInput
      value={data.tags}
      type="character"
      onChange={(newTags) => {
        data.tags = newTags
        handleInput()
      }}
      placeholder="添加标签…"
    />
    <p class="text-muted-foreground text-[0.8rem]">用于整理素材库</p>
  </div>
</div>
