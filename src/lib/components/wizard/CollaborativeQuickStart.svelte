<script lang="ts">
  import StorySetup from './StorySetup.svelte'
  let { onClose }: { onClose: () => void; onOpenFullSetup?: () => void } = $props()
</script>

<StorySetup {onClose} initialMode={'creative-writing'} isImport={false} />
