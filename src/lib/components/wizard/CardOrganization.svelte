<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import MaterialEditor from './MaterialEditor.svelte'
  import type { CardImportDraft } from '$lib/services/storySetup/draft'
  import {
    organizeCard,
    applyOrganization,
    inspectOrganization,
  } from '$lib/services/storySetup/organization'
  import { errMessage } from '$lib/utils/error'

  let {
    card,
    packId,
    variables,
    disabled = false,
    onApply,
    onEditPrompt,
  }: {
    card: CardImportDraft
    packId: string
    variables: Record<string, string>
    disabled?: boolean
    onApply: (card: CardImportDraft) => void | Promise<void>
    onEditPrompt: (templateId: string) => void
  } = $props()
  let busy = $state(false)
  let applying = $state(false)
  let error = $state('')
  let warnings = $state<string[]>([])
  let candidate = $state<CardImportDraft | null>(null)
  let inspection = $state<Awaited<ReturnType<typeof inspectOrganization>>>([])
  let controller: AbortController | undefined
  let request = 0
  let candidateKey = ''
  const inputKey = $derived(JSON.stringify([card, packId, variables, disabled]))
  $effect(() => {
    void inputKey
    cancel()
    candidate = null
    inspection = []
    warnings = []
    error = ''
  })
  onDestroy(cancel)
  function cancel() {
    request++
    controller?.abort()
    controller = undefined
    busy = false
  }
  async function run() {
    if (disabled || busy || !packId) return
    cancel()
    const id = ++request
    const key = inputKey
    controller = new AbortController()
    busy = true
    error = ''
    candidate = null
    warnings = []
    try {
      const source = $state.snapshot(card)
      const result = await organizeCard(
        source,
        packId,
        $state.snapshot(variables),
        controller.signal,
      )
      if (id !== request || key !== inputKey) return
      warnings = result.warnings
      if (result.scenario || result.character) {
        candidate = applyOrganization(source, result)
        candidateKey = key
      }
    } catch (cause) {
      if (id === request) error = errMessage(cause)
    } finally {
      if (id === request) busy = false
    }
  }
  async function inspect() {
    const id = ++request,
      key = inputKey
    try {
      const result = await inspectOrganization(
        $state.snapshot(card),
        packId,
        $state.snapshot(variables),
      )
      if (id === request && key === inputKey) inspection = result
    } catch (cause) {
      if (id === request) error = errMessage(cause)
    }
  }
  async function apply() {
    if (!candidate || disabled || applying || candidateKey !== inputKey) return
    applying = true
    error = ''
    try {
      await onApply($state.snapshot(candidate))
      candidate = null
    } catch (cause) {
      error = errMessage(cause)
    } finally {
      applying = false
    }
  }
</script>

<div class="space-y-3 rounded border p-3">
  <p class="text-sm">AI 整理（按需）：生成候选资料，查看、编辑并采用后才生效。</p>
  <div class="flex flex-wrap gap-2">
    <Button
      size="sm"
      variant="secondary"
      onclick={run}
      disabled={disabled ||
        busy ||
        applying ||
        !packId ||
        (!card.selections.characters && !card.selections.scenario)}
      >{busy ? '正在整理…' : '用 AI 整理'}</Button
    >
    {#if busy}<Button
        size="sm"
        variant="outline"
        onclick={() => {
          cancel()
          error = '已取消整理，现有资料未改变。'
        }}>取消</Button
      >{/if}
    <Button size="sm" variant="outline" onclick={inspect} disabled={disabled || busy || applying}
      >检查实际提示词</Button
    >
  </div>
  {#if error}<p class="text-destructive text-sm" role="alert">{error}</p>{/if}
  {#each warnings as warning, index (index)}<p class="text-sm text-amber-600">{warning}</p>{/each}
  {#if candidate && !disabled}
    <div class="space-y-3">
      <p class="font-medium">候选结果（尚未采用）</p>
      {#if candidate.selections.scenario}<label class="block text-sm"
          >背景<textarea
            class="bg-background mt-1 w-full rounded border p-2"
            rows="5"
            bind:value={candidate.background}></textarea></label
        >{/if}
      <MaterialEditor
        bind:characters={candidate.characters}
        showCharacters={candidate.selections.characters}
        showLore={false}
      />
      <Button size="sm" onclick={apply} disabled={applying}
        >{applying ? '正在保存…' : '采用整理结果'}</Button
      >
    </div>
  {/if}
  {#each inspection as item (item.templateId)}
    <details class="rounded border p-2">
      <summary class="cursor-pointer">{item.templateId} · 提示词检查</summary>
      <div class="space-y-2 text-xs">
        <p>绑定：{item.preset.name} · {item.profile?.name ?? '未配置连接'} · {item.preset.model}</p>
        <p>
          Pack：{item.packId}；System：{item.systemSource} / {item.systemResolution
            ?.templateId}；User：{item.userSource} / {item.userResolution?.templateId}
        </p>
        <p>STpreset：{item.stPresetSource}</p>
        <p>变量：{item.variables.join(', ')}；缺失：{item.missingVariables.join(', ') || '无'}</p>
        <details>
          <summary>变量值</summary>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(
              item.context,
              null,
              2,
            )}</pre>
        </details>
        <p>System</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap">{item.system}</pre>
        <p>User</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap">{item.user}</pre>
        <Button size="sm" variant="outline" onclick={() => onEditPrompt(item.templateId)}
          >编辑当前 Pack</Button
        >
      </div>
    </details>
  {/each}
</div>
