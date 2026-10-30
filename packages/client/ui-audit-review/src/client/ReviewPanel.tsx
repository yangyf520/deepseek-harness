/**
 * Audit review panel: adaptive view switcher based on presentation hints.
 * Routes to SplitPanelView, GroupedListView, or other views based on data characteristics.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AuditDecision, AuditExportDataResult, AuditTrackRequest } from '@deepseek-ai/dsh-audit-review/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ViewSwitcher } from './views/ViewSwitcher.tsx'

/** Read file bytes from workspace. */
export type ReadFileBytes = (sessionId: SessionId, path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Review panel props (from slot system). */
export type ReviewPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'audit'>
  & {
    readFileBytes: ReadFileBytes
    onDecide: (findingId: string, round: number, decision: AuditDecision) => Promise<boolean>
    onApply: (findingId: string, round: number) => Promise<boolean>
    onRate: (findingId: string, round: number, score: number) => Promise<boolean>
    onComment: (findingId: string, round: number, comment: string) => Promise<boolean>
    onTag: (findingId: string, round: number, tags: readonly string[]) => Promise<boolean>
    onTrack: (findingId: string, round: number, workflow: Pick<AuditTrackRequest, 'status' | 'assignee' | 'dueAt'>) => Promise<boolean>
    onExportData: (round: number, format: 'csv' | 'json' | 'html' | 'markdown') => Promise<AuditExportDataResult>
  }

/**
 * Main review panel component - delegates to ViewSwitcher for adaptive rendering.
 */
export function ReviewPanel(props: ReviewPanelProps) {
  const state = props.useProjection('audit')

  if (!state || state.round === 0 || state.findings.length === 0) {
    return <div style={{ padding: '20px', color: 'var(--dsw-alias-label-secondary, rgb(102, 112, 133))' }}>{props.t('preview.empty')}</div>
  }

  return <ViewSwitcher {...props} state={state} />
}
