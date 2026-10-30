/**
 * View switcher: routes to the appropriate view based on presentation hints.
 * @module
 */

import { Component, type ReactNode } from 'react'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { ViewMode, ViewProps } from './types.ts'
import { SplitPanelView } from './SplitPanelView.tsx'
import { GroupedListView } from './GroupedListView.tsx'
import { MatrixView } from './MatrixView.tsx'
import { TimelineView } from './TimelineView.tsx'
import { CollaborationView } from './CollaborationView.tsx'
import { DiffView } from './DiffView.tsx'
import { CapabilityPanel } from './CapabilityPanel.tsx'

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
function chooseViewMode(state: AuditState): ViewMode {
  // Explicit hint from model
  if (state.presentationHints?.layout) {
    return state.presentationHints.layout
  }

  // Infer from data characteristics
  const findings = state.findings

  // Multiple documents → diff view (future)
  const uniquePaths = new Set(findings.map(f => f.anchor.path))
  if (uniquePaths.size > 1) {
    return 'diff-view'
  }

  // Check if findings can be grouped (titles have common prefixes)
  const titles = findings.map(f => f.title).filter((t): t is string => Boolean(t))
  if (titles.length > 3) {
    const prefixes = new Set(titles.map(title => title?.split(/[-—:：]/)[0]?.trim() ?? '').filter(Boolean))
    if (prefixes.size > 1 && prefixes.size < titles.length / 2) {
      return 'grouped-list'
    }
  }

  // Default: split panel
  return 'split-panel'
}

/**
 * Adaptive view switcher component.
 */
export function ViewSwitcher(props: ViewProps) {
  const { state } = props
  const viewMode = chooseViewMode(state)

  // Render the appropriate view based on viewMode, with split-panel as the safe fallback.
  let view: ReactNode
  switch (viewMode) {
    case 'split-panel':
      view = <SplitPanelView {...props} />
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
      view = <CollaborationView {...props} />
      break
    default:
      // Fallback to split-panel for any unexpected viewMode value.
      view = <SplitPanelView {...props} />
  }

  return <ViewErrorBoundary failed={props.t('view.renderFailed')} retry={props.t('action.retry')}><CapabilityPanel {...props} />{view}</ViewErrorBoundary>
}
