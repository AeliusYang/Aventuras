<script lang="ts">
  import StorySetup from './StorySetup.svelte'
  let {
    onClose,
    initialMode = 'adventure',
  }: { onClose: () => void; initialMode?: import('$lib/types').StoryMode } = $props()
</script>

<StorySetup {onClose} {initialMode} isImport={false} />
