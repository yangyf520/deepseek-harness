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

/** Session event: the user decided on one finding. */
export interface AuditDecide {
  readonly round: number
  readonly findingId: string
  readonly decision: 'accept' | 'reject'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'audit/write': AuditWrite
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
  readonly decision: 'accept' | 'reject'
}

/** Result of a decide operation. */
export type AuditDecideResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

/** Request to apply one accepted finding's replacement. */
export interface AuditApplyRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly findingId: string
}

/** Result of an apply operation. */
export type AuditApplyResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }
