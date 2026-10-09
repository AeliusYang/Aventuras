<script lang="ts">
  import { User, Loader2, X, Wand2, ImageUp, AlertCircle } from '@lucide/svelte'
  import { normalizeImageDataUrl } from '$lib/utils/image'
  import type { GeneratedCharacter, GeneratedProtagonist } from '$lib/services/ai/sdk'

  // Shadcn Components
  import * as Card from '$lib/components/ui/card'
  import * as Avatar from '$lib/components/ui/avatar'
  import * as Alert from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Badge } from '$lib/components/ui/badge'
  import { Separator } from '$lib/components/ui/separator'

  interface Props {
    protagonist: GeneratedProtagonist | null
    supportingCharacters: GeneratedCharacter[]
    imageGenerationEnabled: boolean

    // Protagonist portrait
    protagonistVisualDescriptors: string
    protagonistPortrait: string | null
    isGeneratingProtagonistPortrait: boolean
    isUploadingProtagonistPortrait: boolean

    // Supporting character portraits (keyed by name)
    supportingCharacterVisualDescriptors: Record<string, string>
    supportingCharacterPortraits: Record<string, string | null>
    generatingPortraitName: string | null
    uploadingCharacterName: string | null

    portraitError: string | null

    // Handlers
    onProtagonistDescriptorsChange: (value: string) => void
    onGenerateProtagonistPortrait: () => void
    onRemoveProtagonistPortrait: () => void
    onProtagonistPortraitUpload: (event: Event) => void

    onSupportingDescriptorsChange: (name: string, value: string) => void
    onGenerateSupportingPortrait: (name: string) => void
    onRemoveSupportingPortrait: (name: string) => void
    onSupportingPortraitUpload: (event: Event, name: string) => void
  }

  let {
    protagonist,
    supportingCharacters,
    imageGenerationEnabled,
    protagonistVisualDescriptors,
    protagonistPortrait,
    isGeneratingProtagonistPortrait,
    isUploadingProtagonistPortrait,
    supportingCharacterVisualDescriptors,
    supportingCharacterPortraits,
    generatingPortraitName,
    uploadingCharacterName,
    portraitError,
    onProtagonistDescriptorsChange,
    onGenerateProtagonistPortrait,
    onRemoveProtagonistPortrait,
    onProtagonistPortraitUpload,
    onSupportingDescriptorsChange,
    onGenerateSupportingPortrait,
    onRemoveSupportingPortrait,
    onSupportingPortraitUpload,
  }: Props = $props()
</script>

<div class="space-y-4">
  <div class="space-y-1">
    <h3 class="text-lg font-medium">角色肖像</h3>
    <p class="text-muted-foreground text-sm">上传或生成角色肖像，用于故事插图中的角色呈现。</p>
  </div>

  {#if !imageGenerationEnabled}
    <Alert.Root class="py-2">
      <AlertCircle class="h-4 w-4" />
      <Alert.Title class="text-xs font-semibold">未启用图片生成</Alert.Title>
      <Alert.Description class="text-xs">
        尚未配置图片生成。你可以手动上传肖像，或在设置中配置图片生成。
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if portraitError}
    <Alert.Root variant="destructive" class="py-2">
      <AlertCircle class="h-4 w-4" />
      <Alert.Title class="text-xs font-semibold">错误</Alert.Title>
      <Alert.Description class="text-xs">{portraitError}</Alert.Description>
    </Alert.Root>
  {/if}

  <!-- Protagonist Portrait -->
  {#if protagonist}
    <Card.Root class="overflow-hidden">
      <Card.Content class="p-3">
        <div class="flex gap-4">
          <!-- Portrait Preview -->
          <div class="shrink-0">
            {#if protagonistPortrait}
              <div class="group relative">
                <Avatar.Root class="h-24 w-24 rounded-lg border shadow-sm">
                  <Avatar.Image
                    src={normalizeImageDataUrl(protagonistPortrait) ?? ''}
                    alt="{protagonist.name} 肖像"
                    class="object-cover"
                  />
                  <Avatar.Fallback class="bg-muted rounded-lg">
                    <User class="text-muted-foreground h-8 w-8" />
                  </Avatar.Fallback>
                </Avatar.Root>
                <Button
                  size="icon"
                  variant="destructive"
                  class="absolute -top-2 -right-2 h-6 w-6 rounded-full opacity-0 shadow-md transition-opacity group-hover:opacity-100"
                  onclick={onRemoveProtagonistPortrait}
                  title="移除肖像"
                >
                  <X class="h-3 w-3" />
                </Button>
              </div>
            {:else}
              <div
                class="border-muted bg-muted/30 flex h-24 w-24 items-center justify-center rounded-lg border-2 border-dashed"
              >
                <User class="text-muted-foreground/50 h-8 w-8" />
              </div>
            {/if}
          </div>

          <!-- Controls -->
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between">
              <h4 class="truncate font-medium">{protagonist.name}</h4>
              <Badge variant="default" class="h-5 px-1.5 text-[10px]">主角</Badge>
            </div>

            <div class="mb-2 space-y-1.5">
              <Label class="text-muted-foreground text-[10px] tracking-wider uppercase">外貌</Label>
              <Textarea
                value={protagonistVisualDescriptors}
                oninput={(e) => onProtagonistDescriptorsChange(e.currentTarget.value)}
                placeholder="例如：银色长发、紫色眼睛、白皙皮肤、深蓝色长外套…"
                class="min-h-[60px] resize-none text-xs"
                rows={2}
              />
            </div>

            <div class="flex gap-2">
              <div class="relative">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 gap-1.5 text-xs"
                  disabled={isUploadingProtagonistPortrait || isGeneratingProtagonistPortrait}
                >
                  {#if isUploadingProtagonistPortrait}
                    <Loader2 class="h-3 w-3 animate-spin" />
                    正在上传…
                  {:else}
                    <ImageUp class="h-3 w-3" />
                    上传
                  {/if}
                </Button>
                <input
                  type="file"
                  accept="image/*"
                  class="absolute inset-0 cursor-pointer opacity-0"
                  onchange={onProtagonistPortraitUpload}
                  disabled={isUploadingProtagonistPortrait || isGeneratingProtagonistPortrait}
                />
              </div>

              {#if imageGenerationEnabled}
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-7 gap-1.5 text-xs"
                  onclick={onGenerateProtagonistPortrait}
                  disabled={isGeneratingProtagonistPortrait ||
                    isUploadingProtagonistPortrait ||
                    !protagonistVisualDescriptors.trim()}
                  title={!protagonistVisualDescriptors.trim() ? '请先填写外貌描述' : ''}
                >
                  {#if isGeneratingProtagonistPortrait}
                    <Loader2 class="h-3 w-3 animate-spin" />
                    正在生成…
                  {:else}
                    <Wand2 class="h-3 w-3" />
                    {protagonistPortrait ? '重新生成' : '生成'}
                  {/if}
                </Button>
              {/if}
            </div>
          </div>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-dashed">
      <Card.Content
        class="text-muted-foreground flex flex-col items-center justify-center p-6 text-center"
      >
        <User class="mb-2 h-8 w-8 opacity-50" />
        <p class="text-sm">尚未创建主角，请返回上一步创建。</p>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Supporting Character Portraits -->
  {#if supportingCharacters.length > 0}
    <div class="space-y-2">
      <div class="flex items-center gap-2 pb-1">
        <Separator class="flex-1" />
        <h4 class="text-muted-foreground text-xs font-medium tracking-wider uppercase">配角生成</h4>
        <Separator class="flex-1" />
      </div>

      <div class="grid grid-cols-1 gap-3">
        {#each supportingCharacters as char (char.name + char.role + char.description)}
          <Card.Root>
            <Card.Content class="p-3">
              <div class="flex gap-4">
                <!-- Portrait Preview -->
                <div class="shrink-0">
                  {#if supportingCharacterPortraits[char.name]}
                    <div class="group relative">
                      <Avatar.Root class="h-20 w-20 rounded-lg border shadow-sm">
                        <Avatar.Image
                          src={normalizeImageDataUrl(supportingCharacterPortraits[char.name]) ?? ''}
                          alt="{char.name} 肖像"
                          class="object-cover"
                        />
                        <Avatar.Fallback class="bg-muted rounded-lg">
                          <User class="text-muted-foreground h-6 w-6" />
                        </Avatar.Fallback>
                      </Avatar.Root>
                      <Button
                        size="icon"
                        variant="destructive"
                        class="absolute -top-2 -right-2 h-5 w-5 rounded-full opacity-0 shadow-md transition-opacity group-hover:opacity-100"
                        onclick={() => onRemoveSupportingPortrait(char.name)}
                        title="移除肖像"
                      >
                        <X class="h-2.5 w-2.5" />
                      </Button>
                    </div>
                  {:else}
                    <div
                      class="border-muted bg-muted/30 flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed"
                    >
                      <User class="text-muted-foreground/50 h-6 w-6" />
                    </div>
                  {/if}
                </div>

                <!-- Controls -->
                <div class="min-w-0 flex-1 space-y-2">
                  <div class="flex items-center justify-between">
                    <h4 class="truncate text-sm font-medium">{char.name}</h4>
                    <Badge variant="secondary" class="h-4 px-1.5 text-[10px] font-normal">
                      {char.role}
                    </Badge>
                  </div>

                  <div class="space-y-1">
                    <!-- Compact Label/Input group -->
                    <Textarea
                      value={supportingCharacterVisualDescriptors[char.name] || ''}
                      oninput={(e) =>
                        onSupportingDescriptorsChange(char.name, e.currentTarget.value)}
                      placeholder="外貌（例如：黑色短发、绿色眼睛）…"
                      class="min-h-[50px] resize-none text-xs"
                      rows={2}
                    />
                  </div>

                  <div class="flex gap-2">
                    <div class="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        class="h-6 gap-1.5 px-2 text-xs"
                        disabled={uploadingCharacterName === char.name ||
                          generatingPortraitName !== null}
                      >
                        {#if uploadingCharacterName === char.name}
                          <Loader2 class="h-2.5 w-2.5 animate-spin" />
                          正在上传…
                        {:else}
                          <ImageUp class="h-2.5 w-2.5" />
                          上传
                        {/if}
                      </Button>
                      <input
                        type="file"
                        accept="image/*"
                        class="absolute inset-0 cursor-pointer opacity-0"
                        onchange={(e) => onSupportingPortraitUpload(e, char.name)}
                        disabled={uploadingCharacterName !== null ||
                          generatingPortraitName !== null}
                      />
                    </div>

                    {#if imageGenerationEnabled}
                      <Button
                        variant="secondary"
                        size="sm"
                        class="h-6 gap-1.5 px-2 text-xs"
                        onclick={() => onGenerateSupportingPortrait(char.name)}
                        disabled={generatingPortraitName !== null ||
                          uploadingCharacterName !== null ||
                          !(supportingCharacterVisualDescriptors[char.name] || '').trim()}
                        title={!(supportingCharacterVisualDescriptors[char.name] || '').trim()
                          ? '请先填写外貌描述'
                          : ''}
                      >
                        {#if generatingPortraitName === char.name}
                          <Loader2 class="h-2.5 w-2.5 animate-spin" />
                          生成中…
                        {:else}
                          <Wand2 class="h-2.5 w-2.5" />
                          {supportingCharacterPortraits[char.name] ? '重新生成' : '生成'}
                        {/if}
                      </Button>
                    {/if}
                  </div>
                </div>
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    </div>
  {/if}

  {#if !protagonist && supportingCharacters.length === 0}
    <Card.Root class="bg-muted/30 border-dashed">
      <Card.Content
        class="text-muted-foreground flex flex-col items-center justify-center p-8 text-center"
      >
        <User class="mb-3 h-10 w-10 opacity-50" />
        <p>尚未创建角色。</p>
        <p class="mt-1 text-xs">请返回第 5 步创建角色。</p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
