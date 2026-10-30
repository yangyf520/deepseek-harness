/**
 * Matrix comparison view: findings as rows, comparison dimensions as columns.
 * Suitable for multi-candidate evaluation, multi-document clause comparison, etc.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import type { AuditFinding } from '@deepseek-ai/dsh-audit-review/types'
import { parseIssue, SEVERITY_COLOR } from '../AuditCard.tsx'
import { findingSummary } from '../AuditCard.tsx'
import { RatingBadge, TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'

/**
 * Matrix view component: rows are findings, columns are metadata fields or scoring dimensions.
 */
export function MatrixView({ state, t }: ViewProps) {
  const metadata = scenarioMetadataOf(state)
  const findings = state.findings

  // Determine comparison columns: ratings (if any), tags (if any), severity (always)
  const columns = useMemo(() => {
    const cols: Array<{ key: string; label: string; render: (finding: AuditFinding) => React.ReactNode }> = []

    // Severity column (always present)
    cols.push({
      key: 'severity',
      label: t('label.severity'),
      render: (finding) => {
        const severity = parseIssue(finding.issue).severity
        return (
          <span style={{
            background: SEVERITY_COLOR[severity], color: 'white',
            borderRadius: '10px', height: '20px', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
          }}>
            {t(`severity.${severity}`)}
          </span>
        )
      },
    })

    // Rating column (if ratings exist)
    if (metadata.ratings !== undefined && Object.keys(metadata.ratings).length > 0) {
      cols.push({
        key: 'rating',
        label: t('label.score'),
        render: finding => <RatingBadge rating={metadata.ratings?.[finding.id]} />,
      })
    }

    // Tags column (if tags exist)
    if (metadata.tags !== undefined && Object.values(metadata.tags).some(tags => tags.length > 0)) {
      cols.push({
        key: 'tags',
        label: t('label.tags'),
        render: finding => <TagChips tags={metadata.tags?.[finding.id]} />,
      })
    }

    // Decision column
    cols.push({
      key: 'decision',
      label: t('label.decision'),
      render: (finding) => {
        const decision = state.decisions[finding.id]
        if (decision === undefined) return <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('status.pending')}</span>
        return (
          <span style={{
            background: decision === 'accept' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-error-primary)',
            color: 'white', borderRadius: '4px', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
          }}>
            {t(decision === 'accept' ? 'action.accept' : 'action.reject')}
          </span>
        )
      },
    })

    return cols
  }, [metadata, state.decisions, t])

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
        {state.cardTitle ?? t('view.matrix')}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))' }}>
                {t('label.finding')}
              </th>
              {columns.map(col => (
                <th key={col.key} style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 600, borderBottom: '2px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))' }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {findings.map((finding, index) => (
              <tr key={finding.id} style={{ borderBottom: '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))' }}>
                <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                    {index + 1}. {findingSummary(finding)}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))', lineHeight: 1.5 }}>
                    {parseIssue(finding.issue).text}
                  </div>
                </td>
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '10px 12px', textAlign: 'center', verticalAlign: 'middle' }}>
                    {col.render(finding)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
