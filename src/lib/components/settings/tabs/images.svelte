<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { createDebouncedSave } from '$lib/utils/debounce'
  import { settings } from '$lib/stores/settings.svelte'
  import { Label } from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Autocomplete } from '$lib/components/ui/autocomplete'
  import { Slider } from '$lib/components/ui/slider'
  import { RotateCcw, Info, Plus, Copy, Eye, EyeOff, ChevronRight, Check } from '@lucide/svelte'
  import { Textarea } from '$lib/components/ui/textarea'
  import {
    listImageModelsByProvider,
    getProviderSamplerInfo,
    listLoras,
    generateImage,
    requiresApiKey,
    ComfyMode,
    type ImageModelInfo,
  } from '$lib/services/ai/image'
  import {
    validateApiWorkflow,
    detectWorkflowFields,
    fetchModelList,
    clearComfyCacheForUrl,
  } from '$lib/services/ai/image/providers/comfy'
  import type { ComfyCustomWorkflow } from '$lib/services/ai/image/providers/types'
  import ImageModelSelect from '$lib/components/settings/ImageModelSelect.svelte'
  import type { ImageProfile, ImageProviderType, APIProfile } from '$lib/types'
  import * as Tabs from '$lib/components/ui/tabs'
  import * as Alert from '$lib/components/ui/alert'
  import { Card, CardContent } from '$lib/components/ui/card'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { SvelteSet } from 'svelte/reactivity'
  import IconRow from '$lib/components/ui/icon-row.svelte'
  import ImageResolutionSelector from '$lib/components/settings/ImageResolutionSelector.svelte'
  import { defaultImageSpec, type ImageSpec } from '$lib/utils/image'

  const imageStyles = [
    { value: 'image-style-soft-anime', label: '柔和动漫' },
    { value: 'image-style-semi-realistic', label: '半写实动漫' },
    { value: 'image-style-photorealistic', label: '照片写实' },
  ] as const

  const providerTypes: { value: ImageProviderType; label: string }[] = [
    { value: 'nanogpt', label: 'NanoGPT' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'chutes', label: 'Chutes' },
    { value: 'pollinations', label: 'Pollinations' },
    { value: 'google', label: 'Google AI Studio' },
    { value: 'zhipu', label: '智谱 CogView' },
    { value: 'comfyui', label: 'ComfyUI' },
    { value: 'a1111', label: 'A1111 / SD.cpp / Kobold' },
  ]
  const profileModes = [
    { value: ComfyMode.CustomWorkflow, label: '自定义工作流' },
    { value: ComfyMode.BasicTxt2Img, label: '基础文生图' },
    { value: ComfyMode.LoraTxt2Img, label: 'LoRA 文生图' },
    { value: ComfyMode.UnetTxt2Img, label: 'UNet／Flux 文生图' },
  ] as const

  const clipTypeItems = [
    { value: 'lumina2', label: 'Lumina 2' },
    { value: 'flux', label: 'Flux' },
    { value: 'sd3', label: 'SD3' },
    { value: 'stable_audio', label: 'Stable Audio' },
    { value: 'mochi', label: 'Mochi' },
    { value: 'ltxv', label: 'LTX Video' },
    { value: 'cosmos', label: 'Cosmos' },
    { value: 'wan', label: 'Wan' },
    { value: 'hidream', label: 'HiDream' },
  ] as const
  const weightDtypeItems = [
    { value: 'default', label: 'default' },
    { value: 'fp8_e4m3fn', label: 'fp8_e4m3fn' },
    { value: 'fp8_e4m3fn_fast', label: 'fp8_e4m3fn_fast' },
    { value: 'fp8_e5m2', label: 'fp8_e5m2' },
  ] as const

  // Tab state
  let activeTab = $state<'profiles' | 'general' | 'characters' | 'backgrounds' | 'testing'>(
    'profiles',
  )

  // Maps profile type to the corresponding settings key
  const profileIdKey = {
    standard: 'profileId',
    portrait: 'portraitProfileId',
    reference: 'referenceProfileId',
    background: 'backgroundProfileId',
  } as const satisfies Record<string, keyof typeof settings.systemServicesSettings.imageGeneration>

  // Handle profile change
  function onProfileChange(
    profileId: string,
    type: 'standard' | 'portrait' | 'reference' | 'background',
  ) {
    settings.systemServicesSettings.imageGeneration[profileIdKey[type]] = profileId
    settings.saveSystemServicesSettings()
  }

  // Get the currently selected image profile for a type
  function getSelectedImageProfile(
    type: 'standard' | 'portrait' | 'reference' | 'background',
  ): ImageProfile | undefined {
    const profileId = settings.systemServicesSettings.imageGeneration[profileIdKey[type]]
    return profileId ? settings.getImageProfile(profileId) : undefined
  }

  // ===== Image Profile CRUD =====
  let editingProfileId = $state<string | null>(null)
  const isEditingReferenceProfile = $derived(
    editingProfileId !== null &&
      editingProfileId === settings.systemServicesSettings.imageGeneration.referenceProfileId,
  )
  let isNewProfile = $state(false)
  let suppressAutoSave = false
  let profileName = $state('')
  let profileProviderType = $state<ImageProviderType>('nanogpt')
  let profileApiKey = $state('')
  let profileBaseUrl = $state('')
  let showApiKey = $state(false)
  let showCopyDropdown = $state(false)
  let openProfileIds = new SvelteSet<string>()

  // Profile form model state
  let profileModel = $state('')
  let profileModels = $state<ImageModelInfo[]>([])
  const referenceProfileImg2ImgWarning = $derived(
    isEditingReferenceProfile &&
      !!profileModel &&
      profileModels.find((m) => m.id === profileModel)?.supportsImg2Img === false,
  )
  let isLoadingProfileModels = $state(false)
  let profileModelsError = $state<string | null>(null)

  // ComfyUI specific state
  let profileSampler = $state('dpmpp_2m_sde_gpu')
  let profileScheduler = $state('sgm_uniform')
  let profileMode = $state<string>(ComfyMode.BasicTxt2Img)
  let profileCfg = $state(1)
  let profileSteps = $state(6)
  let profilePositivePrompt = $state('')
  let profileNegativePrompt = $state('')
  let profileSamplers = $state<{ value: string; label: string }[]>([])
  let profileSchedulers = $state<{ value: string; label: string }[]>([])
  let profileLoraName = $state('')
  let profileLoraStrengthModel = $state(1.0)
  let profileLoraStrengthClip = $state(1.0)
  let availableLoras = $state<string[]>([])
  const { trigger: triggerAutoSave, flush: flushAutoSave } = createDebouncedSave(autoSaveProfile)

  // Custom workflow state
  let profileCustomWorkflow = $state<ComfyCustomWorkflow | null>(null)
  // Holds parsed workflow data while the user resolves an ambiguous picker — not yet saved to profileCustomWorkflow
  let pendingWorkflowData = $state<{
    workflow: ComfyCustomWorkflow['workflow']
    seedPath: string
    outputNodeId: string
    negativePromptPath: string | null
  } | null>(null)
  let workflowAmbiguousNodes = $state<
    Array<{
      nodeId: string
      title: string
      path: string
      textPreview: string
      kSamplerSlot: string | null
    }>
  >([])
  let workflowPickerSelection = $state<string>('')
  let workflowError = $state<string | null>(null)
  let workflowFileName = $state<string | null>(null)

  // Tracks the baseUrl active when the last cache population happened; used to
  // detect URL changes and evict stale cache entries in comfy.ts.
  let prevComfyBaseUrl: string | null = null

  // UNet mode specific state
  let profileClipName = $state('')
  let profileVaeName = $state('')
  let profileClipType = $state('lumina2')
  let profileWeightDtype = $state('default')
  let availableClips = $state<string[]>([])
  let availableVaes = $state<string[]>([])
  let isLoadingUnetModels = $state(false)
  const clipItems = $derived(availableClips.map((c) => ({ value: c, label: c })))
  const vaeItems = $derived(availableVaes.map((v) => ({ value: v, label: v })))

  const needsWorkflow = $derived(
    profileProviderType === 'comfyui' &&
      profileMode === ComfyMode.CustomWorkflow &&
      (!profileCustomWorkflow || !!pendingWorkflowData),
  )
  const canSaveProfile = $derived(!!profileName.trim() && !needsWorkflow)

  onDestroy(() => flushAutoSave())

  // Testing state
  let testProfileId = $state<string | null>(null)
  let testPrompt = $state('')
  let testSize = $state<ImageSpec>(defaultImageSpec())
  let isGeneratingTestImage = $state(false)
  let testImageResult = $state<string | null>(null)
  let testError = $state<string | null>(null)

  $effect(() => {
    // Clear stale test result when the profile changes
    void testProfileId
    testImageResult = null
    testError = null
  })

  // Derived LoRA items — avoids re-mapping on every render
  const loraItems = $derived(availableLoras.map((l) => ({ value: l, label: l })))

  // Load models for the profile form when provider/apiKey/baseUrl change
  let profileModelsReqId = 0

  async function loadProfileFormModels(
    providerType: ImageProviderType,
    apiKey: string,
    baseUrl: string,
    forceReload: boolean,
  ) {
    const effectiveBaseUrl = baseUrl || undefined
    const reqId = ++profileModelsReqId
    isLoadingProfileModels = true
    profileModelsError = null
    try {
      const models = await listImageModelsByProvider(
        providerType,
        apiKey,
        forceReload,
        effectiveBaseUrl,
      )
      // Discard stale results if a newer request has already started.
      if (reqId !== profileModelsReqId) return
      profileModels = models
    } catch (error) {
      if (reqId !== profileModelsReqId) return
      profileModelsError = error instanceof Error ? error.message : 'Failed to load models'
    } finally {
      if (reqId === profileModelsReqId) isLoadingProfileModels = false
    }
  }

  // Reactively load models when provider, apiKey, or (for ComfyUI) baseUrl changes in profile form.
  // Reactive deps are captured explicitly before untrack() so that reads inside the loader
  // functions (e.g. settings.apiSettings.llmTimeoutMs) are NOT accidentally tracked as
  // dependencies — which would cause the effect to re-run on unrelated settings changes.
  $effect(() => {
    if (editingProfileId && profileProviderType) {
      const providerType = profileProviderType
      const apiKey = profileApiKey
      const baseUrl = profileBaseUrl

      untrack(() => {
        loadProfileFormModels(providerType, apiKey, baseUrl, false)
        if (providerType === 'comfyui') {
          loadSamplerInfo(baseUrl || undefined, 'comfyui')
          loadLoras(baseUrl || undefined)
        } else if (providerType === 'a1111') {
          loadSamplerInfo(baseUrl || undefined, 'a1111')
        } else {
          profileSamplers = []
          profileSchedulers = []
        }
      })
    }
  })

  async function loadSamplerInfo(baseUrl?: string, providerType: 'comfyui' | 'a1111' = 'comfyui') {
    const info = await getProviderSamplerInfo(baseUrl, providerType)
    if ((profileBaseUrl || undefined) !== baseUrl) return
    profileSamplers = info.samplers.map((s) => ({ value: s, label: s }))
    profileSchedulers = info.schedulers.map((s) => ({ value: s, label: s }))
  }

  async function loadLoras(baseUrl?: string) {
    const loras = await listLoras(baseUrl)
    if ((profileBaseUrl || undefined) !== baseUrl) return
    availableLoras = loras
  }

  async function handleTestGenerate() {
    if (isGeneratingTestImage || !testProfileId || !testPrompt.trim()) return

    const profile = settings.getImageProfile(testProfileId)
    if (!profile) return

    const activeProfileId = testProfileId

    isGeneratingTestImage = true
    testError = null
    testImageResult = null

    try {
      const result = await generateImage({
        prompt: testPrompt.trim(),
        model: profile.model || '',
        size: testSize,
        profileId: profile.id,
      })

      if (testProfileId !== activeProfileId || !isGeneratingTestImage) return

      if (result.base64) {
        testImageResult = result.base64
      } else {
        testError = 'No image data returned'
      }
    } catch (e) {
      if (testProfileId !== activeProfileId || !isGeneratingTestImage) return
      testError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      if (testProfileId === activeProfileId) {
        isGeneratingTestImage = false
      }
    }
  }

  // Builds the provider-specific options object from current form state
  function buildProviderOptions(): Record<string, any> {
    if (profileProviderType === 'a1111') {
      return {
        steps: profileSteps,
        cfg: profileCfg,
        negativePrompt: profileNegativePrompt,
        sampler: profileSampler,
        scheduler: profileScheduler,
      }
    }
    if (profileProviderType !== 'comfyui') return {}
    const opts: Record<string, any> = {
      sampler: profileSampler,
      scheduler: profileScheduler,
      mode: profileMode,
      cfg: profileCfg ?? 1,
      step: profileSteps ?? 6,
      positivePrompt: profilePositivePrompt,
      negativePrompt: profileNegativePrompt,
    }
    if (profileLoraName) {
      opts.lora = {
        name: profileLoraName,
        strengthModel: profileLoraStrengthModel ?? 1,
        strengthClip: profileLoraStrengthClip ?? 1,
      }
    }
    if (profileCustomWorkflow) {
      opts.customWorkflow = profileCustomWorkflow
    }
    if (profileMode === ComfyMode.UnetTxt2Img) {
      if (profileClipName) opts.clipName = profileClipName
      if (profileVaeName) opts.vaeName = profileVaeName
      if (profileClipType) opts.clipType = profileClipType
      if (profileWeightDtype) opts.weightDtype = profileWeightDtype
    }
    return opts
  }

  // Save current profile edits (called when collapsible closes)
  async function autoSaveProfile() {
    if (isNewProfile || !editingProfileId || !canSaveProfile) return

    await settings.updateImageProfile(editingProfileId, {
      name: profileName.trim(),
      providerType: profileProviderType,
      apiKey: profileApiKey,
      baseUrl: profileBaseUrl || undefined,
      model: profileModel,
      providerOptions: buildProviderOptions(),
    })
  }

  $effect(() => {
    if (editingProfileId && !isNewProfile) {
      // Touch all form fields so Svelte tracks them as dependencies
      void [
        profileName,
        profileProviderType,
        profileApiKey,
        profileBaseUrl,
        profileModel,
        profileSampler,
        profileScheduler,
        profileMode,
        profileCfg,
        profileSteps,
        profilePositivePrompt,
        profileNegativePrompt,
        profileLoraName,
        profileLoraStrengthModel,
        profileLoraStrengthClip,
        profileCustomWorkflow,
        profileClipName,
        profileVaeName,
        profileClipType,
        profileWeightDtype,
        // a1111 fields reuse profileSteps, profileCfg, profileNegativePrompt, profileSampler
      ]
      // Skip the first run after startEditProfile populates the form
      if (suppressAutoSave) {
        suppressAutoSave = false
        return
      }
      triggerAutoSave()
    }
  })

  // Aliased for clarity in UI but uses the same logic
  function saveEditingProfile() {
    flushAutoSave()
  }

  function startNewProfile() {
    if (editingProfileId) {
      saveEditingProfile()
    }
    editingProfileId = crypto.randomUUID()
    isNewProfile = true
    profileName = ''
    profileProviderType = 'nanogpt'
    profileApiKey = ''
    profileBaseUrl = ''
    profileModel = ''
    profileModels = []
    profileSampler = 'dpmpp_2m_sde_gpu'
    profileScheduler = 'sgm_uniform'
    profileMode = ComfyMode.BasicTxt2Img
    profileCfg = 7
    profileSteps = 20
    profilePositivePrompt = ''
    profileNegativePrompt = ''
    prevComfyBaseUrl = null
    profileCustomWorkflow = null
    pendingWorkflowData = null
    workflowAmbiguousNodes = []
    workflowPickerSelection = ''
    workflowError = null
    workflowFileName = null
    profileClipName = ''
    profileVaeName = ''
    profileClipType = 'lumina2'
    profileWeightDtype = 'default'
    availableClips = []
    availableVaes = []
    showApiKey = false
    showCopyDropdown = false
    openProfileIds.clear()
  }

  function startEditProfile(profile: ImageProfile) {
    if (editingProfileId && editingProfileId !== profile.id) {
      saveEditingProfile()
    }
    suppressAutoSave = true
    editingProfileId = profile.id
    isNewProfile = false
    profileName = profile.name
    profileProviderType = profile.providerType
    profileApiKey = profile.apiKey
    prevComfyBaseUrl = null
    profileBaseUrl = profile.baseUrl || ''
    profileModel = profile.model || ''
    profileModels = []

    if (profile.providerType === 'a1111') {
      const opts = profile.providerOptions || {}
      profileSteps = Number(opts.steps) || 20
      profileCfg = Number(opts.cfg) || 7
      profileNegativePrompt = (opts.negativePrompt as string) || ''
      profileSampler = (opts.sampler as string) || 'Euler a'
      profileScheduler = (opts.scheduler as string) || 'karras'
    }

    if (profile.providerType === 'comfyui') {
      const opts = profile.providerOptions || {}
      profileSampler = (opts.sampler as string) || 'dpmpp_2m_sde_gpu'
      profileScheduler = (opts.scheduler as string) || 'sgm_uniform'
      profileMode = (opts.mode as string) || ComfyMode.BasicTxt2Img
      profileCfg = Number(opts.cfg) || 1
      profileSteps = Number(opts.step) || 6
      profilePositivePrompt = (opts.positivePrompt as string) || ''
      profileNegativePrompt = (opts.negativePrompt as string) || ''
      profileCustomWorkflow = (opts.customWorkflow as ComfyCustomWorkflow) || null
      pendingWorkflowData = null
      workflowFileName = profileCustomWorkflow ? 'Loaded from profile' : null
      workflowAmbiguousNodes = []
      workflowPickerSelection = ''
      workflowError = null
      profileClipName = (opts.clipName as string) || ''
      profileVaeName = (opts.vaeName as string) || ''
      profileClipType = (opts.clipType as string) || 'lumina2'
      profileWeightDtype = (opts.weightDtype as string) || 'default'
      availableClips = []
      availableVaes = []
      if (opts.lora) {
        const lora = opts.lora as any
        profileLoraName = lora.name || ''
        profileLoraStrengthModel = lora.strengthModel ?? 1.0
        profileLoraStrengthClip = lora.strengthClip ?? 1.0
      } else {
        profileLoraName = ''
        profileLoraStrengthModel = 1.0
        profileLoraStrengthClip = 1.0
      }
    }

    showApiKey = false
    showCopyDropdown = false
    openProfileIds.add(profile.id)
  }

  function resetEditState() {
    editingProfileId = null
    isNewProfile = false
    showCopyDropdown = false
  }

  async function handleSaveProfile() {
    if (!canSaveProfile) return

    await settings.addImageProfile({
      name: profileName.trim(),
      providerType: profileProviderType,
      apiKey: profileApiKey,
      baseUrl: profileBaseUrl || undefined,
      model: profileModel,
      providerOptions: buildProviderOptions(),
    })

    resetEditState()
  }

  async function deleteProfile(id: string) {
    await settings.deleteImageProfile(id)
    if (editingProfileId === id) resetEditState()
  }

  function copyApiKeyFromProfile(apiProfile: APIProfile) {
    profileApiKey = apiProfile.apiKey
    showCopyDropdown = false
  }

  function handleProfileOpenChange(open: boolean, profile: ImageProfile) {
    if (open) {
      startEditProfile(profile)
    } else {
      if (editingProfileId === profile.id) {
        saveEditingProfile()
        resetEditState()
      }
      openProfileIds.delete(profile.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Custom workflow handlers
  // ---------------------------------------------------------------------------

  /**
   * Called after a file is selected or JSON is pasted.
   * Validates the JSON, runs detection, and either auto-confirms or shows the picker.
   */
  function processWorkflowJson(json: unknown, filename: string) {
    workflowError = null
    workflowAmbiguousNodes = []
    workflowPickerSelection = ''

    const validationError = validateApiWorkflow(json)
    if (validationError) {
      workflowError = validationError
      return
    }

    const workflow = json as ComfyCustomWorkflow['workflow']
    const { positiveNodes, negativeNode, seedPath, outputNodeId, saveImageCount } =
      detectWorkflowFields(workflow)

    if (positiveNodes.length === 0) {
      workflowError = 'No CLIPTextEncode (positive) node found in workflow.'
      return
    }
    if (!seedPath) {
      workflowError = 'No KSampler or KSamplerAdvanced node found — cannot detect seed path.'
      return
    }
    if (saveImageCount === 0) {
      workflowError = 'No SaveImage node found in workflow.'
      return
    }
    if (saveImageCount > 1) {
      workflowError = `Workflow has ${saveImageCount} SaveImage nodes. Please keep exactly one SaveImage node.`
      return
    }

    workflowFileName = filename

    if (positiveNodes.length > 1) {
      // Ambiguous — show picker. Store parsed data in pending state; do NOT write
      // profileCustomWorkflow yet so the auto-save effect doesn't fire prematurely.
      pendingWorkflowData = {
        workflow,
        seedPath,
        outputNodeId: outputNodeId!,
        negativePromptPath: negativeNode?.path ?? null,
      }
      workflowAmbiguousNodes = positiveNodes
      workflowPickerSelection = positiveNodes[0].path
    } else {
      // Unambiguous — auto-confirm immediately
      pendingWorkflowData = null
      profileCustomWorkflow = {
        workflow,
        positivePromptPath: positiveNodes[0].path,
        seedPath,
        outputNodeId: outputNodeId!,
        negativePromptPath: negativeNode?.path ?? null,
      }
      workflowAmbiguousNodes = []
    }
  }

  function handleWorkflowFileInput(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string)
        processWorkflowJson(json, file.name)
      } catch {
        workflowError = 'Invalid JSON file.'
      }
    }
    reader.readAsText(file)
    // Reset input so the same file can be re-selected after clearing
    input.value = ''
  }

  function confirmWorkflowPicker() {
    if (!pendingWorkflowData || !workflowPickerSelection) return
    profileCustomWorkflow = { ...pendingWorkflowData, positivePromptPath: workflowPickerSelection }
    pendingWorkflowData = null
    workflowAmbiguousNodes = []
  }

  function clearCustomWorkflow() {
    profileCustomWorkflow = null
    pendingWorkflowData = null
    workflowAmbiguousNodes = []
    workflowPickerSelection = ''
    workflowError = null
    workflowFileName = null
  }

  // ---------------------------------------------------------------------------
  // UNet model loading
  // ---------------------------------------------------------------------------

  let unetModelsReqId = 0

  async function loadUnetModels() {
    if (profileProviderType !== 'comfyui') return
    const baseUrl = profileBaseUrl?.trim() || 'http://localhost:8188'
    const reqId = ++unetModelsReqId
    isLoadingUnetModels = true
    try {
      const [clips, vaes] = await Promise.all([
        fetchModelList(baseUrl, 'text_encoders', settings.apiSettings.llmTimeoutMs),
        fetchModelList(baseUrl, 'vae', settings.apiSettings.llmTimeoutMs),
      ])
      if (reqId !== unetModelsReqId) return
      availableClips = clips
      availableVaes = vaes
    } finally {
      if (reqId === unetModelsReqId) isLoadingUnetModels = false
    }
  }

  // Auto-load when switching to UNet mode
  $effect(() => {
    if (profileMode === ComfyMode.UnetTxt2Img && availableClips.length === 0) {
      untrack(() => void loadUnetModels())
    }
  })

  // Evict comfy.ts caches when the user changes the ComfyUI base URL so that
  // the next generate/listModels call fetches fresh model lists.
  // Also clear availableClips/Vaes so the auto-load effect can trigger a fresh fetch.
  $effect(() => {
    if (profileProviderType === 'comfyui') {
      const currentUrl = profileBaseUrl.trim() || 'http://localhost:8188'
      if (prevComfyBaseUrl !== null && prevComfyBaseUrl !== currentUrl) {
        clearComfyCacheForUrl(prevComfyBaseUrl)
        availableClips = []
        availableVaes = []
      }
      prevComfyBaseUrl = currentUrl
    } else {
      if (prevComfyBaseUrl !== null) {
        clearComfyCacheForUrl(prevComfyBaseUrl)
      }
      prevComfyBaseUrl = null
      availableClips = []
      availableVaes = []
    }
  })
</script>

<div class="space-y-4">
  <div class="flex items-center justify-end">
    <Button variant="ghost" size="sm" onclick={() => settings.resetImageGenerationSettings()}>
      <RotateCcw class="mr-1 h-3 w-3" />
      恢复默认设置
    </Button>
  </div>

  <Tabs.Root value={activeTab} onValueChange={(v) => (activeTab = v as typeof activeTab)}>
    <Tabs.List class="grid w-full {settings.uiSettings.debugMode ? 'grid-cols-5' : 'grid-cols-4'}">
      <Tabs.Trigger value="profiles">配置</Tabs.Trigger>
      <Tabs.Trigger value="general">故事插图</Tabs.Trigger>
      <Tabs.Trigger value="characters">角色</Tabs.Trigger>
      <Tabs.Trigger value="backgrounds">背景</Tabs.Trigger>
      {#if settings.uiSettings.debugMode}
        <Tabs.Trigger value="testing">测试</Tabs.Trigger>
      {/if}
    </Tabs.List>

    <div class="mt-4 min-h-[400px]">
      <!-- Profiles Tab -->
      <Tabs.Content value="profiles" class="space-y-4">
        <div class="flex items-center justify-between">
          <p class="text-muted-foreground text-sm">图片配置用于指定图片生成的服务商和 API 密钥。</p>
          <Button size="sm" onclick={startNewProfile}>
            <Plus class="mr-1 h-3 w-3" />
            添加配置
          </Button>
        </div>

        <!-- New Profile Form (inline) -->
        {#if isNewProfile && editingProfileId}
          <Card class="border-primary/50 bg-primary/5">
            <CardContent>
              {@render profileForm()}
              {#if needsWorkflow}
                <p class="text-destructive pt-2 text-xs">保存前请上传并确认工作流。</p>
              {/if}
              <div class="flex gap-2 pt-2">
                <Button variant="outline" onclick={resetEditState} class="flex-1">取消</Button>
                <Button onclick={handleSaveProfile} disabled={!canSaveProfile} class="flex-1">
                  <Check class="h-4 w-4" />
                  创建配置
                </Button>
              </div>
            </CardContent>
          </Card>
        {/if}

        {#if settings.imageProfiles.length === 0 && !isNewProfile}
          <Alert.Root>
            <Info class="h-4 w-4" />
            <Alert.Title>暂无图片配置</Alert.Title>
            <Alert.Description class="text-xs">
              创建图片配置后即可生成图片。可以为不同服务商或用途（如肖像和背景）分别建立配置。
            </Alert.Description>
          </Alert.Root>
        {:else}
          <div class="space-y-3">
            {#each settings.imageProfiles as profile (profile.id)}
              <div class="bg-card text-card-foreground rounded-lg border shadow-sm">
                <Collapsible.Root
                  open={openProfileIds.has(profile.id)}
                  onOpenChange={(open) => handleProfileOpenChange(open, profile)}
                >
                  <div class="flex items-center gap-3 p-3 pl-4">
                    <Collapsible.Trigger
                      class="group/trigger flex flex-1 items-center gap-2 text-left"
                    >
                      <ChevronRight
                        class="h-4 w-4 transition-transform duration-200 group-data-[state=open]/trigger:rotate-90"
                      />
                      <div class="min-w-0 flex-1">
                        <span class="text-sm font-medium">{profile.name}</span>
                        <p class="text-muted-foreground text-xs">
                          {providerTypes.find((p) => p.value === profile.providerType)?.label ||
                            profile.providerType}
                          {profile.model ? ` · ${profile.model}` : ''}
                          {profile.apiKey ? '· 已配置密钥' : '· 未配置密钥'}
                        </p>
                      </div>
                    </Collapsible.Trigger>
                    <div class="flex shrink-0 items-center gap-1">
                      <IconRow onDelete={() => deleteProfile(profile.id)} size="icon" />
                    </div>
                  </div>

                  <Collapsible.Content>
                    {#if editingProfileId === profile.id}
                      <div class="bg-muted/10 space-y-4 border-t p-4">
                        {@render profileForm()}
                      </div>
                    {/if}
                  </Collapsible.Content>
                </Collapsible.Root>
              </div>
            {/each}
          </div>
        {/if}
      </Tabs.Content>

      <!-- General Tab -->
      <Tabs.Content value="general" class="space-y-6">
        <p class="text-muted-foreground text-sm">
          中文写作：在故事设置或创建时的“写作偏好”开启“手动插图”，再点击正文操作栏中的“生成插图”（移动端在更多菜单中）。每次一张，正常续写不自动配图。冒险模式在“视觉呈现”选择智能选图或内嵌插图。
        </p>
        <section class="space-y-6">
          <div class="bg-muted/10 space-y-6 rounded-lg border p-4">
            <div class="space-y-3">
              <Alert.Root>
                <Info class="h-4 w-4" />
                <Alert.Title>故事插图配置选择</Alert.Title>
                <Alert.Description class="text-xs">
                  <ul class="mt-2 list-inside list-disc space-y-1">
                    <li>
                      <strong>参考图配置</strong
                      >：在故事启用“肖像模式”时使用，根据角色肖像生成图片。
                    </li>
                    <li>
                      <strong>普通图片配置</strong>：在故事关闭“肖像模式”时使用。
                    </li>
                  </ul>
                  <p class="mt-2">模型可在“配置”页签的各个配置中设置。</p>
                </Alert.Description>
              </Alert.Root>
            </div>

            <div class="grid gap-6 md:grid-cols-2">
              <!-- Standard Image Configuration -->
              <div class="space-y-4">
                <div class="space-y-2">
                  <Label>普通图片配置</Label>
                  <Autocomplete
                    items={settings.imageProfiles}
                    selected={getSelectedImageProfile('standard')}
                    onSelect={(v) => onProfileChange((v as ImageProfile).id, 'standard')}
                    itemLabel={(p: ImageProfile) =>
                      `${p.name} (${providerTypes.find((t) => t.value === p.providerType)?.label || p.providerType}${p.model ? ` · ${p.model}` : ''})`}
                    itemValue={(p: ImageProfile) => p.id}
                    placeholder="选择图片配置"
                  />
                </div>

                {#if settings.systemServicesSettings.imageGeneration.profileId}
                  <ImageResolutionSelector
                    label="普通图片尺寸"
                    size={settings.systemServicesSettings.imageGeneration.size}
                    onSizeChange={(v) => {
                      settings.systemServicesSettings.imageGeneration.size = v
                      settings.saveSystemServicesSettings()
                    }}
                  />
                {/if}
              </div>

              <!-- Reference Image Configuration -->
              <div class="space-y-4">
                <div class="space-y-2">
                  <Label>参考图（图生图）配置</Label>
                  <Autocomplete
                    items={settings.imageProfiles}
                    selected={getSelectedImageProfile('reference')}
                    onSelect={(v) => onProfileChange((v as ImageProfile).id, 'reference')}
                    itemLabel={(p: ImageProfile) =>
                      `${p.name} (${providerTypes.find((t) => t.value === p.providerType)?.label || p.providerType}${p.model ? ` · ${p.model}` : ''})`}
                    itemValue={(p: ImageProfile) => p.id}
                    placeholder="选择图片配置"
                  />
                </div>

                {#if settings.systemServicesSettings.imageGeneration.referenceProfileId || settings.systemServicesSettings.imageGeneration.profileId}
                  <ImageResolutionSelector
                    label="参考图生成尺寸"
                    size={settings.systemServicesSettings.imageGeneration.referenceSize}
                    onSizeChange={(v) => {
                      settings.systemServicesSettings.imageGeneration.referenceSize = v
                      settings.saveSystemServicesSettings()
                    }}
                  />
                {/if}
              </div>
            </div>
          </div>

          <!-- Image Style -->
          <div class="space-y-2">
            <Label>故事插图风格</Label>
            <Autocomplete
              items={imageStyles}
              selected={imageStyles.find(
                (s) => s.value === settings.systemServicesSettings.imageGeneration.styleId,
              )}
              onSelect={(v) => {
                settings.systemServicesSettings.imageGeneration.styleId = (
                  v as { value: string }
                ).value
                settings.saveSystemServicesSettings()
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择风格"
            />
            <p class="text-muted-foreground mt-1 text-xs">
              生成故事插图的视觉风格，可通过主页或设置中的“提示词管理”编辑。
            </p>
          </div>

          <!-- Max Images Per Message -->
          <div class="space-y-2">
            <Label>
              每条消息的图片上限： {settings.systemServicesSettings.imageGeneration
                .maxImagesPerMessage === 0
                ? '不限'
                : settings.systemServicesSettings.imageGeneration.maxImagesPerMessage}
            </Label>
            <Slider
              type="multiple"
              value={[settings.systemServicesSettings.imageGeneration.maxImagesPerMessage]}
              onValueChange={(v) => {
                settings.systemServicesSettings.imageGeneration.maxImagesPerMessage = v[0]
                settings.saveSystemServicesSettings()
              }}
              min={0}
              max={5}
              step={1}
            />
          </div>
        </section>
      </Tabs.Content>

      <!-- Characters Tab -->
      <Tabs.Content value="characters" class="space-y-6">
        <p class="text-muted-foreground text-sm">
          使用入口：故事侧栏“角色” → 编辑角色 → 外貌特征下的“生成肖像” → 保存修改。
          自动读取人物资料与相关世界书，外貌框可以留空。需要在生成设置绑定“图片生成”的文本分析模型，
          并在此选择角色肖像图片配置；不依赖普通插图配置。默认生成全身立绘，补全细节仅用于图片。
        </p>
        <section class="space-y-4">
          <div class="space-y-2">
            <Label>角色肖像配置</Label>
            <Autocomplete
              items={settings.imageProfiles}
              selected={getSelectedImageProfile('portrait')}
              onSelect={(v) => onProfileChange((v as ImageProfile).id, 'portrait')}
              itemLabel={(p: ImageProfile) =>
                `${p.name} (${providerTypes.find((t) => t.value === p.providerType)?.label || p.providerType}${p.model ? ` · ${p.model}` : ''})`}
              itemValue={(p: ImageProfile) => p.id}
              placeholder="选择图片配置"
            />
            <p class="text-muted-foreground mt-1 text-xs">
              生成角色肖像时使用的配置，模型在该配置中设置。
            </p>
          </div>

          {#if settings.systemServicesSettings.imageGeneration.portraitProfileId || settings.systemServicesSettings.imageGeneration.profileId}
            <ImageResolutionSelector
              label="角色肖像尺寸"
              size={settings.systemServicesSettings.imageGeneration.portraitSize}
              onSizeChange={(v) => {
                settings.systemServicesSettings.imageGeneration.portraitSize = v
                settings.saveSystemServicesSettings()
              }}
            />
          {/if}

          <div class="space-y-2">
            <Label>角色肖像风格</Label>
            <Autocomplete
              items={imageStyles}
              selected={imageStyles.find(
                (s) => s.value === settings.systemServicesSettings.imageGeneration.portraitStyleId,
              )}
              onSelect={(v) => {
                settings.systemServicesSettings.imageGeneration.portraitStyleId = (
                  v as { value: string }
                ).value
                settings.saveSystemServicesSettings()
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择风格"
            />
            <p class="text-muted-foreground mt-1 text-xs">
              角色肖像的视觉风格，可通过主页或设置中的“提示词管理”编辑。
            </p>
          </div>
        </section>
      </Tabs.Content>

      <!-- Backgrounds Tab -->
      <Tabs.Content value="backgrounds" class="space-y-6">
        <p class="text-muted-foreground text-sm">
          在故事设置或创建时的“写作偏好”开启“自动场景背景”后，系统随故事生成判断场景是否需要更新背景。选择配置不会自动开启；无需配置普通插图服务。
        </p>
        <section class="space-y-4">
          <div class="space-y-2">
            <Label>背景图片配置</Label>
            <Autocomplete
              items={settings.imageProfiles}
              selected={getSelectedImageProfile('background')}
              onSelect={(v) => onProfileChange((v as ImageProfile).id, 'background')}
              itemLabel={(p: ImageProfile) =>
                `${p.name} (${providerTypes.find((t) => t.value === p.providerType)?.label || p.providerType}${p.model ? ` · ${p.model}` : ''})`}
              itemValue={(p: ImageProfile) => p.id}
              placeholder="选择图片配置"
            />
            <p class="text-muted-foreground mt-1 text-xs">
              生成背景场景时使用的配置，模型在该配置中设置。
            </p>
          </div>

          <ImageResolutionSelector
            label="背景尺寸"
            size={settings.systemServicesSettings.imageGeneration.backgroundSize}
            onSizeChange={(v) => {
              settings.systemServicesSettings.imageGeneration.backgroundSize = v
              settings.saveSystemServicesSettings()
            }}
          />

          <div class="space-y-2">
            <Label>
              背景模糊程度： {settings.systemServicesSettings.imageGeneration.backgroundBlur}px
            </Label>
            <Slider
              type="multiple"
              value={[settings.systemServicesSettings.imageGeneration.backgroundBlur]}
              onValueChange={(v: number[]) => {
                settings.systemServicesSettings.imageGeneration.backgroundBlur = v[0]
                settings.saveSystemServicesSettings()
              }}
              min={0}
              max={20}
              step={1}
            />
            <p class="text-muted-foreground mt-1 text-xs">背景图片的模糊程度。</p>
          </div>
        </section>
      </Tabs.Content>

      {#if settings.uiSettings.debugMode}
        <Tabs.Content value="testing" class="space-y-6">
          <section class="space-y-4">
            <div class="space-y-2">
              <Label>测试配置</Label>
              <Autocomplete
                items={settings.imageProfiles}
                selected={settings.imageProfiles.find((p) => p.id === testProfileId)}
                onSelect={(v) => (testProfileId = (v as ImageProfile).id)}
                itemLabel={(p: ImageProfile) =>
                  `${p.name} (${providerTypes.find((t) => t.value === p.providerType)?.label || p.providerType}${p.model ? ` · ${p.model}` : ''})`}
                itemValue={(p: ImageProfile) => p.id}
                placeholder="选择要测试的配置"
              />
            </div>

            <div class="space-y-2">
              <Label>提示词</Label>
              <Textarea bind:value={testPrompt} placeholder="输入测试提示词…" rows={4} />
            </div>

            <ImageResolutionSelector
              label="尺寸"
              size={testSize}
              onSizeChange={(v) => (testSize = v)}
            />

            <Button
              onclick={handleTestGenerate}
              disabled={isGeneratingTestImage || !testProfileId || !testPrompt.trim()}
              class="w-full"
            >
              {#if isGeneratingTestImage}
                <RotateCcw class="mr-2 h-4 w-4 animate-spin" />
                正在生成…
              {:else}
                生成测试图片
              {/if}
            </Button>

            {#if testError}
              <Alert.Root variant="destructive">
                <Alert.Title>生成出错</Alert.Title>
                <Alert.Description>{testError}</Alert.Description>
              </Alert.Root>
            {/if}

            {#if testImageResult}
              <div class="mt-4 space-y-2">
                <Label>结果图片</Label>
                <div class="overflow-hidden rounded-lg border bg-black/5">
                  <img
                    src="data:image/png;base64,{testImageResult}"
                    alt="测试生成结果"
                    class="mx-auto block h-auto max-w-full"
                  />
                </div>
              </div>
            {/if}
          </section>
        </Tabs.Content>
      {/if}
    </div>
  </Tabs.Root>
</div>

{#snippet profileForm()}
  <div class="space-y-4">
    <div class="space-y-2">
      <Label>名称</Label>
      <Input bind:value={profileName} placeholder="例如：NanoGPT 图片" />
    </div>

    <div class="space-y-2">
      <Label>服务商</Label>
      <Autocomplete
        items={providerTypes}
        selected={providerTypes.find((p) => p.value === profileProviderType)}
        onSelect={(v) => {
          profileProviderType = (v as { value: ImageProviderType }).value
        }}
        itemLabel={(p: { label: string }) => p.label}
        itemValue={(p: { value: string }) => p.value}
        placeholder="选择服务商"
      />
    </div>

    {#if requiresApiKey(profileProviderType)}
      <div class="space-y-2">
        <Label>API 密钥</Label>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <Input
              type={showApiKey ? 'text' : 'password'}
              bind:value={profileApiKey}
              placeholder="输入 API 密钥"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center pr-3"
              onclick={() => (showApiKey = !showApiKey)}
            >
              {#if showApiKey}
                <EyeOff class="text-muted-foreground h-4 w-4" />
              {:else}
                <Eye class="text-muted-foreground h-4 w-4" />
              {/if}
            </button>
          </div>
        </div>

        {#if settings.apiSettings.profiles.length > 0}
          <div class="relative">
            <Button
              variant="outline"
              size="sm"
              onclick={() => (showCopyDropdown = !showCopyDropdown)}
            >
              <Copy class="mr-1 h-3 w-3" />
              从 API 配置复制
            </Button>
            {#if showCopyDropdown}
              <div class="bg-popover absolute z-10 mt-1 w-64 rounded-md border shadow-md">
                {#each settings.apiSettings.profiles as apiProfile (apiProfile.id)}
                  <button
                    type="button"
                    class="hover:bg-accent w-full px-3 py-2 text-left text-sm"
                    onclick={() => copyApiKeyFromProfile(apiProfile)}
                  >
                    {apiProfile.name}
                    <span class="text-muted-foreground text-xs">({apiProfile.providerType})</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if profileProviderType === 'comfyui' || profileProviderType === 'openai' || profileProviderType === 'zhipu' || profileProviderType === 'a1111'}
      <div class="space-y-2">
        <Label>基础地址（可选）</Label>
        <Input bind:value={profileBaseUrl} placeholder="自定义基础地址" />
      </div>
    {/if}

    {#snippet modelSelectContent()}
      <Label>模型</Label>
      <ImageModelSelect
        models={profileModels}
        selectedModelId={profileModel}
        onModelChange={(id) => {
          profileModel = id
        }}
        showCost={true}
        showImg2ImgIndicator={true}
        showDescription={profileProviderType === 'comfyui'}
        isLoading={isLoadingProfileModels}
        errorMessage={profileModelsError}
        showRefreshButton={true}
        onRefresh={() =>
          loadProfileFormModels(profileProviderType, profileApiKey, profileBaseUrl, true)}
      />
      {#if referenceProfileImg2ImgWarning}
        <p class="text-warning mt-1 text-xs">
          此配置用于参考图生成（图生图），但所选模型不支持图生图。
        </p>
      {:else}
        <p class="text-muted-foreground mt-1 text-xs">此配置生成图片时使用的模型。</p>
      {/if}
    {/snippet}

    {#if profileProviderType !== 'comfyui' && profileProviderType !== 'a1111'}
      <div class="space-y-2">
        {@render modelSelectContent()}
      </div>
    {/if}
    {#if profileProviderType === 'a1111'}
      <div class="space-y-2">
        {@render modelSelectContent()}
      </div>
      <div class="grid grid-cols-2 gap-4 pt-2">
        <div class="space-y-2">
          <Label>采样步数</Label>
          <Input type="number" bind:value={profileSteps} placeholder="20" min="1" />
        </div>
        <div class="space-y-2">
          <Label>提示词引导强度（CFG）</Label>
          <Input type="number" bind:value={profileCfg} placeholder="7" step="0.5" />
        </div>
        <div class="space-y-2">
          <Label>采样器</Label>
          <Autocomplete
            items={profileSamplers}
            selected={profileSamplers.find((s) => s.value === profileSampler)}
            onSelect={(v) => {
              profileSampler = (v as { value: string }).value
            }}
            itemLabel={(s: { label: string }) => s.label}
            itemValue={(s: { value: string }) => s.value}
            placeholder="Euler a"
          />
        </div>
        <div class="space-y-2">
          <Label>调度器</Label>
          <Autocomplete
            items={profileSchedulers}
            selected={profileSchedulers.find((s) => s.value === profileScheduler)}
            onSelect={(v) => {
              profileScheduler = (v as { value: string }).value
            }}
            itemLabel={(s: { label: string }) => s.label}
            itemValue={(s: { value: string }) => s.value}
            placeholder="karras"
          />
        </div>
        <div class="col-span-2 space-y-2">
          <Label>负面提示词</Label>
          <Textarea bind:value={profileNegativePrompt} placeholder="负面提示词…" />
        </div>
      </div>
    {/if}
    {#if profileProviderType === 'comfyui'}
      <div class="grid grid-cols-2 gap-4 pt-2">
        <div class="col-span-2 space-y-2">
          <Label>模式</Label>
          <Autocomplete
            items={profileModes}
            selected={profileModes.find((s) => s.value === profileMode)}
            onSelect={(v) => {
              profileMode = (v as { value: string }).value
            }}
            itemLabel={(s: { label: string }) => s.label}
            itemValue={(s: { value: string }) => s.value}
            placeholder="选择模式"
          />
        </div>
        {#if profileMode !== ComfyMode.CustomWorkflow}
          <div class="col-span-2 space-y-2">
            {@render modelSelectContent()}
          </div>
          <div class="space-y-2">
            <Label>采样器</Label>
            <Autocomplete
              items={profileSamplers}
              selected={profileSamplers.find((s) => s.value === profileSampler)}
              onSelect={(v) => {
                profileSampler = (v as { value: string }).value
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择采样器"
            />
          </div>
          <div class="space-y-2">
            <Label>调度器</Label>
            <Autocomplete
              items={profileSchedulers}
              selected={profileSchedulers.find((s) => s.value === profileScheduler)}
              onSelect={(v) => {
                profileScheduler = (v as { value: string }).value
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择调度器"
            />
          </div>
          <div class="space-y-2">
            <Label>CFG</Label>
            <Input type="number" bind:value={profileCfg} placeholder="输入 CFG 强度" step="0.1" />
          </div>
          <div class="space-y-2">
            <Label>采样步数</Label>
            <Input type="number" bind:value={profileSteps} placeholder="输入采样步数" />
          </div>
        {/if}
        <div class="col-span-2 space-y-2">
          <Label>基础正面提示词</Label>
          <Textarea bind:value={profilePositivePrompt} placeholder="基础正面提示词…" />
        </div>
        {#if (profileMode !== ComfyMode.CustomWorkflow && profileMode !== ComfyMode.UnetTxt2Img) || profileCustomWorkflow?.negativePromptPath}
          <div class="col-span-2 space-y-2">
            <Label>负面提示词</Label>
            <Textarea bind:value={profileNegativePrompt} placeholder="负面提示词…" />
          </div>
        {/if}

        {#if profileMode === ComfyMode.CustomWorkflow}
          <div class="col-span-2 space-y-3 border-t pt-3">
            <div class="flex items-center justify-between">
              <Label>自定义工作流（API 格式）</Label>
              {#if profileCustomWorkflow}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-destructive text-xs underline"
                  onclick={clearCustomWorkflow}
                >
                  清空
                </button>
              {/if}
            </div>

            {#if profileCustomWorkflow && workflowAmbiguousNodes.length === 0}
              <!-- State B: workflow loaded and confirmed -->
              <div class="bg-muted/40 space-y-1 rounded-md border px-3 py-2 text-xs">
                <p class="text-foreground font-medium">
                  ✓ {workflowFileName ?? '已加载工作流'} ({Object.keys(
                    profileCustomWorkflow.workflow,
                  ).length} 个节点）
                </p>
                <p class="text-muted-foreground">
                  提示词 → <code class="text-xs">{profileCustomWorkflow.positivePromptPath}</code>
                </p>
                <p class="text-muted-foreground">
                  种子 → <code class="text-xs">{profileCustomWorkflow.seedPath}</code>
                </p>
                {#if profileCustomWorkflow.negativePromptPath}
                  <p class="text-muted-foreground">
                    负面提示词 → <code class="text-xs"
                      >{profileCustomWorkflow.negativePromptPath}</code
                    >
                  </p>
                {:else}
                  <p class="text-muted-foreground italic">未检测到负面提示词节点（将忽略）。</p>
                {/if}
              </div>
            {:else if workflowAmbiguousNodes.length > 0}
              <!-- Picker: multiple CLIPTextEncode positive nodes found -->
              <div class="bg-muted/40 space-y-2 rounded-md border px-3 py-2">
                <p class="text-muted-foreground text-xs">
                  检测到多个提示词节点，请选择正面提示词节点：
                </p>
                {#each workflowAmbiguousNodes as node (node.nodeId)}
                  <label
                    class="hover:bg-muted/60 flex cursor-pointer items-start gap-2.5 rounded p-1.5 text-xs transition-colors"
                  >
                    <input
                      type="radio"
                      name="workflow-positive-node"
                      value={node.path}
                      bind:group={workflowPickerSelection}
                      class="mt-0.5 shrink-0"
                    />
                    <span class="flex flex-col gap-0.5">
                      <span class="font-mono text-[11px]"
                        >{node.nodeId}{#if node.title}
                          <span class="text-muted-foreground font-sans">— {node.title}</span>{/if}
                        {#if node.kSamplerSlot}
                          <span
                            class="bg-primary/10 text-primary ml-1 rounded px-1 py-0.5 font-sans text-[10px] not-italic"
                            >{node.kSamplerSlot}</span
                          >
                        {/if}
                      </span>
                      <span class="text-muted-foreground italic">{node.textPreview}</span>
                    </span>
                  </label>
                {/each}
                <Button size="sm" class="w-full" onclick={confirmWorkflowPicker}>确认选择</Button>
              </div>
            {:else}
              <!-- State A: no workflow loaded -->
              <details class="group text-xs">
                <summary
                  class="text-muted-foreground hover:text-foreground mb-2 cursor-pointer list-none select-none"
                >
                  <span class="underline underline-offset-2">如何获取工作流文件 ›</span>
                </summary>
                <ol class="text-muted-foreground mt-1 space-y-1.5 pl-1">
                  <li>
                    <span class="text-foreground font-medium">1. 启动 ComfyUI 并启用 CORS：</span>
                    <br />
                    <code class="bg-muted mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px]">
                      python main.py --enable-cors-header
                    </code>
                  </li>
                  <li>
                    <span class="text-foreground font-medium">2. 在 ComfyUI 中启用开发模式：</span>
                    <br />
                    打开 ComfyUI 网页界面 → 点击
                    <strong>齿轮图标（⚙）</strong> → 启用
                    <strong>Dev Mode（开发模式）</strong>。工具栏中会出现
                    <em>“Save (API Format)”</em> 按钮。
                  </li>
                  <li>
                    <span class="text-foreground font-medium">3. 导出工作流：</span>
                    <br />
                    创建或加载工作流，然后点击
                    <strong>Save (API Format)</strong>。将保存一个
                    <code class="text-[11px]">.json</code> 文件，供本应用读取。
                  </li>
                  <li>
                    <span class="text-foreground font-medium">4. 在下方上传文件。</span>
                    <br />
                    应用会自动检测提示词和种子节点。如果存在多个提示词节点，需要选择其中一个。
                  </li>
                </ol>
              </details>
              <label
                class="border-input hover:border-primary flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-4 py-3 text-sm transition-colors"
              >
                <input
                  type="file"
                  accept=".json,application/json"
                  class="hidden"
                  onchange={handleWorkflowFileInput}
                />
                <span class="text-muted-foreground">上传工作流 JSON（API 格式）</span>
              </label>
            {/if}

            {#if workflowError}
              <p class="text-destructive text-xs">{workflowError}</p>
            {/if}
          </div>
        {/if}
      </div>
      {#if profileMode === ComfyMode.LoraTxt2Img}
        <div class="grid grid-cols-2 gap-4 pt-2">
          <div class="col-span-2 space-y-2">
            <Label>LoRA 模型</Label>
            <Autocomplete
              items={loraItems}
              selected={availableLoras.includes(profileLoraName)
                ? { value: profileLoraName, label: profileLoraName }
                : undefined}
              onSelect={(v) => {
                profileLoraName = (v as { value: string }).value
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择 LoRA…"
            />
            <p class="text-muted-foreground text-xs">选择 LoRA 以应用风格或角色细节。</p>
          </div>

          {#if profileLoraName}
            <div class="space-y-2">
              <Label>模型强度</Label>
              <Input
                type="number"
                bind:value={profileLoraStrengthModel}
                placeholder="模型强度"
                step="0.05"
              />
            </div>
            <div class="space-y-2">
              <Label>CLIP 强度</Label>
              <Input
                type="number"
                bind:value={profileLoraStrengthClip}
                placeholder="CLIP 强度"
                step="0.05"
              />
            </div>
          {/if}
        </div>
      {/if}
      {#if profileMode === ComfyMode.UnetTxt2Img}
        <div class="grid grid-cols-2 gap-4 pt-2">
          <div class="col-span-2 space-y-2">
            <div class="flex items-center justify-between">
              <Label>CLIP／文本编码器</Label>
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground text-xs underline"
                disabled={isLoadingUnetModels}
                onclick={loadUnetModels}
              >
                {isLoadingUnetModels ? '正在加载…' : '↻ 刷新'}
              </button>
            </div>
            <Autocomplete
              items={clipItems}
              selected={availableClips.includes(profileClipName)
                ? { value: profileClipName, label: profileClipName }
                : profileClipName
                  ? { value: profileClipName, label: profileClipName }
                  : undefined}
              onSelect={(v) => {
                profileClipName = (v as { value: string }).value
              }}
              allowCustom={true}
              onCustomSelect={(v) => {
                profileClipName = v
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="自动检测首个可用项"
            />
            <p class="text-muted-foreground text-xs">
              留空时自动使用 ComfyUI 中找到的首个文本编码器。
            </p>
          </div>

          <div class="col-span-2 space-y-2">
            <Label>VAE</Label>
            <Autocomplete
              items={vaeItems}
              selected={availableVaes.includes(profileVaeName)
                ? { value: profileVaeName, label: profileVaeName }
                : profileVaeName
                  ? { value: profileVaeName, label: profileVaeName }
                  : undefined}
              onSelect={(v) => {
                profileVaeName = (v as { value: string }).value
              }}
              allowCustom={true}
              onCustomSelect={(v) => {
                profileVaeName = v
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="自动检测首个可用项"
            />
            <p class="text-muted-foreground text-xs">留空时自动使用 ComfyUI 中找到的首个 VAE。</p>
          </div>

          <div class="space-y-2">
            <Label>CLIP 类型</Label>
            <Autocomplete
              items={clipTypeItems}
              selected={clipTypeItems.find((s) => s.value === profileClipType)}
              onSelect={(v) => {
                profileClipType = (v as { value: string }).value
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择 CLIP 类型"
            />
          </div>

          <div class="space-y-2">
            <Label>权重数据类型</Label>
            <Autocomplete
              items={weightDtypeItems}
              selected={weightDtypeItems.find((s) => s.value === profileWeightDtype)}
              onSelect={(v) => {
                profileWeightDtype = (v as { value: string }).value
              }}
              itemLabel={(s: { label: string }) => s.label}
              itemValue={(s: { value: string }) => s.value}
              placeholder="选择数据类型"
            />
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}
