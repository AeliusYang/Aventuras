<script lang="ts">
  import { onDestroy } from 'svelte'
  import { createDebouncedSave } from '$lib/utils/debounce'
  import { settings } from '$lib/stores/settings.svelte'
  import { Cpu, AlertTriangle } from '@lucide/svelte'
  import { fetchModelsFromProvider } from '$lib/services/ai/sdk/providers'

  // Shadcn Components
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import GenerationParamsForm from './GenerationParamsForm.svelte'

  interface Props {
    onOpenManualBodyEditor: (title: string, value: string, onSave: (next: string) => void) => void
  }

  let { onOpenManualBodyEditor }: Props = $props()

  let isLoadingModels = $state(false)
  let modelError = $state<string | null>(null)

  // Debounced save for sliders
  const { trigger: debouncedSave, flush: flushSave } = createDebouncedSave(() =>
    settings.saveApiSettings(),
  )

  onDestroy(() => flushSave())

  async function handleSetMainNarrativeProfile(profileId: string | null) {
    if (!profileId) return
    const previousModel = settings.apiSettings.defaultModel
    await settings.setMainNarrativeProfile(profileId)
    await fetchModelsToProfile()

    const models = settings.getAvailableModels(profileId)
    if (!models.find((m) => m.id === previousModel)) {
      settings.setDefaultModel('')
    }
  }

  async function fetchModelsToProfile() {
    const profile = settings.getMainNarrativeProfile()
    if (!profile) return
    if (isLoadingModels) return

    isLoadingModels = true
    modelError = null

    try {
      const result = await fetchModelsFromProvider(
        profile.providerType,
        profile.baseUrl,
        profile.apiKey,
      )
      await settings.updateProfile(profile.id, {
        ...profile,
        fetchedModels: result,
      })
      console.log(`[MainNarrative] Fetched ${result.length} models from ${profile.providerType}`)
    } catch (error) {
      console.error('[MainNarrative] Failed to fetch models:', error)
      modelError = error instanceof Error ? error.message : 'Failed to load models.'
    } finally {
      isLoadingModels = false
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="flex items-center gap-2 text-base">
      <Cpu class="text-primary h-5 w-5" />
      冒险正文
    </Card.Title>
    <Card.Description
      >用于冒险模式；中文写作正文使用下方“中文写作：中文正文 Writer”绑定的 Agent Profile。</Card.Description
    >
  </Card.Header>

  <Card.Content class="grid gap-3 pt-4">
    {#if settings.apiSettings.profiles.length === 0}
      <div
        class="flex items-center gap-2 rounded border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
      >
        <AlertTriangle class="h-4 w-4 shrink-0" />
        尚未配置模型连接，请在“模型连接”页面添加。
      </div>
    {:else if !settings.apiSettings.defaultModel}
      <div
        class="text-muted-foreground bg-muted/50 flex items-center gap-2 rounded border border-dashed px-3 py-2 text-sm"
      >
        <AlertTriangle class="h-4 w-4 shrink-0" />
        尚未选择模型，请在下方选择或前往“模型连接”页面设置。
      </div>
    {/if}

    <GenerationParamsForm
      profileId={settings.apiSettings.mainNarrativeProfileId}
      model={settings.apiSettings.defaultModel}
      temperature={settings.apiSettings.temperature}
      maxTokens={settings.apiSettings.maxTokens}
      reasoningEffort={settings.apiSettings.reasoningEffort}
      onProfileChange={handleSetMainNarrativeProfile}
      onModelChange={(m) => {
        settings.setDefaultModel(m)
        debouncedSave()
      }}
      onTemperatureChange={(v) => {
        settings.apiSettings.temperature = v
        debouncedSave()
      }}
      onMaxTokensChange={(v) => {
        settings.apiSettings.maxTokens = v
        debouncedSave()
      }}
      onReasoningChange={(v) => {
        settings.apiSettings.reasoningEffort = v
        debouncedSave()
      }}
      onRefreshModels={fetchModelsToProfile}
      isRefreshingModels={isLoadingModels}
      isManualMode={settings.advancedRequestSettings.manualMode}
    />

    {#if modelError}
      <p class="text-destructive text-xs">{modelError}</p>
    {/if}

    <!-- Manual Request Body (unchanged) -->
    {#if settings.advancedRequestSettings.manualMode}
      <div class="mt-4 border-t pt-4">
        <div class="mb-2 flex items-center justify-between">
          <Label>自定义请求体（JSON）</Label>
          <Button
            variant="text"
            size="sm"
            class="h-auto p-0"
            onclick={() =>
              onOpenManualBodyEditor('Main Narrative', settings.apiSettings.manualBody, (next) => {
                settings.apiSettings.manualBody = next
                settings.setMainManualBody(next)
              })}
          >
            在独立窗口中打开
          </Button>
        </div>
        <Textarea
          bind:value={settings.apiSettings.manualBody}
          onblur={() => settings.setMainManualBody(settings.apiSettings.manualBody)}
          class="min-h-[100px] w-full font-mono"
          rows={4}
        />
        <p class="text-muted-foreground mt-1 text-xs">
          覆盖请求参数；消息与工具由 Aventuras 管理。
        </p>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
