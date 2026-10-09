import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const native = vi.hoisted(() => ({
  check: vi.fn(),
  fetch: vi.fn(),
  openUrl: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  getBundleType: vi.fn(),
  isAndroid: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: native.check }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: native.openUrl }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: native.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: native.getVersion,
  getBundleType: native.getBundleType,
}))
vi.mock('$lib/utils/platform', () => ({ isAndroid: native.isAndroid }))

import { updaterService, UpdateError } from './updater'
import { LOCAL_RELEASE_UPDATE_NOTICE, UPSTREAM_UPDATES_ENABLED } from '../constants/localRelease'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  Object.assign(updaterService, { updateAvailable: null, lastInfo: null })
})

describe('local distribution cannot replace itself with upstream', () => {
  it.each([false, true])(
    'does not query desktop or GitHub update endpoints (Android=%s)',
    async (android) => {
      native.isAndroid.mockReturnValue(android)
      expect(UPSTREAM_UPDATES_ENABLED).toBe(false)
      await expect(updaterService.checkForUpdates()).rejects.toEqual(
        new UpdateError('unsupported', LOCAL_RELEASE_UPDATE_NOTICE),
      )
      expect(native.check).not.toHaveBeenCalled()
      expect(native.fetch).not.toHaveBeenCalled()
      expect(native.getVersion).not.toHaveBeenCalled()
      expect(native.getBundleType).not.toHaveBeenCalled()
      expect(updaterService.isChecking()).toBe(false)
    },
  )

  it('rejects stale update installation and all update-specific navigation/relaunch', async () => {
    const install = vi.fn()
    Object.assign(updaterService, {
      updateAvailable: { downloadAndInstall: install },
      lastInfo: {
        available: true,
        canInstallInApp: true,
        downloadUrl: 'https://example.invalid/update.exe',
      },
    })
    expect(updaterService.hasUpdate()).toBe(false)
    expect(updaterService.getUpdateInfo()).toBeNull()
    expect(await updaterService.downloadAndInstall()).toBe(false)
    await updaterService.openDownloadPage()
    await updaterService.relaunch()
    expect(install).not.toHaveBeenCalled()
    expect(native.openUrl).not.toHaveBeenCalled()
    expect(native.relaunch).not.toHaveBeenCalled()
    expect(updaterService.isDownloading()).toBe(false)
  })

  it('removes native updater registration, capabilities and remote config without changing product identity', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'))
    expect(config.identifier).toBe('com.karelian.aventura')
    expect(config.productName).toBe('Aventuras')
    expect(config.bundle.createUpdaterArtifacts).toBe(false)
    expect(config.plugins.updater).toBeUndefined()
    expect(
      capability.permissions.filter(
        (permission: unknown) =>
          typeof permission === 'string' && permission.startsWith('updater:'),
      ),
    ).toEqual([])
    expect(readFileSync('src-tauri/src/lib.rs', 'utf8')).not.toContain(
      '.plugin(tauri_plugin_updater::',
    )
  })

  it('guards startup and update UI even when legacy auto-check settings remain enabled', () => {
    expect(readFileSync('src/routes/+page.svelte', 'utf8')).toContain(
      'if (UPSTREAM_UPDATES_ENABLED && settings.updateSettings.autoCheck)',
    )
    expect(readFileSync('src/lib/components/layout/AppShell.svelte', 'utf8')).toMatch(
      /\{#if UPSTREAM_UPDATES_ENABLED\}\s*<UpdateDialog\s*\/>/,
    )
    const settings = readFileSync('src/lib/components/settings/tabs/interface.svelte', 'utf8')
    expect(settings).toContain('if (!UPSTREAM_UPDATES_ENABLED) return')
    expect(settings).toContain('{#if !UPSTREAM_UPDATES_ENABLED}')
    expect(settings).toContain('{LOCAL_RELEASE_UPDATE_NOTICE}')
  })
})
