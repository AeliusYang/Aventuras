<script lang="ts">
  import { database } from '$lib/services/database'
  import { CollaborativePromptService } from '$lib/services/ai/core/CollaborativePromptService'
  import type { CollaborativeInspectionContext } from '$lib/services/ai/core/CollaborativePromptService'
  import {
    collaborativeServiceIds,
    getCollaborativeAgentTemplateId,
  } from '$lib/services/ai/core/collaborativeAgentDefaults'
  import type { CollaborativeAgentKey } from '$lib/types/collaborative'
  import { Button } from '$lib/components/ui/button'

  let {
    storyId,
    storyContext,
    packId,
    templateId,
    dirty = false,
  }: {
    storyId?: string
    storyContext?: CollaborativeInspectionContext
    packId: string
    templateId: string
    dirty?: boolean
  } = $props()
  const agent = $derived(
    (Object.keys(collaborativeServiceIds) as CollaborativeAgentKey[]).find(
      (key) => getCollaborativeAgentTemplateId(key) === templateId,
    ),
  )
  let result = $state<Awaited<ReturnType<typeof CollaborativePromptService.render>> | null>(null)
  let error = $state('')
  let loading = $state(false)
  let sequence = 0
  $effect(() => {
    storyId
    storyContext
    packId
    templateId
    dirty
    sequence++
    result = null
    error = ''
    loading = false
  })

  async function inspect() {
    if (!storyId || !agent) return
    const ticket = ++sequence
    loading = true
    error = ''
    result = null
    try {
      const actualPack = (await database.getStoryPackId(storyId)) || 'default-pack'
      if (actualPack !== packId)
        throw new Error('此提示词包不是当前故事实际绑定的包。请从故事设置打开提示词管理。')
      const preview = await CollaborativePromptService.render(
        storyId,
        agent,
        { preview: true },
        {},
        storyContext,
      )
      if (ticket === sequence) result = preview
    } catch (cause) {
      if (ticket === sequence) error = cause instanceof Error ? cause.message : '无法检查提示词'
    } finally {
      if (ticket === sequence) loading = false
    }
  }
</script>

{#if agent}
  <details class="max-h-[55vh] shrink-0 overflow-auto border-b p-3 text-xs">
    <summary class="cursor-pointer font-medium">高级检查</summary>
    <div class="mt-3 space-y-3">
      <p class="text-muted-foreground">
        当前故事预览使用已保存的模板和实际模型绑定，不调用模型；不是历史请求快照，也不使用编辑器的测试变量。
      </p>
      <p class="text-muted-foreground">
        尚未提交的本轮输入、检索结果和 Director 简报显示为缺失；当前正文仅用于历史上下文。
      </p>
      {#if !storyId}<p>请先打开一个故事，再检查实际绑定。</p>{/if}
      {#if dirty}<p>编辑内容尚未保存。请保存后刷新检查。</p>{/if}
      <Button size="sm" variant="outline" onclick={inspect} disabled={!storyId || dirty || loading}>
        {loading ? '检查中…' : '刷新当前故事预览'}
      </Button>
      {#if error}<p class="text-destructive" role="alert">{error}</p>{/if}
      {#if result}
        <p>故事：{storyId} · Pack：{result.packId} · 请求模板：{result.templateId}</p>
        <p>
          Agent Profile：{result.preset.name}（{result.presetId}） · 模型：{result.preset.model} · 连接：{result
            .profile.name}（{result.profile.providerType}）
        </p>
        <p>
          System：{result.resolvedSystemSource} / {result.systemTemplateId} · User：{result.userSource}
          / {result.userTemplateId}
        </p>
        <p>
          上面的实际模板 ID 可用于区分 canonical 模板与 legacy 回退；Writer
          的运行时人称约束包含在下方 System 中。
        </p>
        {#if agent === 'writer' && !result.hasDirectorBrief}<p>
            本轮 Director 简报：尚未产生，预览留空。
          </p>{/if}
        <p>缺少变量：{result.missingVariables.join('、') || '无'}</p>
        <details>
          <summary>变量与当前值</summary>
          <pre class="overflow-auto whitespace-pre-wrap">{JSON.stringify(
              result.variableValues,
              null,
              2,
            )}</pre>
        </details>
        <details>
          <summary>System</summary>
          <pre class="overflow-auto whitespace-pre-wrap">{result.system}</pre>
        </details>
        <details>
          <summary>User</summary>
          <pre class="overflow-auto whitespace-pre-wrap">{result.user}</pre>
        </details>
        <details>
          <summary>STpreset 来源</summary>
          <p>
            System：{result.provenance?.systemCustomized
              ? '已修改，与内置模板不同'
              : '与内置模板一致'}；User：{result.provenance?.userCustomized
              ? '已修改，与内置模板不同'
              : '与内置模板一致'}。
          </p>
          <p>以下为内置模板的规则溯源，不代表用户修改内容来自这些预设。</p>
          {#each result.provenance?.sources ?? [] as source}
            <p>
              {source.source} · {source.sourceEntry} · {source.ruleId} · {source.adaptation}：{source.reason}
            </p>
          {:else}<p>此内置模板没有登记 STpreset 来源。</p>{/each}
        </details>
      {/if}
    </div>
  </details>
{/if}
