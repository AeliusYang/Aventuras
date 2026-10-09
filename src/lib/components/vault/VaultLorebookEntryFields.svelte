<script lang="ts">
  import type { VaultLorebookEntry } from '$lib/types'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Label } from '$lib/components/ui/label'
  import SelectTrigger from '../ui/select/select-trigger.svelte'
  import { Select, SelectContent, SelectItem } from '../ui/select'
  import type { EntryType, EntryInjectionMode } from '$lib/types'

  interface Props {
    data: VaultLorebookEntry
    onUpdate: (data: VaultLorebookEntry) => void
    changedFields?: Set<string>
  }

  let { data, onUpdate, changedFields }: Props = $props()

  let textareaRef = $state<HTMLTextAreaElement | null>(null)
  $effect(() => {
    void data
    textareaRef?.scrollTo(0, 0)
  })

  const changed = (field: string) =>
    changedFields?.has(field)
      ? 'border-l-2 border-l-blue-400/50 bg-blue-500/5 pl-3 -ml-3 rounded-lg'
      : ''

  // Type options
  const entryTypes: EntryType[] = ['character', 'location', 'item', 'faction', 'concept', 'event']
  const injectionModes: Array<{ value: EntryInjectionMode; label: string; description: string }> = [
    { value: 'always', label: '始终启用', description: '每次生成均包含' },
    { value: 'keyword', label: '自动', description: '按关键词或 AI 相关性匹配' },
    { value: 'never', label: '禁用', description: '不加入 AI 上下文' },
  ]

  function handleInput() {
    onUpdate({ ...data })
  }
</script>

<div class="space-y-6">
  <div class="space-y-2 {changed('name')}">
    <Label for="entry-name">条目名称</Label>
    <Input id="entry-name" bind:value={data.name} oninput={handleInput} placeholder="条目名称" />
  </div>

  <div class="space-y-2 {changed('type')}">
    <Label>条目类型</Label>
    <Select
      type="single"
      value={data.type}
      onValueChange={(v) => {
        data.type = v as EntryType
        handleInput()
      }}
    >
      <SelectTrigger id="entry-type">
        {`${data.type.charAt(0).toUpperCase() + data.type.slice(1)}` || '选择类型'}
      </SelectTrigger>
      <SelectContent>
        {#each entryTypes as option (option)}
          <SelectItem value={option}>{option.charAt(0).toUpperCase() + option.slice(1)}</SelectItem>
        {/each}
      </SelectContent>
    </Select>
  </div>

  <div class="space-y-2 {changed('keywords')}">
    <Label>关键词</Label>
    <Input
      value={data.keywords?.join(', ') ?? ''}
      oninput={(e) => {
        data.keywords = e.currentTarget.value
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
        handleInput()
      }}
      placeholder="关键词，用英文逗号分隔…"
    />
    <p class="text-muted-foreground text-[0.8rem]">在“关键词”注入模式下，用于触发本条目的词语。</p>
  </div>

  <div class="space-y-2 {changed('aliases')}">
    <Label>别名</Label>
    <Input
      value={data.aliases?.join(', ') ?? ''}
      oninput={(e) => {
        data.aliases = e.currentTarget.value
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
        handleInput()
      }}
      placeholder="别名，用英文逗号分隔…"
    />
    <p class="text-muted-foreground text-[0.8rem]">本条目的其他名称或拼写。</p>
  </div>

  <div class="flex flex-1 flex-col space-y-2 {changed('description')}">
    <Label>描述／内容</Label>
    <Textarea
      bind:value={data.description}
      bind:ref={textareaRef}
      oninput={handleInput}
      class="min-h-[200px] font-mono text-sm leading-relaxed"
      placeholder="在此输入设定内容…"
    />
  </div>

  <div class="bg-muted/30 space-y-4 rounded-lg border p-4">
    <h4 class="text-sm font-medium">注入设置</h4>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="space-y-2 {changed('injectionMode')}">
        <Label class="text-xs">注入模式</Label>
        <Select
          type="single"
          value={data.injectionMode}
          onValueChange={(v) => {
            data.injectionMode = v as EntryInjectionMode
            handleInput()
          }}
        >
          <SelectTrigger id="injection-mode">
            {injectionModes.find((m) => m.value === data.injectionMode)?.label || '选择模式'}
          </SelectTrigger>
          <SelectContent>
            {#each injectionModes as mode (mode.value)}
              <SelectItem value={mode.value}>{mode.label}</SelectItem>
            {/each}
          </SelectContent>
        </Select>
        <p class="text-muted-foreground text-[0.8rem]">
          {injectionModes.find((m) => m.value === data.injectionMode)?.description || ''}
        </p>
      </div>

      <div class="space-y-2 {changed('priority')}">
        <Label class="text-xs">优先级</Label>
        <Input type="number" bind:value={data.priority} oninput={handleInput} />
      </div>
    </div>
  </div>
</div>
