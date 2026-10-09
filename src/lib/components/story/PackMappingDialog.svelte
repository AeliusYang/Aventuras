<!--
  The pack step of a story import — an exception, not a routine. A confident match never gets
  here; see `decidePackPrompt`. What reaches this component is a question worth asking: which
  pack, because the match is uncertain or the named pack is absent, or one missing required
  value on a pack that is otherwise settled.

  It runs after the file is read and before the first row is written, so cancelling costs
  nothing. `StepPackSelection` is reused unchanged — it is already presentational, and the state
  it renders is owned here.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import StepPackSelection from '../wizard/steps/StepPackSelection.svelte'
  import { database } from '$lib/services/database'
  import { DEFAULT_PACK_ID } from '$lib/services/packs'
  import type { PresetPack, CustomVariable } from '$lib/services/packs'
  import { customVariableValue, mergeCustomVariableValues } from '$lib/services/import'
  import type { PackBindingContext, PackBindingResolution } from '$lib/services/import'

  interface Props {
    context: PackBindingContext
    /**
     * The pack is already settled and is not up for discussion — set when a confident match only
     * needs a value the story does not carry. Suppresses the chooser by leaving it the sole
     * option, which `StepPackSelection` already renders as no dropdown at all.
     */
    lockedPack?: PresetPack | null
    /**
     * Ask about these variables only. Set alongside `lockedPack`, so a story stopped for one
     * missing answer is not made to re-review every value it already had.
     */
    onlyVariables?: string[]
    /** Resolves once, with the user's choice or `null` if they backed out. */
    onResolve: (resolution: PackBindingResolution | null) => void
  }

  let { context, lockedPack, onlyVariables, onResolve }: Props = $props()

  let open = $state(true)
  let availablePacks = $state<PresetPack[]>([])
  let selectedPackId = $state(DEFAULT_PACK_ID)
  let targetPackVariables = $state<CustomVariable[]>([])
  let packVariables = $state<CustomVariable[]>([])
  let variableValues = $state<Record<string, string>>({})
  let editedValues = $state<Record<string, string>>({})
  let loading = $state(true)
  let loadToken = 0

  /** The file's own answers, kept so switching packs can re-apply them to matching names. */
  const fileValues = $derived(context.binding?.customVariableValues ?? {})

  /** Named a pack we found, but under a different author. Worth showing, not worth hiding behind. */
  const authorMismatch = $derived(
    context.match.confidence === 'name-only' ? context.match.pack : null,
  )

  $effect(() => {
    void load()
  })

  async function load() {
    availablePacks = lockedPack ? [lockedPack] : await database.getAllPacks()
    // Pre-select the match when there is one; otherwise the built-in pack, which is where the
    // story would have landed anyway.
    selectedPackId = lockedPack?.id ?? context.match.pack?.id ?? DEFAULT_PACK_ID
    await loadVariables(selectedPackId)
    loading = false
  }

  /**
   * Load the chosen pack's variables and seed each one.
   *
   * The story's own answer wins over the pack's default wherever the name matches — the value the
   * author chose is more likely right than a default they never saw — and stays editable here.
   */
  async function loadVariables(packId: string) {
    const token = ++loadToken
    const all = await database.getPackVariables(packId)
    if (token !== loadToken) return
    targetPackVariables = all
    packVariables = onlyVariables ? all.filter((v) => onlyVariables.includes(v.variableName)) : all
    const seeded: Record<string, string> = {}
    for (const variable of packVariables) {
      seeded[variable.variableName] =
        customVariableValue(fileValues, variable.variableName) ?? variable.defaultValue ?? ''
    }
    variableValues = seeded
  }

  async function selectPack(packId: string) {
    selectedPackId = packId
    editedValues = {}
    await loadVariables(packId)
  }

  function setVariable(variableName: string, value: string) {
    variableValues = { ...variableValues, [variableName]: value }
    editedValues = { ...editedValues, [variableName]: value }
  }

  function confirm() {
    const customVariableValues = mergeCustomVariableValues(
      fileValues,
      targetPackVariables,
      editedValues,
    )
    open = false
    onResolve({
      packId: selectedPackId,
      // Keep every answer the file carried, not just the ones this pack defines: a value with no
      // counterpart here is retained so re-binding to a pack that does define it brings it back.
      ...(Object.keys(customVariableValues).length > 0 ? { customVariableValues } : {}),
    })
  }

  function cancel() {
    open = false
    onResolve(null)
  }
</script>

<Dialog.Root {open} onOpenChange={(next) => !next && cancel()}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>
        {lockedPack ? '还需补充一项故事设置' : '本故事的提示词包'}
      </Dialog.Title>
      <Dialog.Description>
        {#if lockedPack}
          此故事使用你的“{lockedPack.name}”提示词包，需要补充故事中未保存的变量值。
        {:else if context.binding && context.match.confidence === 'none'}
          <!-- Leads with the absence: the useful response may well be to cancel and go install
               the pack, which a neutral "choose one" would not suggest. -->
          此故事原来使用的提示词包“{context.binding.pack.name}"{context.binding.pack.author
            ? ` by ${context.binding.pack.author}`
            : ''} ”尚未安装在本设备上。请选择已有提示词包替代，或取消导入并先安装原提示词包。
        {:else if context.binding}
          此故事原来使用的提示词包名为“{context.binding.pack.name}"{context.binding.pack.author
            ? ` by ${context.binding.pack.author}`
            : ''}。请选择要使用的提示词包。
        {:else}
          此故事文件未记录提示词包，请选择要使用的提示词包。
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if authorMismatch}
      <p class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
        你的提示词包“{authorMismatch.name}”名称相同，但作者不同（{authorMismatch.author ??
          '未填写作者'}），可能不是同一个提示词包。
      </p>
    {/if}

    {#if !loading}
      <div class="max-h-[60vh] overflow-y-auto py-2">
        <StepPackSelection
          {availablePacks}
          {selectedPackId}
          {packVariables}
          {variableValues}
          onSelectPack={selectPack}
          onVariableChange={setVariable}
        />
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={cancel}>取消导入</Button>
      <Button onclick={confirm} disabled={loading}>导入故事</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
