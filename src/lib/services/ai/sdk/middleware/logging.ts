/**
 * Logging Middleware
 *
 * Logs request shape and usage without copying story text into console logs.
 */

import type { LanguageModelMiddleware } from 'ai'
import { createLogger } from '$lib/log'

const log = createLogger('AI')

export function loggingMiddleware(): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      log('=== REQUEST ===')
      log('Request shape', { messages: params.prompt.length, structured: !!params.responseFormat })

      const result = await doGenerate()

      log('=== RESPONSE ===')
      if (result.usage) log('Usage:', result.usage)
      if (result.finishReason) log('Finish Reason:', result.finishReason)

      return result
    },

    wrapStream: async ({ doStream, params }) => {
      const startTime = Date.now()
      log('=== STREAM REQUEST ===')
      log('Request shape', { messages: params.prompt.length, structured: !!params.responseFormat })

      const { stream, ...rest } = await doStream()
      log('=== STREAM STARTED ===')

      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            flush() {
              const duration = Date.now() - startTime
              log(`=== STREAM FINISHED (${duration}ms) ===`)
            },
          }),
        ),
      }
    },
  }
}
