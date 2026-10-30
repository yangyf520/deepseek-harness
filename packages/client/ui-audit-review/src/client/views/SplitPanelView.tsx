/**
 * Split-panel view: findings on left, document preview on right.
 * Default view for compliance audits and scenarios with replacement suggestions.
 * @module
 */

import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { FindingCard } from './FindingCard.tsx'
import type { ViewProps } from './types.ts'
import { isCodePath, orderFindings, parseIssue } from '../AuditCard.tsx'
import { scenarioMetadataOf } from './CapabilityBadges.tsx'
import { alignToCard, applyAccepted, clearOutlines, highlightQuote, outlineApplied, unwrapHighlights } from './documentHighlight.ts'
import css from './SplitPanelView.module.css'

/** File extensions that are binary and cannot be rendered as text. */
const BINARY_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|png|jpe?g|gif|webp|zip|gz|tar)$/i

/** Basic document styles for HTML preview. */
const DOCUMENT_STYLES = `
<style>
  [data-audit-document] {
    --_audit-text: var(--dsw-alias-label-primary, #1a1a1a);
    --_audit-bg: var(--dsw-alias-bg-base, #fff);
    --_audit-muted: var(--dsw-alias-label-tertiary, #666);
    --_audit-border: var(--dsw-alias-border-l4, #d0d0d0);
    --_audit-th-bg: var(--dsw-alias-bg-base, #f5f5f5);
  }
  [data-audit-document] { box-sizing: border-box; color: var(--_audit-text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.65; }
  [data-audit-document][data-document-kind='html'] { max-width: 900px; min-height: calc(100% - 24px); margin: 12px auto; padding: 36px 48px; border: 0.5px solid var(--_audit-border); border-radius: var(--dsw-radius-xs); background: var(--_audit-bg); box-shadow: 0 2px 12px color-mix(in srgb, var(--_audit-text) 8%, transparent); }
  [data-audit-document][data-document-kind='docx'] { width: 100%; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  [data-audit-document][data-document-kind='docx'] .docx-wrapper { min-height: 100%; padding: 12px 0; overflow: visible; background: transparent; }
  [data-audit-document][data-document-kind='docx'] .docx { width: calc(100% - 12px); max-width: calc(100% - 12px); margin: 0 auto 12px; border: 0.5px solid var(--_audit-border); box-shadow: 0 2px 12px color-mix(in srgb, var(--_audit-text) 8%, transparent); }
  [data-audit-document][data-document-kind='docx'] .docx > article { padding-right: 24px; padding-left: 24px; }
  [data-audit-document] * { box-sizing: border-box; }
  [data-audit-document] h1 { font-size: 1.8em; font-weight: 700; margin: 0.8em 0 0.4em; }
  [data-audit-document] h2 { font-size: 1.4em; font-weight: 600; margin: 0.6em 0 0.3em; }
  [data-audit-document] h3 { font-size: 1.2em; font-weight: 600; margin: 0.5em 0 0.2em; }
  [data-audit-document] p { margin: 0.4em 0; }
  [data-audit-document] table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
  [data-audit-document] th, [data-audit-document] td { border: 1px solid var(--_audit-border); padding: 6px 10px; text-align: left; font-size: 0.9em; }
  [data-audit-document] th { background: var(--_audit-th-bg); font-weight: 600; }
  [data-audit-document] ul, [data-audit-document] ol { margin: 0.4em 0; padding-left: 1.5em; }
  [data-audit-document] li { margin: 0.2em 0; }
  [data-audit-document] mark { padding: 1px 2px; border-radius: 2px; }
  [data-audit-document] .audit-code-path { margin: -12px 0 18px; padding-bottom: 10px; border-bottom: 1px solid var(--_audit-border); color: var(--_audit-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  [data-audit-document] pre[data-audit-code] { margin: 0; overflow: visible; white-space: pre; tab-size: 2; color: var(--_audit-text); background: transparent; font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>
`

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textPreview(path: string, text: string): string {
  if (isCodePath(path)) {
    return `${DOCUMENT_STYLES}<div class="audit-code-path">${escapeHtml(path)}</div><pre data-audit-code><code>${escapeHtml(text)}</code></pre>`
  }
  return `${DOCUMENT_STYLES}<pre style="margin:0;white-space:pre-wrap;font:inherit">${escapeHtml(text)}</pre>`
}

/**
 * Keep converted document markup inside the preview instead of letting its head content alter the application.
 * @param source - HTML read from the reviewed document's generated preview.
 * @returns inert body markup preceded by preview-scoped styles.
 */
export function prepareDocumentHtml(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html')
  for (const element of document.querySelectorAll('style, link, script, iframe, object, embed, base, meta, title')) element.remove()
  for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name)
    }
  }
  return DOCUMENT_STYLES + document.body.innerHTML
}

/**
 * Split-panel view component.
 */
export function SplitPanelView({ state, sessionId, readFileBytes, t, onDecide, onApply }: ViewProps) {
  const [docHtml, setDocHtml] = useState<string>('')
  const [docError, setDocError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const docTextRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const metadata = scenarioMetadataOf(state)

  const selectedFinding = selectedId !== null ? state.findings.find(f => f.id === selectedId) ?? null : null
  const anchorPath = selectedFinding?.anchor.path ?? state.findings[0]?.anchor.path ?? state.documentPath
  const previewPath = /\.docx$/i.test(state.documentPath) ? state.documentPath : anchorPath
  const htmlPath = anchorPath?.replace(/\.[^.]+$/, '.html') ?? null

  // Load document HTML
  useEffect(() => {
    if (!previewPath) return
    setDocHtml('')
    setDocError(null)

    const failLoad = (error: unknown): void => {
      setDocError(error instanceof Error ? error.message : String(error))
    }

    if (/\.docx$/i.test(previewPath)) {
      readFileBytes(sessionId, previewPath)
        .then(async (bytes) => {
          const staging = document.createElement('div')
          await renderAsync(bytes, staging, staging, {
            breakPages: true,
            ignoreHeight: false,
            ignoreWidth: false,
            inWrapper: true,
            renderHeaders: true,
            renderFooters: true,
          })
          setDocHtml(DOCUMENT_STYLES + staging.innerHTML)
        })
        .catch(failLoad)
      return
    }

    if (htmlPath === null || htmlPath === anchorPath) {
      if (BINARY_EXTENSIONS.test(anchorPath)) {
        setDocError(t('preview.binary'))
        return
      }
      readFileBytes(sessionId, anchorPath)
        .then((bytes) => {
          const text = new TextDecoder().decode(bytes)
          setDocHtml(/\.html?$/i.test(anchorPath) ? prepareDocumentHtml(text) : textPreview(anchorPath, text))
        })
        .catch(failLoad)
      return
    }

    readFileBytes(sessionId, htmlPath)
      .then(bytes => setDocHtml(prepareDocumentHtml(new TextDecoder().decode(bytes))))
      .catch(() => {
        if (BINARY_EXTENSIONS.test(anchorPath)) {
          setDocError(t('preview.noHtml'))
          return
        }
        readFileBytes(sessionId, anchorPath)
          .then((bytes) => {
            const text = new TextDecoder().decode(bytes)
            setDocHtml(textPreview(anchorPath, text))
          })
          .catch(failLoad)
      })
  }, [sessionId, anchorPath, previewPath, htmlPath, readFileBytes])

  // Show accepted replacements and the selected quote in the document, then align the
  // located text with the card that asked for it.
  useEffect(() => {
    const scroller = scrollRef.current
    const container = docTextRef.current
    if (container === null || docHtml === '' || scroller === null) return

    unwrapHighlights(container)
    clearOutlines(container)
    applyAccepted(container, state.findings, state.decisions)

    if (selectedFinding === null) return

    const severity = parseIssue(selectedFinding.issue).severity
    const target = state.decisions[selectedFinding.id] === 'accept'
      ? outlineApplied(container, selectedFinding.id, severity)
      : highlightQuote(container, selectedFinding.anchor.quote, severity)

    if (target !== null) {
      alignToCard(scroller, target, cardRef.current)
    }
  }, [selectedId, state.findings, state.decisions, docHtml])

  const findings = orderFindings(state.findings)
  const codeReview = isCodePath(anchorPath)
  const accepted = Object.entries(state.decisions).filter(([, d]) => d === 'accept').length
  const rejected = Object.entries(state.decisions).filter(([, d]) => d === 'reject').length
  const resolved = Object.values(metadata.workflow ?? {}).filter(item => item.status === 'resolved').length

  return (
    <div className={css.root}>
      {/* Left: Findings list */}
      <div ref={listRef} className={css.findings}>
        <div
          className={css.findingsHeader}
          onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <div className={css.findingsTitle}>
            {codeReview ? t('overview.codeTitle') : (state.cardTitle ?? t('overview.title'))} ({findings.length})
          </div>
          <div className={css.findingsSummary}>
            {state.summary !== undefined && <>{state.summary} · </>}
            <span className={css.acceptedCount}>{accepted} {t('status.accepted')}</span>
            {' · '}
            <span className={css.resolvedCount}>{resolved} {t('workflow.resolved')}</span>
            {' · '}
            <span className={css.rejectedCount}>{rejected} {t('status.rejected')}</span>
          </div>
        </div>
        <div style={{ padding: '16px' }}>
          {findings.map((finding, index) => (
            <div
              key={`${state.round}:${finding.id}`}
              data-finding-id={finding.id}
              ref={selectedId === finding.id ? cardRef : undefined}
              onClick={() => setSelectedId(finding.id)}
              style={{
                cursor: 'pointer',
                outline: selectedId === finding.id ? '2px solid var(--dsw-alias-state-business-primary)' : 'none',
                borderRadius: 'var(--dsw-radius-sm)',
                marginBottom: '12px',
              }}
            >
              <FindingCard
                finding={finding}
                index={index}
                round={state.round}
                t={t}
                onDecide={onDecide}
                onApply={onApply}
                decided={state.decisions[finding.id]}
                severityLabels={state.severityLabels}
                rating={metadata.ratings?.[finding.id]}
                tags={metadata.tags?.[finding.id]}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Right: Document preview */}
      <div ref={scrollRef} className={css.document}>
        {docHtml ? (
          <div
            ref={docTextRef}
            data-audit-document
            data-document-kind={/\.docx$/i.test(previewPath) ? 'docx' : 'html'}
            dangerouslySetInnerHTML={{ __html: docHtml }}
          />
        ) : docError !== null ? (
          <div style={{ color: 'var(--dsw-alias-state-error-primary)', padding: '20px' }}>{docError}</div>
        ) : (
          <div style={{ color: 'var(--dsw-alias-label-secondary)', padding: '20px' }}>{t('preview.loading')}</div>
        )}
      </div>
    </div>
  )
}
