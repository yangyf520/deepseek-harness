/** Shared finding presentation and operation state across review layouts. */
import { useMemo, useRef, useState } from 'react'
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
export function FindingCard({ finding, index, round, t, onDecide, onApply, decided, severityLabels, rating, tags }: {
  finding: AuditFinding
  index: number
  round: number
  t: ViewProps['t']
  onDecide: ViewProps['onDecide']
  onApply: ViewProps['onApply']
  decided?: 'accept' | 'reject' | undefined
  severityLabels?: AuditState['severityLabels']
  rating?: { score: number } | undefined
  tags?: string[] | undefined
}) {
  const [deciding, setDeciding] = useState(false)
  const [outcome, setOutcome] = useState<'decision-error' | 'apply-skipped' | null>(null)
  const inFlight = useRef(false)
  const issueText = finding.issue ?? ''
  const parsed = parseIssue(issueText)
  const { prose } = useMemo(() => splitBasis(parsed.text), [parsed.text])
  const severity = parsed.severity
  const severityLabel = severityLabels?.[severity] ?? t(`severity.${severity}`)
  const summary = findingSummary(finding)
  const codeFinding = isCodePath(finding.anchor.path)
  const canApplyToSource = !NON_TEXT_SOURCE.test(finding.anchor.path)

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
      marginBottom: '8px',
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
            }}>{deciding ? '…' : (finding.replacement !== undefined ? t('action.accept') : t('action.acknowledge'))}</button>
            <button type="button" disabled={deciding} onClick={() => { void decide('reject') }} style={{
              padding: '4px 12px', fontSize: '12px', cursor: deciding ? 'wait' : 'pointer',
              background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 'var(--dsw-radius-sm)',
              height: '24px',
            }}>{deciding ? '…' : (finding.replacement !== undefined ? t('action.reject') : t('action.ignore'))}</button>
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
      {finding.replacement !== undefined && (
        <div style={{ fontSize: '12px', lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)', padding: '8px 10px', background: 'var(--dsw-alias-bg-elevated)', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-sm)' }}>
          <strong style={{ color: 'var(--dsw-alias-state-business-primary)' }}>{t('finding.suggestion')}:</strong> {finding.replacement || t('finding.delete')}
        </div>
      )}
      {outcome !== null && (
        <div role={outcome === 'decision-error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', fontSize: '12px', color: outcome === 'decision-error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' }}>
          {t(outcome === 'apply-skipped' ? 'operation.applySkipped' : 'operation.decisionFailed')}
        </div>
      )}
    </div>
  )
}
