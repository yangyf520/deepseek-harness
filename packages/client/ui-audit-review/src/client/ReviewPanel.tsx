/**
 * Audit review panel: findings on left, Word document on right.
 * @module
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import mammoth from 'mammoth/mammoth.browser.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AuditState, AuditFinding } from './AuditCard.tsx'
import { SEVERITY_COLOR, SEVERITY_BG, extractSeverity } from './AuditCard.tsx'

/** Read file bytes from workspace. */
export type ReadFileBytes = (sessionId: SessionId, path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Review panel props (from slot system). */
export interface ReviewPanelProps {
  sessionId: SessionId
  useProjection: UseProjection
  readFileBytes: ReadFileBytes
  t: (key: string) => string
  onDecide: (findingId: string, round: number, decision: 'accept' | 'reject') => void
  onApply: (findingId: string, round: number) => void
}

/** Locate a global text offset as a text node plus local offset. */
function locateOffset(nodes: readonly Text[], offset: number): { node: Text; offset: number } | undefined {
  let consumed = 0
  for (const node of nodes) {
    const length = node.nodeValue?.length ?? 0
    if (offset <= consumed + length) return { node, offset: offset - consumed }
    consumed += length
  }
  return undefined
}

/** Reset the document container to its original HTML, clearing any highlights. */
function clearHighlight(container: HTMLElement, docHtml: string): void {
  container.innerHTML = docHtml
}

/** Normalize whitespace for comparison. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Wrap the first occurrence of `quote` in `container` with a severity-colored mark. */
function highlightQuote(container: HTMLElement, quote: string, severity: 'high' | 'medium' | 'low'): HTMLElement | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let text = ''
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    nodes.push(current as Text)
    text += current.nodeValue ?? ''
  }

  // Try exact match first
  let start = text.indexOf(quote)

  // If not found, try normalized whitespace match
  if (start < 0) {
    const normalizedQuote = normalizeText(quote)
    const normalizedText = normalizeText(text)
    const normalizedStart = normalizedText.indexOf(normalizedQuote)
    if (normalizedStart >= 0) {
      const textChars = text.split('')
      const normChars = normalizedText.split('')

      // Build mapping from normalized position to original position.
      // Normalized spaces map to whitespace in original; non-spaces map to non-whitespace.
      const normToOrig: number[] = []
      let ti = 0
      for (let ni = 0; ni < normChars.length; ni++) {
        if (normChars[ni] === ' ') {
          // Skip non-whitespace to find the next whitespace in original text
          while (ti < textChars.length && /\S/.test(textChars[ti])) {
            ti++
          }
          if (ti < textChars.length) {
            normToOrig[ni] = ti
            ti++
          }
        } else {
          // Skip whitespace to find the next non-whitespace in original text
          while (ti < textChars.length && /\s/.test(textChars[ti])) {
            ti++
          }
          if (ti < textChars.length) {
            normToOrig[ni] = ti
            ti++
          }
        }
      }

      if (normToOrig[normalizedStart] !== undefined) {
        start = normToOrig[normalizedStart]
        const normalizedEnd = normalizedStart + normalizedQuote.length
        if (normToOrig[normalizedEnd - 1] !== undefined) {
          const end = normToOrig[normalizedEnd - 1] + 1
          const startPos = locateOffset(nodes, start)
          const endPos = locateOffset(nodes, end)
          if (startPos !== undefined && endPos !== undefined) {
            const range = document.createRange()
            range.setStart(startPos.node, startPos.offset)
            range.setEnd(endPos.node, endPos.offset)
            const mark = document.createElement('mark')
            mark.dataset.auditHighlight = '1'
            mark.style.background = SEVERITY_BG[severity]
            mark.style.boxShadow = `inset 0 -2px 0 ${SEVERITY_COLOR[severity]}`
            try {
              range.surroundContents(mark)
            } catch {
              mark.appendChild(range.extractContents())
              range.insertNode(mark)
            }
            return mark
          }
        }
      }
    }
    return null
  }

  const startPos = locateOffset(nodes, start)
  const endPos = locateOffset(nodes, start + quote.length)
  if (startPos === undefined || endPos === undefined) return null
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const mark = document.createElement('mark')
  mark.dataset.auditHighlight = '1'
  mark.style.background = SEVERITY_BG[severity]
  mark.style.boxShadow = `inset 0 -2px 0 ${SEVERITY_COLOR[severity]}`
  try {
    range.surroundContents(mark)
  } catch {
    // The quote crosses inline element boundaries: re-wrap the extracted content.
    mark.appendChild(range.extractContents())
    range.insertNode(mark)
  }
  return mark
}

/** Single finding card with accept/reject/apply. */
function FindingCard({ finding, index, round, t, onDecide, onApply, decided }: {
  finding: AuditFinding
  index: number
  round: number
  t: (key: string) => string
  onDecide: (findingId: string, round: number, decision: 'accept' | 'reject') => void
  onApply: (findingId: string, round: number) => void
  decided?: 'accept' | 'reject' | undefined
}) {
  const severity = finding.severity ?? extractSeverity(finding.issue)
  const severityLabel = t(`severity.${severity}`)
  const fallback = (finding.issue.match(/[^。！？!?\n]+/)?.[0] ?? finding.issue).trim()
  const summary = finding.title ?? (fallback.length > 20 ? `${fallback.slice(0, 20)}…` : fallback)

  return (
    <div style={{
      padding: '12px',
      border: `1px solid ${decided === 'accept' ? 'rgb(34, 139, 34)' : decided === 'reject' ? 'rgb(217, 45, 32)' : 'rgb(220, 225, 235)'}`,
      borderRadius: '12px',
      background: 'rgb(255, 255, 255)',
      marginBottom: '8px',
    }}>
      {/* Header: number, severity, one-line issue summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <div style={{
          width: '20px', height: '20px', borderRadius: '50%',
          cornerShape: 'round',
          background: 'rgb(102, 112, 133)', color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 700, flexShrink: 0,
        } as CSSProperties}>{index + 1}</div>
        <span style={{ flex: '1 1 0%', minWidth: 0, fontSize: '12px', fontWeight: 500, lineHeight: 1.4, color: 'rgb(30, 35, 45)' }}>{summary}</span>
        <span style={{
          background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
          borderRadius: '999px', height: '20px',
          cornerShape: 'round',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 6px', fontSize: '10px', fontWeight: 600, flexShrink: 0,
        } as CSSProperties}>{severityLabel}</span>
      </div>

      {/* Divider between header and body */}
      <div style={{ height: '1px', background: 'rgb(220, 225, 235)', marginBottom: '8px' }} />

      {/* Issue detail */}
      <div style={{ fontSize: '13px', fontWeight: 400, marginBottom: '8px', lineHeight: 1.4, color: 'rgb(30, 35, 45)',
        background: 'rgb(255, 255, 255)', borderRadius: '6px', padding: '8px 10px',
      }}>
        {finding.issue}
      </div>

      {/* Suggestion */}
      <div style={{
        fontSize: '12px', color: 'rgb(100, 110, 130)', lineHeight: 1.5, marginBottom: '10px',
        background: 'rgb(255, 255, 255)', border: '1px solid rgb(220, 225, 235)',
        borderRadius: '6px', padding: '8px 10px',
      }}>
        <strong style={{ color: 'rgb(23, 92, 211)' }}>{t('finding.suggestion')}:</strong> {finding.replacement || '无建议'}
      </div>

      {/* Action buttons */}
      {!decided && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
          <button type="button" onClick={() => onDecide(finding.id, round, 'accept')} style={{
            padding: '4px 32px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
            background: 'rgb(34, 139, 34)', color: 'white', border: 'none', borderRadius: '6px',
          }}>{t('action.accept')}</button>
          <button type="button" onClick={() => onDecide(finding.id, round, 'reject')} style={{
            padding: '4px 32px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
            background: 'white', color: 'rgb(217, 45, 32)', border: '1px solid rgb(217, 45, 32)', borderRadius: '6px',
          }}>{t('action.reject')}</button>
        </div>
      )}
      {decided && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: '12px', color: decided === 'accept' ? 'rgb(34, 139, 34)' : 'rgb(217, 45, 32)', fontWeight: 600 }}>
            {decided === 'accept' ? t('status.accepted') : t('status.rejected')}
          </span>
          {decided === 'accept' && (
            <button type="button" onClick={() => onApply(finding.id, round)} style={{
              padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
              background: 'rgb(23, 92, 211)', color: 'white', border: 'none', borderRadius: '6px',
            }}>{t('action.apply')}</button>
          )}
        </div>
      )}
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
  const docRef = useRef<HTMLDivElement | null>(null)

  const selectedFinding = selectedId !== null ? state?.findings.find(f => f.id === selectedId) ?? null : null

  // Load Word document
  useEffect(() => {
    if (!state || !state.documentPath || !readFileBytes) return
    const docPath = state.documentPath

    readFileBytes(sessionId, docPath)
      .then(bytes => mammoth.convertToHtml({ arrayBuffer: bytes.buffer }))
      .then(result => setDocHtml(result.value))
      .catch(err => setDocError(`文档加载失败: ${err.message}`))
  }, [sessionId, state, readFileBytes])

  // Highlight the selected finding's quote in the document and scroll to it
  useEffect(() => {
    const container = docRef.current
    if (container === null) return
    clearHighlight(container, docHtml)
    if (selectedFinding === null || docHtml === '') return
    const severity = selectedFinding.severity ?? extractSeverity(selectedFinding.issue)
    const mark = highlightQuote(container, selectedFinding.anchor.quote, severity)
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [selectionKey, docHtml])

  if (!state || state.round === 0 || state.findings.length === 0) {
    return <div style={{ padding: '20px', color: 'rgb(102, 112, 133)' }}>暂无审计数据</div>
  }

  const findings = state.findings
  const accepted = Object.entries(state.decisions).filter(([, d]) => d === 'accept').length
  const rejected = Object.entries(state.decisions).filter(([, d]) => d === 'reject').length

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Findings list */}
      <div style={{ width: '400px', overflow: 'auto', padding: '16px', background: 'rgb(250, 251, 252)', borderRight: '1px solid rgb(234, 236, 240)' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
          {t('overview.title')} ({findings.length})
        </div>
        <div style={{ fontSize: '12px', color: 'rgb(102, 112, 133)', marginBottom: '16px' }}>
          {accepted} {t('status.accepted')} · {rejected} {t('status.rejected')} · {findings.length - accepted - rejected} {t('overview.findings')}
        </div>
        {/* Increment selectionKey on each click to force the highlight effect to re-run */}
        {findings.map((finding, index) => (
          <div key={finding.id} onClick={() => { setSelectedId(finding.id); setSelectionKey(k => k + 1) }} style={{
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
        ))}
      </div>

      {/* Right: Word document */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {docHtml ? (
          <div ref={docRef} dangerouslySetInnerHTML={{ __html: docHtml }} />
        ) : docError ? (
          <div style={{ color: 'rgb(217, 45, 32)', padding: '20px' }}>{docError}</div>
        ) : (
          <div style={{ color: 'rgb(102, 112, 133)', padding: '20px' }}>加载中...</div>
        )}
      </div>
    </div>
  )
}
