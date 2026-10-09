import { describe, expect, it, vi } from 'vitest'
const log = vi.hoisted(() => vi.fn())
vi.mock('$lib/log', () => ({ createLogger: () => log }))
import { loggingMiddleware } from './logging'

describe('AI console metadata logging', () => {
  it('does not copy private prompt, prose or provider metadata into console output', async () => {
    const middleware = loggingMiddleware()
    const result = {
      content: [{ type: 'text', text: 'PRIVATE_PROSE' }],
      usage: { inputTokens: 2 },
      finishReason: 'stop',
      providerMetadata: { secret: 'PRIVATE_KEY' },
    }
    await middleware.wrapGenerate!({
      doGenerate: async () => result,
      params: {
        prompt: [{ role: 'system', content: 'PRIVATE_PROMPT' }],
        responseFormat: { type: 'json', schema: { description: 'PRIVATE_SCHEMA' } },
      },
    } as never)
    const captured = JSON.stringify(log.mock.calls)
    expect(captured).toContain('message')
    expect(captured).not.toMatch(/PRIVATE_(PROMPT|PROSE|KEY|SCHEMA)/)
  })
})
