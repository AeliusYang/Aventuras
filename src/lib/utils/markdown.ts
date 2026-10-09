/**
 * Markdown rendering utilities for story content.
 * Uses marked for parsing with safe defaults.
 */

import { marked, Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked'
import { findDialogueStart, matchDialogueAt } from './dialogue'

// Configure marked with safe defaults
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
})

interface DialogueToken extends Tokens.Generic {
  type: 'dialogue'
  open: string
  close: string
  tokens: Tokens.Generic[]
}

/**
 * Wraps quoted speech in `<span class="dialogue-line">`.
 *
 * This runs at the *tokenizer* level rather than over rendered HTML on purpose:
 * the tokenizer sees raw text before escaping, so it can never match a quote that
 * belongs to an HTML attribute (`class="..."` on an embedded image) or one inside
 * a code span. That immunity is structural, not defensive.
 *
 * The span is emitted unconditionally; whether it is coloured, and in what colour,
 * is decided entirely in CSS (`--dialogue-color` + `data-dialogue-highlight` on the
 * root). Gating here instead would force every consumer to re-render the whole
 * story when the user flips the toggle or drags the colour picker.
 */
const dialogueExtension: TokenizerAndRendererExtension = {
  name: 'dialogue',
  level: 'inline',

  start(src: string) {
    const index = findDialogueStart(src)
    return index === -1 ? undefined : index
  },

  tokenizer(src: string) {
    const match = matchDialogueAt(src, 0)
    if (!match) return undefined

    return {
      type: 'dialogue',
      raw: match.raw,
      open: match.open,
      close: match.close,
      tokens: this.lexer.inlineTokens(match.inner),
    } satisfies DialogueToken
  },

  renderer(token) {
    const { open, close, tokens } = token as DialogueToken
    const inner = this.parser.parseInline(tokens)
    return `<span class="dialogue-line">${open}${inner}${close}</span>`
  },
}

/** Dedicated instance: the dialogue extension must not leak into lorebook entries,
 * vault cards or assistant chat, which all go through `parseMarkdown`. */
const storyMarked = new Marked({ breaks: true, gfm: true }).use({
  extensions: [dialogueExtension],
})

/**
 * Mark dialogue in raw HTML returned by a writer without inspecting tag attributes.
 *
 * Some saved narrations contain a writer-owned `<maintext>`/`<p>` HTML wrapper. Marked
 * treats that wrapper as one HTML token, so inline extensions never see the quoted
 * text inside it. Scan only text nodes and send them through the same inline parser;
 * tags, comments, and attributes remain byte-for-byte unchanged.
 */
function renderStoryHtml(raw: string): string {
  let output = ''
  let cursor = 0
  let insideStatusBlock = false

  while (cursor < raw.length) {
    const tagStart = raw.indexOf('<', cursor)
    if (tagStart === -1) {
      output += storyMarked.parseInline(raw.slice(cursor))
      break
    }

    if (tagStart > cursor) {
      output += storyMarked.parseInline(raw.slice(cursor, tagStart))
    }

    const commentEnd = raw.indexOf('-->', tagStart + 4)
    if (raw.startsWith('<!--', tagStart) && commentEnd !== -1) {
      output += raw.slice(tagStart, commentEnd + 3)
      cursor = commentEnd + 3
      continue
    }

    let quote: string | null = null
    let tagEnd = tagStart + 1
    for (; tagEnd < raw.length; tagEnd++) {
      const ch = raw[tagEnd]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        tagEnd++
        break
      }
    }

    // An incomplete tag is safest as literal text, using marked's normal escaping.
    if (tagEnd > raw.length || raw[tagEnd - 1] !== '>') {
      output += storyMarked.parseInline(raw.slice(tagStart))
      break
    }

    const tag = raw.slice(tagStart, tagEnd)
    output += tag
    cursor = tagEnd

    // Status blocks contain quoted state labels, not spoken dialogue. Keep the entire
    // block opaque, including nested details/code tags, so its quotes never become
    // dialogue spans while the surrounding maintext remains parseable.
    if (/^<Status_block\b/i.test(tag)) {
      insideStatusBlock = true
      const closeTag = raw.toLowerCase().indexOf('</status_block>', cursor)
      if (closeTag !== -1) {
        output += raw.slice(cursor, closeTag)
        output += raw.slice(closeTag, closeTag + '</status_block>'.length)
        cursor = closeTag + '</status_block>'.length
        insideStatusBlock = false
      }
    } else if (insideStatusBlock && /^<\/Status_block\b/i.test(tag)) {
      insideStatusBlock = false
    }
  }

  return output
}

/**
 * Parse story prose (narration and player actions) to HTML, marking up dialogue.
 *
 * Used by both the saved-entry renderer and the streaming one, so a line does not
 * change appearance the moment generation finishes.
 */
export function parseStoryMarkdown(text: string): string {
  if (!text) return ''

  try {
    const result = text.trimStart().startsWith('<')
      ? renderStoryHtml(text)
      : storyMarked.parse(text)
    return typeof result === 'string' ? result : ''
  } catch (error) {
    console.error('[Markdown] Story parse error:', error)
    return escapeHtml(text)
  }
}

/**
 * Parse markdown string to HTML.
 * Safe for rendering in story content.
 */
export function parseMarkdown(text: string): string {
  if (!text) return ''

  try {
    // Parse the markdown - marked.parse() can return string or Promise
    // We use parseInline for inline elements to avoid wrapping in <p> tags
    // But for full content we want the full parser
    const result = marked.parse(text)

    // marked.parse returns string in sync mode (our configuration)
    return typeof result === 'string' ? result : ''
  } catch (error) {
    console.error('[Markdown] Parse error:', error)
    // Fallback to plain text with basic escaping
    return escapeHtml(text)
  }
}

/**
 * Parse a fragment of story prose without wrapping it in a block element.
 *
 * For text that is already inside an inline element — the span an embedded image
 * links to, which is spliced back into an already-rendered paragraph.
 */
export function parseStoryMarkdownInline(text: string): string {
  if (!text) return ''

  try {
    const result = storyMarked.parseInline(text)
    return typeof result === 'string' ? result : ''
  } catch (error) {
    console.error('[Markdown] Story inline parse error:', error)
    return escapeHtml(text)
  }
}

/**
 * Render a description that may be HTML or Markdown.
 * If content starts with an HTML tag, render directly (bypasses marked
 * which mangles raw HTML with its breaks/paragraph wrapping).
 * Otherwise parse as markdown.
 */
export function renderDescription(text: string): string {
  if (!text) return ''
  if (text.trimStart().startsWith('<')) return text
  return parseMarkdown(text)
}

/** Strip HTML/Markdown to plain text. Used for card previews where rich rendering isn't appropriate. */
export function stripToPlainText(text: string): string {
  if (!text) return ''
  const html = renderDescription(text)
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent ?? ''
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
