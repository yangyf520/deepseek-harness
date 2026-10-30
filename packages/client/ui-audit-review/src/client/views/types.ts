/**
 * View types for adaptive UI rendering.
 * @module
 */

import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { ReviewPanelProps } from '../ReviewPanel.tsx'

/** Available view modes. */
export type ViewMode = 'split-panel' | 'diff-view' | 'matrix' | 'grouped-list' | 'timeline' | 'custom'

/** View component props. */
export interface ViewProps extends ReviewPanelProps {
  state: AuditState
}

/** View renderer function type. */
export type ViewRenderer = (props: ViewProps) => JSX.Element | null
