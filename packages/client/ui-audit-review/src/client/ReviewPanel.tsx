/**
 * Audit review panel: findings on left, the document on the right.
 * The original .docx is rendered in place when the session recorded one, so the
 * layout matches Word; the generated HTML remains the fallback. The HTML path is
 * derived by convention: anchor.path with its extension replaced by .html
 * (e.g. work/prd.txt → work/prd.html).
 * @module
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { parseAsync, renderDocument } from 'docx-preview'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AuditDecision } from '@deepseek-ai/dsh-audit-review/types'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuditState, AuditFinding, Severity } from './AuditCard.tsx'
import { SEVERITY_COLOR, SEVERITY_BG, findingSummary, parseIssue } from './AuditCard.tsx'

/** Read file bytes from workspace. */
export type ReadFileBytes = (sessionId: SessionId, path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Review panel props (from slot system). */
export type ReviewPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'audit'>
  & {
    readFileBytes: ReadFileBytes
    onDecide: (findingId: string, round: number, decision: AuditDecision) => Promise<void>
    onApply: (findingId: string, round: number) => Promise<void>
  }

/** Reset the document container to its original HTML, clearing any highlights. */
function clearHighlight(container: HTMLElement, docHtml: string): void {
  container.innerHTML = docHtml
}

/**
 * Remove the highlights this panel added, restoring the text they wrapped. `dataset` writes the
 * dashed attribute name, so the selector spells it the same dashed way.
 */
function unwrapHighlights(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll('mark[data-audit-highlight]'))) {
    mark.replaceWith(...Array.from(mark.childNodes))
  }
}

/** Scroll the document so a located element sits at the same height as its card. */
function alignToCard(scroller: HTMLElement, target: HTMLElement, card: HTMLElement | null): void {
  if (card === null) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  const delta = target.getBoundingClientRect().top - card.getBoundingClientRect().top
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' })
}

/** Replace a finding's quote with its suggested text, keeping the severity background. */
function replaceQuote(container: HTMLElement, finding: AuditFinding, severity: Severity): HTMLElement | null {
  const marks = markQuote(container, finding.anchor.quote, severity)
  const first = marks[0]
  if (first === undefined) return null
  applyEdit(marks, finding.anchor.quote, finding.replacement)
  for (const mark of marks) {
    mark.dataset.auditReplaced = finding.id
    delete mark.dataset.auditHighlight
  }
  return first
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
  const after = replacement.slice(prefix, replacement.length - suffix)
  let consumed = 0
  let inserted = false
  for (const mark of marks) {
    const text = mark.textContent
    if (before === '') {
      const at = prefix - consumed
      if (!inserted && at >= 0 && at <= text.length) {
        mark.textContent = text.slice(0, at) + after + text.slice(at)
        inserted = true
      }
    } else {
      const at = text.indexOf(before)
      if (at >= 0) mark.textContent = text.slice(0, at) + after + text.slice(at + before.length)
    }
    consumed += text.length
  }
}

/** Insert every accepted finding's replacement into a freshly rendered document. */
function applyAccepted(container: HTMLElement, findings: readonly AuditFinding[], decisions: AuditState['decisions']): void {
  const applied = new Set(Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]')).map(mark => mark.dataset.auditReplaced))
  for (const finding of findings) {
    if (decisions[finding.id] !== 'accept' || applied.has(finding.id)) continue
    replaceQuote(container, finding, finding.severity ?? parseIssue(finding.issue).severity)
  }
}

/** Outline an applied replacement so the selected card's edit stays visible. */
function outlineApplied(container: HTMLElement, findingId: string, severity: Severity): HTMLElement | null {
  for (const mark of Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]'))) {
    if (mark.dataset.auditReplaced !== findingId) continue
    mark.style.outline = `2px solid ${SEVERITY_COLOR[severity]}`
    mark.style.outlineOffset = '1px'
    return mark
  }
  return null
}

/** Drop focus outlines left by an earlier selection. */
function clearOutlines(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll<HTMLElement>('mark[data-audit-replaced]'))) {
    mark.style.outline = ''
    mark.style.outlineOffset = ''
  }
}

/** File extensions that are binary and cannot be rendered as text. */
const BINARY_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|png|jpe?g|gif|webp|zip|gz|tar)$/i

/** Basic document styles for HTML preview to resemble a readable document. */
const DOCUMENT_STYLES = `
<style>
  body, div { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.8em; font-weight: 700; margin: 0.8em 0 0.4em; }
  h2 { font-size: 1.4em; font-weight: 600; margin: 0.6em 0 0.3em; }
  h3 { font-size: 1.2em; font-weight: 600; margin: 0.5em 0 0.2em; }
  p { margin: 0.4em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
  th, td { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; font-size: 0.9em; }
  th { background: #f5f5f5; font-weight: 600; }
  ul, ol { margin: 0.4em 0; padding-left: 1.5em; }
  li { margin: 0.2em 0; }
  mark { padding: 1px 2px; border-radius: 2px; }
</style>
`

/**
 * docx-preview's own page styles center the page in a column flex box and clip its overflow.
 * In this narrow pane that centering pushes the left edge of wide content out of reach, so the
 * overrides keep the document left-aligned and let the pane scroll to everything it contains.
 */
const DOCX_LAYOUT_OVERRIDES = `
  .audit-docx .docx-wrapper { background: transparent !important; padding: 0 !important; display: block !important; }
  .audit-docx .docx-wrapper > section.docx { width: auto !important; box-shadow: none !important; margin-bottom: 0 !important; }
  .audit-docx section.docx { overflow: visible !important; }
`

/**
 * Render options for this pane: the pane decides sizing, and headers, footers, and page breaks
 * stay out because the pane scrolls the body alone.
 */
const DOCX_RENDER_OPTIONS = {
  inWrapper: true,
  ignoreWidth: true,
  ignoreHeight: true,
  breakPages: false,
  renderHeaders: false,
  renderFooters: false,
  useBase64URL: true,
}

/**
 * Parsed-model nodes this panel walks before rendering. docx-preview types its model `any`, so the
 * two style maps carrying table borders, the numbering a numbered paragraph addresses, and the
 * children that hold them are named here.
 */
interface DocxModelNode {
  cssStyle?: Record<string, string>
  cellStyle?: Record<string, string>
  /** Numbering definition of a numbered paragraph together with its list level. */
  numbering?: { id: string | number; level?: number | null }
  children?: DocxModelNode[]
}

/** Parsed model whose body tree and numbering levels are post-processed before rendering. */
interface DocxModel {
  documentPart: { body: DocxModelNode }
  numberingPart?: { domNumberings?: { level?: number | null }[] }
}

/**
 * docx-preview writes a border with no `w:sz` as the literal width `null`, which CSS rejects and
 * drops together with the whole border; Word draws its 0.5pt default instead. Restoring that
 * width keeps the borders of documents that omit `w:sz` visible.
 * @param node - Parsed node whose style maps and descendants are repaired in place.
 */
function restoreBorderWidths(node: DocxModelNode): void {
  for (const styles of [node.cssStyle, node.cellStyle]) {
    if (styles === undefined) continue
    for (const [property, value] of Object.entries(styles)) {
      // Only border shorthands reach this broken width; `none` borders never carry it.
      if (value.startsWith('null ')) styles[property] = `0.5pt${value.slice(4)}`
    }
  }
  for (const child of node.children ?? []) restoreBorderWidths(child)
}

/**
 * docx-preview reads a list level from `w:ilvl`, which some producers omit. The absent level lands
 * as `undefined` on paragraphs and `null` on numbering definitions, so the classes it writes
 * (`docx-num-<id>-undefined`) never match the rules it emits (`docx-num-<id>-null`) and such lists
 * lose every number. Reading both as level 0 restores those numbers.
 * @param parsed - Parsed model whose numbering levels and body tree are repaired in place.
 */
function restoreNumberingLevels(parsed: DocxModel): void {
  for (const numbering of parsed.numberingPart?.domNumberings ?? []) {
    if (numbering.level == null) numbering.level = 0
  }
  const visit = (node: DocxModelNode): void => {
    if (node.numbering !== undefined && node.numbering.level == null) node.numbering.level = 0
    for (const child of node.children ?? []) visit(child)
  }
  visit(parsed.documentPart.body)
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
    chars.push(char === '“' || char === '”' ? '"' : char === '‘' || char === '’' ? "'" : char)
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

/** Wrap `quote` and return the mark the document scrolls to. */
function highlightQuote(container: HTMLElement, quote: string, severity: Severity): HTMLElement | null {
  return markQuote(container, quote, severity)[0] ?? null
}

/** Header border color per decision: green once accepted, red once rejected, neutral while pending. */
const DECISION_BORDER: Record<'accept' | 'reject' | 'pending', string> = {
  accept: 'rgb(34, 139, 34)',
  reject: 'rgb(217, 45, 32)',
  pending: 'rgb(220, 225, 235)',
}

/**
 * Single finding card: accepting writes the suggestion into the document and undoing takes it back;
 * rejecting leaves the document alone and keeps the card in the list until the rejection is withdrawn.
 */
function FindingCard({ finding, index, round, t, onDecide, onApply, decided }: {
  finding: AuditFinding
  index: number
  round: number
  t: TranslateNS<'audit'>
  onDecide: (findingId: string, round: number, decision: AuditDecision) => Promise<void>
  onApply: (findingId: string, round: number) => Promise<void>
  decided?: 'accept' | 'reject' | undefined
}) {
  // The file rewrite reads the recorded decisions, so the decision has to land before it runs.
  const decide = (decision: AuditDecision): void => {
    void onDecide(finding.id, round, decision).then(() => onApply(finding.id, round))
  }
  // A rejection and its withdrawal leave the document holding the accepted findings it already has.
  const setRejection = (decision: 'reject' | 'undo'): void => {
    void onDecide(finding.id, round, decision)
  }
  const parsed = parseIssue(finding.issue)
  const severity = finding.severity ?? parsed.severity
  const severityLabel = t(`severity.${severity}`)
  const summary = findingSummary(finding)

  return (
    <div style={{
      padding: '12px',
      border: `1px solid ${DECISION_BORDER[decided ?? 'pending']}`,
      borderRadius: '12px',
      background: 'rgb(255, 255, 255)',
      marginBottom: '8px',
    }}>
      {/* Header: severity badge left of the title, action buttons on the right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <span style={{
          background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
          borderRadius: '999px', height: '24px',
          cornerShape: 'round',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
          padding: '0 8px 0 3px', fontSize: '10px', fontWeight: 600, flexShrink: 0,
        } as CSSProperties}>
          <span style={{
            width: '14px', height: '14px', borderRadius: '50%',
            cornerShape: 'round',
            background: SEVERITY_COLOR[severity], color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '9px', fontWeight: 700, flexShrink: 0,
          } as CSSProperties}>{index + 1}</span>
          {severityLabel}
        </span>
        <span style={{ flex: '1 1 0%', minWidth: 0, fontSize: '12px', fontWeight: 700, lineHeight: 1.4, color: 'rgb(30, 35, 45)' }}>{summary}</span>
        {!decided && (
          <>
            <button type="button" onClick={() => decide('accept')} style={{
              padding: '4px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
              background: 'rgb(34, 139, 34)', color: 'white', border: 'none', borderRadius: '999px',
              cornerShape: 'round', flexShrink: 0, height: '24px',
            } as CSSProperties}>{t('action.accept')}</button>
            <button type="button" onClick={() => setRejection('reject')} style={{
              padding: '4px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
              background: 'white', color: 'rgb(217, 45, 32)', border: '1px solid rgb(217, 45, 32)', borderRadius: '999px',
              cornerShape: 'round', flexShrink: 0, height: '24px',
            } as CSSProperties}>{t('action.reject')}</button>
          </>
        )}
        {decided === 'accept' && (
          <button type="button" onClick={() => decide('undo')} style={{
            padding: '4px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
            background: 'white', color: 'rgb(34, 139, 34)', border: '1px solid rgb(34, 139, 34)', borderRadius: '999px',
            cornerShape: 'round', flexShrink: 0, height: '24px',
          } as CSSProperties}>{t('action.undo')}</button>
        )}
        {decided === 'reject' && (
          <button type="button" onClick={() => setRejection('undo')} style={{
            padding: '4px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
            background: 'white', color: 'rgb(217, 45, 32)', border: '1px solid rgb(217, 45, 32)', borderRadius: '999px',
            cornerShape: 'round', flexShrink: 0, height: '24px',
          } as CSSProperties}>{t('action.withdraw')}</button>
        )}
      </div>

      {/* Divider between header and body */}
      <div style={{ height: '1px', background: 'rgb(220, 225, 235)', marginBottom: '8px' }} />

      {/* Issue detail */}
      <div style={{ fontSize: '13px', fontWeight: 400, marginBottom: '8px', lineHeight: 1.4, color: 'rgb(30, 35, 45)',
        background: 'rgb(255, 255, 255)', borderRadius: '6px', padding: '8px 10px',
      }}>
        {parsed.text}
      </div>

      {/* Suggestion */}
      <div style={{
        fontSize: '12px', color: 'rgb(100, 110, 130)', lineHeight: 1.5,
        background: 'rgb(255, 255, 255)', border: '1px solid rgb(220, 225, 235)',
        borderRadius: '6px', padding: '8px 10px',
      }}>
        <strong style={{ color: 'rgb(23, 92, 211)' }}>{t('finding.suggestion')}:</strong> {finding.replacement || t('finding.delete')}
      </div>
    </div>
  )
}

/** Review panel with Word doc and findings. */
export function ReviewPanel({ sessionId, useProjection, readFileBytes, t, onDecide, onApply }: ReviewPanelProps) {
  const state = useProjection('audit') as AuditState | undefined
  const [docHtml, setDocHtml] = useState<string>('')
  const [docError, setDocError] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectionKey, setSelectionKey] = useState(0)
  const [docxReady, setDocxReady] = useState(false)
  // Set once the original renders, so re-rendering for a replacement shows no loading gap.
  const [docxShown, setDocxShown] = useState(false)
  const [docxError, setDocxError] = useState('')
  // Set when the selected quote has no counterpart in the rendered document, so the
  // panel can say why nothing is highlighted instead of highlighting nothing silently.
  const [unlocated, setUnlocated] = useState(false)
  const docTextRef = useRef<HTMLDivElement | null>(null)
  const docxRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Left findings list, scrolled back to its top by a click on the sticky header.
  const listRef = useRef<HTMLDivElement | null>(null)
  // Card whose height the located document text aligns to on selection.
  const cardRef = useRef<HTMLElement | null>(null)

  const documentPath = state?.documentPath ?? null
  const hasOriginal = documentPath !== null && /\.docx$/i.test(documentPath)
  const activeView = hasOriginal ? 'original' : 'text'

  // Findings whose replacements the document must show. A change re-renders the original,
  // because a replaced quote no longer exists in the text it was located in.
  const acceptedKey = Object.entries(state?.decisions ?? {})
    .filter(([, decision]) => decision === 'accept')
    .map(([id]) => id)
    .sort()
    .join(',')

  const selectedFinding = selectedId !== null ? state?.findings.find(f => f.id === selectedId) ?? null : null

  // Derive HTML preview path from anchor.path by convention:
  // work/prd.txt → work/prd.html. The document path recorded by the audit event
  // is the original binary upload, which has no HTML sibling, so anchors win.
  const anchorPath = selectedFinding?.anchor.path ?? state?.findings[0]?.anchor.path ?? state?.documentPath ?? null
  const htmlPath = anchorPath?.replace(/\.[^.]+$/, '.html') ?? null

  // Load HTML preview or fall back to plain text
  useEffect(() => {
    if (!state || !anchorPath || !readFileBytes || activeView !== 'text') return
    setDocHtml('')
    setDocError('')

    // Try loading the HTML version first
    if (htmlPath && htmlPath !== anchorPath) {
      readFileBytes(sessionId, htmlPath)
        .then((bytes) => {
          const html = new TextDecoder().decode(bytes)
          setDocHtml(DOCUMENT_STYLES + html)
        })
        .catch(() => {
          // HTML not available, fall back to plain text if anchor is a text file
          if (BINARY_EXTENSIONS.test(anchorPath)) {
            setDocError('HTML 预览文件不存在。请先运行审计流程生成 HTML 文件。')
            return
          }
          readFileBytes(sessionId, anchorPath)
            .then((bytes) => {
              const text = new TextDecoder().decode(bytes)
              const escaped = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>')
              setDocHtml(`<pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escaped}</pre>`)
            })
            .catch(err => setDocError(`文档加载失败: ${err.message}`))
        })
    } else {
      // No HTML derivation possible, render anchor.path directly
      if (BINARY_EXTENSIONS.test(anchorPath)) {
        setDocError('无法预览二进制文件。请先运行审计流程生成 HTML 文件。')
        return
      }
      const isHtml = anchorPath?.match(/\.html?$/i)
      readFileBytes(sessionId, anchorPath)
        .then((bytes) => {
          if (isHtml) {
            setDocHtml(DOCUMENT_STYLES + new TextDecoder().decode(bytes))
          } else {
            const text = new TextDecoder().decode(bytes)
            const escaped = text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>')
            setDocHtml(`<pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escaped}</pre>`)
          }
        })
        .catch(err => setDocError(`文档加载失败: ${err.message}`))
    }
  }, [sessionId, state, anchorPath, htmlPath, readFileBytes, activeView])

  // Render the original .docx so the panel shows the Word layout. The generated HTML
  // stays the fallback for sessions that recorded no .docx.
  useEffect(() => {
    const container = docxRef.current
    if (activeView !== 'original' || !hasOriginal || container === null || documentPath === null) return
    let stale = false
    setDocxReady(false)
    setDocxError('')
    container.replaceChildren()
    readFileBytes(sessionId, documentPath)
      .then(async (bytes) => {
        const parsed = await parseAsync(bytes, DOCX_RENDER_OPTIONS) as DocxModel
        restoreBorderWidths(parsed.documentPart.body)
        restoreNumberingLevels(parsed)
        return renderDocument(parsed, DOCX_RENDER_OPTIONS)
      })
      .then((nodes) => {
        if (stale) return
        container.replaceChildren(...nodes)
        setDocxReady(true)
        setDocxShown(true)
      })
      .catch((error: unknown) => {
        if (!stale) setDocxError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      stale = true
    }
  }, [sessionId, activeView, hasOriginal, documentPath, readFileBytes, acceptedKey])

  // A different document starts without a rendered copy, so the loading line may show again.
  useEffect(() => {
    setDocxShown(false)
  }, [documentPath])

  // Show accepted replacements and the selected quote in the document, then align the
  // located text with the card that asked for it.
  useEffect(() => {
    const scroller = scrollRef.current
    const show = (container: HTMLElement): void => {
      unwrapHighlights(container)
      clearOutlines(container)
      applyAccepted(container, state?.findings ?? [], state?.decisions ?? {})
      if (selectedFinding === null) {
        setUnlocated(false)
        return
      }
      const severity = selectedFinding.severity ?? parseIssue(selectedFinding.issue).severity
      const target = state?.decisions[selectedFinding.id] === 'accept'
        ? outlineApplied(container, selectedFinding.id, severity)
        : highlightQuote(container, selectedFinding.anchor.quote, severity)
      setUnlocated(target === null)
      if (target !== null && scroller !== null) alignToCard(scroller, target, cardRef.current)
    }
    if (activeView === 'original') {
      const original = docxRef.current
      if (original === null || !docxReady) return
      show(original)
      return
    }
    const container = docTextRef.current
    if (container === null || docHtml === '') {
      setUnlocated(false)
      return
    }
    clearHighlight(container, docHtml)
    show(container)
  }, [selectionKey, docHtml, activeView, docxReady, state])

  if (!state || state.round === 0 || state.findings.length === 0) {
    return <div style={{ padding: '20px', color: 'rgb(102, 112, 133)' }}>暂无审计数据</div>
  }

  const findings = state.findings
  const accepted = Object.entries(state.decisions).filter(([, d]) => d === 'accept').length
  const rejected = Object.entries(state.decisions).filter(([, d]) => d === 'reject').length

  // Card wrapper: selecting a card highlights its quote in the document.
  const renderCard = (finding: AuditFinding, index: number) => (
    <div key={finding.id} onClick={(event) => {
      cardRef.current = event.currentTarget
      setSelectedId(finding.id)
      setSelectionKey(k => k + 1)
    }} style={{
      cursor: 'pointer',
      outline: selectedId === finding.id ? '2px solid rgb(23, 92, 211)' : 'none',
      borderRadius: '12px',
      marginBottom: '12px',
    }}>
      <FindingCard
        finding={finding}
        index={index}
        round={state.round}
        t={t}
        onDecide={onDecide}
        onApply={onApply}
        decided={state.decisions[finding.id]}
      />
    </div>
  )

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Findings list */}
      <div ref={listRef} style={{ width: '400px', overflow: 'auto', padding: '16px', background: 'rgb(250, 251, 252)', borderRight: '1px solid rgb(234, 236, 240)' }}>
        {/* Sticky header: the title and counts stay visible while the findings scroll under them;
            its padding keeps the gap to the first card while stuck, and a click returns the list to
            the top. */}
        <div
          onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{
            position: 'sticky', top: '-16px', zIndex: 1,
            margin: '-16px -16px 0', padding: '12px 16px', cursor: 'pointer',
            background: 'rgb(250, 251, 252)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>
              {t('overview.title')} ({findings.length})
            </div>
            <div style={{ fontSize: '12px', color: 'rgb(102, 112, 133)' }}>
              {accepted} {t('status.accepted')} · {rejected} {t('status.rejected')} · {findings.length - accepted - rejected} {t('overview.findings')}
            </div>
          </div>
        </div>
        {/* Increment selectionKey on each click to force the highlight effect to re-run. Every card
            keeps the number it was audited under; a rejected card stays here and is withdrawn from it. */}
        {findings.map((finding, index) => renderCard(finding, index))}
      </div>

      {/* Right: document, rendered from the original .docx when the session has one */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {unlocated && (
          <div style={{ fontSize: '12px', color: 'rgb(178, 106, 0)', marginBottom: '8px' }}>{t('preview.unlocated')}</div>
        )}
        {activeView === 'original' ? (
          docxError !== '' ? (
            <div style={{ color: 'rgb(217, 45, 32)', padding: '20px' }}>{`原文渲染失败: ${docxError}`}</div>
          ) : (
            <>
              {!docxShown && <div style={{ color: 'rgb(102, 112, 133)', padding: '20px' }}>加载中...</div>}
              <style>{DOCX_LAYOUT_OVERRIDES}</style>
              <div ref={docxRef} className="audit-docx" />
            </>
          )
        ) : docHtml ? (
          <div ref={docTextRef} dangerouslySetInnerHTML={{ __html: docHtml }} />
        ) : docError ? (
          <div style={{ color: 'rgb(217, 45, 32)', padding: '20px' }}>{docError}</div>
        ) : (
          <div style={{ color: 'rgb(102, 112, 133)', padding: '20px' }}>加载中...</div>
        )}
      </div>
    </div>
  )
}
