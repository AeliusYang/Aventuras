import { settings } from '$lib/stores/settings.svelte'
import { PROVIDERS } from '../sdk/providers/config'

export function getImageAnalysisConfigurationIssue(): string | null {
  const preset = settings.generationPresets.find(
    (value) => value.id === settings.getServicePresetId('imageGeneration'),
  )
  if (!preset) return '图片分析尚未绑定有效的 Agent Profile，请前往生成设置。'
  const profile = settings.getProfile(
    preset.profileId ?? settings.apiSettings.mainNarrativeProfileId,
  )
  if (!profile) return '图片分析缺少模型连接，请前往生成设置。'
  if (!preset.model?.trim()) return '图片分析尚未选择文本模型，请前往生成设置。'
  const provider = PROVIDERS[profile.providerType]
  if (!provider?.capabilities.textGeneration) return '图片分析连接不支持文本生成。'
  if (provider.requiresApiKey && !profile.apiKey?.trim())
    return '图片分析连接缺少 API 密钥，请前往模型连接。'
  if (profile.providerType === 'openai-compatible' && !profile.baseUrl?.trim())
    return '图片分析连接缺少服务地址，请前往模型连接。'
  return null
}

export function imageAnalysisBinding() {
  const preset = settings.getPresetConfig(
    settings.getServicePresetId('imageGeneration'),
    'imageGeneration',
  )
  const profile = settings.getProfile(
    preset.profileId ?? settings.apiSettings.mainNarrativeProfileId,
  )
  return { model: preset.model, profile: profile?.name ?? '未配置' }
}
