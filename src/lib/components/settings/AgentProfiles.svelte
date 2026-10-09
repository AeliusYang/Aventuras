<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import { onDestroy } from 'svelte'
  import { createDebouncedSave } from '$lib/utils/debounce'
  import { settings, DEFAULT_SERVICE_PRESET_ASSIGNMENTS } from '$lib/stores/settings.svelte'
  import type { GenerationPreset } from '$lib/types'
  import type { ServiceId } from '$lib/stores/settings.svelte'
  import { ask } from '@tauri-apps/plugin-dialog'
  import {
    X,
    Settings2,
    RotateCcw,
    ChevronDown,
    Bot,
    BookOpen,
    Brain,
    Lightbulb,
    ListChecks,
    Sparkles,
    Search,
    Clock,
    Download,
    Users,
    Wand2,
    Languages,
    Plus,
    Trash2,
    Check,
    Copy,
    AlertCircle,
    AlertTriangle,
  } from '@lucide/svelte'
  import { fetchModelsFromProvider } from '$lib/services/ai/sdk/providers'
  import {
    resolveStructuredOutputs,
    thinkingNudgeApplies,
  } from '$lib/services/ai/sdk/presetResolution'

  // Shadcn Components
  import * as Card from '$lib/components/ui/card'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Switch } from '$lib/components/ui/switch'
  import GenerationParamsForm from './GenerationParamsForm.svelte'

  // All system services that can be assigned to profiles
  const systemServices = [
    {
      id: 'collaborativeSceneDirector',
      label: '中文写作：意图与场景导演',
      icon: Wand2,
      description: '解释自然输入并以原始文字指导本轮正文',
    },
    {
      id: 'collaborativeNarrativePlanner',
      label: '中文写作：长期叙事规划',
      icon: Brain,
      description: '中文写作的长期目标、关系、伏笔与软规划',
    },
    {
      id: 'collaborativePatternReviewer',
      label: '中文写作：结构重复规避',
      icon: Sparkles,
      description: '按需分析近期正文，给导演提供结构规避指导',
    },
    {
      id: 'collaborativeWriter',
      label: '中文写作：中文正文 Writer',
      icon: BookOpen,
      description: '执行导演原文并生成中文小说正文',
    },
    {
      id: 'collaborativeFactStateExtractor',
      label: '中文写作：事实与状态提取',
      icon: Bot,
      description: '正文生成后提取结构化事实与状态',
    },
    {
      id: 'collaborativePlotSuggestions',
      label: '中文写作：短期剧情建议',
      icon: Lightbulb,
      description: '用户主动请求的结构化短期剧情建议',
    },
    // Classification tasks
    {
      id: 'classifier',
      label: '世界状态提取',
      icon: Bot,
      description: '读取正文，更新角色、地点、物品和剧情线索',
    },
    {
      id: 'lorebookClassifier',
      label: '世界书导入',
      icon: BookOpen,
      description: '为导入的世界书条目分类',
    },
    {
      id: 'entryRetrieval',
      label: '世界书条目检索',
      icon: Search,
      description: '选择当前场景相关的世界书条目',
    },
    {
      id: 'worldStateInjection',
      label: '世界状态注入',
      icon: Users,
      description: '将当前角色、地点、物品和剧情线索加入上下文',
    },
    {
      id: 'characterCardImport',
      label: '角色卡导入',
      icon: Download,
      description: '转换角色卡内容',
    },
    // Memory & Context tasks
    {
      id: 'memory',
      label: '记忆系统',
      icon: Brain,
      description: '分析章节和上下文',
    },
    {
      id: 'chapterQuery',
      label: '章节查询',
      icon: Search,
      description: '查询章节细节',
    },
    {
      id: 'timelineFill',
      label: '时间线补全',
      icon: Clock,
      description: '补全时间线中的缺口',
    },
    // Suggestions tasks
    {
      id: 'suggestions',
      label: '创作建议',
      icon: Lightbulb,
      description: '生成剧情建议',
    },
    {
      id: 'actionChoices',
      label: '行动选项',
      icon: ListChecks,
      description: '生成行动选项',
    },
    {
      id: 'styleReviewer',
      label: '文风与重复分析',
      icon: Sparkles,
      description: '分析正文质量与重复模式',
    },
    {
      id: 'imageGeneration',
      label: '图片生成',
      icon: Wand2,
      description: '生成图片提示词',
    },
    {
      id: 'bgImageGeneration',
      label: '背景图场景分析',
      icon: Wand2,
      description: '生成背景图提示词',
    },
    // Agentic tasks
    {
      id: 'loreManagement',
      label: '世界书管理',
      icon: BookOpen,
      description: '自动维护世界书',
    },
    {
      id: 'agenticRetrieval',
      label: '智能记忆检索',
      icon: Search,
      description: '主动检索相关上下文',
    },
    {
      id: 'interactiveVault',
      label: '素材库助手',
      icon: BookOpen,
      description: '协助管理素材库',
    },
    // Wizard tasks
    {
      id: 'wizard:settingExpansion',
      label: '世界设定扩写',
      icon: Wand2,
      description: '扩写世界设定',
    },
    {
      id: 'wizard:settingRefinement',
      label: '世界设定润色',
      icon: Wand2,
      description: '润色世界设定',
    },
    {
      id: 'wizard:protagonistGeneration',
      label: '主角生成',
      icon: Wand2,
      description: '生成主角',
    },
    {
      id: 'wizard:characterElaboration',
      label: '角色设定扩写',
      icon: Wand2,
      description: '扩写角色设定',
    },
    {
      id: 'wizard:characterRefinement',
      label: '角色设定润色',
      icon: Wand2,
      description: '润色角色设定',
    },
    {
      id: 'wizard:supportingCharacters',
      label: '配角生成',
      icon: Wand2,
      description: '生成配角',
    },
    {
      id: 'wizard:openingGeneration',
      label: '开场生成',
      icon: Wand2,
      description: '生成故事开场',
    },
    {
      id: 'wizard:openingRefinement',
      label: '开场润色',
      icon: Wand2,
      description: '润色故事开场',
    },
    // Translation tasks
    {
      id: 'translation:narration',
      label: '翻译正文',
      icon: Languages,
      description: '翻译 AI 生成的正文',
    },
    {
      id: 'translation:input',
      label: '输入翻译',
      icon: Languages,
      description: '将用户输入翻译为英文',
    },
    {
      id: 'translation:ui',
      label: '界面状态翻译',
      icon: Languages,
      description: '翻译界面中的世界状态',
    },
    {
      id: 'translation:suggestions',
      label: '创作建议翻译',
      icon: Languages,
      description: '翻译剧情建议',
    },
    {
      id: 'translation:actionChoices',
      label: '行动选项翻译',
      icon: Languages,
      description: '翻译行动选项',
    },
    {
      id: 'translation:wizard',
      label: '创建向导翻译',
      icon: Languages,
      description: '翻译创建向导中的内容',
    },
  ] as const satisfies readonly {
    id: ServiceId
    label: string
    icon: unknown
    description: string
  }[]

  // State
  let editingPresetId = $state<string | null>(null)
  let activeTaskMenu = $state<string | null>(null)
  let resettingProfiles = $state(false)
  let isLoadingPresetModels = $state(false)

  // Auto-persist: debounced save to avoid a DB write on every slider tick
  const { trigger: debouncedSave, flush: flushSave } = createDebouncedSave(() =>
    settings.saveGenerationPresets(),
  )

  // Flush any pending save when the component is destroyed (e.g. Settings modal closed)
  onDestroy(() => flushSave())

  function getEditingPreset(): GenerationPreset | undefined {
    return settings.generationPresets.find((p) => p.id === editingPresetId)
  }

  const defaultAssignments = DEFAULT_SERVICE_PRESET_ASSIGNMENTS

  async function fetchModelsForPreset() {
    const preset = getEditingPreset()
    if (!preset?.profileId) return
    const profile = settings.getProfile(preset.profileId)
    if (!profile) return
    if (isLoadingPresetModels) return

    isLoadingPresetModels = true
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
      console.log(`[AgentProfiles] Fetched ${result.length} models from ${profile.providerType}`)
    } catch (error) {
      console.error('[AgentProfiles] Failed to fetch models:', error)
    } finally {
      isLoadingPresetModels = false
    }
  }

  // Memoized: compute service-to-profile mapping once per reactive update
  let servicesByProfile = $derived.by(() => {
    const map = new SvelteMap<string, (typeof systemServices)[number][]>()
    for (const service of systemServices) {
      const key = settings.servicePresetAssignments[service.id] || 'custom'
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(service)
    }
    return map
  })

  function getServicesForProfile(profileId: string | 'custom') {
    return servicesByProfile.get(profileId) ?? []
  }

  function createNewPreset() {
    const newId = `preset-${Date.now()}`
    const defaultProfile = settings.getMainNarrativeProfile()
    const newPreset: GenerationPreset = {
      id: newId,
      name: 'New Profile',
      description: '',
      profileId: defaultProfile?.id ?? settings.getDefaultProfileIdForProvider(),
      model: settings.apiSettings.defaultModel ?? '',
      temperature: 0.7,
      maxTokens: 4096,
      reasoningEffort: 'none',
      manualBody: '',
    }
    settings.generationPresets = [...settings.generationPresets, newPreset]
    settings.saveGenerationPresets()
    editingPresetId = newId
  }

  /** Same three conditions the middleware chain applies, so the toggle cannot be inert. */
  function nudgeApplies(preset: GenerationPreset): boolean {
    const profile = preset.profileId ? settings.getProfile(preset.profileId) : null
    if (!profile) return false
    const fetchedModel = settings.getProfileModels(profile.id).find((m) => m.id === preset.model)
    return thinkingNudgeApplies({
      providerType: profile.providerType,
      reasoningEffort: preset.reasoningEffort,
      supportsStructuredOutput: resolveStructuredOutputs(
        preset,
        profile.providerType,
        fetchedModel?.structuredOutput,
      ),
    })
  }

  function startEditingPreset(preset: GenerationPreset) {
    flushSave() // flush any pending save before switching presets
    editingPresetId = preset.id
  }

  function closeEditingPreset() {
    flushSave()
    editingPresetId = null
  }

  async function handleDeletePreset(presetId: string) {
    const preset = settings.generationPresets.find((p) => p.id === presetId)
    if (!preset) return

    const confirmed = await ask(
      `Delete profile "${preset.name}"? Tasks assigned to it will revert to Unassigned.`,
      {
        title: '删除配置',
        kind: 'warning',
      },
    )

    if (confirmed) {
      settings.generationPresets = settings.generationPresets.filter((p) => p.id !== presetId)
      await settings.saveGenerationPresets()

      // Reset assignments - mutate in-memory then save once
      for (const service of systemServices) {
        if (settings.servicePresetAssignments[service.id] === presetId) {
          settings.servicePresetAssignments[service.id] = ''
        }
      }
      await settings.saveServicePresetAssignments()
    }
  }

  async function handleAssignPreset(serviceId: ServiceId, presetId: string | 'custom') {
    settings.setServicePresetId(serviceId, presetId === 'custom' ? '' : presetId)
  }

  async function handleApplyMainToAll() {
    const confirmed = await ask(
      '将冒险正文的连接与模型复制到所有 Agent Profile？其他生成参数保持各 Profile 的设置。',
      { title: '将主模型应用到所有任务', kind: 'warning' },
    )
    if (!confirmed) return

    const mainProfileId = settings.apiSettings.mainNarrativeProfileId
    const mainModel = settings.apiSettings.defaultModel

    settings.generationPresets = settings.generationPresets.map((preset) => ({
      ...preset,
      profileId: mainProfileId,
      model: mainModel,
    }))
    await settings.saveGenerationPresets()
  }

  async function handleResetProfiles() {
    await settings.resetGenerationPresets()

    // Assign tasks to their default profiles
    for (const service of systemServices) {
      const presetId = defaultAssignments[service.id] || ''
      settings.setServicePresetId(service.id, presetId)
    }
  }

  function handleTaskClick(e: MouseEvent, serviceId: string) {
    e.stopPropagation()
    // Toggle the menu - if clicking same task, close it
    if (activeTaskMenu === serviceId) {
      activeTaskMenu = null
    } else {
      activeTaskMenu = serviceId
    }
  }

  async function moveTask(serviceId: ServiceId, targetProfileId: string | 'custom') {
    await handleAssignPreset(serviceId, targetProfileId)
    activeTaskMenu = null
  }

  // Helper to render a task item with inline menu
  function isTaskMenuOpen(serviceId: string): boolean {
    return activeTaskMenu === serviceId
  }
</script>

<div>
  <div class="mb-4 flex items-start justify-between sm:items-center">
    <div>
      <h3 class="text-base font-medium">任务模型配置</h3>
      <p class="text-muted-foreground text-xs">点击任务，可将其分配到其他模型配置。</p>
    </div>
    <div class="flex items-center gap-2">
      {#if resettingProfiles}
        <span class="text-muted-foreground text-xs font-medium"> 重置全部配置？ </span>
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground hover:text-foreground w-5 px-0 hover:bg-transparent"
          onclick={() => (resettingProfiles = false)}
          title="取消"
        >
          <X class="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="text-destructive w-5 px-0 hover:bg-transparent"
          onclick={() => {
            resettingProfiles = false
            handleResetProfiles()
          }}
          title="确认重置"
        >
          <Check class="h-3.5 w-3.5" />
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => (resettingProfiles = true)}
          title="将所有任务配置恢复为默认值"
          class="text-xs"
        >
          <RotateCcw class="mr-1 h-3 w-3" />
          重置
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onclick={handleApplyMainToAll}
          title="将冒险正文的连接与模型应用到所有任务配置"
          class="text-xs"
        >
          <Copy class="mr-1 h-3 w-3" />
          统一使用正文模型
        </Button>
        <Button variant="secondary" size="sm" onclick={createNewPreset} class="text-xs">
          <Plus class="mr-1 h-3 w-3" />
          新建配置
        </Button>
      {/if}
    </div>
  </div>

  {#if editingPresetId}
    {@const preset = getEditingPreset()}
    {#if preset}
      <Card.Root class="mb-6">
        <Card.Header class="pb-3">
          <div class="flex items-start justify-between">
            <Card.Title class="text-base">
              {settings.generationPresets.find((p) => p.id === editingPresetId)
                ? '编辑配置'
                : '创建配置'}
            </Card.Title>
            <Button
              variant="text"
              size="icon"
              class="-mt-2 -mr-2 h-6 w-6"
              onclick={closeEditingPreset}
            >
              <X class="h-4 w-4" />
            </Button>
          </div>
        </Card.Header>

        <Card.Content class="grid gap-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="grid gap-2">
              <Label>名称</Label>
              <Input
                type="text"
                bind:value={preset.name}
                oninput={() => debouncedSave()}
                placeholder="例如：状态提取、记忆"
              />
            </div>
            <div class="grid gap-2">
              <Label>说明</Label>
              <Input
                type="text"
                bind:value={preset.description}
                oninput={() => debouncedSave()}
                placeholder="简短说明"
              />
            </div>
          </div>

          <!-- Warning if no model or deleted profile -->
          {#if !preset.model || (preset.profileId && !settings.getProfile(preset.profileId))}
            <div
              class="flex items-center gap-2 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
            >
              <AlertCircle class="h-4 w-4 shrink-0" />
              尚未配置模型，设置后才能生成故事。
            </div>
          {/if}

          <GenerationParamsForm
            profileId={preset.profileId ?? null}
            model={preset.model}
            temperature={preset.temperature}
            maxTokens={preset.maxTokens}
            reasoningEffort={preset.reasoningEffort}
            timeoutMs={preset.timeoutMs ?? settings.apiSettings.llmTimeoutMs}
            onProfileChange={async (id) => {
              const previousModel = preset.model
              preset.profileId = id
              await fetchModelsForPreset()
              const models = settings.getAvailableModels(
                preset.profileId || settings.getDefaultProfileIdForProvider(),
              )
              if (!models.find((m) => m.id === previousModel)) {
                preset.model = ''
              }
              debouncedSave()
            }}
            onModelChange={(m) => {
              preset.model = m
              debouncedSave()
            }}
            onTemperatureChange={(v) => {
              preset.temperature = v
              debouncedSave()
            }}
            onMaxTokensChange={(v) => {
              preset.maxTokens = v
              debouncedSave()
            }}
            onReasoningChange={(v) => {
              preset.reasoningEffort = v
              debouncedSave()
            }}
            onTimeoutChange={(v) => {
              preset.timeoutMs = v
              debouncedSave()
            }}
            onRefreshModels={fetchModelsForPreset}
            isRefreshingModels={isLoadingPresetModels}
            isManualMode={settings.advancedRequestSettings.manualMode}
          />

          <!-- Structured Output (unchanged) -->
          <div class="grid gap-2">
            <Label>结构化输出</Label>
            <div class="flex rounded-md border">
              {#each [['auto', 'Auto'], ['on', 'Force On'], ['off', 'Force Off']] as [val, label] (val)}
                {@const isActive = (preset.structuredOutputOverride ?? 'auto') === val}
                <button
                  type="button"
                  class="flex-1 px-3 py-1.5 text-xs transition-colors first:rounded-l-md last:rounded-r-md {isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted/50'}"
                  onclick={() => {
                    preset.structuredOutputOverride = val as 'auto' | 'on' | 'off'
                    debouncedSave()
                  }}
                >
                  {label}
                </button>
              {/each}
            </div>
            <p class="text-muted-foreground text-xs">
              自动模式根据服务商和模型能力判断，也可强制开启或关闭。部分本地模型服务的结构化输出可能影响推理。
            </p>
          </div>

          <!-- Thinking nudge. Shown only where it can actually reach the model: a think-tag
               provider, reasoning on, and no native structured output to carry the schema. -->
          {#if nudgeApplies(preset)}
            <div class="flex flex-row items-center justify-between gap-3">
              <div class="space-y-0.5">
                <Label class="text-sm">推理标签引导</Label>
                <p class="text-muted-foreground text-xs">
                  添加提示词，引导模型正确使用 <code>&lt;think&gt;</code> 标签。适用于部分本地模型（如
                  Mistral），但可能影响其他模型（如 Qwen 3.5）。
                </p>
              </div>
              <Switch
                checked={!!preset.thinkingNudgePrompt}
                onCheckedChange={(v) => {
                  preset.thinkingNudgePrompt = !!v
                  debouncedSave()
                }}
              />
            </div>
          {/if}

          <!-- Manual Request Body (unchanged) -->
          {#if settings.advancedRequestSettings.manualMode}
            <div class="border-t pt-2">
              <Label class="mb-2 block">自定义请求体（JSON）</Label>
              <Textarea
                bind:value={preset.manualBody}
                onblur={() => debouncedSave()}
                class="min-h-[100px] font-mono text-xs"
                rows={4}
                placeholder={'{"temperature": 0.7, "top_p": 0.9}'}
              />
              <p class="text-muted-foreground mt-1 text-xs">
                覆盖请求参数；消息与工具由 Aventuras 管理。
              </p>
            </div>
          {/if}
        </Card.Content>
        <!-- No Card.Footer: auto-persist replaces explicit Save/Cancel -->
      </Card.Root>
    {/if}
  {/if}

  <div class="grid grid-cols-1 gap-4 pb-20 md:grid-cols-2 xl:grid-cols-3">
    {#each settings.generationPresets as preset (preset.id)}
      {#if preset.id !== editingPresetId}
        <Card.Root class="flex h-full flex-col">
          <div class="flex items-start justify-between border-b p-3 pb-2">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium" title={preset.name}>
                {preset.name}
              </div>
              <div
                class="truncate text-xs"
                class:text-muted-foreground={preset.model}
                class:text-destructive={!preset.model}
                title={preset.model || '尚未配置模型'}
              >
                {preset.model || '请配置模型'}
              </div>
              {#if !preset.model}
                <div class="text-destructive mt-0.5 flex items-center gap-1 text-xs">
                  <AlertCircle class="h-3 w-3" />
                  点击配置
                </div>
              {:else if preset.profileId && !settings.getProfile(preset.profileId)}
                <div class="text-destructive mt-0.5 flex items-center gap-1 text-xs">
                  <AlertCircle class="h-3 w-3" />
                  未选择模型连接
                </div>
              {:else}
                {@const _profileId = preset.profileId || settings.getDefaultProfileIdForProvider()}
                {@const _models = settings.getAvailableModels(_profileId)}
                {@const _profile = settings.getProfile(_profileId)}
                {#if _models.length > 0 && !_models.find((m) => m.id === preset.model)}
                  <div class="mt-0.5 flex items-center gap-1 text-xs text-yellow-500">
                    <AlertTriangle class="h-3 w-3" />
                    模型不在连接配置中
                  </div>
                {:else if _models.length === 0 && _profile?.fetchedModels.length}
                  <div class="mt-0.5 flex items-center gap-1 text-xs text-red-500">
                    <AlertTriangle class="h-3 w-3" />
                    没有可用模型
                  </div>
                {:else if _models.length === 0}
                  <div class="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                    尚未获取模型
                  </div>
                {/if}
              {/if}
            </div>
            <div class="ml-2 flex shrink-0 gap-1">
              <Button
                variant="text"
                size="icon"
                class="text-muted-foreground hover:text-foreground h-6 w-6"
                onclick={() => startEditingPreset(preset)}
                title="编辑配置"
              >
                <Settings2 class="h-3 w-3" />
              </Button>
              <Button
                variant="text"
                size="icon"
                class="text-muted-foreground h-6 w-6 hover:text-red-500"
                onclick={() => handleDeletePreset(preset.id)}
                title="删除配置"
              >
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
          </div>

          <Card.Content class="bg-muted/30 flex flex-1 flex-col gap-2 p-3">
            {#each getServicesForProfile(preset.id) as service (service.id)}
              <div
                class="bg-background flex flex-col overflow-hidden rounded-md border shadow-sm transition-all"
              >
                <div
                  class="group hover:bg-muted/50 flex w-full items-center gap-2 p-2 text-left transition-colors select-none"
                  role="button"
                  tabindex="0"
                  onclick={(e) => handleTaskClick(e, service.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      activeTaskMenu = activeTaskMenu === service.id ? null : service.id
                    }
                  }}
                  title={service.description}
                >
                  <service.icon class="text-primary h-3 w-3 shrink-0" />
                  <span class="flex-1 truncate text-xs">{service.label}</span>
                  <ChevronDown
                    class="text-muted-foreground ml-auto h-3 w-3 transition-transform {isTaskMenuOpen(
                      service.id,
                    )
                      ? 'rotate-180'
                      : ''}"
                  />
                </div>

                {#if isTaskMenuOpen(service.id)}
                  <div class="bg-muted/50 flex flex-col gap-0.5 border-t p-1">
                    <div
                      class="text-muted-foreground px-2 py-1 text-[10px] font-bold tracking-wider uppercase"
                    >
                      移动到…
                    </div>
                    {#each settings.generationPresets as targetPreset (targetPreset.id)}
                      {#if targetPreset.id !== preset.id}
                        <button
                          class="hover:bg-background w-full truncate rounded-sm px-2 py-1.5 text-left text-xs transition-colors"
                          onclick={(e) => {
                            e.stopPropagation()
                            moveTask(service.id, targetPreset.id)
                          }}
                        >
                          {targetPreset.name}
                        </button>
                      {/if}
                    {/each}
                    <button
                      class="text-muted-foreground hover:bg-background mt-1 w-full rounded-sm border-t px-2 py-1.5 pt-1 text-left text-xs transition-colors"
                      onclick={(e) => {
                        e.stopPropagation()
                        moveTask(service.id, 'custom')
                      }}
                    >
                      未分配
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
            {#if getServicesForProfile(preset.id).length === 0}
              <div
                class="text-muted-foreground flex flex-1 items-center justify-center py-2 text-xs italic"
              >
                尚未分配任务
              </div>
            {/if}
          </Card.Content>
        </Card.Root>
      {/if}
    {/each}

    <!-- Unassigned Card -->
    {#if getServicesForProfile('custom').length !== 0}
      <Card.Root class="bg-muted/20 flex h-full flex-col border-dashed">
        <div class="border-b p-3 pb-2">
          <div class="text-muted-foreground text-sm font-medium">未分配</div>
        </div>
        <Card.Content
          class="flex flex-1 flex-col gap-2 p-3 transition-all {getServicesForProfile('custom')
            .length > 0
            ? 'bg-muted/30'
            : ''}"
        >
          {#if getServicesForProfile('custom').length > 0}
            <div
              class="mb-2 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400"
            >
              未分配的任务无法运行，请为其选择模型配置。
            </div>
          {/if}
          {#each getServicesForProfile('custom') as service (service.id)}
            <div
              class="bg-background flex flex-col overflow-hidden rounded-md border shadow-sm transition-all"
            >
              <button
                class="group hover:bg-muted/50 flex w-full items-center gap-2 p-2 text-left transition-colors select-none"
                onclick={(e) => handleTaskClick(e, service.id)}
                title={service.description}
              >
                <service.icon class="text-muted-foreground h-3 w-3 shrink-0" />
                <span class="flex-1 truncate text-xs">{service.label}</span>
                <ChevronDown
                  class="text-muted-foreground ml-auto h-3 w-3 transition-transform {isTaskMenuOpen(
                    service.id,
                  )
                    ? 'rotate-180'
                    : ''}"
                />
              </button>

              {#if isTaskMenuOpen(service.id)}
                <div class="bg-muted/50 flex flex-col gap-0.5 border-t p-1">
                  <div
                    class="text-muted-foreground px-2 py-1 text-[10px] font-bold tracking-wider uppercase"
                  >
                    移动到…
                  </div>
                  {#each settings.generationPresets as targetPreset (targetPreset.id)}
                    <button
                      class="hover:bg-background w-full truncate rounded-sm px-2 py-1.5 text-left text-xs transition-colors"
                      onclick={(e) => {
                        e.stopPropagation()
                        moveTask(service.id, targetPreset.id)
                      }}
                    >
                      {targetPreset.name}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
</div>
