/** Compact replacement diff, retaining common context without quadratic LCS work. */
export function templateDiff(before: string, after: string): string {
  if (before === after) return 'No changes'
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++
  let end = 0
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]
  )
    end++
  return [
    `@@ -${start + 1},${oldLines.length - start - end} +${start + 1},${newLines.length - start - end} @@`,
    ...oldLines.slice(Math.max(0, start - 2), start).map((line) => ` ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `-${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+${line}`),
    ...newLines.slice(newLines.length - end, newLines.length - end + 2).map((line) => ` ${line}`),
  ].join('\n')
}
