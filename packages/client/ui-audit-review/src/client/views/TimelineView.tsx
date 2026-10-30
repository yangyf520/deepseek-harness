/**
 * Timeline view: shows findings and their decision/comment history chronologically.
 * Suitable for approval workflows, progress tracking, and temporal analysis.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import { parseIssue, SEVERITY_COLOR } from '../AuditCard.tsx'
import { findingSummary } from '../AuditCard.tsx'
import { RatingBadge, TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'

/** Timeline event: a timestamped occurrence on a finding. */
interface TimelineEvent {
  timestamp: number
  findingId: string
  type: 'created' | 'rated' | 'commented' | 'tagged' | 'decided'
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

    // Commented events
    if (metadata.comments !== undefined) {
      for (const [targetId, comments] of Object.entries(metadata.comments)) {
        for (const comment of comments) {
          list.push({
            timestamp: comment.timestamp,
            findingId: targetId,
            type: 'commented',
            label: t('timeline.commented', { author: comment.author ?? t('label.user') }),
            detail: comment.text,
          })
        }
      }
    }

    // Tagged events: we don't have timestamps for tags, so skip for now

    // Sort by timestamp (newest first); created events (timestamp 0) go to bottom
    return list.sort((a, b) => b.timestamp - a.timestamp)
  }, [state.findings, metadata, t])

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px', color: 'var(--dsw-alias-label-primary)' }}>
        {state.cardTitle ?? t('view.timeline')}
      </div>

      <div style={{ position: 'relative', paddingLeft: '24px' }}>
        {/* Vertical line */}
        <div style={{
          position: 'absolute', left: '8px', top: 0, bottom: 0, width: '2px',
          background: 'var(--dsw-alias-border-l4)',
        }} />

        {events.map((event, index) => {
          const finding = state.findings.find(f => f.id === event.findingId)
          const severity = finding !== undefined ? parseIssue(finding.issue).severity : 'low'
          const decision = finding !== undefined ? state.decisions[finding.id] : undefined

          return (
            <div key={index} style={{ position: 'relative', marginBottom: '16px' }}>
              {/* Dot */}
              <div style={{
                position: 'absolute', left: '-20px', top: '4px',
                width: '12px', height: '12px', borderRadius: '50%',
                background: event.type === 'created' ? SEVERITY_COLOR[severity]
                  : event.type === 'decided' ? (decision === 'accept' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-error-primary)')
                    : 'var(--dsw-alias-state-business-primary, rgb(23, 92, 211))',
                border: '2px solid white',
              }} />

              {/* Card */}
              <div style={{
                padding: '10px 12px',
                border: '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))',
                borderRadius: '8px', background: 'var(--dsw-alias-bg-base)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{event.label}</span>
                  {event.timestamp > 0 && (
                    <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, rgb(178, 106, 0))' }}>
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
                  <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))', lineHeight: 1.5 }}>
                    {event.detail}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
