import type { EntryInjection, EntryInjectionMode } from '$lib/types'

const INJECTION_MODES: EntryInjectionMode[] = ['always', 'keyword', 'never']

export function parseJsonOr<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  const candidate = Array.isArray(value) ? value : fallback
  return candidate.filter((item): item is string => typeof item === 'string')
}

export function normalizeEntryInjection(
  value: unknown,
  fallback: Partial<EntryInjection> = {},
): EntryInjection {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<EntryInjection>)
      : {}
  const fallbackMode = INJECTION_MODES.includes(fallback.mode ?? 'keyword')
    ? (fallback.mode ?? 'keyword')
    : 'keyword'
  const candidateMode = candidate.mode
  const mode =
    candidateMode && INJECTION_MODES.includes(candidateMode) ? candidateMode : fallbackMode
  const candidatePriority = candidate.priority
  const fallbackPriority = fallback.priority

  return {
    mode,
    keywords: normalizeStringArray(candidate.keywords, normalizeStringArray(fallback.keywords)),
    priority:
      typeof candidatePriority === 'number' && Number.isFinite(candidatePriority)
        ? candidatePriority
        : typeof fallbackPriority === 'number' && Number.isFinite(fallbackPriority)
          ? fallbackPriority
          : 0,
  }
}
