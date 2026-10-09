export function createRequestDeadline(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  label: string,
) {
  const controller = new AbortController()
  let rejectDeadline: (error: unknown) => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  void deadline.catch(() => {})
  const abort = (error: unknown) => {
    controller.abort(error)
    rejectDeadline(error)
  }
  const onAbort = () => abort(parent?.reason ?? new DOMException('Request aborted', 'AbortError'))
  const timer = setTimeout(
    () =>
      abort(new DOMException(`${label} request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  )
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) onAbort()
  return {
    signal: controller.signal,
    wait: <Result>(pending: PromiseLike<Result>): Promise<Result> =>
      Promise.race([pending, deadline]),
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
      if (!controller.signal.aborted) controller.abort()
    },
  }
}
