/**
 * Types for the audit-review package: session events, projection state,
 * and remote service request/response types.
 * @module @deepseek-ai/dsh-audit-review/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One source-code anchor for a finding. */
export interface AuditAnchor {
  readonly path: string
  readonly line: number
  readonly quote: string
}

/** One audit finding produced by the agent. */
export interface AuditFinding {
  readonly id: string
  readonly title?: string
  readonly anchor: AuditAnchor
  readonly issue: string
  readonly replacement: string
}

/** Session event: the agent wrote audit findings for one round. */
export interface AuditWrite {
  readonly round: number
  readonly documentPath: string
  readonly findings: readonly AuditFinding[]
}

/** A user decision on one finding; `undo` clears an earlier decision. */
export type AuditDecision = 'accept' | 'reject' | 'undo'

/** Session event: the user decided on one finding. */
export interface AuditDecide {
  readonly round: number
  readonly findingId: string
  readonly decision: AuditDecision
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One audit round's findings for one document; a later round supersedes it on replay. */
    'audit/write': AuditWrite
    /** One user decision on one finding of the named round; `undo` clears that finding's earlier decision. */
    'audit/decide': AuditDecide
  }
}

/** Fold state for the audit projection. */
export interface AuditState {
  round: number
  documentPath: string
  findings: AuditFinding[]
  decisions: Record<string, 'accept' | 'reject'>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    audit: AuditState
  }
  interface SessionProjectionMap {
    audit: AuditState
  }
}

/** Request to decide on one finding. */
export interface AuditDecideRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly findingId: string
  readonly decision: AuditDecision
}

/** Result of a decide operation. */
export type AuditDecideResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

/**
 * Request to rewrite an audited file so it holds the round's accepted findings. `findingId` names
 * the finding whose decision just changed, and thereby the file to rewrite.
 */
export interface AuditApplyRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly findingId: string
}

/** Result of rendering a file from the round's accepted findings. */
export type AuditApplyResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

/**
 * Request to export the audited document itself with the round's accepted findings applied; the
 * original upload is never modified.
 */
export interface AuditExportRequest {
  readonly sessionId: SessionId
  readonly round: number
}

/** Result of exporting the edited document: its download name, workspace path, and outcome counts. */
export type AuditExportResult =
  | { ok: true; value: { path: string; filename: string; applied: number; skipped: number } }
  | { ok: false; error: { code: string; message: string } }
