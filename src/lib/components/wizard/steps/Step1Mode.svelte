<script lang="ts">
  import { Sword, Feather } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import type { StoryMode } from '$lib/types'

  interface Props {
    selectedMode: StoryMode
    onModeChange: (mode: StoryMode) => void
  }

  let { selectedMode, onModeChange }: Props = $props()
</script>

<div class="space-y-4">
  <p class="text-muted-foreground">你想以什么方式参与故事？</p>
  <div class="grid gap-4 sm:grid-cols-2">
    <!-- Adventure Mode -->
    <button
      class="group w-full text-left focus:outline-none"
      onclick={() => onModeChange('adventure')}
    >
      <Card.Root
        class="border-border hover:border-primary hover:shadow-primary/5 h-full transition-all duration-200 hover:shadow-md {selectedMode ===
        'adventure'
          ? 'ring-primary border-primary ring-2'
          : ''}"
      >
        <Card.Header>
          <div class="flex items-center gap-4">
            <div class="bg-primary/10 rounded-lg p-3">
              <Sword class="text-primary h-6 w-6" />
            </div>
            <Card.Title>冒险模式</Card.Title>
          </div>
        </Card.Header>
        <Card.Content>
          <p class="text-muted-foreground text-sm">
            <strong>你扮演主角。</strong> 探索世界、与角色互动，用选择影响故事。AI 根据你的行动叙述后续发展。
          </p>
        </Card.Content>
      </Card.Root>
    </button>

    <!-- Creative Writing Mode -->
    <button
      class="group w-full text-left focus:outline-none"
      onclick={() => onModeChange('creative-writing')}
    >
      <Card.Root
        class="border-border hover:border-primary hover:shadow-primary/5 h-full transition-all duration-200 hover:shadow-md {selectedMode ===
        'creative-writing'
          ? 'ring-primary border-primary ring-2'
          : ''}"
      >
        <Card.Header>
          <div class="flex items-center gap-4">
            <div class="bg-primary/10 rounded-lg p-3">
              <Feather class="text-primary h-6 w-6" />
            </div>
            <Card.Title>中文写作</Card.Title>
          </div>
        </Card.Header>
        <Card.Content>
          <p class="text-muted-foreground text-sm">
            <strong>你担任作者。</strong> Director 理解自然输入并安排场景，Writer 按照你的创作意图撰写中文小说正文。
          </p>
        </Card.Content>
      </Card.Root>
    </button>
  </div>
</div>
