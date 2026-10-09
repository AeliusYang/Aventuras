import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('$lib/stores/debug.svelte', () => ({
  debug: { isActive: true, addDebugRequest: vi.fn(() => 'debug-id'), addDebugResponse: vi.fn() },
}))

import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { debug } from '$lib/stores/debug.svelte'
import { createTimeoutFetch } from './fetch'

const url = 'https://user:password@example.com/v1/chat/completions?api_key=query-secret#secret'
const body = {
  model: 'writer-model',
  max_tokens: 8192,
  temperature: 0.8,
  messages: [{ role: 'user', content: 'private-prompt' }],
  metadata: { secret: 'private-metadata' },
}
const init = {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { Authorization: 'x', 'X-Api-Key': 'long-secret-token', Cookie: 'cookie-secret' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe.each(['collaborative-chinese-writer', 'collaborative:sceneDirector'])(
  '%s privacy',
  (service) => {
    it('logs only request metadata and response length without altering the wire payload', async () => {
      vi.mocked(httpFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'private-response' } }],
            promptFeedback: { secret: 'private-feedback' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      const response = await createTimeoutFetch(1000, service, '', 'external-id')(url, init)
      expect(debug.addDebugRequest).toHaveBeenCalledExactlyOnceWith(
        service,
        {
          model: 'writer-model',
          max_tokens: 8192,
          temperature: 0.8,
          messageCount: 1,
          messageLengths: [JSON.stringify(body.messages[0]).length],
        },
        'external-id',
      )
      expect(httpFetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          body: init.body,
          headers: init.headers,
        }),
      )
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: 'private-response' } }],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const logs = JSON.stringify([
        vi.mocked(debug.addDebugRequest).mock.calls,
        vi.mocked(debug.addDebugResponse).mock.calls,
      ])
      for (const secret of [
        'private-',
        'query-secret',
        'password',
        'cookie-secret',
        'long-secret-token',
      ]) {
        expect(logs).not.toContain(secret)
      }
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each([200, 400])(
      'does not read streaming or error bodies for debugging (%s)',
      async (status) => {
        const response = new Response('private-response-or-error', {
          status,
          statusText: 'private-status',
          headers: { 'content-type': 'text/event-stream' },
        })
        const clone = vi.spyOn(response, 'clone')
        vi.mocked(httpFetch).mockResolvedValue(response)
        const returned = await createTimeoutFetch(1000, service)(url, init)
        expect(returned).toBe(response)
        expect(clone).not.toHaveBeenCalled()
        expect(debug.addDebugResponse).toHaveBeenCalledWith(
          'debug-id',
          service,
          status === 200 ? { status, stream: true } : { status },
          expect.any(Number),
        )
        expect(await returned.text()).toBe('private-response-or-error')
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it('omits nonnumeric and unrecognized metadata fields', async () => {
      vi.mocked(httpFetch).mockResolvedValue(new Response('ok'))
      await createTimeoutFetch(1000, service)(url, {
        ...init,
        body: JSON.stringify({
          model: { secret: 'private-model' },
          max_tokens: 'private-token',
          temperature: {},
          contents: [{ parts: [{ text: 'private-prompt' }] }],
          generationConfig: { maxOutputTokens: 7000, temperature: 0.6, secret: 'private-config' },
        }),
      })
      expect(debug.addDebugRequest).toHaveBeenCalledWith(
        service,
        {
          maxOutputTokens: 7000,
          temperature: 0.6,
          messageCount: 1,
          messageLengths: [JSON.stringify({ parts: [{ text: 'private-prompt' }] }).length],
        },
        undefined,
      )
    })

    it('propagates stage cancellation after receiving streaming headers', async () => {
      const stage = new AbortController()
      const response = new Response('pending', { headers: { 'content-type': 'text/event-stream' } })
      vi.mocked(httpFetch).mockResolvedValue(response)
      await createTimeoutFetch(1000, service)(url, { ...init, signal: stage.signal })
      const forwarded = vi.mocked(httpFetch).mock.calls[0][1]!.signal!
      expect(forwarded.aborted).toBe(false)
      const reason = new DOMException('stage deadline', 'TimeoutError')
      stage.abort(reason)
      expect(forwarded.aborted).toBe(true)
      expect(forwarded.reason).toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
    })
  },
)

describe('ordinary request regression', () => {
  it.each(['object', 'headers', 'tuples'] as const)(
    'fully masks credentials in %s headers',
    async (form) => {
      const entries: [string, string][] = [
        ['Authorization', 'x'],
        ['X-Api-Key', ''],
        ['X-Custom-Credential', 'private-secret'],
      ]
      const headers =
        form === 'headers'
          ? new Headers(entries)
          : form === 'tuples'
            ? entries
            : Object.fromEntries(entries)
      vi.mocked(httpFetch).mockResolvedValue(
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      )
      await createTimeoutFetch(1000, 'narrative')(url, { ...init, headers })
      const logged = vi.mocked(debug.addDebugRequest).mock.calls[0][1].headers as Record<
        string,
        string
      >
      expect(Object.values(logged)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]'])
      const sent = vi.mocked(httpFetch).mock.calls[0][1]!.headers
      expect(new Headers(sent).get('Authorization')).toBe('x')
      expect(new Headers(sent).get('X-Custom-Credential')).toBe('private-secret')
    },
  )

  it('keeps manual overrides and debug bodies while fully masking headers and URL credentials', async () => {
    vi.mocked(httpFetch).mockResolvedValue(
      new Response('{"text":"ordinary-response"}', {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await createTimeoutFetch(1000, 'narrative', '{"max_tokens":123,"model":"ignored"}')(url, init)
    expect(httpFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        body: JSON.stringify({ ...body, max_tokens: 123 }),
        headers: init.headers,
      }),
    )
    expect(debug.addDebugRequest).toHaveBeenCalledWith(
      'narrative',
      {
        url: 'https://example.com/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]', Cookie: '[REDACTED]' },
        body: { ...body, max_tokens: 123 },
      },
      undefined,
    )
    expect(debug.addDebugResponse).toHaveBeenCalledWith(
      'debug-id',
      'narrative',
      expect.objectContaining({
        body: { text: 'ordinary-response', usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      expect.any(Number),
    )
  })
})

describe('abort and cleanup', () => {
  it('rejects an already aborted signal with its original reason before making a request', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(
      createTimeoutFetch(1000, 'collaborative:writer')(url, { ...init, signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(httpFetch).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'invalid-json', 'network-error', 'body-error'])(
    'cleans timer and listener after %s without swallowing errors',
    async (path) => {
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const error = new Error('private-network-error')
      const response = new Response('{}', { headers: { 'content-type': 'application/json' } })
      if (path === 'network-error') vi.mocked(httpFetch).mockRejectedValue(error)
      else vi.mocked(httpFetch).mockResolvedValue(response)
      if (path === 'body-error') vi.spyOn(response, 'text').mockRejectedValue(error)
      const result = createTimeoutFetch(1000, 'collaborative:writer')(url, {
        ...init,
        body: path === 'invalid-json' ? '{' : init.body,
        signal: controller.signal,
      })
      if (path === 'success') await result
      else if (path === 'invalid-json')
        await expect(result).rejects.toThrow('Request body is not valid JSON')
      else await expect(result).rejects.toBe(error)
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['caller', 'timeout'])(
    'forwards %s cancellation and releases resources',
    async (source) => {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      vi.mocked(httpFetch).mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
              once: true,
            })
          }),
      )
      const result = createTimeoutFetch(1000, 'collaborative:writer')(url, {
        ...init,
        signal: controller.signal,
      })
      const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
      if (source === 'caller') controller.abort()
      else await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
