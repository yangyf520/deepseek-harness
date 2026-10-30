/**
 * Timeline view: shows timestamped review activity chronologically.
 * Suitable for approval workflows, progress tracking, and temporal analysis.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import { parseIssue, SEVERITY_COLOR } from '../AuditCard.tsx'
import { findingSummary } from '../AuditCard.tsx'
import { RatingBadge, TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'
import { ScenarioView } from './ScenarioView.tsx'
import css from './SpecializedViews.module.css'

/** Timeline event: a timestamped occurrence on a finding. */
interface TimelineEvent {
  timestamp: number
  findingId: string
  type: 'created' | 'rated'
  label: string
  detail?: string
}

/**
 * Timeline view component: chronological stream of events across findings.
 */
export function TimelineView({ state, t }: ViewProps) {
  const metadata = scenarioMetadataOf(state)

  // Build timeline events from state + scenarioMetadata
  const events = useMemo(() => {
    const list: TimelineEvent[] = []

    // Created events: use a synthetic timestamp (we don't have creation time in AuditFinding, so use 0)
    for (const finding of state.findings) {
      list.push({
        timestamp: 0, // Will be sorted to top
        findingId: finding.id,
        type: 'created',
        label: t('timeline.created'),
        detail: findingSummary(finding),
      })
    }

    // Rated events
    if (metadata.ratings !== undefined) {
      for (const [targetId, rating] of Object.entries(metadata.ratings)) {
        list.push({
          timestamp: rating.timestamp,
          findingId: targetId,
          type: 'rated',
          label: t('timeline.rated', { score: String(rating.score) }),
        })
      }
    }

    // Tagged events: we don't have timestamps for tags, so skip for now

    // Sort by timestamp (newest first); created events (timestamp 0) go to bottom
    return list.sort((a, b) => b.timestamp - a.timestamp)
  }, [state.findings, metadata, t])

  return (
    <ScenarioView title={state.cardTitle ?? t('view.timeline')}>
      <div className={css.timeline}>
        {events.map((event, index) => {
          const finding = state.findings.find(f => f.id === event.findingId)
          const severity = finding !== undefined ? parseIssue(finding.issue).severity : 'low'

          return (
            <div key={`${event.findingId}:${event.type}:${event.timestamp}:${index}`} className={css.event}>
              <div className={css.eventDot} style={{ background: event.type === 'created' ? SEVERITY_COLOR[severity] : 'var(--dsw-alias-state-business-primary)' }} />
              <div className={css.eventCard}>
                <div className={css.eventHeader}>
                  <span className={css.eventTitle}>{event.label}</span>
                  {event.timestamp > 0 && (
                    <span className={css.eventTime}>
                      {new Date(event.timestamp).toLocaleString()}
                    </span>
                  )}
                  {finding !== undefined && (
                    <>
                      <RatingBadge rating={metadata.ratings?.[finding.id]} />
                      <TagChips tags={metadata.tags?.[finding.id]} />
                    </>
                  )}
                </div>
                {event.detail !== undefined && (
                  <div className={css.eventDetail}>
                    {event.detail}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </ScenarioView>
  )
}
