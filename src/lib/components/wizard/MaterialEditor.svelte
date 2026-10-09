<script lang="ts">
  import type { SelectedMaterial } from '$lib/services/storySetup/draft'
  import type { Character } from '$lib/types'
  import type { ImportedEntry } from '$lib/services/lorebookImportExport/types'
  import { Button } from '$lib/components/ui/button'
  import { ImageStore } from '$lib/stores/wizard/imageStore.svelte'
  import { hasRequiredCredentials } from '$lib/services/ai/image'
  let {
    characters = $bindable([]),
    lore = $bindable([]),
    showCharacters = true,
    showLore = true,
    packId,
  }: {
    characters?: SelectedMaterial<Partial<Character>>[]
    lore?: SelectedMaterial<ImportedEntry>[]
    showCharacters?: boolean
    showLore?: boolean
    packId?: string
  } = $props()
  const image = new ImageStore(() => packId)
  async function portrait(item: SelectedMaterial<Partial<Character>>, event?: Event) {
    const name = item.value.name ?? ''
    const before = JSON.stringify([item.value, packId])
    if (event) await image.handleSupportingCharacterPortraitUpload(event, name)
    else
      await image.generateSupportingCharacterPortrait(name, [
        {
          name,
          description: item.value.description ?? '',
          traits: item.value.traits ?? [],
          role: '配角',
          relationship: item.value.relationship ?? '',
        },
      ])
    if (before === JSON.stringify([item.value, packId]) && image.supportingCharacterPortraits[name])
      item.value.portrait = image.supportingCharacterPortraits[name]
  }
</script>

{#if showCharacters}
  {#each characters as item (item.key)}
    <div class="space-y-2 rounded border p-3">
      <label class="flex items-center gap-2"
        ><input type="checkbox" bind:checked={item.selected} />导入此角色</label
      >
      <label class="block text-sm"
        >角色姓名<input
          class="bg-background mt-1 w-full rounded border p-2"
          bind:value={item.value.name}
        /></label
      >
      <label class="block text-sm"
        >人物资料<textarea
          class="bg-background mt-1 w-full rounded border p-2"
          rows="3"
          bind:value={item.value.description}></textarea></label
      >
      {#if packId}
        <details>
          <summary class="cursor-pointer text-sm">肖像（可选）</summary>
          <label class="block text-sm"
            >上传肖像<input
              type="file"
              accept="image/*"
              onchange={(e) => portrait(item, e)}
            /></label
          >
          {#if item.value.portrait}<img
              src={item.value.portrait}
              alt="配角肖像"
              class="h-24 w-24 rounded object-cover"
            /><Button size="sm" variant="ghost" onclick={() => (item.value.portrait = null)}
              >移除肖像</Button
            >{/if}
          <label class="block text-sm"
            >外貌描述<input
              class="bg-background mt-1 w-full rounded border p-2"
              bind:value={image.supportingCharacterVisualDescriptors[item.value.name ?? '']}
            /></label
          >
          <Button
            size="sm"
            variant="outline"
            disabled={!hasRequiredCredentials('portrait') ||
              !item.value.name?.trim() ||
              !image.supportingCharacterVisualDescriptors[item.value.name]?.trim() ||
              !!image.generatingPortraitName}
            onclick={() => portrait(item)}>生成配角肖像</Button
          >
          {#if image.portraitError}<p class="text-destructive text-sm">
              {image.portraitError}
            </p>{/if}
        </details>
      {/if}
    </div>
  {/each}
{/if}
{#if showLore}
  {#each lore as item (item.key)}
    <details class="rounded border p-3">
      <summary class="cursor-pointer"
        >{item.value.name || '未命名条目'} · {item.selected ? '将导入' : '已排除'}</summary
      >
      <div class="mt-2 space-y-2">
        <label class="flex items-center gap-2"
          ><input type="checkbox" bind:checked={item.selected} />导入此条目</label
        >
        <label class="block text-sm"
          >条目名称<input
            class="bg-background mt-1 w-full rounded border p-2"
            bind:value={item.value.name}
          /></label
        >
        <label class="block text-sm"
          >内容<textarea
            class="bg-background mt-1 w-full rounded border p-2"
            rows="5"
            bind:value={item.value.description}></textarea></label
        >
      </div>
    </details>
  {/each}
{/if}
