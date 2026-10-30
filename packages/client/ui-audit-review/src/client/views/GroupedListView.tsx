/**
 * Grouped-list view: findings grouped by a configurable field.
 * Suitable for resume matching (group by candidate), section-based reviews, etc.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import type { AuditFinding, AuditState } from '@deepseek-ai/dsh-audit-review/types'
import { orderFindings, parseIssue, SEVERITY_BG, SEVERITY_COLOR } from '../AuditCard.tsx'
import { findingSummary } from '../AuditCard.tsx'
import { RatingBadge, TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'

/**
 * Grouped-list view component.
 */
export function GroupedListView({ state, t }: ViewProps) {
  const groupBy = state.presentationHints?.capabilities?.grouping?.groupBy ?? state.presentationHints?.groupBy
  const findings = orderFindings(state.findings)
  const metadata = scenarioMetadataOf(state)

  // Model-authored grouping (Remote `group`) takes precedence; fall back to title-prefix inference.
  const groups = useMemo(() => {
    const authored = metadata.grouping?.groups
    if (authored !== undefined) {
      const byId = new Map(findings.map(f => [f.id, f]))
      const grouped = Object.entries(authored)
        .map(([label, ids]) => ({ key: label, label, findings: ids.map(id => byId.get(id)).filter(f => f !== undefined) }))
        .filter(group => group.findings.length > 0)
      const groupedIds = new Set(grouped.flatMap(group => group.findings.map(f => f.id)))
      const rest = findings.filter(f => !groupedIds.has(f.id))
      if (rest.length > 0) grouped.push({ key: '__ungrouped', label: t('label.ungrouped'), findings: rest })
      if (grouped.length > 0) return grouped
    }
    if (!groupBy || groupBy === 'title-prefix') {
      return groupByPrefix(findings, t('label.ungrouped'))
    }
    // Default: no grouping
    return [{ key: 'all', label: t('label.all'), findings }]
  }, [findings, groupBy, metadata, t])

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', height: '100%', overflow: 'auto' }}>
      {/* Left: Grouped findings */}
      <div style={{ flex: '1 1 360px', minWidth: 0, overflow: 'auto', background: 'var(--dsw-alias-fill-secondary)', borderRight: '1px solid var(--dsw-alias-border-l4)' }}>
        <div style={{
          position: 'sticky', top: 0, zIndex: 1,
          padding: '16px',
          background: 'var(--dsw-alias-fill-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l4)',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
            {state.cardTitle ?? t('overview.title')}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
            {groups.length} {t('count.groups')} · {findings.length} {t('overview.findings')}
          </div>
        </div>
        <div style={{ padding: '16px' }}>
          {groups.map(group => (
            <div key={group.key} style={{ marginBottom: '24px' }}>
              <div style={{
                fontSize: '13px', fontWeight: 600, marginBottom: '12px',
                color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))',
                paddingBottom: '8px', borderBottom: '2px solid var(--dsw-alias-state-business-primary, rgb(23, 92, 211))',
              }}>
                {group.label} ({group.findings.length})
              </div>
              {group.findings.map((finding) => {
                const severity = parseIssue(finding.issue).severity
                return (
                  <div key={finding.id} style={{
                    padding: '10px', marginBottom: '8px',
                    border: '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))',
                    borderRadius: '8px', background: 'var(--dsw-alias-bg-base)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <span style={{
                        background: SEVERITY_COLOR[severity], color: 'white',
                        borderRadius: '999px', padding: '2px 8px', fontSize: '10px', fontWeight: 600,
                      }}>
                        {severityLabels(state.severityLabels, severity, t)}
                      </span>
                      <span style={{ flex: '1', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
                        {findingSummary(finding)}
                      </span>
                      <RatingBadge rating={metadata.ratings?.[finding.id]} />
                      <TagChips tags={metadata.tags?.[finding.id]} />
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))', lineHeight: 1.5 }}>
                      {parseIssue(finding.issue).text}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Right: Summary visualization */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        <SummaryVisualization groups={groups} state={state} t={t} />
      </div>
    </div>
  )
}

/** Group findings by extracting common prefix from titles. */
function groupByPrefix(
  findings: readonly AuditFinding[],
  fallback: string,
): Array<{ key: string; label: string; findings: AuditFinding[] }> {
  const groups = new Map<string, AuditFinding[]>()

  for (const finding of findings) {
    const title = finding.title ?? ''
    // Extract prefix before common delimiters
    const prefix = title.split(/[-—:：]/)[0]?.trim() ?? fallback
    const key = prefix || fallback

    const group = groups.get(key) ?? []
    group.push(finding)
    groups.set(key, group)
  }

  return Array.from(groups.entries()).map(([key, findings]) => ({
    key,
    label: key,
    findings,
  }))
}

/** Get severity label from custom labels or default. */
function severityLabels(labels: AuditState['severityLabels'], severity: 'high' | 'medium' | 'low', t: ViewProps['t']): string {
  if (labels && labels[severity]) return labels[severity]
  return t(`severity.${severity}`)
}

/** Summary visualization component. */
function SummaryVisualization({ groups, state, t }: { groups: Array<{ key: string; label: string; findings: AuditFinding[] }>; state: AuditState; t: ViewProps['t'] }) {
  const severities = state.findings.map(f => parseIssue(f.issue).severity)
  const highCount = severities.filter((s: string) => s === 'high').length
  const mediumCount = severities.filter((s: string) => s === 'medium').length
  const lowCount = severities.filter((s: string) => s === 'low').length
  const metadata = scenarioMetadataOf(state)

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '24px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
        {t('label.summary')}
      </h2>

      {/* Overall statistics */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '32px',
      }}>
        <div style={{
          padding: '16px', borderRadius: '8px',
          background: SEVERITY_BG.high, border: `1px solid ${SEVERITY_COLOR.high}`,
        }}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: SEVERITY_COLOR.high }}>{highCount}</div>
          <div style={{ fontSize: '12px', color: SEVERITY_COLOR.high }}>{severityLabels(state.severityLabels, 'high', t)}</div>
        </div>
        <div style={{
          padding: '16px', borderRadius: '8px',
          background: SEVERITY_BG.medium, border: `1px solid ${SEVERITY_COLOR.medium}`,
        }}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: SEVERITY_COLOR.medium }}>{mediumCount}</div>
          <div style={{ fontSize: '12px', color: SEVERITY_COLOR.medium }}>{severityLabels(state.severityLabels, 'medium', t)}</div>
        </div>
        <div style={{
          padding: '16px', borderRadius: '8px',
          background: SEVERITY_BG.low, border: `1px solid ${SEVERITY_COLOR.low}`,
        }}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: SEVERITY_COLOR.low }}>{lowCount}</div>
          <div style={{ fontSize: '12px', color: SEVERITY_COLOR.low }}>{severityLabels(state.severityLabels, 'low', t)}</div>
        </div>
      </div>

      {/* Rating leaderboard when scoring capability has produced data */}
      {metadata.ratings !== undefined && Object.keys(metadata.ratings).length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
            {t('label.ranking')}
          </h3>
          {Object.entries(metadata.ratings)
            .sort(([, a], [, b]) => b.score - a.score)
            .map(([targetId, rating]) => {
              const finding = state.findings.find(f => f.id === targetId)
              return (
                <div key={targetId} style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 12px', marginBottom: '8px',
                  border: '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))',
                  borderRadius: '6px',
                }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--dsw-alias-state-business-primary, rgb(23, 92, 211))', color: 'white',
                    fontSize: '13px', fontWeight: 700,
                  }}>
                    {rating.score}
                  </div>
                  <div style={{ flex: '1', fontSize: '13px', fontWeight: 600 }}>
                    {finding !== undefined ? findingSummary(finding) : targetId}
                  </div>
                  <TagChips tags={metadata.tags?.[targetId]} />
                </div>
              )
            })}
        </div>
      )}

      {/* Group breakdown */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
          {t('label.groupStats')}
        </h3>
        {groups.map((group) => {
          const groupSeverities = group.findings.map(f => parseIssue(f.issue).severity)
          const groupHigh = groupSeverities.filter((s: string) => s === 'high').length
          const groupMedium = groupSeverities.filter((s: string) => s === 'medium').length
          const groupLow = groupSeverities.filter((s: string) => s === 'low').length

          return (
            <div key={group.key} style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '12px', marginBottom: '8px',
              border: '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))',
              borderRadius: '6px',
            }}>
              <div style={{ flex: '1', fontSize: '13px', fontWeight: 600 }}>{group.label}</div>
              <div style={{ display: 'flex', gap: '8px', fontSize: '12px' }}>
                {groupHigh > 0 && <span style={{ color: SEVERITY_COLOR.high }}>{groupHigh}</span>}
                {groupMedium > 0 && <span style={{ color: SEVERITY_COLOR.medium }}>{groupMedium}</span>}
                {groupLow > 0 && <span style={{ color: SEVERITY_COLOR.low }}>{groupLow}</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* User goals if available */}
      {state.presentationHints?.userGoals && state.presentationHints.userGoals.length > 0 && (
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
            {t('label.goals')}
          </h3>
          <ul style={{ fontSize: '13px', lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))', paddingLeft: '20px' }}>
            {state.presentationHints.userGoals.map((goal: string, i: number) => (
              <li key={i}>{goal}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
