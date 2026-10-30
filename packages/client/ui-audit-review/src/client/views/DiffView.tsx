/**
 * Diff view: side-by-side comparison of findings across multiple documents.
 * Suitable for version comparison, draft review, and multi-document clause analysis.
 * @module
 */

import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { ViewProps } from './types.ts'
import { orderFindings } from '../AuditCard.tsx'
import { scenarioMetadataOf } from './CapabilityBadges.tsx'
import { FindingCard } from './FindingCard.tsx'
import { ScenarioView } from './ScenarioView.tsx'
import css from './SpecializedViews.module.css'

/** One document's findings grouped by path. */
interface DocumentGroup {
  path: string
  findings: ReturnType<typeof orderFindings>
}

/**
 * Diff view component: findings grouped by document, displayed in columns.
 */
export function DiffView({ state, t, onDecide, onApply, onEditReplacement }: ViewProps) {
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
    <ScenarioView
      title={state.cardTitle ?? t('overview.title')}
      summary={<>
        <span className={css.metric}><strong>{findings.length}</strong> {t('overview.findings')}</span>
        <span className={`${css.metric} ${css.accepted}`}><strong>{accepted}</strong> {t('status.accepted')}</span>
        <span className={`${css.metric} ${css.rejected}`}><strong>{rejected}</strong> {t('status.rejected')}</span>
        <span className={css.metric}><strong>{documentGroups.length}</strong> {t('count.documents')}</span>
      </>}
    >
      <div className={css.columns} style={{ '--audit-column-count': documentGroups.length } as CSSProperties}>
        {documentGroups.map(group => (
          <DocumentColumn
            key={group.path}
            group={group}
            state={state}
            metadata={metadata}
            t={t}
            onDecide={onDecide}
            onApply={onApply}
            onEditReplacement={onEditReplacement}
          />
        ))}
      </div>
    </ScenarioView>
  )
}

/** One document's column in the diff view. */
function DocumentColumn({ group, state, metadata, t, onDecide, onApply, onEditReplacement }: {
  group: DocumentGroup
  state: ViewProps['state']
  metadata: ReturnType<typeof scenarioMetadataOf>
  t: ViewProps['t']
  onDecide: ViewProps['onDecide']
  onApply: ViewProps['onApply']
  onEditReplacement: ViewProps['onEditReplacement']
}) {
  const { path, findings } = group
  const fileName = path.split('/').pop() ?? path

  return (
    <section className={css.column}>
      {/* Column header */}
      <header className={css.columnHeader}>
        <div className={css.columnTitle} title={path}>
          {fileName}
        </div>
        <div className={css.columnMeta}>
          {findings.length} {t('overview.findings')}
        </div>
      </header>

      {/* Findings list */}
      <div className={css.cardList}>
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
            onEditReplacement={onEditReplacement}
            decided={state.decisions[finding.id]}
            severityLabels={state.severityLabels}
            rating={metadata.ratings?.[finding.id]}
            tags={metadata.tags?.[finding.id]}
            editedReplacement={metadata.replacements?.[finding.id]}
          />
        ))}
      </div>
    </section>
  )
}
