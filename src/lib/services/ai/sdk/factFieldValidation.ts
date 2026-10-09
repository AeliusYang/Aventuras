function discardedFields(source: unknown, parsed: unknown, path = ''): string[] {
  if (source === null || typeof source !== 'object') return []
  return Object.entries(source).flatMap(([key, value]) => {
    const fieldPath = Array.isArray(source)
      ? `${path}[${key}]`
      : /^[A-Za-z_$][\w$]*$/.test(key)
        ? `${path ? `${path}.` : ''}${key}`
        : `${path}[${JSON.stringify(key)}]`
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Object.prototype.hasOwnProperty.call(parsed, key)
    )
      return [fieldPath]
    return discardedFields(value, (parsed as Record<string, unknown>)[key], fieldPath)
  })
}

export function assertNoDiscardedFactFields(source: unknown, parsed: unknown): void {
  const paths = discardedFields(source, parsed)
  if (paths.length)
    throw new Error(
      `事实提取包含当前合同未接纳的字段：${paths.join('、')}。本次提取未应用，请针对已保存正文单独重试提取。`,
    )
}
