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
import { TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'
import { FindingCard } from './FindingCard.tsx'
import css from './GroupedListView.module.css'

/**
 * Grouped-list view component.
 */
export function GroupedListView({ state, t, onDecide, onApply, onEditReplacement }: ViewProps) {
  const groupBy = state.presentationHints?.capabilities?.grouping?.groupBy ?? state.presentationHints?.groupBy
  const findings = orderFindings(state.findings)
  const metadata = scenarioMetadataOf(state)
  const findingIndices = new Map(findings.map((finding, index) => [finding.id, index]))

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
    <div className={css.root}>
      {/* Left: Grouped findings */}
      <div className={css.findingsPane}>
        <div className={css.header}>
          <div className={css.title}>
            {state.cardTitle ?? t('overview.title')}
          </div>
          <div className={css.subtitle}>
            {groups.length} {t('count.groups')} · {findings.length} {t('overview.findings')}
          </div>
        </div>
        <div className={css.groups}>
          {groups.map(group => (
            <section key={group.key} className={css.group}>
              <h2 className={css.groupTitle}>
                {group.label} ({group.findings.length})
              </h2>
              <div className={css.groupCards}>{group.findings.map(finding => (
                <FindingCard
                  key={`${state.round}:${finding.id}`}
                  finding={finding}
                  documentPath={state.documentPath}
                  index={findingIndices.get(finding.id) ?? 0}
                  round={state.round}
                  t={t}
                  onDecide={onDecide}
                  onApply={onApply}
                  onEditReplacement={onEditReplacement}
                  decided={state.decisions[finding.id]}
                  severityLabels={state.severityLabels}
                  rating={metadata.ratings?.[finding.id]}
                  tags={metadata.tags?.[finding.id]}
                  editedReplacement={metadata.replacements?.[finding.id]}
                />
              ))}</div>
            </section>
          ))}
        </div>
      </div>

      {/* Right: Summary visualization */}
      <div className={css.summaryPane}>
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
      <h2 className={css.summaryTitle}>
        {t('label.summary')}
      </h2>

      {/* Overall statistics */}
      <div className={`${css.severityGrid} ${css.summarySection}`}>
        <div className={css.severityMetric} style={{ color: SEVERITY_COLOR.high, background: SEVERITY_BG.high }}>
          <div className={css.severityValue}>{highCount}</div>
          <div className={css.severityLabel}>{severityLabels(state.severityLabels, 'high', t)}</div>
        </div>
        <div className={css.severityMetric} style={{ color: SEVERITY_COLOR.medium, background: SEVERITY_BG.medium }}>
          <div className={css.severityValue}>{mediumCount}</div>
          <div className={css.severityLabel}>{severityLabels(state.severityLabels, 'medium', t)}</div>
        </div>
        <div className={css.severityMetric} style={{ color: SEVERITY_COLOR.low, background: SEVERITY_BG.low }}>
          <div className={css.severityValue}>{lowCount}</div>
          <div className={css.severityLabel}>{severityLabels(state.severityLabels, 'low', t)}</div>
        </div>
      </div>

      {/* Rating leaderboard when scoring capability has produced data */}
      {metadata.ratings !== undefined && Object.keys(metadata.ratings).length > 0 && (
        <section className={css.summarySection}>
          <h3 className={css.sectionTitle}>
            {t('label.ranking')}
          </h3>
          <div className={css.summaryList}>{Object.entries(metadata.ratings)
            .sort(([, a], [, b]) => b.score - a.score)
            .map(([targetId, rating]) => {
              const finding = state.findings.find(f => f.id === targetId)
              return (
                <div key={targetId} className={css.summaryRow}>
                  <div className={css.score}>
                    {rating.score}
                  </div>
                  <div className={css.rowLabel}>
                    {finding !== undefined ? findingSummary(finding) : targetId}
                  </div>
                  <TagChips tags={metadata.tags?.[targetId]} />
                </div>
              )
            })}</div>
        </section>
      )}

      {/* Group breakdown */}
      <section className={css.summarySection}>
        <h3 className={css.sectionTitle}>
          {t('label.groupStats')}
        </h3>
        <div className={css.summaryList}>{groups.map((group) => {
          const groupSeverities = group.findings.map(f => parseIssue(f.issue).severity)
          const groupHigh = groupSeverities.filter((s: string) => s === 'high').length
          const groupMedium = groupSeverities.filter((s: string) => s === 'medium').length
          const groupLow = groupSeverities.filter((s: string) => s === 'low').length

          return (
            <div key={group.key} className={css.summaryRow}>
              <div className={css.rowLabel}>{group.label}</div>
              <div className={css.severityCounts}>
                {groupHigh > 0 && <span style={{ color: SEVERITY_COLOR.high }}>{groupHigh}</span>}
                {groupMedium > 0 && <span style={{ color: SEVERITY_COLOR.medium }}>{groupMedium}</span>}
                {groupLow > 0 && <span style={{ color: SEVERITY_COLOR.low }}>{groupLow}</span>}
              </div>
            </div>
          )
        })}</div>
      </section>

      {/* User goals if available */}
      {state.presentationHints?.userGoals && state.presentationHints.userGoals.length > 0 && (
        <section>
          <h3 className={css.sectionTitle}>
            {t('label.goals')}
          </h3>
          <ul className={css.goals}>
            {state.presentationHints.userGoals.map((goal: string, i: number) => (
              <li key={i}>{goal}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
