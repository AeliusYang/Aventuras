<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, STORY_WIDTH_OPTIONS } from '$lib/stores/settings.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { database } from '$lib/services/database'
  import { grammarService } from '$lib/services/grammar'
  import { THEMES } from '../../../../themes/themes'
  import { Switch } from '$lib/components/ui/switch'
  import { Slider } from '$lib/components/ui/slider'
  import { Label } from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Badge } from '$lib/components/ui/badge'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import ColorPicker from '$lib/components/shared/ColorPicker.svelte'
  import { Separator } from '$lib/components/ui/separator'
  import { getSupportedLanguages } from '$lib/services/ai/utils/TranslationService'
  import { updaterService, UpdateError } from '$lib/services/updater'
  import {
    UPSTREAM_UPDATES_ENABLED,
    LOCAL_RELEASE_UPDATE_NOTICE,
  } from '$lib/constants/localRelease'
  import { updateNotifier } from '$lib/stores/updateNotifier.svelte'
  import { isAndroid } from '$lib/utils/platform'
  import { RefreshCw, Loader2, Languages, Plus, X, Trash2 } from '@lucide/svelte'

  const showIncognitoKeyboard = isAndroid()

  /**
   * What the swatch and the preview should show. An empty stored colour means "the
   * theme's accent", so resolve it from CSS rather than showing an empty swatch.
   * Reading `theme` keeps this in step with a theme switch.
   */
  const effectiveDialogueColor = $derived.by(() => {
    const stored = settings.uiSettings.dialogueColor
    if (stored) return stored
    void settings.uiSettings.theme
    if (typeof document === 'undefined') return '#888888'
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-accent')
      .trim()
    return accent || '#888888'
  })

  const storyWidthIndex = $derived(
    Math.max(
      0,
      STORY_WIDTH_OPTIONS.findIndex((o) => o.key === settings.uiSettings.storyMaxWidth),
    ),
  )

  let isCheckingUpdates = $state(false)
  let updateMessage = $state<string | null>(null)
  let customDictionaryWords = $state<string[]>([])
  let customDictionaryInput = $state('')
  let loadingCustomDictionary = $state(false)
  let customDictionaryBusy = $state(false)

  onMount(() => {
    void loadCustomDictionary()
  })

  async function loadCustomDictionary() {
    loadingCustomDictionary = true
    try {
      customDictionaryWords = await grammarService.getCustomWords()
    } catch (error) {
      console.error('[Interface] Failed to load custom dictionary:', error)
      ui.showToast('Failed to load custom dictionary', 'error')
    } finally {
      loadingCustomDictionary = false
    }
  }

  async function handleAddCustomWord() {
    const input = customDictionaryInput
    if (!input.trim()) return

    customDictionaryBusy = true
    try {
      const result = await grammarService.addWord(input)
      if (result === 'added') {
        customDictionaryInput = ''
        customDictionaryWords = await grammarService.getCustomWords()
        ui.showToast('Word added to custom dictionary', 'info')
        return
      }

      if (result === 'exists') {
        ui.showToast('Word is already in your custom dictionary', 'warning')
        return
      }

      ui.showToast('Only single words can be added to the dictionary', 'warning')
    } catch (error) {
      console.error('[Interface] Failed to add custom dictionary word:', error)
      ui.showToast('Failed to add word to dictionary', 'error')
    } finally {
      customDictionaryBusy = false
    }
  }

  function handleCustomDictionaryInputKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void handleAddCustomWord()
  }

  async function handleRemoveCustomWord(word: string) {
    customDictionaryBusy = true
    try {
      const result = await grammarService.removeWord(word)
      if (result === 'removed') {
        customDictionaryWords = await grammarService.getCustomWords()
        return
      }

      if (result === 'not_found') {
        customDictionaryWords = await grammarService.getCustomWords()
        ui.showToast('Word not found in custom dictionary', 'warning')
        return
      }

      ui.showToast('Invalid dictionary word', 'warning')
    } catch (error) {
      console.error('[Interface] Failed to remove custom dictionary word:', error)
      ui.showToast('Failed to remove word from dictionary', 'error')
    } finally {
      customDictionaryBusy = false
    }
  }

  async function handleClearCustomDictionary() {
    if (customDictionaryWords.length === 0) return
    const confirmed = confirm('Clear all custom dictionary words? This cannot be undone.')
    if (!confirmed) return

    customDictionaryBusy = true
    try {
      await grammarService.clearCustomWords()
      customDictionaryWords = []
      ui.showToast('Custom dictionary cleared', 'info')
    } catch (error) {
      console.error('[Interface] Failed to clear custom dictionary:', error)
      ui.showToast('Failed to clear custom dictionary', 'error')
    } finally {
      customDictionaryBusy = false
    }
  }

  async function handleCheckForUpdates() {
    if (!UPSTREAM_UPDATES_ENABLED) return
    isCheckingUpdates = true
    updateMessage = null
    try {
      const info = await updaterService.checkForUpdates()
      await settings.setLastChecked(Date.now())
      if (info.available) {
        // Hand off to the dialog, which is the only place that can actually act on it.
        updateNotifier.show(info)
        updateMessage = null
      } else {
        updateMessage = "You're up to date!"
      }
    } catch (error) {
      // Report the reason rather than a flat "failed": "no published release" and
      // "cannot reach the server" call for completely different responses from the user.
      updateMessage = error instanceof UpdateError ? error.message : 'Failed to check for updates.'
      console.error('[Interface] Update check failed:', error)
    } finally {
      isCheckingUpdates = false
    }
  }

  import type { FontSizeOption } from '$lib/types'

  const fontSizes = [
    { value: 'small', label: '小' },
    { value: 'medium', label: '中' },
    { value: 'large', label: '大' },
    { value: 'xlarge', label: '特大' },
    { value: 'xxlarge', label: '超大' },
  ] as const
</script>

<div class="space-y-4">
  <!-- Theme Selection -->
  <div>
    <Label class="mb-2 block">主题</Label>
    <Select.Root
      type="single"
      value={settings.uiSettings.theme}
      onValueChange={(v) => settings.setTheme(v)}
    >
      <Select.Trigger class="h-10 w-full">
        {THEMES.find((t) => t.id === settings.uiSettings.theme)?.label ?? '选择主题'}
      </Select.Trigger>
      <Select.Content>
        {#each THEMES as theme (theme.id)}
          <Select.Item value={theme.id} label={theme.label}>
            {theme.label}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <p class="text-muted-foreground mt-1 text-xs">
      {THEMES.find((t) => t.id === settings.uiSettings.theme)?.description ?? ''}
    </p>
  </div>

  <!-- Font Size -->
  <div>
    <Label class="mb-2 block">字号</Label>
    <Select.Root
      type="single"
      value={settings.uiSettings.fontSize}
      onValueChange={(v) => settings.setFontSize(v as FontSizeOption)}
    >
      <Select.Trigger class="h-10 w-full">
        {fontSizes.find((s) => s.value === settings.uiSettings.fontSize)?.label ?? '选择尺寸'}
      </Select.Trigger>
      <Select.Content>
        {#each fontSizes as size (size.value)}
          <Select.Item value={size.value} label={size.label}>
            {size.label}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <!-- Story Content Width -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <Label>正文宽度</Label>
      <span class="text-muted-foreground text-sm">
        {STORY_WIDTH_OPTIONS[storyWidthIndex]?.label ?? '默认'}
      </span>
    </div>
    <p class="text-muted-foreground text-xs">故事区域的最大宽度，同时影响正文和内嵌图片</p>
    <Slider
      type="single"
      min={0}
      max={STORY_WIDTH_OPTIONS.length - 1}
      step={1}
      value={storyWidthIndex}
      onValueChange={(idx) => settings.setStoryMaxWidth(STORY_WIDTH_OPTIONS[idx].key)}
    />
    <div class="text-muted-foreground flex justify-between text-xs">
      <span>{STORY_WIDTH_OPTIONS[0].label}</span>
      <span>{STORY_WIDTH_OPTIONS[STORY_WIDTH_OPTIONS.length - 1].label}</span>
    </div>
  </div>

  <!-- Word Count Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>正文字符统计</Label>
      <p class="text-muted-foreground text-xs">在状态栏显示当前故事的正文字符数</p>
    </div>
    <Switch
      checked={settings.uiSettings.showWordCount}
      onCheckedChange={(v) => {
        settings.uiSettings.showWordCount = v
        database.setSetting('show_word_count', v.toString())
      }}
    />
  </div>

  <!-- Dialogue Highlighting -->
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <div>
        <Label>对白高亮</Label>
        <p class="text-muted-foreground text-xs">
          为正文中引号内的对白着色。使用可视化正文样式的故事不受影响。
        </p>
      </div>
      <Switch
        checked={settings.uiSettings.highlightDialogue}
        onCheckedChange={(v) => settings.setHighlightDialogue(v)}
      />
    </div>

    {#if settings.uiSettings.highlightDialogue}
      <div class="flex items-center justify-between gap-3 pl-1">
        <div>
          <Label class="text-sm">对白颜色</Label>
          <p class="text-muted-foreground text-xs">
            {settings.uiSettings.dialogueColor ? '自定义颜色' : '使用当前主题的强调色'}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          {#if settings.uiSettings.dialogueColor}
            <Button variant="ghost" size="sm" onclick={() => settings.setDialogueColor('')}>
              使用主题强调色
            </Button>
          {/if}
          <ColorPicker
            value={effectiveDialogueColor}
            onChange={(c) => settings.setDialogueColor(c)}
          />
        </div>
      </div>

      <p class="prose-content border-border text-muted-foreground rounded-md border p-3 text-sm">
        船长靠近了一些。
        <span class="dialogue-line" style:color={effectiveDialogueColor}> “天亮之前启航。” </span>
      </p>
    {/if}
  </div>

  <!-- Spellcheck Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>拼写检查</Label>
      <p class="text-muted-foreground text-xs">输入时提供语法和拼写建议</p>
    </div>
    <Switch
      checked={settings.uiSettings.spellcheckEnabled}
      onCheckedChange={(v) => settings.setSpellcheckEnabled(v)}
    />
  </div>

  <!-- Custom Dictionary -->
  <div class="space-y-3 rounded-lg border p-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <Label>自定义词典</Label>
        <p class="text-muted-foreground text-xs">
          始终忽略以下拼写（{customDictionaryWords.length} 词)
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onclick={handleClearCustomDictionary}
        disabled={customDictionaryBusy || customDictionaryWords.length === 0}
      >
        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
        全部清空
      </Button>
    </div>

    <div class="flex gap-2">
      <Input
        placeholder="添加自定义词语…"
        bind:value={customDictionaryInput}
        onkeydown={handleCustomDictionaryInputKeydown}
      />
      <Button
        variant="outline"
        size="icon"
        onclick={handleAddCustomWord}
        disabled={customDictionaryBusy || !customDictionaryInput.trim()}
        title="添加自定义词语"
      >
        <Plus class="h-4 w-4" />
      </Button>
    </div>

    {#if loadingCustomDictionary}
      <p class="text-muted-foreground text-xs">正在加载词典…</p>
    {:else if customDictionaryWords.length === 0}
      <p class="text-muted-foreground text-xs">尚未保存自定义词语。</p>
    {:else}
      <ScrollArea class="h-24 w-full rounded-md border">
        <div class="flex flex-wrap gap-1 p-2">
          {#each customDictionaryWords as word (word)}
            <Badge variant="secondary" class="gap-1 pr-1">
              <span class="max-w-36 truncate">{word}</span>
              <button
                class="hover:text-destructive text-muted-foreground p-0 transition-colors"
                onclick={() => handleRemoveCustomWord(word)}
                title="移除词语"
                disabled={customDictionaryBusy}
              >
                <X class="h-3 w-3" />
              </button>
            </Badge>
          {/each}
        </div>
      </ScrollArea>
    {/if}
  </div>

  <!-- Suggestions Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>创作建议</Label>
      <p class="text-muted-foreground text-xs">显示 AI 生成的行动选项和剧情建议</p>
    </div>
    <Switch
      checked={!settings.uiSettings.disableSuggestions}
      onCheckedChange={(v) => settings.setDisableSuggestions(!v)}
    />
  </div>

  <!-- Action Prefixes Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>输入类型按钮</Label>
      <p class="text-muted-foreground text-xs">显示“行动／对白／想法”等输入类型按钮</p>
    </div>
    <Switch
      checked={!settings.uiSettings.disableActionPrefixes}
      onCheckedChange={(v) => settings.setDisableActionPrefixes(!v)}
    />
  </div>

  <!-- Show Reasoning Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>推理过程</Label>
      <p class="text-muted-foreground text-xs">显示模型返回的推理过程</p>
    </div>
    <Switch
      checked={settings.uiSettings.showReasoning}
      onCheckedChange={(v) => settings.setShowReasoning(v)}
    />
  </div>

  <!-- Auto Scroll Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>自动滚动</Label>
      <p class="text-muted-foreground text-xs">生成时自动滚动到最新内容</p>
    </div>
    <Switch
      checked={settings.uiSettings.autoScroll}
      onCheckedChange={(v) => settings.setAutoScroll(v)}
    />
  </div>

  <!-- Scroll to Top Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>悬浮返回顶部按钮</Label>
      <p class="text-muted-foreground text-xs">显示跳转到故事首段的悬浮按钮</p>
    </div>
    <Switch
      checked={settings.uiSettings.showScrollToTop}
      onCheckedChange={(v) => settings.setShowScrollToTop(v)}
    />
  </div>

  <!-- Scroll to Bottom Toggle -->
  <div class="flex items-center justify-between">
    <div>
      <Label>悬浮返回底部按钮</Label>
      <p class="text-muted-foreground text-xs">显示跳转到故事最新段落的悬浮按钮</p>
    </div>
    <Switch
      checked={settings.uiSettings.showScrollToBottom}
      onCheckedChange={(v) => settings.setShowScrollToBottom(v)}
    />
  </div>

  {#if showIncognitoKeyboard}
    <!-- Incognito Keyboard Toggle -->
    <div class="flex items-center justify-between">
      <div>
        <Label>键盘隐私模式</Label>
        <p class="text-muted-foreground text-xs">
          请求键盘不学习你的输入内容；部分键盘可能不支持。
        </p>
      </div>
      <Switch
        checked={settings.uiSettings.incognitoKeyboard}
        onCheckedChange={(v) => settings.setIncognitoKeyboard(v)}
      />
    </div>
  {/if}

  <!-- Translation Section -->
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Languages class="text-muted-foreground h-4 w-4" />
      <Label class="text-base font-medium">内容翻译</Label>
    </div>

    <div class="flex items-center justify-between">
      <div>
        <Label>启用内容翻译</Label>
        <p class="text-muted-foreground text-xs">
          将 AI 回复翻译为目标语言，同时保留原有英文提示词
        </p>
      </div>
      <Switch
        checked={settings.translationSettings.enabled}
        onCheckedChange={(v) => {
          settings.translationSettings.enabled = v
          settings.saveTranslationSettings()
        }}
      />
    </div>

    {#if settings.translationSettings.enabled}
      <!-- Target Language -->
      <div>
        <Label class="mb-2 block">目标语言</Label>
        <Select.Root
          type="single"
          value={settings.translationSettings.targetLanguage}
          onValueChange={(v) => {
            settings.translationSettings.targetLanguage = v
            settings.saveTranslationSettings()
          }}
        >
          <Select.Trigger class="h-10 w-full">
            {getSupportedLanguages().find(
              (l) => l.code === settings.translationSettings.targetLanguage,
            )?.name ?? '选择语言'}
          </Select.Trigger>
          <Select.Content class="max-h-60">
            {#each getSupportedLanguages() as lang (lang.code)}
              <Select.Item value={lang.code} label={lang.name}>
                {lang.name}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <p class="text-muted-foreground mt-1 text-xs">翻译后内容的显示语言</p>
      </div>

      <!-- Translate Narration -->
      <div class="flex items-center justify-between">
        <div>
          <Label>翻译正文</Label>
          <p class="text-muted-foreground text-xs">正文生成后，再翻译故事内容</p>
        </div>
        <Switch
          checked={settings.translationSettings.translateNarration}
          onCheckedChange={(v) => {
            settings.translationSettings.translateNarration = v
            settings.saveTranslationSettings()
          }}
        />
      </div>

      <!-- Translate User Input -->
      <div class="flex items-center justify-between">
        <div>
          <Label>翻译用户输入</Label>
          <p class="text-muted-foreground text-xs">将你的输入翻译成英文后再发送给 AI</p>
        </div>
        <Switch
          checked={settings.translationSettings.translateUserInput}
          onCheckedChange={(v) => {
            settings.translationSettings.translateUserInput = v
            settings.saveTranslationSettings()
          }}
        />
      </div>

      <!-- Translate World State -->
      <div class="flex items-center justify-between">
        <div>
          <Label>翻译世界状态</Label>
          <p class="text-muted-foreground text-xs">翻译界面中显示的角色名、地点和物品</p>
        </div>
        <Switch
          checked={settings.translationSettings.translateWorldState}
          onCheckedChange={(v) => {
            settings.translationSettings.translateWorldState = v
            settings.saveTranslationSettings()
          }}
        />
      </div>
    {/if}
  </div>

  <Separator class="my-4" />

  <!-- Updates Section -->
  <div class="space-y-4">
    <Label class="text-base font-medium">软件更新</Label>

    {#if !UPSTREAM_UPDATES_ENABLED}
      <p class="text-muted-foreground text-sm">{LOCAL_RELEASE_UPDATE_NOTICE}</p>
    {:else}
      <!-- Check for Updates Button -->
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={handleCheckForUpdates}
          disabled={isCheckingUpdates}
        >
          {#if isCheckingUpdates}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            正在检查…
          {:else}
            <RefreshCw class="mr-2 h-4 w-4" />
            检查更新
          {/if}
        </Button>
        {#if updateMessage}
          <span class="text-muted-foreground text-sm">{updateMessage}</span>
        {/if}
      </div>

      <!-- Check on Startup Toggle -->
      <div class="flex items-center justify-between">
        <div>
          <Label>启动时检查更新</Label>
          <p class="text-muted-foreground text-xs">启动应用时检查新版本，发现更新后提示</p>
        </div>
        <Switch
          checked={settings.updateSettings.autoCheck}
          onCheckedChange={(v) => settings.setAutoCheck(v)}
        />
      </div>
    {/if}
  </div>
</div>
