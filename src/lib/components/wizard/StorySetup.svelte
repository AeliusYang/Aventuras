<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import * as ResponsiveModal from '$lib/components/ui/responsive-modal'
  import { Button } from '$lib/components/ui/button'
  import StepPackSelection from './steps/StepPackSelection.svelte'
  import MaterialEditor from './MaterialEditor.svelte'
  import CardOrganization from './CardOrganization.svelte'
  import WritingStyleFields from '$lib/components/shared/WritingStyleFields.svelte'
  import UniversalVaultBrowser from '$lib/components/vault/UniversalVaultBrowser.svelte'
  import {
    createSetupDraft,
    createCardDraft,
    selectedSetup,
    setupPayload,
    setupProblems,
    migrateLegacyDraft,
    restoreSetupDraft,
  } from '$lib/services/storySetup/draft'
  import type { StorySetupDraft } from '$lib/services/storySetup/draft'
  import { CharacterCardImport } from '$lib/services/characterCardImport'
  import { parseSTChat } from '$lib/services/stChatImporter'
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import { packService, missingRequiredVariables } from '$lib/services/packs/pack-service'
  import { database } from '$lib/services/database'
  import type { PresetPack, CustomVariable } from '$lib/services/packs/types'
  import type { StoryMode, VaultCharacter, VaultLorebook, VaultScenario } from '$lib/types'
  import { scenarioService } from '$lib/services/ai/wizard/ScenarioService'
  import { ImageStore } from '$lib/stores/wizard/imageStore.svelte'
  import { hasRequiredCredentials } from '$lib/services/ai/image'
  import { errMessage } from '$lib/utils/error'

  let {
    onClose,
    initialMode = 'adventure',
    isImport = false,
  }: { onClose: () => void; initialMode?: StoryMode; isImport?: boolean } = $props()
  const mode = untrack(() => initialMode)
  const importing = untrack(() => isImport)
  const storageKey = `aventuras:story-setup-v1:${mode}:${importing ? 'import' : 'new'}`
  const legacyKey = importing
    ? 'aventuras:creative-st-import-draft'
    : 'aventuras:creative-quick-start-draft'
  let draft = $state<StorySetupDraft>(createSetupDraft(mode))
  let step = $state(1)
  let ready = $state(false)
  let busy = $state(false)
  let committedId = $state('')
  let loadingFile = $state(false)
  let packBusy = $state(false)
  let packLoadError = $state('')
  let storageWarning = $state('')
  let generating = $state(false)
  let error = $state('')
  let recoveryError = $state('')
  let packs = $state<PresetPack[]>([])
  let variables = $state<CustomVariable[]>([])
  let vault = $state<'character' | 'lorebook' | 'scenario' | null>(null)
  let generatedOpening = $state('')
  let generatedKey = ''
  let fileRevision = 0
  let packRevision = 0
  let alive = true
  const image = new ImageStore(() => draft.packId)
  const selected = $derived(selectedSetup(draft))
  const problems = $derived([
    ...setupProblems(draft),
    ...(packLoadError ? [packLoadError] : []),
    ...(ready && !packs.some((p) => p.id === draft.packId)
      ? ['所选提示词包已不存在，请重新选择。']
      : []),
    ...missingRequiredVariables(variables, draft.variables).map(
      (v) => `请填写提示词包变量：${v.displayName}。`,
    ),
  ])
  const imageEnabled = $derived(hasRequiredCredentials())
  const draftKey = $derived(JSON.stringify(draft))
  $effect(() => {
    if (ready && !busy && !committedId && !recoveryError) {
      try {
        localStorage.setItem(storageKey, draftKey)
        storageWarning = ''
      } catch {
        storageWarning =
          '本地草稿空间不足。本窗口内资料仍保留，可直接创建故事；关闭窗口后未保存的修改可能丢失。'
      }
    }
  })
  $effect(() => {
    if (generatedKey && generatedKey !== draftKey) generatedOpening = ''
  })
  onDestroy(() => {
    alive = false
    fileRevision++
    packRevision++
  })

  onMount(async () => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        draft = restoreSetupDraft(JSON.parse(saved), mode)
      } else if (mode === 'creative-writing') {
        const legacy = localStorage.getItem(legacyKey)
        if (legacy) {
          const value = JSON.parse(legacy)
          draft = migrateLegacyDraft(mode, value)
          if (value.cardRawJson) {
            const card = CharacterCardImport.parseJson(value.cardRawJson)
            if (!card) throw new Error('旧角色卡草稿无法解析')
            draft.card = createCardDraft(
              card,
              value.cardRawJson,
              value.cardFilename || '角色卡.json',
            )
            draft.openingSource = 'card'
          }
          if (value.chatText) {
            const chat = parseSTChat(value.chatText)
            if (!chat.success) throw new Error(chat.error)
            draft.chat = { filename: value.chatFilename || '聊天.jsonl', messages: chat.messages }
            draft.openingSource = 'chat'
          }
        }
      }
    } catch (cause) {
      recoveryError = `草稿未覆盖：${errMessage(cause)}。可以保留备份后重新开始。`
    }
    try {
      draft.packId = await packService.resolveSetupPackId(mode, importing, draft.packId)
      packs = await packService.getAllPacks()
      await loadVariables(draft.packId, true)
    } catch (cause) {
      error = errMessage(cause)
    } finally {
      ready = true
    }
  })

  async function loadVariables(id: string, preserve = false) {
    const revision = ++packRevision
    draft.packId = id
    packBusy = true
    packLoadError = ''
    try {
      const result = await database.getPackVariables(id)
      if (!alive || revision !== packRevision) return
      variables = result
      const defaults = Object.fromEntries(result.map((v) => [v.variableName, v.defaultValue ?? '']))
      draft.variables = preserve ? { ...defaults, ...draft.variables } : defaults
    } catch (cause) {
      if (revision === packRevision)
        packLoadError = `提示词包变量加载失败，请重新选择该包：${errMessage(cause)}`
    } finally {
      if (revision === packRevision) packBusy = false
    }
  }
  function resetDraft() {
    const raw = localStorage.getItem(storageKey)
    if (raw) localStorage.setItem(`${storageKey}:recovery:${Date.now()}`, raw)
    const packId = draft.packId
    draft = createSetupDraft(mode)
    draft.packId = packId
    recoveryError = ''
    step = 1
    void loadVariables(packId)
  }
  async function readCard(file?: File) {
    if (!file) return
    const revision = ++fileRevision
    loadingFile = true
    error = ''
    try {
      const raw = await CharacterCardImport.readFile(file)
      const parsed = CharacterCardImport.parseJson(raw)
      if (!parsed) throw new Error('无法解析角色卡，请选择 PNG 或 JSON 文件。')
      let portrait: string | undefined
      if (file.name.toLowerCase().endsWith('.png'))
        portrait = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
      if (!alive || revision !== fileRevision) return
      draft.card = createCardDraft(parsed, raw, file.name, portrait)
      if (!draft.title.trim()) draft.title = parsed.name
      draft.openingSource = draft.chat ? 'chat' : 'card'
    } catch (cause) {
      if (revision === fileRevision) error = errMessage(cause)
    } finally {
      if (revision === fileRevision) loadingFile = false
    }
  }
  async function readChat(file?: File) {
    if (!file) return
    const revision = ++fileRevision
    loadingFile = true
    error = ''
    try {
      const result = parseSTChat(await file.text())
      if (!result.success) throw new Error(result.error)
      if (!alive || revision !== fileRevision) return
      draft.chat = { filename: file.name, messages: result.messages }
      draft.openingSource = 'chat'
      if (!draft.title.trim()) draft.title = result.characterName
    } catch (cause) {
      if (revision === fileRevision) error = errMessage(cause)
    } finally {
      if (revision === fileRevision) loadingFile = false
    }
  }
  function editPrompt(id: string) {
    localStorage.setItem(storageKey, JSON.stringify($state.snapshot(draft)))
    ui.openPromptPackEditor(draft.packId, id)
    onClose()
  }
  function addCharacter() {
    draft.characters.push({
      key: crypto.randomUUID(),
      selected: true,
      origin: 'manual',
      value: { name: '', description: '', traits: [] },
    })
  }
  function addLore() {
    draft.lore.push({
      key: crypto.randomUUID(),
      selected: true,
      origin: 'manual',
      value: {
        name: '',
        description: '',
        type: 'concept',
        keywords: [],
        aliases: [],
        injectionMode: 'keyword',
        priority: 100,
      },
    })
  }
  function selectVault(item: VaultCharacter | VaultLorebook | VaultScenario) {
    if (vault === 'character') {
      const c = item as VaultCharacter
      draft.protagonist = {
        name: c.name,
        description: c.description,
        traits: c.traits,
        portrait: c.portrait,
        visualDescriptors: c.visualDescriptors,
      }
    }
    if (vault === 'lorebook') {
      const l = item as VaultLorebook
      for (const [index, value] of l.entries.entries()) {
        const key = `vault:${l.id}:${index}`
        if (!draft.lore.some((v) => v.key === key))
          draft.lore.push({
            key,
            selected: true,
            origin: 'manual',
            value: { ...value, keywords: value.keywords ?? [], aliases: value.aliases ?? [] },
          })
      }
    }
    if (vault === 'scenario') {
      const s = item as VaultScenario
      draft.background = s.settingSeed
      draft.characters.push(
        ...s.npcs.map((value) => ({
          key: crypto.randomUUID(),
          origin: 'manual' as const,
          selected: true,
          value,
        })),
      )
      if (s.firstMessage) {
        draft.opening = s.firstMessage
        draft.openingSource = 'manual'
      }
    }
    vault = null
  }
  async function generateOpening() {
    if (generating || packBusy || packLoadError) return
    generating = true
    error = ''
    generatedOpening = ''
    const key = draftKey
    try {
      const result = await scenarioService.generateOpening(
        draft.packId,
        {
          customVariableValues: { ...draft.variables },
          characters: selected.characters.map(({ value }) => ({
            name: value.name ?? '',
            description: value.description ?? '',
            traits: value.traits ?? [],
            role: '配角',
            relationship: value.relationship ?? '',
          })),
          mode,
          genre: 'custom',
          title: draft.title,
          settingSeed: selected.background,
          protagonist: {
            name: draft.protagonist.name ?? '',
            description: draft.protagonist.description ?? '',
            background: '',
            motivation: '',
            traits: draft.protagonist.traits ?? [],
          },
          writingStyle: { ...draft.settings, tone: draft.settings.tone ?? '' },
        },
        settings.servicePresetAssignments['wizard:openingGeneration'],
        selected.lore.map((v) => v.value),
      )
      if (!alive || key !== draftKey) return
      if (!result.scene.trim()) throw new Error('没有生成可用开场，现有内容未改变。')
      generatedKey = key
      generatedOpening = result.scene
    } catch (cause) {
      if (alive && key === draftKey) error = errMessage(cause)
    } finally {
      generating = false
    }
  }
  async function save() {
    if (busy || (!committedId && (!ready || packBusy || recoveryError || problems.length))) return
    busy = true
    error = ''
    try {
      if (!committedId) {
        const created = await story.createStoryFromWizard(setupPayload($state.snapshot(draft)))
        committedId = created.id
      }
      localStorage.removeItem(storageKey)
      if (mode === 'creative-writing') localStorage.removeItem(legacyKey)
      await story.loadStory(committedId)
      ui.resetScrollBreak()
      ui.setActivePanel('story')
      onClose()
    } catch (cause) {
      error = (committedId ? '故事已保存，打开失败；重试只会重新打开：' : '') + errMessage(cause)
      busy = false
    }
  }
</script>

<ResponsiveModal.Root
  open={true}
  dismissible={!busy}
  onOpenChange={(open) => {
    if (!open && !busy) onClose()
  }}
>
  <ResponsiveModal.Content
    class="flex h-full flex-col gap-0 p-0 sm:h-auto sm:max-h-[92vh] sm:max-w-3xl"
  >
    <div class="flex items-center justify-between border-b p-4">
      <div>
        <ResponsiveModal.Title
          >{importing ? '导入' : '新建'}{mode === 'creative-writing'
            ? '中文写作'
            : '冒险故事'}</ResponsiveModal.Title
        >
        <ResponsiveModal.Description
          >{importing
            ? `步骤 ${step} / 2：${step === 1 ? '选择文件' : '确认导入'}`
            : '填写想确定的内容，其余资料可以以后补充。'}</ResponsiveModal.Description
        >
      </div>
      <Button variant="ghost" disabled={busy} onclick={onClose}>关闭</Button>
    </div>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {#if recoveryError}<p class="text-destructive" role="alert">{recoveryError}</p>
        <Button onclick={resetDraft}>保留备份并重新开始</Button>{/if}
      {#if error}<p class="text-destructive whitespace-pre-wrap" role="alert">{error}</p>{/if}
      {#if storageWarning}<p class="text-sm text-amber-600" role="status">{storageWarning}</p>{/if}
      {#if importing && step === 1}
        <p class="text-sm">可选择角色卡、聊天记录，或同时选择。此步骤不调用 AI。</p>
        <label class="block space-y-2 rounded border p-4"
          >角色卡（PNG / JSON）<input
            class="block w-full"
            type="file"
            accept=".png,.json"
            disabled={loadingFile}
            onchange={(e) => readCard(e.currentTarget.files?.[0])}
          /></label
        >
        {#if draft.card}<div class="flex items-center justify-between">
            <span>{draft.card.filename}</span><Button
              variant="ghost"
              onclick={() => {
                draft.card = null
                draft.openingSource = draft.chat ? 'chat' : 'manual'
              }}>移除角色卡</Button
            >
          </div>{/if}
        <label class="block space-y-2 rounded border p-4"
          >聊天记录（JSONL）<input
            class="block w-full"
            type="file"
            accept=".jsonl"
            disabled={loadingFile}
            onchange={(e) => readChat(e.currentTarget.files?.[0])}
          /></label
        >
        {#if draft.chat}<div class="flex items-center justify-between">
            <span>{draft.chat.filename} · {draft.chat.messages.length} 条消息</span><Button
              variant="ghost"
              onclick={() => {
                draft.chat = null
                draft.openingSource = draft.card ? 'card' : 'manual'
              }}>移除聊天记录</Button
            >
          </div>{/if}
      {:else}
        <fieldset class="space-y-4" disabled={busy || !!committedId}>
          <label class="block text-sm"
            >故事标题（可选）<input
              class="bg-background mt-1 w-full rounded border p-2"
              placeholder="未命名故事"
              bind:value={draft.title}
            /></label
          >
          <StepPackSelection
            availablePacks={packs}
            selectedPackId={draft.packId}
            packVariables={variables}
            variableValues={draft.variables}
            onSelectPack={(id) => loadVariables(id)}
            onVariableChange={(key, value) => (draft.variables[key] = value)}
          />
          <label class="block text-sm"
            >主角姓名{mode === 'creative-writing'
              ? '（可选；留空保留 {{user}}）'
              : '（必填）'}<input
              class="bg-background mt-1 w-full rounded border p-2"
              bind:value={draft.protagonist.name}
            /></label
          >
          {#if draft.card || draft.chat}
            <label class="block text-sm"
              >开始方式<select
                class="bg-background mt-1 w-full rounded border p-2"
                bind:value={draft.openingSource}
              >
                {#if draft.chat}<option value="chat"
                    >继续聊天历史（{draft.chat.messages.length} 条）</option
                  >{/if}
                {#if draft.card?.greetings.length}<option value="card">使用角色卡开场</option
                  >{/if}<option value="manual">自定义开场</option>
              </select></label
            >
          {/if}
          {#if draft.openingSource === 'chat' && draft.chat}
            <details>
              <summary>预览将保存的 {draft.chat.messages.length} 条消息</summary>
              <div class="max-h-64 space-y-3 overflow-auto">
                {#each draft.chat.messages as message, index (index)}<p
                    class="text-sm whitespace-pre-wrap"
                  >
                    {index + 1}. {message.content}
                  </p>{/each}
              </div>
            </details>
          {:else if draft.openingSource === 'card' && draft.card}
            {#if draft.card.greetings.length}<label class="block text-sm"
                >开场版本<select
                  class="bg-background mt-1 w-full rounded border p-2"
                  bind:value={draft.card.selectedGreeting}
                  >{#each draft.card.greetings as _, index (index)}<option value={index}
                      >开场 {index + 1}</option
                    >{/each}</select
                ></label
              >
              <label class="block text-sm"
                >开场正文<textarea
                  class="bg-background mt-1 w-full rounded border p-2"
                  rows="6"
                  bind:value={draft.card.greetings[draft.card.selectedGreeting]}></textarea></label
              >
            {:else}<p class="text-muted-foreground text-sm">
                角色卡没有开场白，可以选择自定义开场。
              </p>{/if}
          {:else}
            <label class="block text-sm"
              >开场正文（可手写或主动生成）<textarea
                class="bg-background mt-1 w-full rounded border p-2"
                rows="5"
                bind:value={draft.opening}></textarea></label
            >
          {/if}
          <Button
            size="sm"
            variant="outline"
            disabled={generating ||
              packBusy ||
              !!packLoadError ||
              !draft.packId ||
              missingRequiredVariables(variables, draft.variables).length > 0}
            onclick={generateOpening}
            >{generating ? '正在生成候选开场…' : '用 AI 生成候选开场'}</Button
          >
          {#if generatedOpening}<label class="block text-sm"
              >候选开场（尚未采用）<textarea
                class="bg-background mt-1 w-full rounded border p-2"
                rows="6"
                bind:value={generatedOpening}></textarea></label
            ><Button
              size="sm"
              onclick={() => {
                draft.opening = generatedOpening
                draft.openingSource = 'manual'
                generatedOpening = ''
              }}>采用开场</Button
            >{/if}
          {#if mode === 'creative-writing'}<label class="block text-sm"
              >第一条作者输入（可选；进入故事后发送）<textarea
                class="bg-background mt-1 w-full rounded border p-2"
                rows="3"
                bind:value={draft.initialInput}></textarea></label
            >{/if}
          {#if draft.card}
            <section class="space-y-3 rounded border p-3">
              <p class="font-medium">角色卡资料 · {draft.card.filename}</p>
              <div class="flex flex-wrap gap-4">
                <label
                  ><input type="checkbox" bind:checked={draft.card.selections.characters} /> 角色（作为配角）</label
                ><label
                  ><input type="checkbox" bind:checked={draft.card.selections.scenario} /> 场景与背景</label
                ><label
                  ><input type="checkbox" bind:checked={draft.card.selections.lorebook} /> 世界书</label
                >
              </div>
              {#if draft.card.selections.scenario}<label class="block text-sm"
                  >角色卡背景<textarea
                    class="bg-background mt-1 w-full rounded border p-2"
                    rows="4"
                    bind:value={draft.card.background}></textarea></label
                >{/if}
              <MaterialEditor
                packId={draft.packId}
                bind:characters={draft.card.characters}
                bind:lore={draft.card.lore}
                showCharacters={draft.card.selections.characters}
                showLore={draft.card.selections.lorebook}
              />
              <CardOrganization
                card={draft.card}
                packId={draft.packId}
                variables={draft.variables}
                disabled={packBusy ||
                  !!packLoadError ||
                  busy ||
                  missingRequiredVariables(variables, draft.variables).length > 0}
                onApply={(card) => {
                  draft.card = card
                }}
                onEditPrompt={editPrompt}
              />
            </section>
          {/if}
          <details class="rounded border p-3">
            <summary class="cursor-pointer">背景与限制（可选）</summary>
            <div class="mt-3 space-y-2">
              <label class="block text-sm"
                >世界背景<textarea
                  class="bg-background mt-1 w-full rounded border p-2"
                  rows="5"
                  bind:value={draft.background}></textarea></label
              ><Button size="sm" variant="outline" onclick={() => (vault = 'scenario')}
                >从场景素材库添加</Button
              >
            </div>
          </details>
          <details class="rounded border p-3">
            <summary class="cursor-pointer">角色与肖像（可选）</summary>
            <div class="mt-3 space-y-3">
              <label class="block text-sm"
                >主角资料<textarea
                  class="bg-background mt-1 w-full rounded border p-2"
                  rows="3"
                  bind:value={draft.protagonist.description}></textarea></label
              >
              <Button size="sm" variant="outline" onclick={() => (vault = 'character')}
                >从人物素材库选择主角</Button
              >
              <label class="block text-sm"
                >主角肖像<input
                  class="mt-1 block"
                  type="file"
                  accept="image/*"
                  onchange={async (e) => {
                    await image.handleProtagonistPortraitUpload(e)
                    draft.protagonist.portrait = image.protagonistPortrait
                  }}
                /></label
              >
              {#if draft.protagonist.portrait}<img
                  class="h-24 w-24 rounded object-cover"
                  src={draft.protagonist.portrait}
                  alt="主角肖像"
                /><Button
                  size="sm"
                  variant="ghost"
                  onclick={() => (draft.protagonist.portrait = null)}>移除肖像</Button
                >{/if}
              <label class="block text-sm"
                >肖像外貌描述<input
                  class="bg-background mt-1 w-full rounded border p-2"
                  bind:value={image.protagonistVisualDescriptors}
                /></label
              >
              <Button
                size="sm"
                variant="outline"
                disabled={!hasRequiredCredentials('portrait') ||
                  !draft.protagonist.name?.trim() ||
                  !image.protagonistVisualDescriptors.trim() ||
                  image.isGeneratingProtagonistPortrait}
                onclick={async () => {
                  await image.generateProtagonistPortrait({
                    name: draft.protagonist.name!,
                    description: draft.protagonist.description ?? '',
                    background: '',
                    motivation: '',
                    traits: draft.protagonist.traits ?? [],
                  })
                  draft.protagonist.portrait = image.protagonistPortrait
                }}>生成肖像</Button
              >
              {#if image.portraitError}<p class="text-destructive text-sm">
                  {image.portraitError}
                </p>{/if}
              <MaterialEditor
                packId={draft.packId}
                bind:characters={draft.characters}
                showLore={false}
              /><Button size="sm" variant="outline" onclick={addCharacter}>添加配角</Button>
            </div>
          </details>
          <details class="rounded border p-3">
            <summary class="cursor-pointer">补充世界书（可选）</summary>
            <div class="mt-3 space-y-3">
              <MaterialEditor bind:lore={draft.lore} showCharacters={false} />
              <div class="flex gap-2">
                <Button size="sm" variant="outline" onclick={addLore}>添加条目</Button><Button
                  size="sm"
                  variant="outline"
                  onclick={() => (vault = 'lorebook')}>从世界书素材库添加</Button
                >
              </div>
            </div>
          </details>
          {#if vault}<div class="rounded border p-3">
              <Button size="sm" variant="ghost" onclick={() => (vault = null)}>收起素材库</Button
              ><UniversalVaultBrowser type={vault} onSelect={selectVault} />
            </div>{/if}
          <details class="rounded border p-3">
            <summary class="cursor-pointer">写作偏好（可选）</summary>
            <div class="mt-3">
              <WritingStyleFields
                {mode}
                selectedPOV={draft.settings.pov}
                selectedTense={draft.settings.tense}
                tone={draft.settings.tone ?? ''}
                visualProseMode={draft.settings.visualProseMode ?? false}
                imageGenerationEnabled={imageEnabled}
                backgroundImagesAvailable={hasRequiredCredentials('background')}
                portraitReferenceAvailable={hasRequiredCredentials('reference')}
                imageGenerationMode={draft.settings.imageGenerationMode ?? 'none'}
                backgroundImagesEnabled={draft.settings.backgroundImagesEnabled ?? false}
                referenceMode={draft.settings.referenceMode ?? false}
                targetLength={draft.settings.targetLength}
                onPOVChange={(v) => (draft.settings.pov = v)}
                onTenseChange={(v) => (draft.settings.tense = v)}
                onToneChange={(v) => (draft.settings.tone = v)}
                onVisualProseModeChange={(v) => (draft.settings.visualProseMode = v)}
                onImageGenerationModeChange={(v) => (draft.settings.imageGenerationMode = v)}
                onBackgroundImagesEnabledChange={(v) =>
                  (draft.settings.backgroundImagesEnabled = v)}
                onReferenceModeChange={(v) => (draft.settings.referenceMode = v)}
                onTargetLengthChange={(v) => (draft.settings.targetLength = v)}
              />
            </div>
          </details>
          <p class="bg-muted/30 rounded p-3 text-sm">
            将保存：{selected.characters.length} 个配角、{selected.lore.length} 条世界书；背景{selected.background.trim()
              ? '已填写'
              : '留空'}；{selected.chatMessages
              ? `${selected.chatMessages.length} 条聊天消息`
              : selected.opening.trim()
                ? '1 个开场'
                : '无开场正文'}。
          </p>
          {#each problems as problem (problem)}<p class="text-muted-foreground text-sm">
              {problem}
            </p>{/each}
        </fieldset>
      {/if}
    </div>
    <div class="flex justify-between border-t p-4">
      {#if importing && step === 2}<Button
          variant="secondary"
          disabled={busy}
          onclick={() => (step = 1)}>上一步</Button
        >{:else}<span></span>{/if}
      {#if importing && step === 1}<Button
          disabled={!ready || loadingFile || recoveryError !== '' || (!draft.card && !draft.chat)}
          onclick={() => (step = 2)}>下一步：确认导入</Button
        >{:else}<Button
          disabled={busy ||
            (!committedId && (!ready || packBusy || !!recoveryError || problems.length > 0))}
          onclick={save}
          >{busy ? '正在保存…' : committedId ? '重新打开已保存故事' : '创建并打开故事'}</Button
        >{/if}
    </div>
  </ResponsiveModal.Content>
</ResponsiveModal.Root>
