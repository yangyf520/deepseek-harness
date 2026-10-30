/**
 * Document highlight and scroll alignment utilities for audit review.
 * Restored from pre-refactor ReviewPanel to support scroll-to-finding and replacement application.
 * @module
 */

import type { AuditFinding, AuditState } from '../AuditCard.tsx'
import { SEVERITY_BG, SEVERITY_COLOR, parseIssue } from '../AuditCard.tsx'
import type { Severity } from '../AuditCard.tsx'

/**
 * Reset the document container to its original HTML, clearing any highlights.
 * @param container - Document preview container to reset.
 * @param docHtml - Original preview markup to restore.
 */
export function clearHighlight(container: HTMLElement, docHtml: string): void {
  container.innerHTML = docHtml
}

/**
 * Remove the highlights this panel added, restoring the text they wrapped. `dataset` writes the
 * dashed attribute name, so the selector spells it the same dashed way.
 * @param container - Document preview containing audit marks.
 */
export function unwrapHighlights(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll('mark[data-audit-highlight]'))) {
    mark.replaceWith(...Array.from(mark.childNodes))
  }
}

/**
 * Scroll the document so a located element sits at the same height as its card.
 * @param scroller - Independently scrolling document pane.
 * @param target - Located evidence or replacement in the document.
 * @param card - Selected finding card, or null when it is unavailable.
 */
export function alignToCard(scroller: HTMLElement, target: HTMLElement, card: HTMLElement | null): void {
  if (card === null) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  const delta = target.getBoundingClientRect().top - card.getBoundingClientRect().top
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' })
}

/** Length of the leading run both texts share. */
function commonPrefix(left: string, right: string): number {
  let length = 0
  while (length < left.length && length < right.length && left[length] === right[length]) length++
  return length
}

/** Length of the trailing run both texts share, staying clear of the prefix they already share. */
function commonSuffix(left: string, right: string, prefix: number): number {
  let length = 0
  while (length < left.length - prefix && length < right.length - prefix
    && left[left.length - 1 - length] === right[right.length - 1 - length]) length++
  return length
}

/**
 * Apply the quote-to-replacement edit to the text the marks cover. Only the characters the two
 * texts do not share change, so a row the document renders as several cells keeps its other cells
 * and the suggestion shows up where the wording differs.
 */
function applyEdit(marks: readonly HTMLElement[], quote: string, replacement: string): void {
  const prefix = commonPrefix(quote, replacement)
  const suffix = commonSuffix(quote, replacement, prefix)
  const before = quote.slice(prefix, quote.length - suffix)
  const after = replacement.slice(prefix, suffix > 0 ? replacement.length - suffix : replacement.length)
  let consumed = 0
  let inserted = false
  for (const mark of marks) {
    const text = mark.textContent
    if (before === '') {
      const at = prefix - consumed
      if (!inserted && at >= 0 && at <= (text?.length ?? 0)) {
        mark.textContent = (text?.slice(0, at) ?? '') + after + (text?.slice(at) ?? '')
        inserted = true
      }
    } else {
      const at = text?.indexOf(before) ?? -1
      if (at >= 0) mark.textContent = (text?.slice(0, at) ?? '') + after + (text?.slice(at + before.length) ?? '')
    }
    consumed += text?.length ?? 0
  }
}

/** Replace a finding's quote with its suggested text, keeping the severity background. */
function replaceQuote(container: HTMLElement, finding: AuditFinding, severity: Severity): HTMLElement | null {
  const marks = markQuote(container, finding.anchor.quote, severity)
  const first = marks[0]
  if (first === undefined) return null
  applyEdit(marks, finding.anchor.quote, finding.replacement ?? '')
  for (const mark of marks) {
    mark.dataset.auditReplaced = finding.id
    delete mark.dataset.auditHighlight
  }
  return first
}

/**
 * Insert every accepted finding's replacement into a freshly rendered document.
 * @param container - Document preview receiving replacements.
 * @param findings - Findings that may provide accepted replacements.
 * @param decisions - Current decision for each finding.
 */
export function applyAccepted(container: HTMLElement, findings: readonly AuditFinding[], decisions: AuditState['decisions']): void {
  const applied = new Set(Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]')).map(mark => mark.dataset.auditReplaced))
  for (const finding of findings) {
    if (decisions[finding.id] !== 'accept' || applied.has(finding.id)) continue
    replaceQuote(container, finding, parseIssue(finding.issue).severity)
  }
}

/**
 * Outline an applied replacement so the selected card's edit stays visible.
 * @param container - Document preview containing applied replacements.
 * @param findingId - Finding whose replacement should receive focus.
 * @param severity - Severity that selects the outline color.
 * @returns The outlined replacement, or null when it is not rendered.
 */
export function outlineApplied(container: HTMLElement, findingId: string, severity: Severity): HTMLElement | null {
  for (const mark of Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]'))) {
    if (mark.dataset.auditReplaced !== findingId) continue
    mark.style.outline = `2px solid ${SEVERITY_COLOR[severity]}`
    mark.style.outlineOffset = '1px'
    return mark
  }
  return null
}

/**
 * Drop focus outlines left by an earlier selection.
 * @param container - Document preview containing applied replacements.
 */
export function clearOutlines(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]'))) {
    mark.style.outline = ''
    mark.style.outlineOffset = ''
  }
}

/** Text nodes that carry document text, in document order. Injected styles never match. */
function documentTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const parent = (current as Text).parentElement
    if (parent !== null && (parent.tagName === 'STYLE' || parent.tagName === 'SCRIPT')) continue
    nodes.push(current as Text)
  }
  return nodes
}

/**
 * Comparable characters paired with the offset each came from. Findings quote the plain-text
 * extraction of the document, where table cells carry `|` separators and spacing can differ from
 * the rendered page, so separators are dropped on both sides and quotes are folded to one form.
 */
function foldText(text: string): { key: string; index: number[] } {
  const chars: string[] = []
  const index: number[] = []
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset] ?? ''
    if (/\s/.test(char) || char === '|' || char === '｜') continue
    let normalized = char
    if (char === '\u201C' || char === '\u201D' || char === '\u201E') normalized = '"'
    else if (char === '\u2018' || char === '\u2019') normalized = "'"
    chars.push(normalized)
    index.push(offset)
  }
  return { key: chars.join(''), index }
}

/**
 * Match `quote` against folded document text. The audit quotes the plain-text extraction, where a
 * merged table cell repeats on every row it spans and cells carry `|` separators; the rendered
 * table writes that cell once, so a quote holding those repeats matches only after dropping its
 * leading segments. The matched range is what the document can highlight.
 */
function findQuote(key: string, quote: string): { start: number; end: number } | null {
  const folded = foldText(quote).key
  const segments = quote.split(/[|｜]/).map(segment => foldText(segment).key).filter(segment => segment !== '')
  const candidates = [folded]
  for (let drop = 1; drop < segments.length; drop++) candidates.push(segments.slice(drop).join(''))
  for (let keep = segments.length - 1; keep > 0; keep--) candidates.push(segments.slice(0, keep).join(''))
  const shortest = Math.min(4, folded.length)
  for (const candidate of candidates) {
    if (candidate.length < shortest) continue
    const at = key.indexOf(candidate)
    if (at >= 0) return { start: at, end: at + candidate.length }
  }
  // Converted HTML can omit labels or punctuation that the plain-text extractor
  // included around an anchor. Fall back to the longest unique run so every valid
  // finding can still navigate to its evidence without highlighting unrelated text.
  const minimum = Math.min(8, folded.length)
  for (let width = Math.min(48, folded.length); width >= minimum; width--) {
    for (let offset = 0; offset + width <= folded.length; offset++) {
      const candidate = folded.slice(offset, offset + width)
      const at = key.indexOf(candidate)
      if (at >= 0 && key.indexOf(candidate, at + 1) === -1) return { start: at, end: at + width }
    }
  }
  return null
}

/**
 * Wrap the rendered occurrence of `quote` in severity-colored marks and return them. One mark per
 * text run keeps a quote that crosses runs — a table row, for example — fully highlighted, because
 * every range stays inside a single text node.
 */
function markQuote(container: HTMLElement, quote: string, severity: Severity): HTMLElement[] {
  const nodes = documentTextNodes(container)
  const haystack = foldText(nodes.map(node => node.nodeValue ?? '').join(''))
  const match = findQuote(haystack.key, quote)
  if (match === null) return []
  const start = haystack.index[match.start] ?? 0
  const end = (haystack.index[match.end - 1] ?? start) + 1

  const marks: HTMLElement[] = []
  let consumed = 0
  for (const node of nodes) {
    const length = node.nodeValue?.length ?? 0
    const first = Math.max(start - consumed, 0)
    const last = Math.min(end - consumed, length)
    consumed += length
    if (last <= first) continue
    const range = document.createRange()
    range.setStart(node, first)
    range.setEnd(node, last)
    const mark = document.createElement('mark')
    mark.dataset.auditHighlight = '1'
    mark.style.background = SEVERITY_BG[severity]
    mark.style.boxShadow = `inset 0 -2px 0 ${SEVERITY_COLOR[severity]}`
    range.surroundContents(mark)
    marks.push(mark)
  }
  return marks
}

/**
 * Wrap `quote` and return the mark the document scrolls to.
 * @param container - Document preview to search.
 * @param quote - Extracted evidence text to locate.
 * @param severity - Severity that selects highlight colors.
 * @returns The first rendered highlight, or null when the quote cannot be located.
 */
export function highlightQuote(container: HTMLElement, quote: string, severity: Severity): HTMLElement | null {
  return markQuote(container, quote, severity)[0] ?? null
}
