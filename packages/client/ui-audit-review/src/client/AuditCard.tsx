/**
 * Audit review react components: overview card and turn-tail wrapper.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadFileBytes } from './ReviewPanel.tsx'

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

/** The level prefix `audit_write` requires at the start of every issue. */
const LEVEL_PREFIX = /^\s*[【[]\s*(高|中|低)风险\s*[】\]]\s*/

/** A finding's issue split into its declared severity and the prose shown to users. */
export interface ParsedIssue {
  severity: Severity
  /** Issue prose with the level prefix removed. */
  text: string
}

/**
 * Read a finding's severity from the level prefix the audit tool requires and strip that
 * prefix from the prose, so the level never depends on incidental characters.
 * @param issue - Raw issue text recorded by `audit_write`.
 * @returns the declared severity and the display prose.
 */
export function parseIssue(issue: string): ParsedIssue {
  const match = LEVEL_PREFIX.exec(issue)
  if (match === null) return { severity: inferSeverity(issue), text: issue }
  const text = issue.slice(match[0].length)
  if (match[1] === '高') return { severity: 'high', text }
  if (match[1] === '中') return { severity: 'medium', text }
  return { severity: 'low', text }
}

/**
 * Keyword fallback for issues recorded before the level prefix was required.
 * @param issue - Raw issue text.
 * @returns the inferred severity.
 */
function inferSeverity(issue: string): Severity {
  if (/安全|泄露|越权|丢失|高风险|严重/.test(issue)) return 'high'
  if (/矛盾|不一致|冲突|缺失|为空|未定义|未提及|不衔接|遗漏/.test(issue)) return 'medium'
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
  findings: readonly AuditFinding[]
  decisions: Record<string, 'accept' | 'reject'>
}

/** Overview card props. */
interface AuditOverviewProps {
  sessionId: SessionId
  state: AuditState
  onOpenReview: () => void
  onDownload: () => void
  t: TranslateNS<'audit'>
}

/** Overview card showing summary and finding list. */
export function AuditOverviewCard({ state, onOpenReview, onDownload, t }: AuditOverviewProps) {
  const findings = state.findings
  const severities = findings.map(f => f.severity ?? parseIssue(f.issue).severity)
  const highCount = severities.filter(s => s === 'high').length
  const mediumCount = severities.filter(s => s === 'medium').length
  const lowCount = severities.filter(s => s === 'low').length

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
        const parsed = parseIssue(finding.issue)
        const severity = finding.severity ?? parsed.severity
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
            }}>{parsed.text}</span>
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
export type AuditTurnTailProps =
  PropsRuntime<'conversation.chat.turnTail'>
  & PropsLocale<'audit'>
  & {
    openSidebar: (address: string) => void
    readFileBytes: ReadFileBytes
  }

/** Turn-tail entry point. */
export function AuditTurnTail({ sessionId, useProjection, openSidebar, readFileBytes, t }: AuditTurnTailProps) {
  const state = useProjection('audit')
  if (!state || state.round === 0 || state.findings.length === 0) return null

  const handleOpenReview = () => {
    openSidebar(`dsh-resource://audit/${sessionId}`)
  }

  const handleDownload = () => {
    const docPath = state.findings[0]?.anchor?.path
    if (!docPath) return
    // The audited file is the one the review panel rewrites, so a download carries the accepted findings.
    void readFileBytes(sessionId, docPath).then((bytes) => {
      const url = URL.createObjectURL(new Blob([bytes]))
      const link = document.createElement('a')
      link.href = url
      link.download = docPath.split('/').pop() || 'document'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    }).catch((error: unknown) => {
      console.error('audit download failed:', error)
    })
  }

  return <AuditOverviewCard sessionId={sessionId} state={state} onOpenReview={handleOpenReview} onDownload={handleDownload} t={t} />
}
