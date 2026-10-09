<script lang="ts">
  import { settings, type ProviderPreset } from '$lib/stores/settings.svelte'
  import {
    Check,
    ExternalLink,
    ArrowLeft,
    Server,
    Zap,
    Globe,
    Palette,
    Type,
    Languages,
    ArrowRight,
  } from '@lucide/svelte'
  import { fade, blur, slide } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import { getSupportedLanguages } from '$lib/services/ai/utils/TranslationService'
  import { THEMES } from '../../../themes/themes'
  import type { FontSizeOption } from '$lib/types'

  import * as Card from '$lib/components/ui/card'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import * as Select from '$lib/components/ui/select'

  interface Props {
    onComplete: () => void
  }

  let { onComplete }: Props = $props()

  const fontSizes: { value: FontSizeOption; label: string }[] = [
    { value: 'small', label: '小' },
    { value: 'medium', label: '中' },
    { value: 'large', label: '大' },
    { value: 'xlarge', label: '特大' },
    { value: 'xxlarge', label: '超大' },
  ]

  // State
  let step = $state<'interface' | 'select' | 'configure'>('interface')
  let selectedProvider = $state<ProviderPreset | null>(null)
  let apiKey = $state('')
  let showApiKey = $state(false)
  let isSubmitting = $state(false)
  let error = $state<string | null>(null)

  // Provider info
  const providers = [
    {
      id: 'openrouter' as ProviderPreset,
      name: 'OpenRouter',
      description: '通过一个 API 使用多种模型。',
      icon: Globe,
      signupUrl: 'https://openrouter.ai/keys',
      keyPrefix: 'sk-or-',
      requiresKey: true,
      color: 'border-blue-500/20 hover:border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10',
      iconColor: 'text-blue-500',
    },
    {
      id: 'nanogpt' as ProviderPreset,
      name: 'NanoGPT',
      description: '提供 DeepSeek 等模型的 API 服务。',
      icon: Zap,
      signupUrl: 'https://nano-gpt.com/api',
      keyPrefix: 'sk-nano-',
      requiresKey: true,
      note: '自动识别推理模型',
      color:
        'border-yellow-500/20 hover:border-yellow-500/50 bg-yellow-500/5 hover:bg-yellow-500/10',
      iconColor: 'text-yellow-500',
    },
    {
      id: 'openai-compatible' as ProviderPreset,
      name: '自定义／本地服务',
      description: '配置兼容 OpenAI 接口的模型服务。',
      icon: Server,
      signupUrl: '',
      keyPrefix: '',
      requiresKey: false,
      note: '稍后可在设置中填写 API 地址。',
      color:
        'border-purple-500/20 hover:border-purple-500/50 bg-purple-500/5 hover:bg-purple-500/10',
      iconColor: 'text-purple-500',
    },
  ]

  function selectProvider(id: ProviderPreset) {
    selectedProvider = id
    error = null
    apiKey = ''
    step = 'configure'
  }

  function goBack() {
    if (step === 'configure') {
      step = 'select'
    } else if (step === 'select') {
      step = 'interface'
    }
    error = null
  }

  function goToSelect() {
    step = 'select'
  }

  function getSelectedProviderInfo() {
    return providers.find((p) => p.id === selectedProvider)
  }

  async function handleSubmit() {
    const providerInfo = getSelectedProviderInfo()
    if (!providerInfo) return

    if (providerInfo.requiresKey && !apiKey.trim()) {
      error = '请输入 API 密钥'
      return
    }

    isSubmitting = true
    error = null

    try {
      await settings.initializeWithProvider(selectedProvider!, apiKey.trim())
      onComplete()
    } catch (e) {
      console.error('Failed to initialize with provider:', e)
      error = e instanceof Error ? e.message : '初始化失败，请重试。'
    } finally {
      isSubmitting = false
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && apiKey.trim()) {
      handleSubmit()
    }
  }
</script>

<div
  class="welcome-screen bg-background fixed inset-0 z-50 flex h-full w-full flex-col items-center justify-center overflow-x-hidden overflow-y-auto p-4 text-center"
  out:fade={{ duration: 300 }}
>
  <div class="mb-8 space-y-2">
    <h1 class="text-foreground text-4xl font-bold tracking-tight">欢迎使用 Aventuras</h1>
    <p class="text-muted-foreground text-lg">
      {#if step === 'interface'}
        设置你的阅读环境
      {:else if step === 'select'}
        选择模型服务商，开始创作
      {:else}
        {@const p = getSelectedProviderInfo()}
        配置 {p?.name ?? 'Provider'}
      {/if}
    </p>
  </div>

  <div class="flex w-full max-w-2xl justify-center">
    {#if step === 'interface'}
      <div
        class="w-full max-w-md"
        in:blur={{ amount: 10, duration: 400, easing: quintOut, delay: 100 }}
        out:blur={{ amount: 10, duration: 200, easing: quintOut }}
      >
        <Card.Root class="bg-card/95 border-border w-full text-left shadow-2xl backdrop-blur-sm">
          <Card.Content class="space-y-6 p-6">
            <!-- Theme -->
            <div class="space-y-3">
              <Label class="flex items-center gap-2 text-base">
                <Palette size={18} class="text-primary" />
                主题
              </Label>
              <Select.Root
                type="single"
                value={settings.uiSettings.theme}
                onValueChange={(v) => settings.setTheme(v)}
              >
                <Select.Trigger class="w-full">
                  {THEMES.find((t) => t.id === settings.uiSettings.theme)?.label ??
                    'Select a theme'}
                </Select.Trigger>
                <Select.Content>
                  {#each THEMES as theme (theme.id)}
                    <Select.Item value={theme.id}>{theme.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>

            <!-- Font Size -->
            <div class="space-y-3">
              <Label class="flex items-center gap-2 text-base">
                <Type size={18} class="text-primary" />
                字号
              </Label>
              <div class="grid grid-cols-5 gap-1.5">
                {#each fontSizes as option (option.value)}
                  <Button
                    variant={settings.uiSettings.fontSize === option.value ? 'default' : 'outline'}
                    class="w-full px-1 text-xs"
                    onclick={() => settings.setFontSize(option.value)}
                  >
                    {option.label}
                  </Button>
                {/each}
              </div>
            </div>

            <!-- Translation -->
            <div class="border-border space-y-4 border-t pt-4">
              <div class="flex items-center justify-between">
                <Label class="flex items-center gap-2 text-base">
                  <Languages size={18} class="text-primary" />
                  内容翻译
                </Label>
                <Switch
                  checked={settings.translationSettings.enabled}
                  onCheckedChange={(v) => settings.updateTranslationSettings({ enabled: v })}
                />
              </div>

              {#if settings.translationSettings.enabled}
                <div
                  class="bg-muted/50 space-y-4 rounded-xl p-4"
                  transition:slide={{ duration: 200, axis: 'y' }}
                >
                  <div class="space-y-2">
                    <Label for="lang-select" class="text-sm">目标语言</Label>
                    <Select.Root
                      type="single"
                      value={settings.translationSettings.targetLanguage}
                      onValueChange={(v) =>
                        settings.updateTranslationSettings({
                          targetLanguage: v,
                        })}
                    >
                      <Select.Trigger id="lang-select" class="w-full">
                        {getSupportedLanguages().find(
                          (l) => l.code === settings.translationSettings.targetLanguage,
                        )?.name ?? 'Select language'}
                      </Select.Trigger>
                      <Select.Content class="max-h-[200px] overflow-y-auto">
                        {#each getSupportedLanguages() as lang (lang.code)}
                          <Select.Item value={lang.code}>{lang.name}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>

                  <div class="flex items-center justify-between pt-2">
                    <Label class="text-muted-foreground text-sm font-normal">翻译我的输入</Label>
                    <Switch
                      checked={settings.translationSettings.translateUserInput}
                      onCheckedChange={(v) =>
                        settings.updateTranslationSettings({
                          translateUserInput: v,
                        })}
                    />
                  </div>

                  <div class="flex items-center justify-between">
                    <Label class="text-muted-foreground text-sm font-normal">翻译世界状态</Label>
                    <Switch
                      checked={settings.translationSettings.translateWorldState}
                      onCheckedChange={(v) =>
                        settings.updateTranslationSettings({
                          translateWorldState: v,
                        })}
                    />
                  </div>
                </div>
              {/if}
            </div>
          </Card.Content>
          <Card.Footer>
            <Button class="w-full" size="lg" onclick={goToSelect}>
              下一步 <ArrowRight class="ml-2 h-4 w-4" />
            </Button>
          </Card.Footer>
        </Card.Root>
      </div>
    {:else if step === 'select'}
      <div
        class="w-full"
        in:blur={{ amount: 10, duration: 400, easing: quintOut, delay: 100 }}
        out:blur={{ amount: 10, duration: 200, easing: quintOut }}
      >
        <div class="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
          {#each providers as provider (provider.id)}
            <button
              onclick={() => selectProvider(provider.id)}
              class="group flex flex-col items-center gap-4 rounded-xl border p-6 text-center transition-all duration-200 hover:-translate-y-1 hover:shadow-lg {provider.color} bg-card text-card-foreground"
            >
              <div
                class="bg-muted ring-background group-hover:bg-background rounded-full p-4 ring-1 transition-colors"
              >
                <provider.icon size={32} class={provider.iconColor} />
              </div>
              <div class="space-y-1">
                <h3 class="text-foreground font-semibold">{provider.name}</h3>
                <p class="text-muted-foreground text-xs leading-relaxed">
                  {provider.description}
                </p>
              </div>
            </button>
          {/each}
        </div>

        <div class="mt-8 flex justify-center">
          <Button
            variant="ghost"
            onclick={() => (step = 'interface')}
            class="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={16} class="mr-2" /> 返回阅读设置
          </Button>
        </div>
      </div>
    {:else}
      <!-- Configure Step -->
      {@const provider = getSelectedProviderInfo()}
      {#if provider}
        <div
          class="w-full max-w-md"
          in:blur={{ amount: 10, duration: 400, easing: quintOut, delay: 100 }}
          out:blur={{ amount: 10, duration: 200, easing: quintOut }}
        >
          <Card.Root class="bg-card/95 border-border w-full shadow-2xl backdrop-blur-sm">
            <Card.Header>
              <div class="flex items-center gap-4">
                <Button variant="ghost" size="icon" onclick={goBack} title="返回">
                  <ArrowLeft size={20} />
                </Button>
                <div class="flex items-center gap-3">
                  <provider.icon size={24} class={provider.iconColor} />
                  <Card.Title>配置</Card.Title>
                </div>
              </div>
            </Card.Header>
            <Card.Content class="space-y-4 text-left">
              {#if provider.requiresKey}
                <div class="space-y-2">
                  <div class="flex items-center justify-between">
                    <Label for="api-key">API 密钥</Label>
                    {#if provider.signupUrl}
                      <a
                        href={provider.signupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-primary flex items-center gap-1 text-xs hover:underline"
                      >
                        获取密钥 <ExternalLink size={10} />
                      </a>
                    {/if}
                  </div>
                  <div class="relative">
                    <Input
                      id="api-key"
                      type={showApiKey ? 'text' : 'password'}
                      placeholder={provider.keyPrefix
                        ? `${provider.keyPrefix}...`
                        : '输入 API 密钥'}
                      bind:value={apiKey}
                      onkeydown={handleKeyDown}
                      autofocus
                    />
                  </div>
                </div>
              {:else}
                <p class="text-muted-foreground text-sm">
                  {provider.description}
                </p>
              {/if}

              {#if provider.note}
                <div class="bg-muted text-muted-foreground rounded-lg p-3 text-xs">
                  <span class="text-primary font-semibold">提示：</span>
                  {provider.note}
                </div>
              {/if}

              {#if error}
                <div
                  class="bg-destructive/10 text-destructive border-destructive/20 rounded-lg border p-3 text-sm"
                >
                  {error}
                </div>
              {/if}

              <Button
                class="w-full"
                size="lg"
                onclick={handleSubmit}
                disabled={(provider.requiresKey && !apiKey.trim()) || isSubmitting}
              >
                {#if isSubmitting}
                  <div
                    class="border-primary-foreground/30 border-t-primary-foreground mr-2 h-4 w-4 animate-spin rounded-full border-2"
                  ></div>
                  正在配置…
                {:else}
                  <Check class="mr-2 h-4 w-4" />
                  开始使用
                {/if}
              </Button>
            </Card.Content>
          </Card.Root>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .welcome-screen {
    padding-top: max(var(--safe-top), 1rem);
    padding-bottom: max(var(--safe-bottom), 1rem);
  }
</style>
