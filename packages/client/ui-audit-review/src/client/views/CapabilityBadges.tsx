/**
 * Capability badges: renders per-target rating scores and tags from
 * `scenarioMetadata` written by the audit-review Remote capability methods.
 * @module
 */

/** Scenario metadata carried by the audit projection state. */
export interface ScenarioMetadata {
  ratings?: Record<string, { score: number; comment?: string; timestamp: number }>
  tags?: Record<string, string[]>
  comments?: Record<string, ReadonlyArray<{ text: string; author?: string; timestamp: number }>>
  grouping?: { groupBy: string; groups: Record<string, string[]> }
  [key: string]: unknown
}

/**
 * Extract scenario metadata from an audit state value.
 */
export function scenarioMetadataOf(state: { scenarioMetadata?: Record<string, unknown> }): ScenarioMetadata {
  return (state.scenarioMetadata ?? {}) as ScenarioMetadata
}

/** Rating badge: shows a numeric score when the target has been rated. */
export function RatingBadge({ rating }: { rating?: { score: number } | undefined }) {
  if (rating === undefined) return null
  return (
    <span style={{
      background: 'var(--dsw-alias-state-business-primary, rgb(23, 92, 211))', color: 'white',
      borderRadius: '999px', padding: '1px 8px', fontSize: '10px', fontWeight: 700,
      flexShrink: 0,
    }}>
      {rating.score}
    </span>
  )
}

/** Tag chips: shows user-assigned tags for the target. */
export function TagChips({ tags }: { tags?: string[] | undefined }) {
  if (tags === undefined || tags.length === 0) return null
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      {tags.map(tag => (
        <span key={tag} style={{
          background: 'var(--dsw-alias-fill-secondary, rgb(240, 242, 245))',
          color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))',
          borderRadius: '4px', padding: '1px 6px', fontSize: '10px',
        }}>
          {tag}
        </span>
      ))}
    </span>
  )
}
