<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { AlertTriangle, Settings } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'

  let hasIssues = $derived(settings.hasGenerationConfigIssues)
  let healthReason = $derived(settings.modelHealthBlockReason)

  // If profiles are structurally invalid → send to API tab to fix profiles.
  // Otherwise (valid profiles, but missing model) → send to Generation tab.
  let isProfileInvalid = $derived(settings.hasInvalidProfiles())

  let ctaLabel = $derived(
    healthReason
      ? healthReason === 'auth'
        ? '检查 API 密钥'
        : '更换模型'
      : isProfileInvalid
        ? '检查模型连接'
        : '配置模型',
  )
  let message = $derived(
    healthReason === 'auth'
      ? '认证失败，请检查 API 密钥或选择其他模型。'
      : healthReason === 'down'
        ? '所选模型暂不可用，请更换模型或等待恢复。'
        : isProfileInvalid
          ? '部分模型连接需要重新配置，完成后才能使用 AI 功能。'
          : '部分 AI 任务尚未配置模型，完成配置后才能生成故事。',
  )

  function handleFix() {
    if (healthReason || isProfileInvalid) {
      ui.openSettingsToApiTab()
    } else {
      ui.openSettingsToGenerationTab()
    }
  }
</script>

{#if hasIssues}
  <div
    class="flex items-center justify-between gap-3 bg-amber-500/90 px-4 py-2 text-amber-950 shadow-md"
  >
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <AlertTriangle class="h-5 w-5 shrink-0" />
      <p class="truncate text-sm font-medium">{message}</p>
    </div>
    <Button
      variant="secondary"
      size="sm"
      class="shrink-0 bg-amber-950 text-amber-100 hover:bg-amber-900 hover:text-amber-50"
      onclick={handleFix}
    >
      <Settings class="h-4 w-4" />
      <span class="hidden sm:inline">{ctaLabel}</span>
      <span class="sm:hidden">配置</span>
    </Button>
  </div>
{/if}
