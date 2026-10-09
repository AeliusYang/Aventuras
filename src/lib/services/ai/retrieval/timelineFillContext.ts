import type { TimelineFillResult } from './TimelineFillService'

export function buildTimelineFillBlock(timelineFillResult?: TimelineFillResult | null): string {
  if (!timelineFillResult || timelineFillResult.responses.length === 0) return ''

  let block = '## Relevant Story Data\n'
  block +=
    'The following information was retrieved from past chapters and is relevant to the current scene:\n\n'

  for (const response of timelineFillResult.responses) {
    const chapterLabel =
      response.chapterNumbers.length === 1
        ? `Chapter ${response.chapterNumbers[0]}`
        : `Chapters ${response.chapterNumbers.join(', ')}`

    block += `**${chapterLabel}**\n`
    block += `Q: ${response.query}\n`
    block += `A: ${response.answer}\n\n`
  }

  return block
}
