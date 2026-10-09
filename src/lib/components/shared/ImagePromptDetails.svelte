<script lang="ts">
  import type { ImagePromptDiagnostic } from '$lib/services/image/diagnostics'
  import { ui } from '$lib/stores/ui.svelte'
  let {
    diagnostic,
    beforeOpen = () => true,
  }: { diagnostic: ImagePromptDiagnostic | null; beforeOpen?: () => boolean } = $props()
  function openTemplate(templateId: string) {
    if (diagnostic && beforeOpen())
      ui.openPromptPackEditor(diagnostic.packId ?? 'default-pack', templateId)
  }
</script>

{#if diagnostic}
  <details class="my-2 max-h-96 overflow-auto rounded border p-2 text-xs break-words">
    <summary class="cursor-pointer font-medium">生图依据与提示词</summary>
    <div class="mt-2 space-y-2">
      <p>资料整理：{diagnostic.profile} · {diagnostic.model}</p>
      <p>
        提示词包：{diagnostic.packId} · 模板：{diagnostic.resolvedTemplateId ??
          diagnostic.templateId} · 来源：{diagnostic.templateSource}
      </p>
      {#if diagnostic.imageModel}<p>
          图片配置：{diagnostic.imageProfile} · {diagnostic.imageModel}
        </p>{/if}
      <button class="underline" onclick={() => openTemplate(diagnostic!.templateId)}
        >编辑分析提示词</button
      >
      {#if diagnostic.generationTemplateId}<button
          class="ml-2 underline"
          onclick={() => openTemplate(diagnostic!.generationTemplateId!)}>编辑肖像模板</button
        >{/if}
      {#each diagnostic.evidence.missing as missing}<p class="text-amber-500">{missing}</p>{/each}
      <p>
        仅用于图片的补全：{diagnostic.inferredDetails.join('；') ||
          '无／尚未完成分析'}。不会写回人物或世界书。
      </p>
      <details>
        <summary>资料来源与原文</summary>{#each diagnostic.evidence.sources as source}<p
            class="mt-2 font-medium"
          >
            {source.name}（{source.kind} · {source.id}）
          </p>
          <pre class="whitespace-pre-wrap">{source.text}</pre>{/each}
      </details>
      <details>
        <summary>分析 System / User</summary>
        <pre class="whitespace-pre-wrap">{diagnostic.system + '\n\n' + diagnostic.user}</pre>
      </details>
      <details>
        <summary>最终绘图提示词</summary>
        <pre class="whitespace-pre-wrap">{diagnostic.finalPrompt ?? '尚未发送图片请求'}</pre>
      </details>
    </div>
  </details>
{/if}
