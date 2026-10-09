import { afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('$lib/stores/settings.svelte', () => ({
  settings: {
    getServicePresetId: () => 'writer',
    getPresetConfig: () => ({ timeoutMs: 360000 }),
  },
}))
import { NarrativePhase, type NarrativeInput } from './NarrativePhase'
import type { GenerationEvent, RetrievalResult } from '../types'
import type { StreamChunk } from '$lib/services/ai/core/types'
import type { NovelTurn } from '$lib/types/collaborative'
import { settings } from '$lib/stores/settings.svelte'
import * as collaborative from '../collaborative'

async function drain<R>(gen: AsyncGenerator<GenerationEvent, R>) {
  const events: GenerationEvent[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

/** A stream chunk; `content` and `done` are required on the type, so they get defaults. */
const chunk = (over: Partial<StreamChunk> = {}): StreamChunk => ({
  content: '',
  done: false,
  ...over,
})

/**
 * A stand-in for `streamNarrative` that yields the given chunks. Declared with rest
 * parameters so a `vi.fn()` wrapping it records the arguments the phase passed.
 */
const streamOf = (...chunks: StreamChunk[]) =>
  async function* (..._args: unknown[]): AsyncGenerator<StreamChunk> {
    for (const c of chunks) yield c
  }

const retrievalResult: RetrievalResult = {
  worldStateBlock: '## World State',
  chapterContext: '## Chapters',
  lorebookContext: '## Lorebook',
  lorebookRetrievalResult: null,
  worldStateRetrievalResult: null,
  timelineFillResult: null,
  combinedContext: '## Chapters\n## Lorebook',
}

function makeInput(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  return {
    visibleEntries: [],
    worldState: {} as any,
    story: { id: 's1' } as any,
    retrievalResult,
    styleReview: null,
    ...overrides,
  } as NarrativeInput
}

const phaseWith = (streamNarrative: any) => new NarrativePhase({ streamNarrative })
const novelTurn = () =>
  ({
    version: 2,
    historyKey: 'h',
    rawInput: '继续',
    requestedLength: '1500-3000中文字',
    sceneDirectorOutput: '导演原文',
    confirmedPlan: null,
    confirmedPatternGuidance: null,
  }) as NovelTurn

describe('NarrativePhase', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it.each(['dynamic', 'short', 'medium', 'long', undefined] as const)(
    'completes the stream for %s length, including persisted Writer recovery text',
    async (mode) => {
      const turn = novelTurn()
      turn.requestedLength = collaborative.resolveCollaborativeLength('继续', undefined, mode)
      const prose = '她把信放回抽屉。\n\n楼下有人敲门。'
      const { events, result } = await drain(
        phaseWith(
          streamOf(
            chunk({ content: prose.slice(0, 8) }),
            chunk({ content: prose.slice(8), done: true, finishReason: 'stop' }),
          ),
        ).execute(makeInput({ novelTurn: JSON.parse(JSON.stringify(turn)) })),
      )
      expect(result?.content).toBe(prose)
      expect(
        events
          .filter((event) => event.type === 'narrative_chunk')
          .map((event) => event.content)
          .join(''),
      ).toBe(prose)
      expect(events.at(-1)).toMatchObject({
        type: 'phase_complete',
        phase: 'narrative',
        result: { content: prose },
      })
      expect(events.some((event) => event.type === 'error')).toBe(false)
    },
  )

  it('keeps completed prose and truncation metadata when metric recording throws', async () => {
    vi.spyOn(collaborative, 'recordNovelOutput').mockImplementation(() => {
      throw new Error('统计故障')
    })
    const turn = novelTurn()
    const { result, events } = await drain(
      phaseWith(
        streamOf(chunk({ content: '正文已完成。', done: true, finishReason: 'length' })),
      ).execute(makeInput({ novelTurn: turn })),
    )
    expect(result).toMatchObject({
      content: '正文已完成。',
      actualChineseCharacters: 5,
      outputTruncated: true,
      finishReason: 'length',
    })
    expect(result?.outputMetricsWarning).toContain('统计故障')
    expect(turn.outputMetricsWarning).toBe(result?.outputMetricsWarning)
    expect(events.at(-1)).toMatchObject({ type: 'phase_complete', phase: 'narrative' })
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
  it('accumulates content and reasoning across chunks', async () => {
    const stream = streamOf(
      chunk({ content: 'The dragon ', reasoning: 'setting up ' }),
      chunk({ content: 'fell.', reasoning: 'the fall' }),
      chunk({ done: true }),
    )

    const { events, result } = await drain(phaseWith(stream).execute(makeInput()))

    expect(result).toEqual({
      content: 'The dragon fell.',
      reasoning: 'setting up the fall',
      chunkCount: 3,
    })
    expect(events.filter((e) => e.type === 'narrative_chunk')).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('phase_complete')
  })

  it('does not emit a chunk event for a bare done marker', async () => {
    // It carries nothing to show; forwarding it would append an empty render pass.
    const stream = streamOf(chunk({ content: 'Hi.' }), chunk({ done: true }))

    const { events } = await drain(phaseWith(stream).execute(makeInput()))

    expect(events.filter((e) => e.type === 'narrative_chunk')).toHaveLength(1)
  })

  it('records Chinese length and a short-output reason without expanding the text', async () => {
    const { result } = await drain(
      phaseWith(
        streamOf(chunk({ content: '这是一段很短的正文。' }), chunk({ done: true })),
      ).execute(
        makeInput({
          novelTurn: {
            version: 2,
            historyKey: 'h',
            rawInput: '继续',
            sceneDirectorOutput: '继续推进',
            confirmedPlan: null,
            confirmedPatternGuidance: null,
          },
        }),
      ),
    )
    expect(result).toMatchObject({ requestedLength: '1500-3000中文字', actualChineseCharacters: 9 })
    expect(result?.shortStopReason).toContain('低于本轮目标')
  })

  it.each([undefined, 'stop', 'length', 'unknown', 'content-filter', 'tool-calls'])(
    'preserves actual finish reason %s in event, return and turn metadata',
    async (finishReason) => {
      const turn = novelTurn()
      const { result, events } = await drain(
        phaseWith(
          streamOf(chunk({ content: '中文𠀀。' }), chunk({ done: true, finishReason })),
        ).execute(makeInput({ novelTurn: turn })),
      )
      expect(result?.finishReason).toBe(finishReason)
      expect(result?.actualChineseCharacters).toBe(3)
      expect(result?.outputTruncated).toBe(
        finishReason === 'length' ? true : finishReason === 'stop' ? false : undefined,
      )
      expect(result?.shortStopReason).toBeTruthy()
      expect(events.at(-1)).toMatchObject({ type: 'phase_complete', result })
      expect(turn.finishReason).toBe(finishReason)
      expect(turn.outputTruncated).toBe(result?.outputTruncated)
      expect(turn.actualChineseCharacters).toBe(3)
    },
  )

  it('never guesses truncation from output length or trailing newline', async () => {
    for (const content of ['字'.repeat(11000), '短文。\n']) {
      const { result } = await drain(
        phaseWith(streamOf(chunk({ content, done: true }))).execute(
          makeInput({ novelTurn: novelTurn() }),
        ),
      )
      expect(result?.outputTruncated).toBeUndefined()
      expect(result?.finishReason).toBeUndefined()
    }
  })

  it('resets an empty attempt finish reason before a successful retry', async () => {
    let attempts = 0
    const stream = vi.fn(async function* () {
      if (++attempts === 1) yield chunk({ done: true, finishReason: 'stop' })
      else yield chunk({ content: '成功正文。', done: true })
    })
    const turn = novelTurn()
    const { result } = await drain(phaseWith(stream).execute(makeInput({ novelTurn: turn })))
    expect(stream).toHaveBeenCalledTimes(2)
    expect(result?.finishReason).toBeUndefined()
    expect(turn.outputTruncated).toBeUndefined()
  })

  it('preserves finish metadata on ordinary narration without adding novel metrics', async () => {
    const { result } = await drain(
      phaseWith(
        streamOf(chunk({ content: 'Ordinary.', done: true, finishReason: 'stop' })),
      ).execute(makeInput()),
    )
    expect(result?.finishReason).toBe('stop')
    expect(result?.actualChineseCharacters).toBeUndefined()
    expect(result?.requestedLength).toBeUndefined()
  })

  it('does not retry an exhausted empty collaborative response', async () => {
    const stream = vi.fn(streamOf(chunk({ done: true, finishReason: 'length' })))
    const { result, events } = await drain(
      phaseWith(stream).execute(makeInput({ novelTurn: novelTurn() })),
    )
    expect(stream).toHaveBeenCalledOnce()
    expect(result).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true })
    expect((events.at(-1) as any).error.message).toContain('额度已耗尽')
  })

  it('preserves ordinary RPG retries after exhausted empty output', async () => {
    let attempts = 0
    const stream = vi.fn(async function* () {
      if (++attempts === 1) yield chunk({ done: true, finishReason: 'length' })
      else yield chunk({ content: 'Ordinary.', done: true, finishReason: 'stop' })
    })
    const { result } = await drain(phaseWith(stream).execute(makeInput()))
    expect(result?.content).toBe('Ordinary.')
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('times out a stream that stalls after text, without completing partial prose', async () => {
    vi.useFakeTimers()
    const turn = novelTurn()
    const stream = async function* () {
      yield chunk({ content: '尚未写完' })
      await new Promise(() => {})
    }
    const pending = drain(phaseWith(stream).execute(makeInput({ novelTurn: turn })))
    await vi.advanceTimersByTimeAsync(360000)
    const { result, events } = await pending
    expect(result).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { name: 'TimeoutError' } })
    expect(events.some((event) => event.type === 'phase_complete')).toBe(false)
    expect(turn.actualChineseCharacters).toBeUndefined()
  })

  it('uses one deadline across empty retries', async () => {
    vi.useFakeTimers()
    const stream = vi.fn(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 200000))
      yield chunk({ done: true, finishReason: 'stop' })
    })
    const pending = drain(phaseWith(stream).execute(makeInput({ novelTurn: novelTurn() })))
    await vi.advanceTimersByTimeAsync(360000)
    const { result, events } = await pending
    expect(stream).toHaveBeenCalledTimes(2)
    expect(result).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { name: 'TimeoutError' } })
  })

  it('cancels promptly when the provider ignores the signal', async () => {
    const controller = new AbortController()
    const stream = async function* () {
      yield chunk({ content: '未完' })
      await new Promise(() => {})
    }
    const pending = drain(
      phaseWith(stream).execute(
        makeInput({
          novelTurn: novelTurn(),
          abortSignal: controller.signal,
        }),
      ),
    )
    controller.abort()
    const { result, events } = await pending
    expect(result).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'aborted' })
  })

  it('uses the configured Writer budget instead of the default timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(settings, 'getPresetConfig').mockReturnValue({ timeoutMs: 123000 } as any)
    const stream = async function* () {
      await new Promise(() => {})
      yield chunk({ content: 'unreachable' })
    }
    const pending = drain(phaseWith(stream).execute(makeInput({ novelTurn: novelTurn() })))
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(122999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const { events } = await pending
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { name: 'TimeoutError' } })
    expect(settings.getPresetConfig).toHaveBeenCalledWith('writer', 'collaborativeWriter')
  })

  it('never records late prose after the stage has timed out', async () => {
    vi.useFakeTimers()
    const turn = novelTurn()
    let release: () => void = () => {}
    const stream = async function* () {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      yield chunk({ content: '迟到的完整正文', done: true, finishReason: 'stop' })
    }
    const pending = drain(phaseWith(stream).execute(makeInput({ novelTurn: turn })))
    await vi.advanceTimersByTimeAsync(360000)
    const { result, events } = await pending
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBeNull()
    expect(turn.actualChineseCharacters).toBeUndefined()
    expect(events.some((event) => event.type === 'phase_complete')).toBe(false)
  })

  it('does not complete or record partial output after a provider error', async () => {
    const turn = novelTurn()
    const stream = async function* () {
      yield chunk({ content: '部分正文。' })
      throw new Error('provider error part')
    }
    const { result, events } = await drain(
      phaseWith(stream).execute(makeInput({ novelTurn: turn })),
    )
    expect(result).toBeNull()
    expect(events.some((event) => event.type === 'phase_complete')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true })
    expect(turn.actualChineseCharacters).toBeUndefined()
  })

  it('passes the world state block separately from the retrieved context', async () => {
    // The two are joined downstream, not here: memory retrieval has to be told what world
    // state the narrator already has, which is only expressible while they are distinct.
    const streamNarrative = vi.fn(streamOf(chunk({ content: 'Hi.' }), chunk({ done: true })))

    await drain(phaseWith(streamNarrative).execute(makeInput()))

    const args = streamNarrative.mock.calls[0]
    expect(args[4]).toBe('## Chapters\n## Lorebook')
    expect(args[7]).toBe('## World State')
  })

  describe('empty responses', () => {
    // Some providers return a well-formed but empty stream. Surfacing that as a blank
    // narration looks like the app broke, so it is retried before giving up.

    it('retries and succeeds on a later attempt', async () => {
      let attempt = 0
      const streamNarrative = vi.fn(async function* () {
        attempt++
        if (attempt < 3) return
        yield chunk({ content: 'Finally.' })
      })

      const { result } = await drain(phaseWith(streamNarrative).execute(makeInput()))

      expect(streamNarrative).toHaveBeenCalledTimes(3)
      expect(result?.content).toBe('Finally.')
    })

    it('treats whitespace-only output as empty', async () => {
      const streamNarrative = vi.fn(streamOf(chunk({ content: '   \n  ' })))

      const { result } = await drain(phaseWith(streamNarrative).execute(makeInput()))

      expect(streamNarrative).toHaveBeenCalledTimes(3)
      expect(result).toBeNull()
    })

    it('gives up fatally after three attempts', async () => {
      const streamNarrative = vi.fn(async function* (): AsyncGenerator<StreamChunk> {})

      const { events, result } = await drain(phaseWith(streamNarrative).execute(makeInput()))

      expect(streamNarrative).toHaveBeenCalledTimes(3)
      expect(result).toBeNull()
      const error = events.find((e) => e.type === 'error')
      expect(error).toMatchObject({ fatal: true, phase: 'narrative' })
    })
  })

  it('treats a stream failure as fatal, unlike the other phases', async () => {
    // There is no turn without a narration, so this one cannot degrade gracefully.
    const streamNarrative = async function* (): AsyncGenerator<StreamChunk> {
      throw new Error('provider down')
    }

    const { events, result } = await drain(phaseWith(streamNarrative).execute(makeInput()))

    expect(result).toBeNull()
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true })
  })

  describe('abort', () => {
    it('does not start the stream when already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const streamNarrative = vi.fn()

      const { events, result } = await drain(
        phaseWith(streamNarrative).execute(makeInput({ abortSignal: controller.signal })),
      )

      expect(streamNarrative).not.toHaveBeenCalled()
      expect(result).toBeNull()
      expect(events.map((e) => e.type)).toEqual(['phase_start', 'aborted'])
    })

    it('stops mid-stream and discards what it had', async () => {
      const controller = new AbortController()
      const streamNarrative = async function* () {
        yield chunk({ content: 'The dragon ' })
        controller.abort()
        yield chunk({ content: 'fell.' })
      }

      const { events, result } = await drain(
        phaseWith(streamNarrative).execute(makeInput({ abortSignal: controller.signal })),
      )

      expect(result).toBeNull()
      expect(events.at(-1)?.type).toBe('aborted')
      expect(events.filter((e) => e.type === 'narrative_chunk')).toHaveLength(1)
    })

    it('reports an AbortError as an abort, not a fatal error', async () => {
      const abortError = new Error('aborted')
      abortError.name = 'AbortError'
      const streamNarrative = async function* (): AsyncGenerator<StreamChunk> {
        throw abortError
      }

      const { events } = await drain(phaseWith(streamNarrative).execute(makeInput()))

      expect(events.map((e) => e.type)).toEqual(['phase_start', 'aborted'])
    })
  })
})
