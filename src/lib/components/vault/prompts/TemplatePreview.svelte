<script lang="ts">
  import { templateEngine } from '$lib/services/templates/engine'
  import { variableRegistry } from '$lib/services/templates/variables'
  import type { CustomVariable } from '$lib/services/packs/types'
  import type { TemplateContext } from '$lib/services/templates/types'
  import { AlertTriangle } from '@lucide/svelte'

  interface Props {
    content: string
    customVariables: CustomVariable[]
    hideHeader?: boolean
    testValues?: Record<string, string>
  }

  let { content, customVariables, hideHeader = false, testValues }: Props = $props()

  function buildSampleContext(
    vars: CustomVariable[],
    overrides?: Record<string, string>,
  ): TemplateContext {
    const context: TemplateContext = {}

    // All variables get bracket-name fallback; actual values come from testValues overrides
    for (const v of variableRegistry.getByCategory('system')) {
      context[v.name] = `[${v.name}]`
    }
    for (const v of variableRegistry.getByCategory('runtime')) {
      context[v.name] = `[${v.name}]`
    }
    for (const v of vars) {
      context[v.variableName] = `[${v.displayName}]`
    }

    // Apply test value overrides (single source of truth for all sample/default values)
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== '') {
          context[key] = value
        }
      }
    }

    return context
  }

  // Debounced rendering
  let previewOutput = $state('')
  let previewError = $state('')
  let renderTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    // Track dependencies
    const currentContent = content
    const currentVars = customVariables
    const currentTestValues = testValues

    clearTimeout(renderTimer)
    renderTimer = setTimeout(() => {
      if (!currentContent.trim()) {
        previewOutput = ''
        previewError = ''
        return
      }

      const context = buildSampleContext(currentVars, currentTestValues)
      const result = templateEngine.render(currentContent, context)

      if (result === null) {
        previewError = 'Template could not be rendered. Check for syntax errors.'
        previewOutput = ''
      } else {
        previewOutput = result
        previewError = ''
      }
    }, 300)

    return () => clearTimeout(renderTimer)
  })
</script>

<div class="flex h-full flex-col overflow-hidden">
  {#if !hideHeader}
    <div class="border-b px-4 py-2">
      <h4 class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        渲染预览（测试变量）
      </h4>
      <p class="text-muted-foreground mt-1 text-[11px]">
        仅反映当前编辑缓冲区按测试变量渲染的结果，不是历史真实请求快照。
      </p>
    </div>
  {/if}

  <div class="flex-1 overflow-auto bg-[hsl(var(--muted)/0.3)] p-4">
    {#if previewError}
      <div class="flex items-start gap-2 text-sm text-yellow-500">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{previewError}</span>
      </div>
    {:else if previewOutput}
      <pre
        class="font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-[hsl(var(--foreground)/0.9)]">{previewOutput}</pre>
    {:else}
      <p class="text-muted-foreground text-sm italic">在编辑器中输入内容以查看预览…</p>
    {/if}
  </div>
</div>
