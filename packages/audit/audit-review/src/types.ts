/**
 * Types for the audit-review package: session events, projection state,
 * and remote service request/response types.
 * @module @deepseek-ai/dsh-audit-review/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Metadata values for audit findings (scoring, tagging, grouping, etc.) */
export type AuditMetadataValue = string | number | boolean | null
/** Metadata record for audit findings. */
export type AuditMetadata = Record<string, AuditMetadataValue>

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
  readonly replacement?: string
  /** Arbitrary metadata for capability-based operations (scoring, tagging, etc.) */
  readonly metadata?: AuditMetadata
}

/** Session event: the agent wrote audit findings for one round. */
export interface AuditWrite {
  readonly round: number
  readonly documentPath: string
  readonly findings: readonly AuditFinding[]
  /** Model-generated card title reflecting the analysis scenario (e.g. "合规审查", "匹配结果"). */
  readonly cardTitle?: string
  /** Model-generated summary line (e.g. "21 条违规", "3 位候选人"). */
  readonly summary?: string
  /** Optional scenario-specific severity labels (e.g. {high:"违规",medium:"风险",low:"建议"}). */
  readonly severityLabels?: { readonly high: string; readonly medium: string; readonly low: string }
  /** Model-driven presentation hints for adaptive UI. */
  readonly presentationHints?: PresentationHints
}

/** A user decision on one finding; `undo` clears an earlier decision. */
export type AuditDecision = 'accept' | 'reject' | 'undo'

/** Session event: the user decided on one finding. */
export interface AuditDecide {
  readonly round: number
  readonly findingId: string
  readonly decision: AuditDecision
}

/** Session event: update scenario metadata (ratings, comments, tags, groupings, etc.) */
export interface ScenarioUpdate {
  readonly [key: string]: JsonValue
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One audit round's findings for one document; a later round supersedes it on replay. */
    'audit/write': AuditWrite
    /** One user decision on one finding of the named round; `undo` clears that finding's earlier decision. */
    'audit/decide': AuditDecide
    /** Update scenario metadata (ratings, comments, tags, groupings, etc.) */
    'scenario/update': ScenarioUpdate
  }
}

/**
 * Capability configuration for generic enterprise scenarios.
 * Each capability can be enabled/disabled and configured independently.
 */
export interface CapabilityConfig {
  /** Group finding by any field or pattern */
  readonly grouping?: {
    readonly enabled: boolean
    readonly groupBy: string
    readonly pattern?: string
  }
  /** Score any target (candidates, items, sections) */
  readonly scoring?: {
    readonly enabled: boolean
    readonly target: string
    readonly label: string
    readonly range: readonly number[]
  }
  /** Add comments to any finding or target */
  readonly commenting?: {
    readonly enabled: boolean
  }
  /** Tag findings with arbitrary labels */
  readonly tagging?: {
    readonly enabled: boolean
    readonly allowedTags?: ReadonlyArray<string>
  }
  /** Make decisions (accept/reject/approve) */
  readonly deciding?: {
    readonly enabled: boolean
    readonly actions?: ReadonlyArray<'accept' | 'reject' | 'undo' | 'approve' | 'mitigate'>
  }
  /** Export in various formats */
  readonly exporting?: {
    readonly enabled: boolean
    readonly formats: ReadonlyArray<'csv' | 'json' | 'html' | 'markdown' | 'modified-document'>
  }
  /** Visualize data with charts and graphs */
  readonly visualizing?: {
    readonly enabled: boolean
    readonly type?: 'chart' | 'heatmap' | 'matrix' | 'timeline' | 'distribution'
  }
  /** Compare and track differences */
  readonly comparing?: {
    readonly enabled: boolean
  }
  /** Track progress and status */
  readonly tracking?: {
    readonly enabled: boolean
  }
  /** Enable multi-user collaboration */
  readonly collaboration?: {
    readonly enabled: boolean
  }
}

/**
 * Presentation hints: model-driven configuration for adaptive UI.
 * Defines which capabilities to enable and how to display them.
 */
export interface PresentationHints {
  /** Layout type for the review panel */
  readonly layout?: 'split-panel' | 'diff-view' | 'matrix' | 'grouped-list' | 'timeline' | 'custom'
  /** Capability configuration (new generic approach) */
  readonly capabilities?: CapabilityConfig
  /** Legacy: allowed user actions (deprecated, use capabilities instead) */
  readonly allowedActions?: ReadonlyArray<'accept' | 'reject' | 'undo' | 'comment' | 'score' | 'shortlist' | 'compare'>
  /** Legacy: field to group by (deprecated, use capabilities.grouping instead) */
  readonly groupBy?: string
  /** Legacy: scoring config (deprecated, use capabilities.scoring instead) */
  readonly scoring?: {
    readonly enabled: boolean
    readonly field: string
    readonly label: string
    readonly range: readonly number[]
  }
  /** Legacy: visualization type (deprecated, use capabilities.visualizing instead) */
  readonly visualization?: 'severity-distribution' | 'score-chart' | 'heatmap' | 'timeline' | 'comparison-matrix'
  /** Legacy: export formats (deprecated, use capabilities.exporting instead) */
  readonly exportFormats?: ReadonlyArray<'modified-document' | 'score-sheet' | 'comparison-report' | 'summary-pdf' | 'findings-matrix'>
  /** User goals inferred from conversation context */
  readonly userGoals?: readonly string[]
  /** Arbitrary scenario-specific configuration */
  readonly custom?: AuditMetadata
}

/** Fold state for the audit projection. */
export interface AuditState {
  round: number
  documentPath: string
  findings: AuditFinding[]
  decisions: Record<string, 'accept' | 'reject'>
  /** Model-generated card title; falls back to a generic label when absent. */
  cardTitle?: string
  /** Model-generated summary line; falls back to "N 条发现" when absent. */
  summary?: string
  /** Scenario-specific severity labels; when absent the UI falls back to locale defaults. */
  severityLabels?: { readonly high: string; readonly medium: string; readonly low: string }
  /** Model-driven presentation hints for adaptive UI. */
  presentationHints?: PresentationHints
  /** Arbitrary scenario metadata (ratings, comments, tags, groupings, etc.) */
  scenarioMetadata?: Record<string, JsonValue>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    audit: AuditState
  }
  interface SessionProjectionMap {
    audit: AuditState
  }
}

/** The code and message a failed remote call reports. */
export interface AuditFailure {
  readonly code: string
  readonly message: string
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
  | { ok: false; error: AuditFailure }

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
  | { ok: false; error: AuditFailure }

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
  | { ok: false; error: AuditFailure }

// ========== Capability Operation Types ==========

/** Request to group findings by a field. */
export interface AuditGroupRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly groupBy: string
  readonly pattern?: string
}

/** Result of grouping operation. */
export type AuditGroupResult =
  | { ok: true; groups: Record<string, string[]> }
  | { ok: false; error: AuditFailure }

/** Request to rate a target. */
export interface AuditRateRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly targetId: string
  readonly score: number
  readonly metadata?: AuditMetadata
}

/** Result of rating operation. */
export type AuditRateResult =
  | { ok: true }
  | { ok: false; error: AuditFailure }

/** Request to comment on a target. */
export interface AuditCommentRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly targetId: string
  readonly comment: string
  readonly author?: string
  readonly metadata?: AuditMetadata
}

/** Result of commenting operation. */
export type AuditCommentResult =
  | { ok: true }
  | { ok: false; error: AuditFailure }

/** Request to tag a target. */
export interface AuditTagRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly targetId: string
  readonly tags: readonly string[]
}

/** Result of tagging operation. */
export type AuditTagResult =
  | { ok: true }
  | { ok: false; error: AuditFailure }

/** Request to export data in a specific format. */
export interface AuditExportDataRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly format: 'csv' | 'json' | 'html' | 'markdown'
  readonly template?: string
  readonly filters?: AuditMetadata
}

/** Result of data export operation. */
export type AuditExportDataResult =
  | { ok: true; data: string; filename: string; mimeType: string }
  | { ok: false; error: AuditFailure }

/** Request to update the business-processing state of one finding. */
export interface AuditTrackRequest {
  readonly sessionId: SessionId
  readonly round: number
  readonly targetId: string
  readonly status: 'open' | 'in-progress' | 'resolved' | 'closed'
  readonly assignee?: string
  readonly dueAt?: string
}

/** Result of updating one finding's business-processing state. */
export type AuditTrackResult =
  | { ok: true }
  | { ok: false; error: AuditFailure }
