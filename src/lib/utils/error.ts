export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    if (value.error && value.error !== error) {
      const nested = errorMessage(value.error)
      if (nested !== '[object Object]') return nested
    }
    for (const key of ['message', 'statusText', 'body', 'responseBody', 'code', 'status']) {
      const candidate = value[key]
      if (candidate !== undefined && candidate !== null) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate
        if (typeof candidate !== 'string') {
          try { return JSON.stringify(candidate) } catch { /* fall through */ }
        }
      }
    }
    try { return JSON.stringify(error) } catch { return Object.prototype.toString.call(error) }
  }
  return String(error)
}

export function asError(error: unknown, fallback = '未知错误'): Error {
  if (error instanceof Error) return error
  const message = errorMessage(error)
  return new Error(message === '[object Object]' ? fallback : message)
}

// Keep the short name used by existing import/export UI code.
export const errMessage = errorMessage
