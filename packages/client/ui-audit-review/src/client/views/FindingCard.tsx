/** Shared finding presentation and operation state across review layouts. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AuditDecision, AuditFinding, AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { ViewProps } from './types.ts'
import { parseIssue, findingSummary, isCodePath, SEVERITY_BG, SEVERITY_COLOR } from '../AuditCard.tsx'
import { splitBasis } from '../regulation.ts'
import { RatingBadge, TagChips } from './CapabilityBadges.tsx'
import css from './ReviewPresentation.module.css'

const NON_TEXT_SOURCE = /\.(?:docx?|xlsx?|pptx?|pdf|png|jpe?g|gif|webp|zip|gz|tar)$/i

/**
 * Shared evidence, decision and file-application controls for review layouts.
 * @param props - Finding, current decision and injected operations.
 * @returns The review card, including failed-operation recovery.
 */
export function FindingCard({
  finding, documentPath, index, round, t, onDecide, onApply, onEditReplacement,
  decided, severityLabels, rating, tags, editedReplacement,
}: {
  finding: AuditFinding
  documentPath?: string
  index: number
  round: number
  t: ViewProps['t']
  onDecide: ViewProps['onDecide']
  onApply: ViewProps['onApply']
  onEditReplacement?: ViewProps['onEditReplacement']
  decided?: 'accept' | 'reject' | undefined
  severityLabels?: AuditState['severityLabels']
  rating?: { score: number } | undefined
  tags?: string[] | undefined
  editedReplacement?: string | undefined
}) {
  const [deciding, setDeciding] = useState(false)
  const [outcome, setOutcome] = useState<'decision-error' | 'apply-skipped' | null>(null)
  const [editingReplacement, setEditingReplacement] = useState(false)
  const [replacementDraft, setReplacementDraft] = useState(editedReplacement ?? finding.replacement ?? '')
  const [savingReplacement, setSavingReplacement] = useState(false)
  const [inlineError, setInlineError] = useState(false)
  const inFlight = useRef(false)
  const issueText = finding.issue ?? ''
  const parsed = parseIssue(issueText)
  const { prose } = useMemo(() => splitBasis(parsed.text), [parsed.text])
  const severity = parsed.severity
  const severityLabel = severityLabels?.[severity] ?? t(`severity.${severity}`)
  const summary = findingSummary(finding)
  const codeFinding = isCodePath(finding.anchor.path)
  const canApplyToSource = !NON_TEXT_SOURCE.test(documentPath ?? finding.anchor.path)
  const effectiveReplacement = editedReplacement ?? finding.replacement

  useEffect(() => setReplacementDraft(effectiveReplacement ?? ''), [effectiveReplacement])

  const saveReplacement = async (replacement: string | null): Promise<void> => {
    if (onEditReplacement === undefined || savingReplacement) return
    setSavingReplacement(true)
    setInlineError(false)
    try {
      const saved = await onEditReplacement(finding.id, round, replacement)
      if (!saved) return setInlineError(true)
      setEditingReplacement(false)
      if (decided === 'accept' && canApplyToSource && !await onApply(finding.id, round)) setOutcome('apply-skipped')
    } catch {
      setInlineError(true)
    } finally {
      setSavingReplacement(false)
    }
  }

  const decide = async (decision: AuditDecision): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setDeciding(true)
    setOutcome(null)
    let phase: 'decision' | 'apply' = 'decision'
    try {
      if (!await onDecide(finding.id, round, decision)) {
        setOutcome('decision-error')
        return
      }
      const changesDocument = canApplyToSource && finding.replacement !== undefined && (decision === 'accept' || decided === 'accept')
      if (changesDocument) {
        phase = 'apply'
        if (!await onApply(finding.id, round)) {
          setOutcome('apply-skipped')
        }
      }
    } catch (error) {
      void error
      setOutcome(phase === 'apply' ? 'apply-skipped' : 'decision-error')
    } finally {
      inFlight.current = false
      setDeciding(false)
    }
  }

  return (
    <div style={{
      padding: '12px',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-bg-base)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '8px', paddingBottom: '8px', borderBottom: '0.5px solid var(--dsw-alias-border-l4)' }}>
        <span className={css.severityTag} style={{
          background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
          padding: '0 7px 0 3px', fontSize: '10px', fontWeight: 500, flexShrink: 0,
        }}>
          <span className={css.severityIndex} style={{
            width: '12px', height: '12px',
            background: SEVERITY_COLOR[severity], color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '8px', fontWeight: 500, flexShrink: 0,
          }}>{index + 1}</span>
          {severityLabel}
        </span>
        <span style={{ flex: '1 1 0%', minWidth: 0, fontSize: '12px', fontWeight: 500, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' }}>{summary}</span>
        <TagChips tags={tags} />
        <RatingBadge rating={rating} />
        {decided === undefined ? (
          <>
            <button type="button" disabled={deciding} onClick={() => { void decide('accept') }} style={{
              padding: '4px 12px', fontSize: '12px', cursor: deciding ? 'wait' : 'pointer',
              background: 'var(--dsw-alias-state-business-primary)', color: '#ffffff', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
              height: '24px',
            }}>{deciding ? '…' : t('action.accept')}</button>
            <button type="button" disabled={deciding} onClick={() => { void decide('reject') }} style={{
              padding: '4px 12px', fontSize: '12px', cursor: deciding ? 'wait' : 'pointer',
              background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 'var(--dsw-radius-sm)',
              height: '24px',
            }}>{deciding ? '…' : t('action.reject')}</button>
          </>
        ) : <>
          <span style={{ fontSize: '12px', color: decided === 'accept' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-error-primary)', fontWeight: 500 }}>
            {t(decided === 'accept' ? 'status.accepted' : 'status.rejected')}
          </span>
          <button type="button" disabled={deciding} onClick={() => { void decide('undo') }} style={{
            padding: '4px 12px', fontSize: '12px', cursor: deciding ? 'wait' : 'pointer',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-sm)', height: '24px',
          }}>{t('action.undo')}</button>
        </>}
      </div>
      <div style={{ fontSize: '13px', marginBottom: '8px', lineHeight: 1.4, padding: '8px 10px', background: 'var(--dsw-alias-bg-elevated)', borderRadius: 'var(--dsw-radius-xs)', color: 'var(--dsw-alias-label-primary)' }}>
        {codeFinding && <div style={{ marginBottom: '6px', color: 'var(--dsw-alias-label-tertiary)', font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>{finding.anchor.path}:{finding.anchor.line}</div>}
        {prose}
        {codeFinding && <pre style={{ margin: '8px 0 0', padding: '8px', overflowX: 'auto', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-xs)', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}><code>{finding.anchor.quote}</code></pre>}
      </div>
      {finding.replacement !== undefined && (editingReplacement ? (
        <div className={css.replacementEditor} onClick={event => event.stopPropagation()}>
          <label className={css.srOnly} htmlFor={`replacement-${finding.id}`}>{t('finding.suggestion')}</label>
          <textarea id={`replacement-${finding.id}`} autoFocus value={replacementDraft} onChange={event => setReplacementDraft(event.target.value)} />
          <div className={css.inlineActions}>
            <button type="button" disabled={savingReplacement} onClick={() => { setReplacementDraft(effectiveReplacement ?? ''); setEditingReplacement(false) }}>{t('action.cancel')}</button>
            <button type="button" disabled={savingReplacement} onClick={() => void saveReplacement(replacementDraft)}>{t('action.save')}</button>
          </div>
        </div>
      ) : (
        <div className={css.replacement} onDoubleClick={() => setEditingReplacement(true)} title={t('finding.editHint')}>
          <div><strong>{t('finding.suggestion')}:</strong> {effectiveReplacement || t('finding.delete')}</div>
          {editedReplacement !== undefined && <button type="button" onClick={(event) => { event.stopPropagation(); void saveReplacement(null) }}>{t('action.restore')}</button>}
        </div>
      ))}
      {inlineError && <div role="alert" className={css.inlineError}>{t('operation.failed')}</div>}
      {outcome !== null && (
        <div role={outcome === 'decision-error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', fontSize: '12px', color: outcome === 'decision-error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' }}>
          {t(outcome === 'apply-skipped' ? 'operation.applySkipped' : 'operation.decisionFailed')}
        </div>
      )}
    </div>
  )
}
