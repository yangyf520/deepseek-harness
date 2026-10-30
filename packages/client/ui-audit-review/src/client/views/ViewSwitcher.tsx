/**
 * View switcher: routes to the appropriate view based on presentation hints.
 * @module
 */

import { Component, type ReactNode, useState } from 'react'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { FindingFilter, ViewMode, ViewProps } from './types.ts'
import { SplitPanelView } from './SplitPanelView.tsx'
import { GroupedListView } from './GroupedListView.tsx'
import { MatrixView } from './MatrixView.tsx'
import { TimelineView } from './TimelineView.tsx'
import { DiffView } from './DiffView.tsx'
import { ScenarioEmptyState } from './ScenarioView.tsx'

/**
 * Error boundary to catch rendering errors and prevent white screen.
 */
class ViewErrorBoundary extends Component<
  { children: ReactNode; failed: string; retry: string },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; failed: string; retry: string }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('View rendering error:', error, errorInfo)
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', color: 'var(--dsw-alias-state-error-primary)', textAlign: 'center' }}>
          <h3>{this.props.failed}</h3>
          <p style={{ fontSize: '14px', marginTop: '8px' }}>{this.state.error?.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '12px',
              padding: '6px 16px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l4)',
              background: 'var(--dsw-alias-bg-base)',
              cursor: 'pointer',
            }}
          >
            {this.props.retry}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Determine the best view mode from presentation hints and data characteristics.
 */
export function chooseViewMode(state: AuditState): ViewMode {
  const hints = state.presentationHints
  const capabilities = hints?.capabilities
  const uniquePaths = new Set(state.findings.map(finding => finding.anchor.path))

  switch (hints?.layout) {
    case 'diff-view':
      return uniquePaths.size > 1 ? 'diff-view' : 'split-panel'
    case 'grouped-list':
      return capabilities?.grouping?.enabled === true || hints.groupBy !== undefined
        ? 'grouped-list'
        : 'split-panel'
    case 'matrix':
      return capabilities?.scoring?.enabled === true || capabilities?.comparing?.enabled === true
        ? 'matrix'
        : 'split-panel'
    case 'timeline':
      return capabilities?.tracking?.enabled === true || capabilities?.visualizing?.type === 'timeline'
        ? 'timeline'
        : 'split-panel'
    case 'split-panel':
      return 'split-panel'
    case 'custom':
    case undefined:
      return uniquePaths.size > 1 ? 'diff-view' : 'split-panel'
  }
}

/**
 * Adaptive view switcher component.
 */
export function ViewSwitcher(props: ViewProps) {
  const { state } = props
  const [findingFilter, setFindingFilter] = useState<FindingFilter>('all')
  if (state.findings.length === 0) return <ScenarioEmptyState>{props.t('preview.empty')}</ScenarioEmptyState>
  const viewMode = chooseViewMode(state)

  // Render the appropriate view based on viewMode, with split-panel as the safe fallback.
  let view: ReactNode
  switch (viewMode) {
    case 'split-panel':
      view = <SplitPanelView {...props} filter={findingFilter} onFilterChange={setFindingFilter} />
      break
    case 'grouped-list':
      view = <GroupedListView {...props} />
      break
    case 'diff-view':
      view = <DiffView {...props} />
      break
    case 'matrix':
      view = <MatrixView {...props} />
      break
    case 'timeline':
      view = <TimelineView {...props} />
      break
    case 'custom':
      view = <SplitPanelView {...props} filter={findingFilter} onFilterChange={setFindingFilter} />
      break
    default:
      // Fallback to split-panel for any unexpected viewMode value.
      view = <SplitPanelView {...props} filter={findingFilter} onFilterChange={setFindingFilter} />
  }

  return <ViewErrorBoundary failed={props.t('view.renderFailed')} retry={props.t('action.retry')}>{view}</ViewErrorBoundary>
}
