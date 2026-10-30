/** Shared business-operation panel for every audit presentation. */
import { useMemo, useState } from 'react'
import type { AuditExportDataResult, AuditTrackRequest, CapabilityConfig } from '@deepseek-ai/dsh-audit-review/types'
import type { ViewProps } from './types.ts'
import css from './CapabilityPanel.module.css'

type Workflow = Pick<AuditTrackRequest, 'status' | 'assignee' | 'dueAt'>
type Outcome = { tone: 'success' | 'error'; text: string } | null

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

/** Render enabled scenario operations once, above the selected presentation. */
export function CapabilityPanel(props: ViewProps) {
  const { state, t } = props
  const capabilities: CapabilityConfig = {
    commenting: { enabled: true },
    tagging: { enabled: true },
    tracking: { enabled: true },
    collaboration: { enabled: true },
    exporting: { enabled: true, formats: ['csv', 'json', 'html', 'markdown'] },
    ...state.presentationHints?.capabilities,
  }
  const [targetId, setTargetId] = useState(state.findings[0]?.id ?? '')
  const [score, setScore] = useState('')
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [workflow, setWorkflow] = useState<Workflow>({ status: 'open' })
  const [outcome, setOutcome] = useState<Outcome>(null)
  const enabled = Object.values(capabilities).some(value => value?.enabled === true)
  const allowedTags = capabilities?.tagging?.allowedTags ?? []
  const formats = useMemo(() => capabilities?.exporting?.formats.filter(format => format !== 'modified-document') ?? [], [capabilities])
  if (!enabled) return null

  const settle = async (operation: Promise<boolean>, success: string): Promise<void> => {
    try {
      setOutcome(await operation ? { tone: 'success', text: success } : { tone: 'error', text: t('operation.failed') })
    } catch {
      setOutcome({ tone: 'error', text: t('operation.failed') })
    }
  }
  const exportData = async (format: 'csv' | 'json' | 'html' | 'markdown'): Promise<void> => {
    try {
      const result = await props.onExportData(state.round, format)
      if (!result.ok) return setOutcome({ tone: 'error', text: result.error.message })
      download(result)
      setOutcome({ tone: 'success', text: t('operation.exported') })
    } catch {
      setOutcome({ tone: 'error', text: t('operation.failed') })
    }
  }

  return <section aria-label={t('capability.title')} className={css.panel}>
    <details className={css.details}>
      <summary className={css.summary}>
        <span>{t('capability.more')}</span>
        {outcome !== null && <span role="status" className={outcome.tone === 'error' ? css.error : css.success}>{outcome.text}</span>}
        <span className={css.disclosure}>
          <span className={css.expandLabel}>{t('capability.expand')}</span>
          <span className={css.collapseLabel}>{t('capability.collapse')}</span>
          <span aria-hidden="true" className={css.chevron} />
        </span>
      </summary>
      <div className={css.content}>
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
          <div className={css.groupTitle}>{t('capability.workflowGroup')}</div>
          <div className={css.fields}>
            {capabilities?.tagging?.enabled === true && (allowedTags.length > 0
              ? allowedTags.map(tag => <label key={tag} style={{ fontSize: '12px' }}><input type="checkbox" checked={tags.includes(tag)} onChange={() => {
                const next = tags.includes(tag) ? tags.filter(value => value !== tag) : [...tags, tag]
                setTags(next)
                void settle(props.onTag(targetId, state.round, next), t('operation.saved'))
              }} /> {tag}</label>)
              : <input aria-label={t('capability.tags')} value={tags.join(',')} onChange={event => setTags(event.target.value.split(',').map(value => value.trim()).filter(Boolean))} onBlur={() => void settle(props.onTag(targetId, state.round, tags), t('operation.saved'))} style={fieldStyle} />)}
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
        {formats.length > 0 && <div className={css.group}>
          <div className={css.groupTitle}>{t('capability.exportGroup')}</div>
          <div className={css.fields}>
            {formats.map(format => <button key={format} type="button" style={buttonStyle} onClick={() => void exportData(format)}>{t('capability.export')} {format.toUpperCase()}</button>)}
          </div>
        </div>}
      </div>
    </details>
  </section>
}
