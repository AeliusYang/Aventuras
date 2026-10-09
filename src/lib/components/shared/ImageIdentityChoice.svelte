<script lang="ts">
  import type { ImageIdentityConflict } from '$lib/services/image/generationContext'
  let {
    conflict,
    onselect,
  }: { conflict: ImageIdentityConflict | null; onselect: (name: string, id: string) => void } =
    $props()
</script>

{#if conflict}
  <div class="my-2 space-y-2 rounded border p-2 text-xs">
    <p>{conflict.message}</p>
    {#each conflict.candidates as candidate}
      <button
        class="block w-full rounded border p-2 text-left"
        onclick={() => onselect(conflict!.characterName, candidate.id)}
      >
        <strong>{candidate.name}</strong>
        <span class="text-muted-foreground ml-2">{candidate.id}</span>
        <span class="mt-1 line-clamp-3 block whitespace-pre-wrap">{candidate.description}</span>
      </button>
    {/each}
  </div>
{/if}
