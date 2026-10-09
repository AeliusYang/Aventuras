<script lang="ts">
  import {
    settings,
    CLASSIFIER_WINDOW_MIN,
    CLASSIFIER_WINDOW_MAX,
    ENTRY_RETRIEVAL_WINDOW_MIN,
    ENTRY_RETRIEVAL_WINDOW_MAX,
  } from '$lib/stores/settings.svelte'
  import {
    ChevronDown,
    RotateCcw,
    FolderOpen,
    BookOpen,
    Brain,
    Search,
    Bug,
    Code2,
    Layers,
    Sparkles,
    Users,
    PenLine,
  } from '@lucide/svelte'
  import { Switch } from '$lib/components/ui/switch'
  import { Label } from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Separator } from '$lib/components/ui/separator'
  import { advancedPanelView } from './advancedPanelView'

  // Open/closed state for every collapsible section, keyed by id so `sectionHeader` can
  // bind to it generically instead of each section carrying its own `let`.
  //
  // Every id is listed with an explicit `false`, and `SectionId` is derived from this
  // object rather than being `string`. Both matter: `bind:open` refuses a value of
  // `undefined` when the prop has a fallback, so an id that is missing here does not
  // degrade -- it throws and takes the whole tab down. Deriving the type means a section
  // whose id is not in this list fails `npm run check` instead.
  const openSections = $state({
    entryRetrieval: false,
    worldStateInjection: false,
    memoryRetrieval: false,
    classifier: false,
    styleReviewer: false,
    loreManagement: false,
    suggestions: false,
    lorebookImport: false,
  })

  type SectionId = keyof typeof openSections

  // Manual mode toggle handler
  async function handleManualModeToggle(checked: boolean) {
    await settings.setAdvancedManualMode(checked)
  }

  // Debug mode toggle handler
  function handleDebugModeToggle(checked: boolean) {
    settings.setDebugMode(checked)
  }

  const system = $derived(settings.systemServicesSettings)
  const service = $derived(settings.serviceSpecificSettings)

  // Which controls currently do anything, what the headers say, and how the help lines
  // are worded. Lives in `advancedPanelView` so the rules can be tested -- this project has
  // no DOM test setup, and the panel is exactly where a control quietly ceasing to matter
  // goes unnoticed.
  const view = $derived(advancedPanelView(system))

  interface SectionConfig {
    /** Must be a key of `openSections`; see the note there. */
    id: SectionId
    title: string
    subtitle: string
    /** Any lucide-svelte icon; they all share this shape. */
    icon: typeof Search
    /** Full Tailwind classes, not fragments -- the scanner only sees literals. */
    iconWrap: string
    iconColor: string
    onReset: () => void
    badge?: { text: string; muted?: boolean }
  }

  interface SliderConfig {
    label: string
    value: number
    min: number
    max: number
    step: number
    onChange: (value: number) => void
    /** Reading shown in the pill. Defaults to the raw value. */
    display?: string
    /** Explanatory line under the control. */
    help?: string
    /** Labels for the two ends of the track, in place of `help`. */
    ends?: [string, string]
    /** When set, the control is dimmed, taken out of the tab order, and explained. */
    inactiveReason?: string
  }

  interface SwitchConfig {
    label: string
    description: string
    checked: boolean
    onChange: (checked: boolean) => void
  }

  const saveSystem = () => settings.saveSystemServicesSettings()
  const saveService = () => settings.saveServiceSpecificSettings()
</script>

{#snippet stateBadge(text: string, muted = false)}
  <span
    class="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase {muted
      ? 'text-muted-foreground bg-muted'
      : 'bg-primary/10 text-primary'}"
  >
    {text}
  </span>
{/snippet}

{#snippet sectionHeader(cfg: SectionConfig)}
  {@const Icon = cfg.icon}
  <div class="flex items-center gap-3 p-3 pl-4">
    <Collapsible.Trigger class="group/trigger flex flex-1 items-center gap-2 text-left">
      <div
        class="flex h-8 w-8 items-center justify-center rounded-md transition-colors {cfg.iconWrap}"
      >
        <Icon class="h-4 w-4 {cfg.iconColor}" />
      </div>
      <div class="flex-1">
        <div class="flex items-center gap-2">
          <Label class="leading-none font-medium">{cfg.title}</Label>
          {#if cfg.badge}{@render stateBadge(cfg.badge.text, cfg.badge.muted)}{/if}
        </div>
        <p class="text-muted-foreground mt-1 text-xs">{cfg.subtitle}</p>
      </div>
    </Collapsible.Trigger>
    <div class="flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon" class="h-8 w-8" onclick={cfg.onReset} title="恢复默认值">
        <RotateCcw class="h-3.5 w-3.5" />
      </Button>
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon" class="h-8 w-8">
            <ChevronDown
              class="h-4 w-4 transition-transform duration-200 {openSections[cfg.id]
                ? 'rotate-180'
                : ''}"
            />
            <span class="sr-only">切换</span>
          </Button>
        {/snippet}
      </Collapsible.Trigger>
    </div>
  </div>
{/snippet}

{#snippet sliderRow(cfg: SliderConfig)}
  <div class="space-y-3" class:opacity-50={!!cfg.inactiveReason} inert={!!cfg.inactiveReason}>
    <div class="flex justify-between">
      <Label>{cfg.label}</Label>
      <span class="bg-muted rounded px-2 py-0.5 text-xs font-medium">
        {cfg.display ?? cfg.value}
      </span>
    </div>
    <Slider
      value={cfg.value}
      min={cfg.min}
      max={cfg.max}
      step={cfg.step}
      type="single"
      onValueChange={cfg.onChange}
    />
    {#if cfg.ends}
      <div
        class="text-muted-foreground flex justify-between text-[10px] font-medium tracking-wider uppercase"
      >
        <span>{cfg.ends[0]}</span>
        <span>{cfg.ends[1]}</span>
      </div>
    {:else if cfg.help}
      <p class="text-muted-foreground text-xs">{cfg.help}</p>
    {/if}
    {#if cfg.inactiveReason}
      <p class="text-muted-foreground/80 text-[11px] italic">未启用： {cfg.inactiveReason}</p>
    {/if}
  </div>
{/snippet}

{#snippet switchRow(cfg: SwitchConfig)}
  <div class="flex flex-row items-center justify-between">
    <div class="space-y-0.5">
      <Label class="text-sm">{cfg.label}</Label>
      <p class="text-muted-foreground text-xs">{cfg.description}</p>
    </div>
    <Switch checked={cfg.checked} onCheckedChange={cfg.onChange} />
  </div>
{/snippet}

{#snippet groupHeading(text: string, subtitle: string)}
  <div class="px-1 pt-2">
    <h3 class="text-xs font-semibold tracking-wide uppercase">{text}</h3>
    <p class="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
  </div>
{/snippet}

<div class="space-y-6">
  <!-- General Settings -->
  <div class="space-y-4">
    <!-- Manual Request Mode -->
    <div class="flex flex-row items-center justify-between">
      <div class="space-y-0.5">
        <div class="flex items-center gap-2">
          <Code2 class="text-muted-foreground h-4 w-4" />
          <Label>自定义请求模式</Label>
        </div>
        <p class="text-muted-foreground text-xs">直接编辑完整请求体参数。</p>
        {#if settings.advancedRequestSettings.manualMode}
          <p class="pt-1 text-xs font-medium text-amber-500">
            已启用自定义请求模式，温度和最大 Token 控件暂不可调整。
          </p>
        {/if}
      </div>
      <Switch
        checked={settings.advancedRequestSettings.manualMode}
        onCheckedChange={handleManualModeToggle}
      />
    </div>

    <!-- Debug Mode -->
    <div class="flex flex-row items-center justify-between">
      <div class="space-y-0.5">
        <div class="flex items-center gap-2">
          <Bug class="text-muted-foreground h-4 w-4" />
          <Label>调试模式</Label>
        </div>
        <p class="text-muted-foreground text-xs">记录 API 请求与响应，便于排查问题。</p>
        {#if settings.uiSettings.debugMode}
          <p class="pt-1 text-xs font-medium text-amber-500">
            日志仅在当前会话中保留，不写入存储。
          </p>
        {/if}
      </div>
      <Switch checked={settings.uiSettings.debugMode} onCheckedChange={handleDebugModeToggle} />
    </div>
  </div>

  <Separator />

  <!-- ==================================================================== -->
  <!-- Group 1: what is assembled into the narrator's prompt, before a turn  -->
  <!-- ==================================================================== -->
  {@render groupHeading(
    '正文生成上下文',
    '每轮生成前选择并发送。条目检索与世界状态注入使用独立的数据来源，记忆检索则查找过去的章节。',
  )}

  <div class="space-y-3">
    <!-- Entry Retrieval -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.entryRetrieval}>
        {@render sectionHeader({
          id: 'entryRetrieval',
          title: '世界书条目检索',
          subtitle: '选择要加入提示词的世界书条目（预先编写的设定）',
          icon: Search,
          iconWrap: 'bg-amber-500/10 group-hover/trigger:bg-amber-500/20',
          iconColor: 'text-amber-500',
          onReset: () => settings.resetEntryRetrievalSettings(),
          badge: view.badges.entryRetrieval,
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            <p class="text-muted-foreground text-xs leading-relaxed">
              选择要加入上下文的 <strong>世界书条目</strong> （你或 AI
              编写的角色、地点、物品、阵营、概念和事件设定）。当前位置、活跃角色和背包内容由下方的
              <strong>世界状态注入</strong> 从逐轮更新的实时状态中选择。无论使用哪种记忆检索模式，每轮正文生成都会执行此步骤。智能记忆检索会读取世界书以理解历史，但由这里决定哪些条目进入正文上下文。
            </p>

            {@render sliderRow({
              label: '最近条目范围',
              value: system.entryRetrieval.recentEntriesCount,
              display: `${system.entryRetrieval.recentEntriesCount} entries`,
              min: ENTRY_RETRIEVAL_WINDOW_MIN,
              max: ENTRY_RETRIEVAL_WINDOW_MAX,
              step: 1,
              help: view.help.entryRecentEntries,
              onChange: (v) => {
                system.entryRetrieval.recentEntriesCount = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '匹配条目上限',
              value: system.entryRetrieval.maxTier2Entries,
              display: `${system.entryRetrieval.maxTier2Entries} entries`,
              min: 5,
              max: 40,
              step: 5,
              help: '按名称、别名或关键词匹配的条目数量上限。世界书条目通常长于世界状态记录，因此此上限通常应更低。',
              onChange: (v) => {
                system.entryRetrieval.maxTier2Entries = v
                saveSystem()
              },
            })}

            {@render switchRow({
              label: '匹配场景中的实体',
              description:
                '除正文提到的名称外，也匹配世界状态中当前地点、在场角色、随身物品和进行中任务的设定。这些匹配优先级较低，超出上限时优先舍弃。如果它们占用了过多条目名额，可以关闭。',
              checked: system.entryRetrieval.useSceneEntities,
              onChange: (v) => {
                system.entryRetrieval.useSceneEntities = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '全部纳入的预算',
              value: system.entryRetrieval.tier3WholesaleWordBudget,
              display: `${system.entryRetrieval.tier3WholesaleWordBudget} words`,
              min: 100,
              max: 2500,
              step: 100,
              help: '未匹配设定在预算内时全部纳入，无需调用模型；超出时由模型筛选，若关闭下方开关则舍弃。提高预算可能减少模型调用，但会增加提示词长度。',
              onChange: (v) => {
                system.entryRetrieval.tier3WholesaleWordBudget = v
                saveSystem()
              },
            })}

            {@render switchRow({
              label: '超出预算时由模型筛选条目',
              description:
                '剩余条目超出预算时，由模型筛选相关内容。关闭后将舍弃超预算的剩余条目；预算内的剩余条目仍会全部纳入。',
              checked: view.entryLLMOn,
              onChange: (v) => {
                system.entryRetrieval.enableLLMSelection = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '模型筛选条目上限',
              value: system.entryRetrieval.maxTier3Entries,
              display: `${system.entryRetrieval.maxTier3Entries} entries`,
              min: 5,
              max: 50,
              step: 5,
              help: '限制模型筛选的数量。仅在超预算时生效；预算内的剩余内容全部纳入，不受此上限影响。',
              inactiveReason: view.inactive.maxTier3Entries,
              onChange: (v) => {
                system.entryRetrieval.maxTier3Entries = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '每条最大词数',
              value: system.entryRetrieval.maxWordsPerEntry,
              display:
                system.entryRetrieval.maxWordsPerEntry === 0
                  ? 'Unlimited'
                  : String(system.entryRetrieval.maxWordsPerEntry),
              min: 0,
              max: 500,
              step: 50,
              ends: ['Unlimited', '500 Words'],
              help: '写入上下文时截断过长的描述，适用于所有来源的条目。',
              onChange: (v) => {
                system.entryRetrieval.maxWordsPerEntry = v
                saveSystem()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>

    <!-- World State Injection -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.worldStateInjection}>
        {@render sectionHeader({
          id: 'worldStateInjection',
          title: '世界状态注入',
          subtitle: '选择要加入提示词的动态角色、地点、物品和任务记录',
          icon: Users,
          iconWrap: 'bg-teal-500/10 group-hover/trigger:bg-teal-500/20',
          iconColor: 'text-teal-500',
          onReset: () => settings.resetWorldStateInjectionSettings(),
          badge: view.badges.worldState,
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            <p class="text-muted-foreground text-xs leading-relaxed">
              选择故事中需要加入上下文的 <strong>实时世界状态</strong>
              ，包括“世界状态提取”每轮更新的在场角色、当前位置、背包和活跃剧情线索。这部分数据独立于上方的
              <strong>世界书条目检索</strong> 所选择的世界书设定。此步骤会完整运行于
              <strong>每一轮</strong> 正文生成，适用于所有记忆检索模式。智能记忆检索搜索世界书与章节，不搜索实时世界状态，因此无法替代此步骤。
            </p>

            {@render sliderRow({
              label: '最近条目范围',
              value: system.worldStateInjection.recentEntriesCount,
              display: `${system.worldStateInjection.recentEntriesCount} entries`,
              min: 2,
              max: 15,
              step: 1,
              help: view.help.worldStateRecentEntries,
              onChange: (v) => {
                system.worldStateInjection.recentEntriesCount = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '匹配实体上限',
              value: system.worldStateInjection.maxTier2Entries,
              display: `${system.worldStateInjection.maxTier2Entries} entities`,
              min: 5,
              max: 60,
              step: 5,
              help: '按名称匹配的实体数量上限。',
              onChange: (v) => {
                system.worldStateInjection.maxTier2Entries = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '全部纳入的预算',
              value: system.worldStateInjection.tier3WholesaleWordBudget,
              display: `${system.worldStateInjection.tier3WholesaleWordBudget} words`,
              min: 100,
              max: 2500,
              step: 100,
              help: '尚未选中的世界状态在预算内时全部纳入，无需调用模型；超出时由模型筛选，若关闭下方开关则舍弃。原版估算每条约 16 词，500 词约可容纳 30 条；中文内容的实际数量可能不同。',
              onChange: (v) => {
                system.worldStateInjection.tier3WholesaleWordBudget = v
                saveSystem()
              },
            })}

            {@render switchRow({
              label: '超出预算时由模型筛选实体',
              description:
                '剩余内容超出预算时，由模型筛选相关角色、地点、物品和任务。关闭后舍弃超预算的剩余内容；预算内的内容仍会全部纳入。',
              checked: view.worldStateLLMOn,
              onChange: (v) => {
                system.worldStateInjection.enableLLMSelection = v
                saveSystem()
              },
            })}

            {@render sliderRow({
              label: '模型筛选实体上限',
              value: system.worldStateInjection.maxTier3Entries,
              display: `${system.worldStateInjection.maxTier3Entries} entities`,
              min: 5,
              max: 80,
              step: 5,
              help: '仅限制超预算时由模型筛选的实体数量。当前地点、在场角色、携带物品、进行中任务及近期提及的保留状态不受此上限影响。',
              inactiveReason: view.inactive.worldStateMaxTier3,
              onChange: (v) => {
                system.worldStateInjection.maxTier3Entries = v
                saveSystem()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>

    <!-- Memory Retrieval -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.memoryRetrieval}>
        {@render sectionHeader({
          id: 'memoryRetrieval',
          title: '记忆检索',
          subtitle: '从过去章节检索上下文的方式',
          icon: Sparkles,
          iconWrap: 'bg-pink-500/10 group-hover/trigger:bg-pink-500/20',
          iconColor: 'text-pink-500',
          onReset: () => {
            settings.resetTimelineFillSettings()
            settings.resetAgenticRetrievalSettings()
          },
          badge: view.badges.memory,
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render switchRow({
              label: '启用记忆检索',
              description: '生成时检索过去章节中的相关内容',
              checked: view.memoryOn,
              onChange: (v) => {
                system.timelineFill.enabled = v
                saveSystem()
              },
            })}

            {#if view.memoryOn}
              <!-- Mode Selection -->
              <div class="space-y-3">
                <Label>检索模式</Label>
                <div class="grid grid-cols-2 gap-2">
                  <button
                    class="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors {view.memoryMode ===
                    'static'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'}"
                    onclick={() => {
                      system.timelineFill.mode = 'static'
                      saveSystem()
                    }}
                  >
                    <span class="text-sm font-medium">静态检索</span>
                    <span class="text-muted-foreground text-xs">
                      先生成问题，再从章节中查找答案
                    </span>
                  </button>
                  <button
                    class="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors {view.memoryMode ===
                    'agentic'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'}"
                    onclick={() => {
                      system.timelineFill.mode = 'agentic'
                      saveSystem()
                    }}
                  >
                    <span class="text-sm font-medium">智能检索</span>
                    <span class="text-muted-foreground text-xs">
                      由模型调用工具，主动查找章节和条目
                    </span>
                  </button>
                </div>
              </div>

              {#if view.memoryMode === 'static'}
                {@render sliderRow({
                  label: '查询数量上限',
                  value: system.timelineFill.maxQueries,
                  min: 1,
                  max: 10,
                  step: 1,
                  help: '用于查询历史章节的问题数量',
                  onChange: (v) => {
                    system.timelineFill.maxQueries = v
                    saveSystem()
                  },
                })}
              {/if}

              {#if view.memoryMode !== 'static'}
                {@render sliderRow({
                  label: '迭代次数上限',
                  value: system.agenticRetrieval.maxIterations,
                  min: 5,
                  max: 50,
                  step: 5,
                  help: '检索任务调用工具的最大轮数',
                  onChange: (v) => {
                    system.agenticRetrieval.maxIterations = v
                    saveSystem()
                  },
                })}

                {@render switchRow({
                  label: '启用原文搜索工具',
                  description:
                    '允许任务直接跨章节搜索故事原文，无需额外模型阅读整章，通常可降低成本。',
                  checked: view.grepOn,
                  onChange: (v) => {
                    system.agenticRetrieval.grepEnabled = v
                    saveSystem()
                  },
                })}

                {#if view.grepOn}
                  {@render sliderRow({
                    label: '每次搜索返回的引文数量',
                    value: system.agenticRetrieval.grepExcerptsPerSearch,
                    display: `${system.agenticRetrieval.grepExcerptsPerSearch} quotes`,
                    min: 5,
                    max: 60,
                    step: 1,
                    help: '控制任务每次能读取的搜索结果数量。过低可能导致信息不足，转而调用另一模型阅读整章，增加成本。',
                    onChange: (v) => {
                      system.agenticRetrieval.grepExcerptsPerSearch = v
                      saveSystem()
                    },
                  })}
                {/if}
              {/if}
            {/if}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  </div>

  <Separator />

  <!-- ==================================================================== -->
  <!-- Group 2: work that happens after the narrator has answered            -->
  <!-- ==================================================================== -->
  {@render groupHeading(
    '每轮生成之后',
    '读取刚生成的正文。通过保存的状态和记录影响后续轮次，不改变本轮正文。',
  )}

  <div class="space-y-3">
    <!-- World State Classifier -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.classifier}>
        {@render sectionHeader({
          id: 'classifier',
          title: '世界状态提取',
          subtitle: '从每段正文提取世界状态变化',
          icon: Brain,
          iconWrap: 'bg-cyan-500/10 group-hover/trigger:bg-cyan-500/20',
          iconColor: 'text-cyan-500',
          onReset: () => settings.resetClassifierSettings(),
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render sliderRow({
              label: '最近条目范围',
              value: system.classifier.recentEntriesWindow,
              display: `${system.classifier.recentEntriesWindow} entries`,
              min: CLASSIFIER_WINDOW_MIN,
              max: CLASSIFIER_WINDOW_MAX,
              step: 1,
              help: '与待分析正文一起完整发送的近期故事条目。每轮通常含动作和正文两条。',
              onChange: (v) => {
                system.classifier.recentEntriesWindow = v
                saveSystem()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>

    <!-- Style Reviewer -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.styleReviewer}>
        {@render sectionHeader({
          id: 'styleReviewer',
          title: '文风与重复分析',
          subtitle: '检测近期正文中重复的短语和叙述模式',
          icon: PenLine,
          iconWrap: 'bg-violet-500/10 group-hover/trigger:bg-violet-500/20',
          iconColor: 'text-violet-500',
          onReset: () => settings.resetStyleReviewerSettings(),
          badge: view.badges.styleReviewer,
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render switchRow({
              label: '启用文风检查',
              description: '定期分析近期正文中过度使用的表达与结构，并将结果反馈给正文生成提示词',
              checked: view.styleReviewerOn,
              onChange: (v) => {
                system.styleReviewer.enabled = v
                saveSystem()
              },
            })}

            {#if view.styleReviewerOn}
              {@render sliderRow({
                label: '检查间隔',
                value: system.styleReviewer.triggerInterval,
                display: `${system.styleReviewer.triggerInterval} turns`,
                min: 2,
                max: 32,
                step: 1,
                help: '检查的执行频率。两次检查之间会持续使用上次结果，缩短间隔会增加模型调用。',
                onChange: (v) => {
                  system.styleReviewer.triggerInterval = v
                  saveSystem()
                },
              })}

              {@render sliderRow({
                label: '最近条目范围',
                value: system.styleReviewer.recentEntriesCount,
                display: `${system.styleReviewer.recentEntriesCount} entries`,
                min: 4,
                max: 64,
                step: 1,
                help: '用于重复分析的近期正文条目数，不包含玩家动作。',
                onChange: (v) => {
                  system.styleReviewer.recentEntriesCount = v
                  saveSystem()
                },
              })}
            {/if}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>

    <!-- Lore Management -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.loreManagement}>
        {@render sectionHeader({
          id: 'loreManagement',
          title: '设定管理',
          subtitle: '自主任务限制与条目合并',
          icon: BookOpen,
          iconWrap: 'bg-purple-500/10 group-hover/trigger:bg-purple-500/20',
          iconColor: 'text-purple-500',
          onReset: () => settings.resetLoreManagementSettings(),
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render sliderRow({
              label: '迭代次数上限',
              value: system.loreManagement.maxIterations,
              min: 10,
              max: 100,
              step: 5,
              ends: ['Conservative', 'Extensive'],
              onChange: (v) => {
                system.loreManagement.maxIterations = v
                saveSystem()
              },
            })}

            {@render switchRow({
              label: '要求处理重复条目',
              description:
                '任务始终会看到名称相同或近似的条目。开启后，必须合并每组条目或明确它们是不同事物才能结束，有助于减少重复，但可能延长运行时间。',
              checked: service.loreManagement.requireDuplicateResolution,
              onChange: (v) => {
                service.loreManagement.requireDuplicateResolution = v
                saveService()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  </div>

  <Separator />

  <!-- ==================================================================== -->
  <!-- Group 3: everything that is not the narrator turn                     -->
  <!-- ==================================================================== -->
  {@render groupHeading('建议与导入', '这些辅助功能各自使用独立的上下文预算，不直接修改正文。')}

  <div class="space-y-3">
    <!-- Suggestions & Choices (was "Context Window") -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.suggestions}>
        {@render sectionHeader({
          id: 'suggestions',
          title: '剧情建议与行动选项',
          subtitle: '生成剧情建议和行动选项时使用的上下文数量',
          icon: Layers,
          iconWrap: 'bg-blue-500/10 group-hover/trigger:bg-blue-500/20',
          iconColor: 'text-blue-500',
          onReset: () => {
            settings.resetContextWindowSettings()
            settings.resetLorebookLimitsSettings()
          },
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render sliderRow({
              label: '剧情建议',
              value: service.contextWindow.recentEntriesForSuggestions,
              display: `${service.contextWindow.recentEntriesForSuggestions} entries`,
              min: 2,
              max: 15,
              step: 1,
              help: '生成剧情建议时读取的近期故事条目数量。条目检索与世界状态注入使用各自独立的范围。',
              onChange: (v) => {
                service.contextWindow.recentEntriesForSuggestions = v
                saveService()
              },
            })}

            {@render sliderRow({
              label: '行动选项',
              value: service.contextWindow.recentEntriesForChoices,
              display: `${service.contextWindow.recentEntriesForChoices} entries`,
              min: 1,
              max: 10,
              step: 1,
              help: '生成行动选项时使用的条目数量',
              onChange: (v) => {
                service.contextWindow.recentEntriesForChoices = v
                saveService()
              },
            })}

            {@render sliderRow({
              label: '剧情建议使用的世界书条目',
              value: service.lorebookLimits.maxForSuggestions,
              display: `${service.lorebookLimits.maxForSuggestions} entries`,
              min: 5,
              max: 30,
              step: 5,
              help: '生成剧情建议时包含的世界书条目上限',
              onChange: (v) => {
                service.lorebookLimits.maxForSuggestions = v
                saveService()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>

    <!-- Lorebook Import -->
    <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
      <Collapsible.Root bind:open={openSections.lorebookImport}>
        {@render sectionHeader({
          id: 'lorebookImport',
          title: '世界书导入',
          subtitle: '批量大小与并发数',
          icon: FolderOpen,
          iconWrap: 'bg-green-500/10 group-hover/trigger:bg-green-500/20',
          iconColor: 'text-green-500',
          onReset: () => settings.resetLorebookClassifierSpecificSettings(),
        })}

        <Collapsible.Content>
          <div class="bg-muted/10 space-y-6 border-t p-4">
            {@render sliderRow({
              label: '批量大小',
              value: service.lorebookClassifier.batchSize,
              min: 10,
              max: 100,
              step: 10,
              ends: ['Reliable', 'Fast'],
              onChange: (v) => {
                service.lorebookClassifier.batchSize = v
                saveService()
              },
            })}

            {@render sliderRow({
              label: '最大并发请求数',
              value: service.lorebookClassifier.maxConcurrent,
              min: 1,
              max: 10,
              step: 1,
              ends: ['Sequential', 'Parallel'],
              onChange: (v) => {
                service.lorebookClassifier.maxConcurrent = v
                saveService()
              },
            })}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  </div>
</div>
