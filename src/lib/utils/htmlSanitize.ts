/**
 * HTML Sanitization for Visual Prose Mode.
 *
 * Sanitizes HTML for safe rendering while preserving rich styling capabilities.
 * Allows: div, span, p, style, most CSS properties
 * Blocks: script, iframe, javascript: URLs, dangerous CSS
 */

import { scopeCssSelectors } from './cssScope'
import { dialogueSpans } from './dialogue'

export interface TTSSanitizeOptions {
  removeTags: boolean
  removeAllTagContent: boolean
  htmlTagsToRemoveContent?: string[]
}

/**
 * Sanitize Visual Prose HTML for safe rendering.
 * @param html - Raw HTML content
 * @param entryId - Entry ID for CSS scoping
 * @param highlightDialogue - Wrap recognised dialogue text nodes for the story renderer
 * @returns Sanitized and scoped HTML
 */
export function sanitizeVisualProse(
  html: string,
  entryId: string,
  highlightDialogue = false,
): string {
  const scopeClass = `vp-${entryId.slice(0, 8)}`

  // Create a temporary container for parsing
  const template = document.createElement('template')
  template.innerHTML = html

  const fragment = template.content

  // Remove dangerous elements (but preserve inline image action buttons)
  const dangerousElements = fragment.querySelectorAll(
    'script, iframe, object, embed, form, input, textarea, select, meta, link, base',
  )
  dangerousElements.forEach((el) => el.remove())

  // Remove buttons except inline image action buttons
  const buttons = fragment.querySelectorAll('button')
  buttons.forEach((btn) => {
    const isInlineImageBtn =
      btn.classList.contains('inline-image-btn') || btn.hasAttribute('data-action')
    if (!isInlineImageBtn) {
      btn.remove()
    }
  })

  // Process all elements
  const allElements = fragment.querySelectorAll('*')
  allElements.forEach((el) => {
    // Remove event handlers and dangerous attributes
    const attributesToRemove: string[] = []

    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase()
      const value = attr.value.toLowerCase()

      // Remove event handlers
      if (name.startsWith('on')) {
        attributesToRemove.push(attr.name)
        return
      }

      // Remove javascript: URLs
      if (value.includes('javascript:') || value.includes('data:text/html')) {
        attributesToRemove.push(attr.name)
        return
      }

      // Remove dangerous href/src patterns
      if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
        attributesToRemove.push(attr.name)
        return
      }
    })

    attributesToRemove.forEach((name) => el.removeAttribute(name))

    // Sanitize inline styles
    if (el instanceof HTMLElement && el.style.cssText) {
      el.style.cssText = sanitizeInlineStyle(el.style.cssText)
    }
  })

  // Scope CSS in style tags
  const styleTags = fragment.querySelectorAll('style')
  styleTags.forEach((styleTag) => {
    if (styleTag.textContent) {
      styleTag.textContent = scopeCssSelectors(styleTag.textContent, scopeClass)
    }
  })

  // Convert newlines in text content to <br> tags (but not whitespace between tags)
  convertNewlinesToBr(fragment)
  if (highlightDialogue) markDialogueTextNodes(fragment)

  // Wrap in scoped container
  const wrapper = document.createElement('div')
  wrapper.className = `${scopeClass} visual-prose-entry`
  wrapper.appendChild(fragment)

  return wrapper.outerHTML
}

const blockTags = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

function markDialogueTextNodes(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const groups = new Map<Node, Text[]>()
  let node = walker.nextNode() as Text | null

  while (node) {
    const parent = node.parentElement
    if (
      node.textContent &&
      (!parent ||
        !parent.closest('status_block, pre, code, style, script, textarea, .dialogue-line'))
    ) {
      let group: Node = root
      let ancestor: Element | null = parent
      while (ancestor && ancestor !== root) {
        if (blockTags.has(ancestor.tagName.toLowerCase())) {
          group = ancestor
          break
        }
        ancestor = ancestor.parentElement
      }
      const textNodes = groups.get(group)
      if (textNodes) textNodes.push(node)
      else groups.set(group, [node])
    }
    node = walker.nextNode() as Text | null
  }

  for (const textNodes of groups.values()) {
    const text = textNodes.map((textNode) => textNode.textContent ?? '').join('')
    const spans = dialogueSpans(text)
    for (let index = spans.length - 1; index >= 0; index--) {
      const span = spans[index]
      if (!span) continue
      const range = document.createRange()
      const start = resolveTextPoint(textNodes, span.start, false)
      const end = resolveTextPoint(textNodes, span.end, true)
      if (!start || !end) continue
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const wrapper = document.createElement('span')
      wrapper.className = 'dialogue-line'
      wrapper.appendChild(range.extractContents())
      range.insertNode(wrapper)
    }
  }
}

function resolveTextPoint(
  textNodes: Text[],
  offset: number,
  endPoint: boolean,
): { node: Text; offset: number } | null {
  let position = 0
  for (const node of textNodes) {
    const length = node.textContent?.length ?? 0
    const nextPosition = position + length
    if (offset < nextPosition || (endPoint && offset === nextPosition)) {
      return { node, offset: offset - position }
    }
    position = nextPosition
  }
  const last = textNodes[textNodes.length - 1]
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : null
}

/** Mark dialogue in an already-sanitized HTML fragment without changing its structure. */
export function highlightDialogueHtml(html: string): string {
  if (!html || typeof document === 'undefined') return html

  const template = document.createElement('template')
  template.innerHTML = html
  markDialogueTextNodes(template.content)
  return template.innerHTML
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function markDialogueText(text: string): string {
  const spans = dialogueSpans(text)
  if (spans.length === 0) return escapeText(text)
  let output = ''
  let cursor = 0
  for (const span of spans) {
    output += escapeText(text.slice(cursor, span.start))
    output += `<span class="dialogue-line">${escapeText(text.slice(span.start, span.end))}</span>`
    cursor = span.end
  }
  return output + escapeText(text.slice(cursor))
}

/**
 * Convert newline characters in text nodes to <br> tags.
 * Only converts newlines in text nodes that contain actual content,
 * NOT whitespace-only nodes between HTML tags.
 */
function convertNewlinesToBr(node: Node): void {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null)
  const textNodes: Text[] = []

  // Elements where we should never convert newlines
  const skipElements = new Set(['pre', 'code', 'style', 'script', 'textarea'])

  // Collect text nodes that need conversion
  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    const content = textNode.textContent || ''

    // Skip if no newlines
    if (!content.includes('\n')) {
      textNode = walker.nextNode() as Text | null
      continue
    }

    // Skip whitespace-only nodes (these are just formatting between tags)
    if (content.trim() === '') {
      textNode = walker.nextNode() as Text | null
      continue
    }

    // Skip if inside pre, code, style, script
    let parent = textNode.parentNode as Element | null
    let shouldSkip = false
    while (parent) {
      const tagName = parent.tagName?.toLowerCase()
      if (tagName && skipElements.has(tagName)) {
        shouldSkip = true
        break
      }
      parent = parent.parentNode as Element | null
    }

    if (!shouldSkip) {
      textNodes.push(textNode)
    }

    textNode = walker.nextNode() as Text | null
  }

  // Replace newlines with <br> in each collected text node
  for (const text of textNodes) {
    const parent = text.parentNode
    if (!parent) continue

    const content = text.textContent || ''
    const parts = content.split('\n')

    if (parts.length <= 1) continue

    // Create a fragment with text and <br> elements
    const fragment = document.createDocumentFragment()
    parts.forEach((part, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'))
      }
      if (part) {
        fragment.appendChild(document.createTextNode(part))
      }
    })

    parent.replaceChild(fragment, text)
  }
}

/**
 * Sanitize inline CSS style string.
 */
function sanitizeInlineStyle(css: string): string {
  // Remove dangerous CSS properties
  const dangerousPatterns = [
    /position\s*:\s*(fixed|absolute)/gi,
    /z-index\s*:\s*\d+/gi,
    /expression\s*\(/gi,
    /behavior\s*:/gi,
    /-moz-binding\s*:/gi,
    /javascript\s*:/gi,
  ]

  let sanitized = css
  dangerousPatterns.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, '')
  })

  return sanitized
}

/**
 * Sanitize HTML specifically for TTS consumption.
 * - Always strips <style> tag and its content
 * - Optionally strips all tag content
 * - Always removes the tags themselves; optionally drops the text inside specified tags
 */
export function sanitizeTextForTTS(html: string, options: TTSSanitizeOptions): string {
  if (!html) return ''

  // Santization disabled, return raw text
  if (!options.removeTags) {
    return html
  }

  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content

  // Always remove <style> tag and its content
  fragment.querySelectorAll('style').forEach((node) => node.remove())

  const shouldRemoveContent = (tag: string): boolean => {
    if (options.removeAllTagContent) return true
    if (options.htmlTagsToRemoveContent && options.htmlTagsToRemoveContent.includes(tag))
      return true
    return false
  }

  const processNode = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    // Process children first (depth-first)
    const childNodes = Array.from(el.childNodes)
    childNodes.forEach(processNode)

    if (shouldRemoveContent(tag)) {
      el.remove()
      return
    }

    // Unwrap the element while preserving its children
    const parent = el.parentNode
    if (!parent) return

    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el)
    }
    parent.removeChild(el)
  }

  Array.from(fragment.childNodes).forEach(processNode)

  const text = fragment.textContent ?? ''

  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
