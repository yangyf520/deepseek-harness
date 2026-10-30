/** Validated audit snapshots and event replay shared by Host and Remote consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { AuditState, PresentationHints } from './types.ts'
import { presentationHintsSchema, resolvePresentationHints } from './scenario.ts'

const emptyState: AuditState = { round: 0, documentPath: '', findings: [], decisions: {} }

/** Audit snapshot fields preserved by storage and Remote serialization. */
export const auditStateSchema = z.object({
  round: z.number().int().nonnegative(),
  documentPath: z.string(),
  findings: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    anchor: z.object({ path: z.string(), line: z.number().int(), quote: z.string() }),
    issue: z.string(),
    replacement: z.string().optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })),
  decisions: z.record(z.string(), z.enum(['accept', 'reject'])),
  cardTitle: z.string().optional(),
  summary: z.string().optional(),
  severityLabels: z.object({
    high: z.string(),
    medium: z.string(),
    low: z.string(),
  }).optional(),
  presentationHints: presentationHintsSchema.optional(),
  scenarioMetadata: z.record(z.string(), z.json()).optional(),
})

/**
 * Replay audit events without mutating prior snapshots.
 * @param state - Previous audit snapshot.
 * @param event - Committed session event.
 * @returns The next audit snapshot.
 */
export function foldAudit(state: AuditState, event: SessionEvent): AuditState {
  switch (event.type) {
    case 'audit/write': {
      const next: AuditState = {
        round: event.data.round,
        documentPath: event.data.documentPath,
        findings: [...event.data.findings],
        decisions: {},
      }
      if (event.data.cardTitle !== undefined) next.cardTitle = event.data.cardTitle
      if (event.data.summary !== undefined) next.summary = event.data.summary
      if (event.data.severityLabels !== undefined) next.severityLabels = event.data.severityLabels
      next.presentationHints = resolvePresentationHints(event.data.presentationHints ?? state.presentationHints, next.findings)
      return next
    }
    case 'audit/decide': {
      if (event.data.round !== state.round) return state
      const { findingId, decision } = event.data
      // The latest decision wins, so a user who changes their mind can undo one.
      const decisions = Object.fromEntries(Object.entries(state.decisions).filter(([id]) => id !== findingId))
      if (decision !== 'undo') decisions[findingId] = decision
      return { ...state, decisions }
    }
    case 'scenario/update': {
      // Merge scenario metadata from capability operations (group, rate, comment, tag, etc.)
      const metadata = { ...state.scenarioMetadata, ...event.data }
      const hints = presentationHintsSchema.safeParse(event.data.presentationHints)
      return {
        ...state,
        scenarioMetadata: metadata,
        ...(hints.success ? { presentationHints: resolvePresentationHints(hints.data as PresentationHints, state.findings) } : {}),
      }
    }
    default:
      return state
  }
}

/**
 * Register the audit projection for the lifetime of its plugin.
 * @param ctx - Context owning the projection registration.
 */
export function registerProjection(ctx: Context): void {
  const schema = auditStateSchema as z.ZodType<AuditState>
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'audit',
    stateSchema: schema,
    init: (): AuditState => ({ ...emptyState }),
    apply: foldAudit,
    wire: {
      viewSchema: schema,
      view: (state: AuditState) => state,
    },
    stateVersion: 1,
  }))
}
