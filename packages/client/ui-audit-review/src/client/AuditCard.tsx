/**
 * Audit review react components: overview card and turn-tail wrapper.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Severity level for color coding. */
export type Severity = 'high' | 'medium' | 'low'

/** Color map for severity badges. */
export const SEVERITY_COLOR: Record<Severity, string> = {
  high: '#b91c1c',
  medium: '#b45309',
  low: '#047857',
}

/** Light severity backgrounds for cards and document highlights. */
export const SEVERITY_BG: Record<Severity, string> = {
  high: '#fee2e2',
  medium: '#fef3c7',
  low: '#d1fae5',
}

/** Extract severity from issue text. */
export function extractSeverity(issue: string): Severity {
  if (issue.includes('高') || issue.toLowerCase().includes('high')) return 'high'
  if (issue.includes('中') || issue.toLowerCase().includes('medium')) return 'medium'
  return 'low'
}

/** Finding from the audit projection. */
export interface AuditFinding {
  id: string
  title?: string
  anchor: { path: string; line: number; quote: string }
  issue: string
  replacement: string
  severity?: Severity
}

/** Audit state from projection. */
export interface AuditState {
  round: number
  documentPath: string
  findings: AuditFinding[]
  decisions: Record<string, 'accept' | 'reject'>
}

/** Overview card props. */
interface AuditOverviewProps {
  sessionId: SessionId
  state: AuditState
  onOpenReview: () => void
  onDownload: () => void
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Overview card showing summary and finding list. */
export function AuditOverviewCard({ state, onOpenReview, onDownload, t }: AuditOverviewProps) {
  const findings = state.findings
  const highCount = findings.filter(f => extractSeverity(f.issue) === 'high').length
  const mediumCount = findings.filter(f => extractSeverity(f.issue) === 'medium').length
  const lowCount = findings.filter(f => extractSeverity(f.issue) === 'low').length

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px',
      border: '1px solid rgb(234, 236, 240)', borderRadius: '6px',
    }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '12px' }}>{t('overview.title')}</strong>
        <span style={{ fontSize: '11px', color: 'rgb(102, 112, 133)' }}>
          {findings.length} {t('overview.findings')}
        </span>
        {highCount > 0 && (
          <span style={{ fontSize: '11px', color: SEVERITY_COLOR.high }}>
            {t('severity.high')} {highCount}
          </span>
        )}
        {mediumCount > 0 && (
          <span style={{ fontSize: '11px', color: SEVERITY_COLOR.medium }}>
            {t('severity.medium')} {mediumCount}
          </span>
        )}
        {lowCount > 0 && (
          <span style={{ fontSize: '11px', color: SEVERITY_COLOR.low }}>
            {t('severity.low')} {lowCount}
          </span>
        )}
      </div>
      {findings.slice(0, 3).map((finding, i) => {
        const severity = finding.severity ?? extractSeverity(finding.issue)
        return (
          <div key={finding.id} style={{
            display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', cursor: 'pointer',
          }}>
            <span style={{
              minWidth: '20px', textAlign: 'center',
              background: SEVERITY_COLOR[severity], color: 'rgb(255, 255, 255)',
              borderRadius: '999px', fontSize: '10px', padding: '1px 5px', fontWeight: 600,
            }}>{i + 1}</span>
            <span style={{
              background: SEVERITY_COLOR[severity], color: 'rgb(255, 255, 255)',
              borderRadius: '4px', fontSize: '10px', padding: '0 5px',
            }}>{t(`severity.${severity}`)}</span>
            <span style={{
              flex: '1 1 0%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{finding.issue}</span>
          </div>
        )
      })}
      {findings.length > 3 && (
        <div style={{ fontSize: '11px', color: 'rgb(23, 92, 211)', cursor: 'pointer' }}
          onClick={onOpenReview}>
          +{findings.length - 3} {t('overview.more')}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={onOpenReview} style={{
          fontSize: '12px', cursor: 'pointer',
          background: 'rgb(23, 92, 211)', border: 'none', color: 'rgb(255, 255, 255)',
          borderRadius: '6px', padding: '4px 12px',
        }}>{t('overview.openReview')}</button>
        <button type="button" onClick={onDownload} style={{
          fontSize: '12px', cursor: 'pointer',
          background: 'white', border: '1px solid rgb(234, 236, 240)', color: 'rgb(102, 112, 133)',
          borderRadius: '6px', padding: '4px 12px',
        }}>{t('overview.download')}</button>
      </div>
    </div>
  )
}

/** Turn-tail card wrapper props. */
export interface AuditTurnTailProps extends PropsRuntime<'conversation.chat.turnTail'> {
  sessionId: SessionId
  useProjection: UseProjection
  openSidebar: (address: string) => void
}

/** Turn-tail entry point. */
export function AuditTurnTail({ sessionId, useProjection, openSidebar, t }: AuditTurnTailProps) {
  const state = useProjection<AuditState>('audit')
  if (!state || state.round === 0 || state.findings.length === 0) return null

  const handleOpenReview = () => {
    openSidebar(`dsh-resource://audit/${sessionId}`)
  }

  const handleDownload = () => {
    const docPath = state.findings[0]?.anchor?.path
    if (!docPath) return
    // Trigger download via workspace file API
    const link = document.createElement('a')
    link.href = `/api/workspace/${sessionId}/files/${encodeURIComponent(docPath)}`
    link.download = docPath.split('/').pop() || 'document'
    link.click()
  }

  return <AuditOverviewCard sessionId={sessionId} state={state} onOpenReview={handleOpenReview} onDownload={handleDownload} t={t} />
}
