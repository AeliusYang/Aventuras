<script lang="ts">
  import { untrack } from 'svelte'
  import { story } from '$lib/stores/story.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { database } from '$lib/services/database'
  import { parseJson } from '$lib/services/characterCardImport/parseJson'
  import { createCardDraft } from '$lib/services/storySetup/draft'
  import CardOrganization from '../wizard/CardOrganization.svelte'

  const current = untrack(() => story.currentStory!)
  const source = untrack(() => current.settings!.importSource!)
  const scope = {
    storyId: current.id,
    branchId: current.currentBranchId ?? null,
    rawJson: source.rawCardJson!,
  }
  const parsed = parseJson(scope.rawJson)
  const initialCard = parsed
    ? createCardDraft(parsed, scope.rawJson, source.originalFilename ?? '角色卡')
    : null
  if (initialCard && source.selections) initialCard.selections = { ...source.selections }
  if (initialCard)
    for (const item of [...initialCard.characters, ...initialCard.lore]) {
      if (source.excludedSourceKeys?.includes(item.key)) item.selected = false
    }
  let card = $state(initialCard)
  let packId = $state('')
  let variables = $state<Record<string, string>>({})
  let error = $state('')
  let ready = $state(false)
  $effect(() => {
    if (ui.settingsModalOpen) {
      ready = false
      return
    }
    let active = true
    void Promise.all([
      database.getStoryPackId(current.id),
      database.getStoryCustomVariables(current.id),
    ])
      .then(([pack, values]) => {
        if (active) {
          packId = pack || 'default-pack'
          variables = values ?? {}
          ready = true
        }
      })
      .catch((cause) => {
        if (active) error = String(cause)
      })
    return () => {
      active = false
    }
  })
</script>

{#if error}<p class="text-destructive text-sm">{error}</p>{/if}
{#if card && ready}
  <CardOrganization
    {card}
    {packId}
    {variables}
    disabled={ui.isGenerating ||
      !!ui.submissionScope ||
      story.currentStory?.settings?.importSource?.organizationEnabled === false}
    onApply={async (candidate) => {
      const result = await story.applyImportOrganization(candidate, {
        ...scope,
        packId,
        variables: $state.snapshot(variables),
      })
      card = candidate
      ui.showToast(
        `整理已采用，新增 ${result.charactersAdded} 个配角，更新 ${result.charactersUpdated} 个配角，新增 ${result.loreEntriesAdded} 条世界书。`,
        'info',
      )
    }}
    onEditPrompt={(templateId) => ui.openPromptPackEditor(packId, templateId)}
  />
{:else if !card}<p class="text-destructive text-sm">原始角色卡无法解析，现有故事未改变。</p>{/if}
