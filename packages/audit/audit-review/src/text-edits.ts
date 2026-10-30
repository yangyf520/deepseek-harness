/** Quote resolution and deterministic edits against an unchanged document revision. */
import type { AuditFinding } from './types.ts'

/**
 * Every index at which `quote` occurs in `content`; an empty quote yields none.
 * @param content - File text searched for the quote.
 * @param quote - Quoted span to locate.
 * @returns each matching character index, in file order.
 */
export function occurrences(content: string, quote: string): number[] {
  if (quote === '') return []
  const found: number[] = []
  for (let at = content.indexOf(quote); at !== -1; at = content.indexOf(quote, at + quote.length)) found.push(at)
  return found
}

/**
 * 1-based line number holding the character at `index`.
 * @param content - File text owning the index.
 * @param index - Character index to locate.
 * @returns the 1-based line number.
 */
export function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

/**
 * Resolve a finding's quote to its span in `content`, disambiguating a repeated quote by the
 * anchor's line number.
 * @param content - File text searched for the quote.
 * @param finding - Finding whose anchor names the quote.
 * @returns the resolved span, or the error the caller reports instead of writing.
 */
function locateQuote(content: string, finding: AuditFinding):
  { ok: true; start: number; end: number } | { ok: false; code: string; message: string } {
  const quote = finding.anchor.quote
  const matches = occurrences(content, quote)
  const first = matches[0]
  if (first === undefined) {
    return { ok: false, code: 'anchor-not-found', message: `anchor quote not found in "${finding.anchor.path}"` }
  }
  const start = matches.length === 1 ? first : matches.find(at => lineAt(content, at) === finding.anchor.line)
  if (start === undefined) {
    return {
      ok: false,
      code: 'anchor-ambiguous',
      message: `anchor quote appears ${matches.length} times in "${finding.anchor.path}" and none sits on line ${finding.anchor.line}`,
    }
  }
  return { ok: true, start, end: start + quote.length }
}

/**
 * Render the file text the accepted findings ask for from the content captured before the round's
 * first apply. Edits are resolved against that base and written right to left, so each one keeps
 * the offsets the base gave it; an empty replacement whose line holds nothing else removes that
 * line. Rendering from the base makes an undo exact whatever order findings were decided in.
 * @param base - File text before the round's first apply.
 * @param findings - Accepted findings anchored in this file, in any order.
 * @returns the rendered text, or the error to report when an anchor cannot be placed.
 */
export function renderAccepted(base: string, findings: readonly AuditFinding[]):
  { ok: true; text: string } | { ok: false; code: string; message: string } {
  const edits: { start: number; end: number; text: string }[] = []
  for (const finding of findings) {
    if (finding.replacement === undefined) continue
    const span = locateQuote(base, finding)
    if (!span.ok) return span
    const lineStart = base.lastIndexOf('\n', span.start - 1) + 1
    const lineEnd = base.indexOf('\n', span.end)
    const tail = lineEnd === -1 ? base.slice(span.end) : base.slice(span.end, lineEnd)
    const removesLine = (finding.replacement ?? '') === '' && base.slice(lineStart, span.start).trim() === '' && tail.trim() === ''
    edits.push(removesLine
      ? { start: lineStart, end: lineEnd === -1 ? base.length : lineEnd + 1, text: '' }
      : { start: span.start, end: span.end, text: finding.replacement ?? '' })
  }
  edits.sort((left, right) => right.start - left.start)
  let text = base
  let boundary = base.length
  for (const edit of edits) {
    if (edit.end > boundary) {
      return { ok: false, code: 'anchor-overlap', message: 'two accepted findings cover the same text; undo one of them first' }
    }
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    boundary = edit.start
  }
  return { ok: true, text }
}
