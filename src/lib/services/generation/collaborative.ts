import type { Story, StoryEntry, TargetLength } from '$lib/types'
import type {
  CollaborativeNovelLength,
  CollaborativeNovelPatternFreshness,
  CollaborativeNovelPatternState,
  NovelRetry,
  NovelTurn,
} from '$lib/types/collaborative'

export const DEFAULT_NOVEL_LENGTH: CollaborativeNovelLength = '1500-3000中文字'
const LENGTH_VALUE =
  /^((?:\d{1,3}(?:,\d{3})+|\d+))(?:\s*[-–—~～至到]\s*((?:\d{1,3}(?:,\d{3})+|\d+)))?\s*(?:个?\s*(?:中文字符|中文字|汉字|字))?$/
const EXPLICIT_LENGTH =
  /((?:\d{1,3}(?:,\d{3})+|\d+)(?:\s*[-–~～至到]\s*(?:\d{1,3}(?:,\d{3})+|\d+))?)\s*(?:个?\s*(?:中文字符|中文字|汉字|字))/g

export function validateCollaborativeLength(value: string): CollaborativeNovelLength {
  const match = value.trim().match(LENGTH_VALUE)
  if (!match) throw new Error('中文写作篇幅必须是字符单值或范围，例如 2000 或 1500-3000。')
  const minimum = Number(match[1].replace(/,/g, ''))
  const maximum = match[2] ? Number(match[2].replace(/,/g, '')) : undefined
  if (!Number.isSafeInteger(minimum) || minimum <= 0) throw new Error('中文写作篇幅必须大于 0。')
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < minimum))
    throw new Error('中文写作篇幅范围的上限必须不小于下限。')
  return `${minimum}${maximum === undefined ? '' : `-${maximum}`}中文字` as CollaborativeNovelLength
}

export function collaborativeLengthFromRawInput(rawInput: string): CollaborativeNovelLength | null {
  const matches = [...rawInput.matchAll(EXPLICIT_LENGTH)]
  if (!matches.length) return null
  const explicit = matches.filter((match) => {
    const before = rawInput.slice(Math.max(0, match.index! - 16), match.index)
    const after = rawInput.slice(match.index! + match[0].length, match.index! + match[0].length + 6)
    return (
      rawInput.trim() === match[0].trim() ||
      /(?:本轮|这轮|正文|篇幅|长度|字数|写|生成|控制|限制)/.test(before) ||
      /^(?:左右|上下|以内|以上|以下|篇幅|长度|正文)/.test(after)
    )
  })
  return explicit.length ? validateCollaborativeLength(explicit.at(-1)![0]) : null
}

export function resolveCollaborativeLength(
  rawInput: string,
  storyDefault?: string,
  setupLength?: TargetLength,
): string {
  const setupInstructions = {
    dynamic: '随场景节奏动态调整：快速交锋简短，完整场景充分展开，不固定字数',
    short: '短篇幅（约 2–4 段），集中完成当前叙事动作',
    medium: '中等篇幅（约 3–6 段），充分展开当前场景',
    long: '长篇幅（约 5–8 段以上），展开细节与人物张力',
  }
  return (
    collaborativeLengthFromRawInput(rawInput) ??
    (storyDefault !== undefined
      ? validateCollaborativeLength(storyDefault)
      : setupLength
        ? setupInstructions[setupLength]
        : DEFAULT_NOVEL_LENGTH)
  )
}

export function collaborativePatternFreshness(
  state: CollaborativeNovelPatternState | null | undefined,
  currentHistoryKey: string,
  currentNarrationCount: number,
): CollaborativeNovelPatternFreshness | undefined {
  if (!state?.confirmed) return undefined
  if (state.analyzedHistoryKey === currentHistoryKey) return 'current'
  if (state.analyzedNarrationCount === undefined) return 'stale'
  const added = currentNarrationCount - state.analyzedNarrationCount
  return added > 0 && added <= 2 ? 'aging' : 'stale'
}

export function historyKey(entries: StoryEntry[]): string {
  let hash = 2166136261
  for (const entry of entries.filter((e) => e.type === 'narration' || e.type === 'user_action'))
    for (const char of `${entry.type}\0${entry.content}\0`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16)
}

export function previousNovelTurn(entries: StoryEntry[]): NovelTurn | null {
  return (
    [...entries].reverse().find((entry) => {
      const turn = entry.metadata?.novelTurn
      return (
        entry.type === 'narration' &&
        entry.content.trim() &&
        turn?.version === 2 &&
        turn.sceneDirectorOutput?.trim() &&
        !turn.directorDiagnostics?.directorFallback
      )
    })?.metadata?.novelTurn ?? null
  )
}

export function collaborativeUserContext(
  entries: StoryEntry[],
  currentEntryId?: string,
  includePreviousDirector = true,
) {
  const currentIndex = currentEntryId
    ? entries.findIndex((entry) => entry.id === currentEntryId)
    : -1
  const history = currentIndex < 0 ? entries : entries.slice(0, currentIndex)
  const recentUserInputs = history
    .filter((entry) => entry.type === 'user_action' && entry.content.trim())
    .slice(-8)
    .map((entry) => ({ entryId: entry.id, text: entry.content }))
  const previousDirectorOutput = includePreviousDirector
    ? previousNovelTurn(history)?.sceneDirectorOutput
    : undefined
  return {
    ...(recentUserInputs.length ? { recentUserInputs } : {}),
    ...(previousDirectorOutput ? { previousDirectorOutput } : {}),
  }
}

export function collaborativeRerollInput(input: Record<string, unknown>) {
  if (!input.reroll || typeof input.reroll !== 'object' || Array.isArray(input.reroll)) return input
  const fields = { ...input }
  const reroll = { ...(input.reroll as Record<string, unknown>) }
  delete fields.previousDirectorOutput
  delete fields.rejectedDirectorOutput
  delete reroll.rejectedDirectorOutput
  fields.reroll = reroll
  return fields
}

export function collaborativeRecentPassages(entries: StoryEntry[]) {
  const passages: { entryId: string; passage: number; text: string; userInputEntryId?: string }[] =
    []
  let userInputEntryId: string | undefined
  for (const entry of entries) {
    if (entry.type === 'user_action') userInputEntryId = entry.id
    if (entry.type !== 'narration') continue
    passages.push({
      entryId: entry.id,
      passage: passages.length + 1,
      text: entry.content,
      ...(userInputEntryId ? { userInputEntryId } : {}),
    })
    userInputEntryId = undefined
  }
  return passages.slice(-8)
}

export function collaborativeOptionalContext(story: Story, entries: StoryEntry[]) {
  const workflow = story.settings?.collaborativeNovelWorkflow
  const confirmedPlan =
    workflow?.narrativePlanner?.enabled === false
      ? null
      : story.settings?.collaborativeNovelPlan?.confirmed
  const confirmedPatternGuidance =
    workflow?.patternReviewer?.enabled === false
      ? null
      : story.settings?.collaborativeNovelPattern?.confirmed
  return {
    ...collaborativeUserContext(entries),
    ...(confirmedPlan ? { confirmedPlan } : {}),
    ...(confirmedPatternGuidance ? { confirmedPatternGuidance } : {}),
  }
}

const fallbackContexts = new WeakMap<NovelTurn, ReturnType<typeof collaborativeUserContext>>()

export function setNovelFallbackContext(
  turn: NovelTurn,
  context: ReturnType<typeof collaborativeUserContext>,
) {
  fallbackContexts.set(turn, context)
}

export function novelRetry(entry: StoryEntry, rawInput: string): NovelRetry {
  const turn = entry.metadata?.novelTurn
  return {
    mode: 'different',
    rawInput,
    sourceText: entry.content,
    sourceEntryId: entry.id,
    rejectedDirectorOutput: turn?.sceneDirectorOutput ?? undefined,
    historyKey: historyKey([entry]),
    storyId: entry.storyId,
    branchId: entry.branchId,
  }
}

export function novelWriterEntries(entries: StoryEntry[]): StoryEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type === 'narration') return [{ ...entry, metadata: null, reasoning: undefined }]
    if (entry.type === 'user_action') return [{ ...entry, metadata: null, reasoning: undefined }]
    return []
  })
}

export function novelWriterContext(turn: NovelTurn): string {
  const fallbackContext = fallbackContexts.get(turn)
  const userSources = fallbackContext && { ...fallbackContext }
  if (turn.reroll && userSources) delete userSources.previousDirectorOutput
  return [
    '【Scene Director 原始输出】',
    turn.sceneDirectorOutput ?? '本轮 Director 未返回内容，请依据其他原始上下文继续。',
    ...(!turn.sceneDirectorOutput || turn.directorDiagnostics?.directorFallback
      ? [
          '【临时失败回退资料：用户来源要求优先；指导、旧安排及拒绝版本均非事实】',
          ...(userSources ? [JSON.stringify(userSources)] : []),
          ...(turn.confirmedPlan
            ? ['【已确认长期计划；冲突部分停用，不改写】', turn.confirmedPlan]
            : []),
          ...(turn.confirmedPatternGuidance
            ? ['【已确认结构指导；按当前事实判断适用性】', turn.confirmedPatternGuidance]
            : []),
          ...(turn.reroll
            ? ['【被拒绝正文：识别旧因果路线并实质改换，不得当作历史】', turn.reroll.rejectedProse]
            : []),
        ]
      : []),
    '【用户本轮原始输入】',
    turn.rawInput,
    '【调用方权威篇幅 requestedLength】',
    turn.requestedLength || DEFAULT_NOVEL_LENGTH,
  ].join('\n\n')
}

export function novelOutputMetrics(turn: NovelTurn, content: string, finishReason?: string) {
  const length = turn.requestedLength || DEFAULT_NOVEL_LENGTH
  const numericLength = LENGTH_VALUE.test(length.trim())
  const requestedLength = numericLength ? validateCollaborativeLength(length) : length
  const actualChineseCharacters = (content.match(/\p{Script=Han}/gu) ?? []).length
  const minimum = numericLength ? Number(requestedLength.match(/\d+/)?.[0]) : undefined
  const outputTruncated =
    finishReason === 'length' ? true : finishReason === 'stop' ? false : undefined
  return {
    requestedLength,
    actualChineseCharacters,
    shortStopReason: outputTruncated
      ? '模型因输出 Token 上限停止，正文可能被截断；未自动扩写。'
      : minimum !== undefined && actualChineseCharacters < minimum
        ? `正文仅 ${actualChineseCharacters} 个中文字符，低于本轮目标 ${requestedLength}。`
        : undefined,
    outputTruncated,
    finishReason,
    outputMetricsWarning: undefined as string | undefined,
  }
}

export function recordNovelOutput(turn: NovelTurn, content: string, finishReason?: string) {
  const metrics = novelOutputMetrics(turn, content, finishReason)
  Object.assign(turn, metrics)
  return metrics
}
