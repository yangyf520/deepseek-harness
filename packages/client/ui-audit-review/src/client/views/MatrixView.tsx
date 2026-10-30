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
import { ScenarioView } from './ScenarioView.tsx'
import presentationCss from './ReviewPresentation.module.css'
import css from './SpecializedViews.module.css'

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
          <span className={presentationCss.severityTag} style={{
            background: SEVERITY_COLOR[severity], color: 'white',
            display: 'inline-flex', alignItems: 'center', padding: '0 8px', fontSize: '10px', fontWeight: 500,
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
        if (decision === undefined) return <span className={css.pending}>{t('status.pending')}</span>
        return (
          <span className={`${css.decision} ${decision === 'accept' ? css.decisionAccepted : css.decisionRejected}`}>
            {t(decision === 'accept' ? 'action.accept' : 'action.reject')}
          </span>
        )
      },
    })

    return cols
  }, [metadata, state.decisions, t])

  return (
    <ScenarioView title={state.cardTitle ?? t('view.matrix')} summary={<span className={css.metric}><strong>{findings.length}</strong> {t('overview.findings')}</span>}>
      <div className={css.tableFrame}>
        <table className={css.matrix}>
          <thead>
            <tr>
              <th>
                {t('label.finding')}
              </th>
              {columns.map(col => (
                <th key={col.key}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {findings.map((finding, index) => (
              <tr key={finding.id}>
                <td>
                  <div className={css.findingTitle}>
                    {index + 1}. {findingSummary(finding)}
                  </div>
                  <div className={css.findingDetail}>
                    {parseIssue(finding.issue).text}
                  </div>
                </td>
                {columns.map(col => (
                  <td key={col.key}>
                    {col.render(finding)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ScenarioView>
  )
}
