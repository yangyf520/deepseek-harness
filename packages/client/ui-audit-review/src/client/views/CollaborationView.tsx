/**
 * Collaboration view: shows findings with their comment threads and approval status.
 * Suitable for multi-reviewer workflows, approval chains, and discussion tracking.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import { parseIssue, SEVERITY_COLOR, SEVERITY_BG } from '../AuditCard.tsx'
import { findingSummary } from '../AuditCard.tsx'
import { RatingBadge, TagChips, scenarioMetadataOf } from './CapabilityBadges.tsx'

/**
 * Collaboration view component: findings with comment threads and decision status.
 */
export function CollaborationView({ state, t }: ViewProps) {
  const metadata = scenarioMetadataOf(state)

  // Group comments by targetId
  const commentsByTarget = useMemo(() => {
    if (metadata.comments === undefined) return new Map<string, ReadonlyArray<{ text: string; author?: string; timestamp: number }>>()
    return new Map(Object.entries(metadata.comments))
  }, [metadata.comments])

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px', color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
        {state.cardTitle ?? t('view.collaboration')}
      </div>

      {/* Summary stats */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', fontSize: '12px' }}>
        <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))' }}>
          <span style={{ fontWeight: 500 }}>{state.findings.length}</span> {t('overview.findings')}
        </div>
        <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))' }}>
          <span style={{ fontWeight: 600 }}>
            {state.findings.filter(f => state.decisions[f.id] !== undefined).length}
          </span> {t('status.decided')}
        </div>
        <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))' }}>
          <span style={{ fontWeight: 600 }}>
            {Array.from(commentsByTarget.values()).reduce((sum, arr) => sum + arr.length, 0)}
          </span> {t('count.comments')}
        </div>
      </div>

      {/* Findings with comment threads */}
      {state.findings.map((finding, index) => {
        const severity = parseIssue(finding.issue).severity
        const decision = state.decisions[finding.id]
        const comments = commentsByTarget.get(finding.id) ?? []

        return (
          <div key={finding.id} style={{
            marginBottom: '16px',
            border: `1px solid ${decision === 'accept' ? 'var(--dsw-alias-state-business-primary)' : decision === 'reject' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l4)'}`,
            borderRadius: '8px', background: 'var(--dsw-alias-bg-base)',
          }}>
            {/* Finding header */}
            <div style={{
              padding: '12px', borderBottom: comments.length > 0 ? '1px solid var(--dsw-alias-border-l4, rgb(234, 236, 240))' : 'none',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <span style={{
                background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
                borderRadius: '10px', height: '20px', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: '10px', fontWeight: 600,
              }}>
                {t(`severity.${severity}`)}
              </span>
              <span style={{ flex: '1', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
                {index + 1}. {findingSummary(finding)}
              </span>
              <RatingBadge rating={metadata.ratings?.[finding.id]} />
              <TagChips tags={metadata.tags?.[finding.id]} />
              {decision !== undefined && (
                <span style={{
                  background: decision === 'accept' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-error-primary)',
                  color: 'white', borderRadius: '999px', padding: '2px 8px', fontSize: '10px', fontWeight: 600,
                }}>
                  {t(decision === 'accept' ? 'status.accepted' : 'status.rejected')}
                </span>
              )}
            </div>

            {/* Comment thread */}
            {comments.length > 0 && (
              <div style={{ padding: '12px', background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))' }}>
                {comments.map((comment, commentIndex) => (
                  <div key={commentIndex} style={{ marginBottom: commentIndex < comments.length - 1 ? '10px' : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600 }}>
                        {comment.author ?? t('label.user')}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, rgb(178, 106, 0))' }}>
                        {new Date(comment.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
                      {comment.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
