/**
 * Diff view: side-by-side comparison of findings across multiple documents.
 * Suitable for version comparison, draft review, and multi-document clause analysis.
 * @module
 */

import { useMemo } from 'react'
import type { ViewProps } from './types.ts'
import { orderFindings } from '../AuditCard.tsx'
import { scenarioMetadataOf } from './CapabilityBadges.tsx'
import { FindingCard } from './FindingCard.tsx'

/** One document's findings grouped by path. */
interface DocumentGroup {
  path: string
  findings: ReturnType<typeof orderFindings>
}

/**
 * Diff view component: findings grouped by document, displayed in columns.
 */
export function DiffView({ state, t, onDecide, onApply }: ViewProps) {
  const metadata = scenarioMetadataOf(state)
  const findings = orderFindings(state.findings)

  // Group findings by document path
  const documentGroups = useMemo<DocumentGroup[]>(() => {
    const groups = new Map<string, typeof findings>()
    for (const finding of findings) {
      const path = finding.anchor.path
      const group = groups.get(path) ?? []
      group.push(finding)
      groups.set(path, group)
    }
    return Array.from(groups.entries()).map(([path, items]) => ({ path, findings: items }))
  }, [findings])

  const accepted = Object.entries(state.decisions).filter(([, d]) => d === 'accept').length
  const rejected = Object.entries(state.decisions).filter(([, d]) => d === 'reject').length

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '20px', padding: '12px 16px',
        background: 'var(--dsw-alias-fill-secondary)',
        borderRadius: '8px',
      }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {state.cardTitle ?? t('overview.title')}
        </div>
        <div style={{ display: 'flex', gap: '8px', fontSize: '12px' }}>
          <div style={{ padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-base)' }}>
            <span style={{ fontWeight: 500 }}>{findings.length}</span> {t('overview.findings')}
          </div>
          <div style={{ padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-base)' }}>
            <span style={{ fontWeight: 500, color: 'var(--dsw-alias-state-business-primary)' }}>{accepted}</span> {t('status.accepted')}
          </div>
          <div style={{ padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-base)' }}>
            <span style={{ fontWeight: 500, color: 'var(--dsw-alias-state-error-primary)' }}>{rejected}</span> {t('status.rejected')}
          </div>
          <div style={{ padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-base)' }}>
            <span style={{ fontWeight: 500 }}>{documentGroups.length}</span> {t('count.documents')}
          </div>
        </div>
      </div>

      {/* Document columns */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${documentGroups.length}, 1fr)`,
        gap: '16px',
      }}>
        {documentGroups.map(group => (
          <DocumentColumn
            key={group.path}
            group={group}
            state={state}
            metadata={metadata}
            t={t}
            onDecide={onDecide}
            onApply={onApply}
          />
        ))}
      </div>
    </div>
  )
}

/** One document's column in the diff view. */
function DocumentColumn({ group, state, metadata, t, onDecide, onApply }: {
  group: DocumentGroup
  state: ViewProps['state']
  metadata: ReturnType<typeof scenarioMetadataOf>
  t: ViewProps['t']
  onDecide: ViewProps['onDecide']
  onApply: ViewProps['onApply']
}) {
  const { path, findings } = group
  const fileName = path.split('/').pop() ?? path

  return (
    <div style={{
      border: '1px solid var(--dsw-alias-border-l4)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-base)',
      overflow: 'hidden',
    }}>
      {/* Column header */}
      <div style={{
        padding: '12px 16px',
        background: 'var(--dsw-alias-fill-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-l4)',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, rgb(30, 35, 45))' }}>
          {fileName}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))', marginTop: '4px' }}>
          {findings.length} {t('overview.findings')}
        </div>
      </div>

      {/* Findings list */}
      <div style={{ padding: '12px', maxHeight: '600px', overflow: 'auto' }}>
        {findings.map((finding, index) => (
          <FindingCard
            key={`${state.round}:${finding.id}`}
            finding={finding}
            documentPath={state.documentPath}
            index={index}
            round={state.round}
            t={t}
            onDecide={onDecide}
            onApply={onApply}
            decided={state.decisions[finding.id]}
            severityLabels={state.severityLabels}
            rating={metadata.ratings?.[finding.id]}
            tags={metadata.tags?.[finding.id]}
          />
        ))}
      </div>
    </div>
  )
}
