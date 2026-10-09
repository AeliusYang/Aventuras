<script module lang="ts">
  // Module-level state persists across component remounts (settings open/close)
  let _sqlQuery = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
  let _queryResult: { columns: string[]; rows: Record<string, unknown>[] } | null = null
  let _queryError: string | null = null
  let _queryTime = 0
  let _showSqlEditor = false
</script>

<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte'
  import {
    FlaskConical,
    Download,
    Loader2,
    RotateCcw,
    AlertTriangle,
    Database,
    Undo2,
    GitBranch,
    Clock,
    ShieldCheck,
    Terminal,
    Play,
    Copy,
    Upload,
    Smartphone,
    Bell,
    Eye,
    Package,
  } from '@lucide/svelte'
  import { Switch } from '$lib/components/ui/switch'
  import { Label } from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { Separator } from '$lib/components/ui/separator'
  import * as Dialog from '$lib/components/ui/dialog'
  import { database } from '$lib/services/database'
  import { isAndroid } from '$lib/utils/platform'
  import { autosize } from '$lib/utils/autosize'
  import { ask, open } from '@tauri-apps/plugin-dialog'
  import { openFilters } from '$lib/utils/dialogFilters'
  import { invoke } from '@tauri-apps/api/core'
  import { errMessage } from '$lib/utils/error'

  // Local mirror so we can revert the visual state if the confirm dialog is cancelled
  let stateTrackingChecked = $state(settings.experimentalFeatures.stateTracking)

  let isBackingUp = $state(false)
  let backupResult = $state<{ success: boolean; message: string } | null>(null)
  let hasEverBackedUp = $state(false)
  let isRestoring = $state(false)
  let restoreError = $state<string | null>(null)
  let showBackupConfirm = $state(false)
  let showRestoreConfirm = $state(false)

  // SQL Query Box state — initialized from module-level persisted values
  let sqlQuery = $state(_sqlQuery)
  let queryResult = $state<{ columns: string[]; rows: Record<string, unknown>[] } | null>(
    _queryResult,
  )
  let queryError = $state<string | null>(_queryError)
  let isQuerying = $state(false)
  let queryTime = $state<number>(_queryTime)
  let showSqlEditor = $state(_showSqlEditor)

  // Sync state back to module-level on change
  $effect(() => {
    _sqlQuery = sqlQuery
  })
  $effect(() => {
    _queryResult = queryResult
  })
  $effect(() => {
    _queryError = queryError
  })
  $effect(() => {
    _queryTime = queryTime
  })
  $effect(() => {
    _showSqlEditor = showSqlEditor
  })

  async function handleRunQuery() {
    if (!sqlQuery.trim()) return
    isQuerying = true
    queryError = null
    queryResult = null
    const start = performance.now()
    try {
      const result = await database.rawQuery(sqlQuery.trim())
      queryTime = Math.round(performance.now() - start)
      queryResult = result
    } catch (error) {
      queryTime = Math.round(performance.now() - start)
      queryError = errMessage(error)
    } finally {
      isQuerying = false
    }
  }

  function handleCopyResults() {
    if (!queryResult) return
    const text = JSON.stringify(queryResult.rows, null, 2)
    navigator.clipboard.writeText(text)
  }

  function handleQueryKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRunQuery()
    }
  }

  function handleBackup() {
    showBackupConfirm = true
  }

  async function handleBackupConfirmed() {
    showBackupConfirm = false
    isBackingUp = true
    backupResult = null
    try {
      const { backupService } = await import('$lib/services/backupService')
      const savedPath = await backupService.createFullBackup()
      if (savedPath) {
        backupResult = { success: true, message: `Backup saved to:\n${savedPath}` }
        hasEverBackedUp = true
      } else {
        backupResult = { success: false, message: 'Backup cancelled.' }
      }
    } catch (error) {
      console.error('[ExperimentalSettings] Backup failed:', error)
      backupResult = {
        success: false,
        message: `Backup failed: ${errMessage(error)}`,
      }
    } finally {
      isBackingUp = false
    }
  }

  async function handleRestore() {
    showRestoreConfirm = true
  }

  async function handleRestoreConfirmed() {
    showRestoreConfirm = false
    restoreError = null

    // Pick the backup file. On Android this returns a SAF content:// URI; on desktop a real path.
    const selected = await open({
      title: '选择要恢复的 Aventura 备份',
      // openFilters drops these on Android. It matters here: SAF appends " (1)" AFTER ".zip" for
      // duplicate names, and Android cannot resolve a MIME type for "backup.zip (1)", so a
      // zip-filtered picker would grey out the very backup the user is trying to restore.
      filters: openFilters([
        { name: 'ZIP Archive', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ]),
      multiple: false,
      directory: false,
    })
    if (!selected) return

    let zipPath = selected as string
    // Android: the picked content:// URI can't be std::fs-opened by the native restore, so stream
    // it into a real temp file first (natively — no bytes cross the JS bridge), then restore that.
    if (isAndroid()) {
      isRestoring = true
      try {
        zipPath = await invoke<string>('import_saf_to_temp', { srcUri: selected })
      } catch (error) {
        restoreError = errMessage(error)
        isRestoring = false
        return
      }
    }
    await doRestore(zipPath)
  }

  async function doRestore(zipPath: string) {
    isRestoring = true
    restoreError = null
    try {
      const { backupService } = await import('$lib/services/backupService')
      await backupService.restoreFromBackup(zipPath)
      // App will exit — we won't reach here
    } catch (error) {
      console.error('[ExperimentalSettings] Restore failed:', error)
      restoreError = errMessage(error)
    } finally {
      isRestoring = false
    }
  }

  async function handleStateTrackingToggle(checked: boolean) {
    if (checked && !hasEverBackedUp) {
      // Recommend backup before enabling
      const shouldContinue = await ask(
        'It is strongly recommended to download a full backup before enabling experimental features.\n\nWould you like to continue without a backup?',
        { title: '启用状态跟踪', kind: 'warning' },
      )
      if (!shouldContinue) {
        stateTrackingChecked = !checked // revert visual state
        return
      }
    }
    await settings.updateExperimentalFeatures({ stateTracking: checked })
  }

  async function handleRollbackToggle(checked: boolean) {
    await settings.updateExperimentalFeatures({ rollbackOnDelete: checked })
  }

  async function handleLightweightBranchesToggle(checked: boolean) {
    await settings.updateExperimentalFeatures({ lightweightBranches: checked })
  }

  async function handleSnapshotIntervalChange(value: number) {
    await settings.updateExperimentalFeatures({ autoSnapshotInterval: value })
  }

  // -- Android background generation handlers --

  const showAndroidSection = isAndroid()

  async function handleBackgroundGenerationToggle(checked: boolean) {
    if (!checked) {
      // Turning off master toggle cascades to disable sub-toggles (single write)
      await settings.updateExperimentalFeatures({
        backgroundGeneration: false,
        generationNotifications: false,
        notificationPreview: false,
      })
    } else {
      await settings.updateExperimentalFeatures({ backgroundGeneration: true })
    }
  }

  async function handleGenerationNotificationsToggle(checked: boolean) {
    if (checked) {
      // Request notification permission on Android 13+
      try {
        const { isPermissionGranted, requestPermission } =
          await import('@tauri-apps/plugin-notification')
        let granted = await isPermissionGranted()
        if (!granted) {
          const result = await requestPermission()
          granted = result === 'granted'
        }
        if (!granted) {
          // Permission denied — don't enable the toggle
          return
        }
      } catch (e) {
        console.warn('[ExperimentalSettings] Notification permission check failed:', e)
        return
      }
    } else {
      // Turning off notifications cascades to disable preview (single write)
      await settings.updateExperimentalFeatures({
        generationNotifications: false,
        notificationPreview: false,
      })
      return
    }
    await settings.updateExperimentalFeatures({ generationNotifications: checked })
  }

  async function handleNotificationPreviewToggle(checked: boolean) {
    await settings.updateExperimentalFeatures({ notificationPreview: checked })
  }

  async function handleLegacyImportPackMappingToggle(checked: boolean) {
    await settings.updateExperimentalFeatures({ legacyImportPackMapping: checked })
  }

  async function handleResetAll() {
    await settings.resetExperimentalFeatures()
    stateTrackingChecked = settings.experimentalFeatures.stateTracking
  }
</script>

<div class="space-y-6">
  <!-- Header Banner -->
  <div class="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
    <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
    <div class="space-y-1">
      <p class="text-sm font-medium text-amber-500">实验功能</p>
      <p class="text-muted-foreground text-xs">
        这些功能仍在开发中，行为或数据格式可能发生变化。
        <strong>启用前请先创建备份。</strong>
      </p>
    </div>
  </div>

  <!-- Backup Section -->
  <div class="bg-muted/30 space-y-3 rounded-lg border p-4">
    <div class="flex items-center gap-2">
      <ShieldCheck class="text-primary h-4 w-4" />
      <Label class="text-sm font-medium">数据备份与恢复</Label>
    </div>
    <p class="text-muted-foreground text-xs">
      将完整数据库备份为 ZIP 文件，包含保存故事、世界书条目和图片的 SQLite
      数据库。可通过恢复备份返回此前状态。
    </p>
    <div class="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onclick={handleBackup}
        disabled={isBackingUp || isRestoring}
        class="gap-2"
      >
        {#if isBackingUp}
          <Loader2 class="h-4 w-4 animate-spin" />
          正在创建备份…
        {:else}
          <Download class="h-4 w-4" />
          下载备份
        {/if}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onclick={handleRestore}
        disabled={isBackingUp || isRestoring}
        class="gap-2"
      >
        {#if isRestoring}
          <Loader2 class="h-4 w-4 animate-spin" />
          正在恢复…
        {:else}
          <Upload class="h-4 w-4" />
          从备份恢复
        {/if}
      </Button>
    </div>
    {#if backupResult}
      <p class="text-xs {backupResult.success ? 'text-green-500' : 'text-destructive'}">
        {backupResult.message}
      </p>
    {/if}
    {#if restoreError}
      <div class="bg-destructive/10 border-destructive/30 rounded-md border p-3">
        <p class="text-destructive text-xs">{restoreError}</p>
      </div>
    {/if}
  </div>

  <Separator />

  <!-- Feature Toggles -->
  <div class="space-y-5">
    <div class="flex items-center gap-2">
      <FlaskConical class="text-muted-foreground h-4 w-4" />
      <Label class="text-sm font-medium">功能开关</Label>
    </div>

    <!-- State Tracking -->
    <div class="flex flex-row items-center justify-between">
      <div class="space-y-0.5">
        <div class="flex items-center gap-2">
          <Database class="text-muted-foreground h-4 w-4" />
          <Label>状态变化记录</Label>
        </div>
        <p class="text-muted-foreground text-xs">
          AI 完成状态提取后，在每段故事上记录世界状态变化，为回滚和轻量分支提供依据。
        </p>
        {#if settings.experimentalFeatures.stateTracking}
          <p class="pt-1 text-xs font-medium text-amber-500">已启用，新段落将记录状态变化。</p>
        {/if}
      </div>
      <Switch bind:checked={stateTrackingChecked} onCheckedChange={handleStateTrackingToggle} />
    </div>

    <!-- Rollback on Delete -->
    <div
      class="flex flex-row items-center justify-between {!settings.experimentalFeatures
        .stateTracking
        ? 'opacity-50'
        : ''}"
    >
      <div class="space-y-0.5">
        <div class="flex items-center gap-2">
          <Undo2 class="text-muted-foreground h-4 w-4" />
          <Label>删除时回滚状态</Label>
        </div>
        <p class="text-muted-foreground text-xs">
          删除消息时，自动撤销从该处开始的所有世界状态变化，并一并删除后续内容。
        </p>
        {#if !settings.experimentalFeatures.stateTracking}
          <p class="text-muted-foreground pt-1 text-xs italic">需要先启用状态变化记录。</p>
        {:else if settings.experimentalFeatures.rollbackOnDelete}
          <p class="pt-1 text-xs font-medium text-amber-500">
            已启用，删除内容时会同时删除后续内容并回滚状态。
          </p>
        {/if}
      </div>
      <Switch
        checked={settings.experimentalFeatures.rollbackOnDelete}
        onCheckedChange={handleRollbackToggle}
        disabled={!settings.experimentalFeatures.stateTracking}
      />
    </div>

    <!-- Lightweight Branches -->
    <div
      class="flex flex-row items-center justify-between {!settings.experimentalFeatures
        .stateTracking
        ? 'opacity-50'
        : ''}"
    >
      <div class="space-y-0.5">
        <div class="flex items-center gap-2">
          <GitBranch class="text-muted-foreground h-4 w-4" />
          <Label>轻量分支</Label>
        </div>
        <p class="text-muted-foreground text-xs">
          新分支共享父分支的世界状态，只有修改过的实体才会创建副本。
        </p>
        {#if !settings.experimentalFeatures.stateTracking}
          <p class="text-muted-foreground pt-1 text-xs italic">需要先启用状态变化记录。</p>
        {:else if settings.experimentalFeatures.lightweightBranches}
          <p class="pt-1 text-xs font-medium text-amber-500">已启用，新分支仅复制修改过的实体。</p>
        {/if}
      </div>
      <Switch
        checked={settings.experimentalFeatures.lightweightBranches}
        onCheckedChange={handleLightweightBranchesToggle}
        disabled={!settings.experimentalFeatures.stateTracking}
      />
    </div>
  </div>

  <Separator />

  <!-- Snapshot Interval -->
  <div class="space-y-3 {!settings.experimentalFeatures.stateTracking ? 'opacity-50' : ''}">
    <div class="flex items-center gap-2">
      <Clock class="text-muted-foreground h-4 w-4" />
      <Label>自动快照间隔</Label>
    </div>
    <p class="text-muted-foreground text-xs">
      每隔多少段内容保存一次世界状态快照。间隔越短，回滚越快，但占用更多存储空间。
    </p>
    <div class="flex items-center gap-4">
      <Slider
        type="single"
        value={settings.experimentalFeatures.autoSnapshotInterval}
        onValueChange={handleSnapshotIntervalChange}
        min={5}
        max={100}
        step={5}
        disabled={!settings.experimentalFeatures.stateTracking}
        class="flex-1"
      />
      <span class="text-muted-foreground w-12 text-right font-mono text-sm">
        {settings.experimentalFeatures.autoSnapshotInterval}
      </span>
    </div>
  </div>

  <Separator />

  <!-- Pack mapping for older story files -->
  <div class="space-y-5">
    <div class="flex items-center gap-2">
      <Package class="text-muted-foreground h-4 w-4" />
      <Label class="text-sm font-medium">故事导入</Label>
    </div>

    <div class="flex flex-row items-center justify-between">
      <div class="space-y-0.5">
        <Label>为旧版故事文件选择提示词包</Label>
        <p class="text-muted-foreground text-xs">
          旧版故事文件未记录提示词包，默认使用内置包导入。开启后，导入此类文件时会让你选择提示词包。已记录提示词包的文件会自动匹配已安装的包，仅在无法确定匹配或缺少必填变量时询问。
        </p>
        <p class="text-muted-foreground pt-1 text-xs italic">
          只有一个已安装提示词包时，此选项不影响导入。
        </p>
      </div>
      <Switch
        checked={settings.experimentalFeatures.legacyImportPackMapping}
        onCheckedChange={handleLegacyImportPackMappingToggle}
      />
    </div>
  </div>

  <Separator />

  <!-- Android Background Generation (only shown on Android) -->
  {#if showAndroidSection}
    <div class="space-y-5">
      <div class="flex items-center gap-2">
        <Smartphone class="text-muted-foreground h-4 w-4" />
        <Label class="text-sm font-medium">Android 后台生成</Label>
      </div>

      <!-- Background Generation toggle -->
      <div class="flex flex-row items-center justify-between">
        <div class="space-y-0.5">
          <div class="flex items-center gap-2">
            <Smartphone class="text-muted-foreground h-4 w-4" />
            <Label>后台生成</Label>
          </div>
          <p class="text-muted-foreground text-xs">
            切换应用或锁屏后继续生成正文。使用前台服务和唤醒锁，可能略微增加耗电。
          </p>
          {#if settings.experimentalFeatures.backgroundGeneration}
            <p class="pt-1 text-xs font-medium text-amber-500">
              已启用，应用进入后台后会继续生成。
            </p>
          {/if}
        </div>
        <Switch
          checked={settings.experimentalFeatures.backgroundGeneration}
          onCheckedChange={handleBackgroundGenerationToggle}
        />
      </div>

      <!-- Generation Notifications toggle -->
      <div
        class="flex flex-row items-center justify-between {!settings.experimentalFeatures
          .backgroundGeneration
          ? 'opacity-50'
          : ''}"
      >
        <div class="space-y-0.5">
          <div class="flex items-center gap-2">
            <Bell class="text-muted-foreground h-4 w-4" />
            <Label>生成完成通知</Label>
          </div>
          <p class="text-muted-foreground text-xs">应用在后台完成正文生成后发送通知。</p>
          {#if !settings.experimentalFeatures.backgroundGeneration}
            <p class="text-muted-foreground pt-1 text-xs italic">需要先启用后台生成。</p>
          {/if}
        </div>
        <Switch
          checked={settings.experimentalFeatures.generationNotifications}
          onCheckedChange={handleGenerationNotificationsToggle}
          disabled={!settings.experimentalFeatures.backgroundGeneration}
        />
      </div>

      <!-- Notification Preview toggle -->
      <div
        class="flex flex-row items-center justify-between {!settings.experimentalFeatures
          .generationNotifications
          ? 'opacity-50'
          : ''}"
      >
        <div class="space-y-0.5">
          <div class="flex items-center gap-2">
            <Eye class="text-muted-foreground h-4 w-4" />
            <Label>通知中显示预览</Label>
          </div>
          <p class="text-muted-foreground text-xs">在通知中显示生成正文的前几行。</p>
          {#if !settings.experimentalFeatures.generationNotifications}
            <p class="text-muted-foreground pt-1 text-xs italic">需要先启用生成完成通知。</p>
          {/if}
        </div>
        <Switch
          checked={settings.experimentalFeatures.notificationPreview}
          onCheckedChange={handleNotificationPreviewToggle}
          disabled={!settings.experimentalFeatures.generationNotifications}
        />
      </div>

      <p class="text-muted-foreground text-xs italic">
        部分手机的电池优化机制仍可能中断生成。必要时，请在设备设置中将 Aventuras
        排除在电池优化之外。
      </p>
    </div>

    <Separator />
  {/if}

  <!-- Reset Button -->
  <div class="flex items-center justify-between">
    <div class="space-y-0.5">
      <p class="text-sm font-medium">重置实验功能</p>
      <p class="text-muted-foreground text-xs">关闭所有实验功能并恢复默认值。</p>
    </div>
    <Button variant="outline" size="sm" onclick={handleResetAll} class="gap-2">
      <RotateCcw class="h-4 w-4" />
      重置
    </Button>
  </div>

  <Separator />

  <!-- SQL Query Console Toggle -->
  <div class="flex flex-row items-center justify-between">
    <div class="space-y-0.5">
      <div class="flex items-center gap-2">
        <Terminal class="text-muted-foreground h-4 w-4" />
        <Label>SQL 查询控制台</Label>
      </div>
      <p class="text-muted-foreground text-xs">直接对应用的 SQLite 数据库执行 SQL 查询。</p>
    </div>
    <Switch checked={showSqlEditor} onCheckedChange={(v) => (showSqlEditor = v)} />
  </div>

  {#if showSqlEditor}
    <div class="space-y-3">
      <div
        class="bg-destructive/10 border-destructive/30 flex items-start gap-3 rounded-lg border p-3"
      >
        <AlertTriangle class="text-destructive mt-0.5 h-4 w-4 shrink-0" />
        <p class="text-destructive text-xs">
          <strong>高风险操作区域。</strong>
          写入语句（INSERT、UPDATE、DELETE、DROP）可能永久修改或损坏数据，请先备份。按
          <kbd class="bg-destructive/20 rounded px-1 py-0.5 font-mono text-[10px]">Ctrl+Enter</kbd> 执行。
        </p>
      </div>

      <!-- Query Input -->
      <textarea
        bind:value={sqlQuery}
        use:autosize={{ enabled: true, value: sqlQuery }}
        onkeydown={handleQueryKeydown}
        placeholder="SELECT * FROM stories LIMIT 10;"
        spellcheck={false}
        class="bg-surface-950 border-surface-700 text-foreground placeholder:text-muted-foreground max-h-[50dvh] w-full resize-none rounded-md border p-3 font-mono text-xs leading-relaxed focus:ring-1 focus:ring-amber-500/50 focus:outline-none"
        rows={4}></textarea>

      <!-- Actions -->
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={handleRunQuery}
          disabled={isQuerying || !sqlQuery.trim()}
          class="gap-2"
        >
          {#if isQuerying}
            <Loader2 class="h-4 w-4 animate-spin" />
            正在执行…
          {:else}
            <Play class="h-4 w-4" />
            执行查询
          {/if}
        </Button>
        {#if queryResult}
          <Button variant="ghost" size="sm" onclick={handleCopyResults} class="gap-2">
            <Copy class="h-4 w-4" />
            复制 JSON
          </Button>
          <span class="text-muted-foreground text-xs">
            {queryResult.rows.length} 行 用时 {queryTime}ms
          </span>
        {/if}
      </div>

      <!-- Error -->
      {#if queryError}
        <div class="bg-destructive/10 border-destructive/30 rounded-md border p-3">
          <p class="text-destructive font-mono text-xs whitespace-pre-wrap">{queryError}</p>
        </div>
      {/if}

      <!-- Results Table -->
      {#if queryResult && queryResult.rows.length > 0}
        <div class="border-surface-700 max-h-72 overflow-auto rounded-md border">
          <table class="w-full text-xs">
            <thead class="bg-surface-800 sticky top-0">
              <tr>
                {#each queryResult.columns as col (col)}
                  <th
                    class="border-surface-700 text-muted-foreground border-b px-3 py-2 text-left font-medium"
                  >
                    {col}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each queryResult.rows as row (JSON.stringify(row))}
                <tr class="border-surface-700/50 hover:bg-surface-800/50 border-b last:border-b-0">
                  {#each queryResult.columns as col (col)}
                    <td
                      class="text-foreground max-w-xs truncate px-3 py-1.5 font-mono"
                      title={String(row[col] ?? '')}
                    >
                      {row[col] === null ? 'NULL' : row[col]}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if queryResult && queryResult.rows.length === 0}
        <p class="text-muted-foreground text-xs italic">查询未返回数据。</p>
      {/if}
    </div>
  {/if}
</div>

<!-- Backup Warning Dialog -->
<Dialog.Root bind:open={showBackupConfirm}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <AlertTriangle class="h-5 w-5 text-amber-500" />
        备份包含敏感信息
      </Dialog.Title>
      <Dialog.Description class="space-y-3 pt-2">
        <p>
          备份包含你的 <strong>完整设置</strong>，其中包括
          <strong class="text-destructive">API 密钥</strong> 和
          <strong class="text-destructive">模型服务商配置</strong>.
        </p>
        <p class="font-medium text-amber-500">
          请勿与他人分享此文件，持有备份的人可以读取其中的 API 密钥。
        </p>
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="gap-2 sm:gap-0">
      <Button variant="outline" onclick={() => (showBackupConfirm = false)}>取消</Button>
      <Button onclick={handleBackupConfirmed} class="gap-2">
        <Download class="h-4 w-4" />
        继续
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Restore Confirmation Dialog -->
<Dialog.Root bind:open={showRestoreConfirm}>
  <Dialog.Content class="p-6 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <AlertTriangle class="h-5 w-5 text-amber-500" />
        从备份恢复
      </Dialog.Title>
      <Dialog.Description class="space-y-3 pt-2">
        <p>
          此操作将 <strong class="text-destructive">替换整个数据库</strong> ，使用备份 ZIP 中的数据库。
        </p>
        <p>
          当前数据库会另存一份安全副本，文件名为
          <span class="font-mono text-xs">aventura-pre-restore.db</span> ，位于应用数据目录。
        </p>
        <p class="font-medium text-amber-500">恢复后应用将关闭，需要手动重新打开。</p>
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="mt-4 justify-between sm:justify-between">
      <Button variant="outline" onclick={() => (showRestoreConfirm = false)}>取消</Button>
      <Button
        variant="outline"
        onclick={handleRestoreConfirmed}
        class="border-destructive text-destructive hover:bg-destructive/10 gap-2"
      >
        <Upload class="h-4 w-4" />
        恢复并关闭应用
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
