<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Switch } from '$lib/components/ui/switch'
  import { Label } from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import { Package } from '@lucide/svelte'
  import { renderDescription } from '$lib/utils/markdown'
  import type { PresetPack, CustomVariable } from '$lib/services/packs/types'

  interface Props {
    availablePacks: PresetPack[]
    selectedPackId: string
    packVariables: CustomVariable[]
    variableValues: Record<string, string>
    onSelectPack: (packId: string) => void
    onVariableChange: (variableName: string, value: string) => void
  }

  let {
    availablePacks,
    selectedPackId,
    packVariables,
    variableValues,
    onSelectPack,
    onVariableChange,
  }: Props = $props()

  const selectedPack = $derived(availablePacks.find((p) => p.id === selectedPackId))
  const hasVariables = $derived(packVariables.length > 0)
</script>

<div class="space-y-4">
  <!-- Header with icon badge -->
  <div class="flex items-center gap-3">
    <div class="bg-primary/10 flex h-8 w-8 items-center justify-center rounded-md">
      <Package class="text-primary h-4 w-4" />
    </div>
    <div>
      <h3 class="text-lg font-semibold">提示词包</h3>
      <p class="text-muted-foreground text-sm">选择此故事使用的提示词模板。</p>
    </div>
  </div>

  <!-- Pack Dropdown (only shown when multiple packs exist) -->
  {#if availablePacks.length}
    <div class="space-y-2">
      <Label>提示词包</Label>
      <Select.Root
        type="single"
        value={selectedPackId}
        onValueChange={(v) => {
          if (v) onSelectPack(v)
        }}
      >
        <Select.Trigger class="w-full">
          {selectedPack?.name ?? '选择提示词包'}
        </Select.Trigger>
        <Select.Content>
          {#each availablePacks as pack (pack.id)}
            <Select.Item value={pack.id} label={pack.name}>
              <div class="flex items-center gap-2">
                {pack.name}
                {#if pack.isDefault}
                  <Badge variant="secondary" class="text-xs">默认</Badge>
                {/if}
              </div>
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if selectedPack?.description}
        <div class="prose-content text-muted-foreground text-xs">
          {@html renderDescription(selectedPack.description)}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Variable Inputs -->
  {#if hasVariables}
    <!-- Divider with centered label -->
    <div class="relative py-1">
      <div class="absolute inset-0 flex items-center" aria-hidden="true">
        <div class="w-full border-t"></div>
      </div>
      <div class="relative flex justify-center text-xs uppercase">
        <span class="bg-background text-muted-foreground px-2">变量</span>
      </div>
    </div>

    <div class="space-y-3">
      {#each packVariables as variable (variable.id)}
        <div class="space-y-1">
          {#if variable.variableType === 'boolean'}
            <!-- Boolean: horizontal layout with label left, switch right -->
            <div class="flex items-center justify-between">
              <div class="space-y-0.5">
                <Label for="var-{variable.variableName}">{variable.displayName}</Label>
                {#if variable.description}
                  <p class="text-muted-foreground text-xs">{variable.description}</p>
                {/if}
              </div>
              <Switch
                id="var-{variable.variableName}"
                checked={variableValues[variable.variableName] === 'true'}
                onCheckedChange={(v) =>
                  onVariableChange(variable.variableName, v ? 'true' : 'false')}
              />
            </div>
          {:else}
            <!-- Non-boolean: stacked label then input -->
            <Label for="var-{variable.variableName}">{variable.displayName}</Label>
            {#if variable.description}
              <p class="text-muted-foreground text-xs">{variable.description}</p>
            {/if}

            {#if variable.variableType === 'text'}
              <Input
                id="var-{variable.variableName}"
                value={variableValues[variable.variableName] ?? ''}
                oninput={(e) => onVariableChange(variable.variableName, e.currentTarget.value)}
                placeholder={variable.displayName}
              />
            {:else if variable.variableType === 'textarea'}
              <Textarea
                id="var-{variable.variableName}"
                rows={3}
                value={variableValues[variable.variableName] ?? ''}
                oninput={(e) => onVariableChange(variable.variableName, e.currentTarget.value)}
                placeholder={variable.displayName}
              />
            {:else if variable.variableType === 'number'}
              <Input
                id="var-{variable.variableName}"
                type="number"
                value={variableValues[variable.variableName] ?? ''}
                oninput={(e) => onVariableChange(variable.variableName, e.currentTarget.value)}
                placeholder="0"
              />
            {:else if variable.variableType === 'enum' && variable.enumOptions}
              <Select.Root
                type="single"
                value={variableValues[variable.variableName] ?? ''}
                onValueChange={(v) => {
                  if (v !== undefined) onVariableChange(variable.variableName, v)
                }}
              >
                <Select.Trigger class="w-full">
                  {variable.enumOptions.find(
                    (o) => o.value === variableValues[variable.variableName],
                  )?.label ?? '请选择…'}
                </Select.Trigger>
                <Select.Content>
                  {#each variable.enumOptions as opt (opt.value)}
                    {#if opt.value}
                      <Select.Item value={opt.value} label={opt.label || opt.value}>
                        {opt.label || opt.value}
                      </Select.Item>
                    {/if}
                  {/each}
                </Select.Content>
              </Select.Root>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
