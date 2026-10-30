/** Shared business-operation panel for every audit presentation. */
import { useEffect, useState } from 'react'
import type { AuditExportDataResult, AuditFinding, AuditTrackRequest, CapabilityConfig } from '@deepseek-ai/dsh-audit-review/types'
import type { ViewProps } from './types.ts'
import css from './CapabilityPanel.module.css'

type Workflow = Pick<AuditTrackRequest, 'status' | 'assignee' | 'dueAt'>
type Outcome = { tone: 'success' | 'error'; text: string } | null
type VisibleExportFormat = 'csv' | 'html' | 'pdf'

const fieldStyle = { minWidth: 0, padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }
const buttonStyle = { ...fieldStyle, cursor: 'pointer', fontWeight: 500 }

function download(result: Extract<AuditExportDataResult, { ok: true }>): void {
  const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = result.filename
  link.click()
  URL.revokeObjectURL(url)
}

function escapePrintable(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Build the printable report used by the browser's Save as PDF flow. */
export function printableAuditHtml(findings: readonly AuditFinding[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Audit review</title><style>
    @page { size: A4; margin: 18mm; }
    body { color: #172033; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { margin: 0 0 18px; font-size: 22px; }
    article { break-inside: avoid; margin: 0 0 12px; padding: 12px; border: 1px solid #d9e0ea; border-radius: 8px; }
    h2 { margin: 0 0 6px; font-size: 15px; }
    p { margin: 4px 0; }
    .replacement { color: #1769e0; }
  </style></head><body><h1>Audit review</h1>${findings.map((finding, index) => `<article><h2>${index + 1}. ${escapePrintable(finding.title ?? finding.id)}</h2><p>${escapePrintable(finding.issue)}</p>${finding.replacement === undefined ? '' : `<p class="replacement">Suggested replacement: ${escapePrintable(finding.replacement)}</p>`}</article>`).join('')}</body></html>`
}

function printPDF(findings: readonly AuditFinding[]): void {
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.setAttribute('aria-hidden', 'true')
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 1_000)
  }
  frame.srcdoc = printableAuditHtml(findings)
  document.body.append(frame)
}

/** Render enabled scenario operations once, above the selected presentation. */
export function CapabilityPanel(props: ViewProps) {
  const { state, t } = props
  const capabilities: CapabilityConfig = {
    commenting: { enabled: true },
    tagging: { enabled: true },
    tracking: { enabled: true },
    collaboration: { enabled: true },
    exporting: { enabled: true, formats: ['csv', 'html', 'pdf'] },
    ...state.presentationHints?.capabilities,
  }
  const [targetId, setTargetId] = useState(state.findings[0]?.id ?? '')
  const [score, setScore] = useState('')
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [workflow, setWorkflow] = useState<Workflow>({ status: 'open' })
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [expanded, setExpanded] = useState(false)
  const enabled = Object.values(capabilities).some(value => value?.enabled === true)
  const allowedTags = capabilities?.tagging?.allowedTags ?? []
  const formats: readonly VisibleExportFormat[] = capabilities.exporting?.enabled === true ? ['csv', 'html', 'pdf'] : []

  useEffect(() => {
    if (outcome === null) return
    const timer = window.setTimeout(() => setOutcome(null), 2_500)
    return () => window.clearTimeout(timer)
  }, [outcome])

  if (!enabled) return null

  const settle = async (operation: Promise<boolean>, success: string): Promise<void> => {
    try {
      setOutcome(await operation ? { tone: 'success', text: success } : { tone: 'error', text: t('operation.failed') })
    } catch {
      setOutcome({ tone: 'error', text: t('operation.failed') })
    }
  }
  const exportData = async (format: VisibleExportFormat): Promise<void> => {
    try {
      if (format === 'pdf') {
        printPDF(state.findings)
        return
      }
      const result = await props.onExportData(state.round, format)
      if (!result.ok) return setOutcome({ tone: 'error', text: result.error.message })
      download(result)
      setOutcome({ tone: 'success', text: t('operation.exported') })
    } catch {
      setOutcome({ tone: 'error', text: t('operation.failed') })
    }
  }

  return <section aria-label={t('capability.title')} className={css.panel}>
    <div className={css.toolbar}>
      {formats.length > 0 && <div className={css.toolbarExports}>
        {formats.map(format => <button key={format} type="button" className={css.exportButton} onClick={() => void exportData(format)}>{t('capability.export')} {format.toUpperCase()}</button>)}
      </div>}
      {outcome !== null && <span role="status" className={outcome.tone === 'error' ? css.error : css.success}>{outcome.text}</span>}
      <button type="button" className={css.moreButton} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span>{t('capability.more')}</span>
        <span className={css.disclosure}>{t(expanded ? 'capability.collapse' : 'capability.expand')}<span aria-hidden="true" className={`${css.chevron} ${expanded ? css.chevronOpen : ''}`} /></span>
      </button>
    </div>
    {expanded && <div className={css.content}>
      <div className={css.group}>
        <div className={css.groupTitle}>{t('capability.reviewGroup')}</div>
        <div className={css.fields}>
          <select aria-label={t('capability.target')} value={targetId} onChange={event => setTargetId(event.target.value)} style={fieldStyle}>
            {state.findings.map(finding => <option key={finding.id} value={finding.id}>{finding.title ?? finding.id}</option>)}
          </select>
          {capabilities?.scoring?.enabled === true && <>
            <input aria-label={capabilities.scoring.label} type="number" min={capabilities.scoring.range[0]} max={capabilities.scoring.range[1]} value={score} onChange={event => setScore(event.target.value)} style={{ ...fieldStyle, width: '88px' }} />
            <button type="button" style={buttonStyle} disabled={score === ''} onClick={() => void settle(props.onRate(targetId, state.round, Number(score)), t('operation.saved'))}>{t('capability.rate')}</button>
          </>}
          {capabilities?.commenting?.enabled === true && <>
            <input aria-label={t('capability.comment')} value={comment} onChange={event => setComment(event.target.value)} style={{ ...fieldStyle, flex: '1 1 160px' }} />
            <button type="button" style={buttonStyle} disabled={comment.trim() === ''} onClick={() => void settle(props.onComment(targetId, state.round, comment), t('operation.saved'))}>{t('capability.comment')}</button>
          </>}
        </div>
      </div>
      <div className={css.group}>
        <div className={css.groupTitle}>{t(allowedTags.length > 0 ? 'capability.workflowGroup' : 'capability.progressGroup')}</div>
        <div className={css.fields}>
          {capabilities?.tagging?.enabled === true && allowedTags.map(tag => <label key={tag} style={{ fontSize: '12px' }}><input type="checkbox" checked={tags.includes(tag)} onChange={() => {
            const next = tags.includes(tag) ? tags.filter(value => value !== tag) : [...tags, tag]
            setTags(next)
            void settle(props.onTag(targetId, state.round, next), t('operation.saved'))
          }} /> {tag}</label>)}
          {capabilities?.tracking?.enabled === true && <>
            <select aria-label={t('capability.status')} value={workflow.status} onChange={(event) => {
              const next: Workflow = { status: event.target.value as Workflow['status'] }
              setWorkflow(next)
              void settle(props.onTrack(targetId, state.round, next), t('operation.saved'))
            }} style={fieldStyle}>
              {(['open', 'in-progress', 'resolved', 'closed'] as const).map(status => <option key={status} value={status}>{t(`workflow.${status}`)}</option>)}
            </select>
          </>}
        </div>
      </div>
    </div>}
  </section>
}
